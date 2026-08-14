// dsh-run.js —— 派活工具（dsh_run）
// 协议细节以 DSH 官方实现与实测行为为准（DSH 0.1.0-rc.6）。
// 流程：liveConfig 合并（直读 dataDir/config.json 的 global 键优先，协议实测 6.2）
//       → 懒建单例 DshConnection 并 ensure()（失败转人话）
//       → LabelStore 取号【MMdd-NN】→ 单例 runner（embedded=HeadlessRunner / external=TaskRunner）→ run()
//       → wait=false（默认异步）：立即返回「已派单」，后台完成后经宿主 deferred 通道唤醒（register/resolve/fail）
//       → wait=true（同步）：直接等终态返回（外接模式已知边界：同步无审批通知，协议实测 4.5）
// 台账：globalThis.__dshBridge.ops（进程内 Map，仅内存不落盘，对齐协议实测 7.2 的剥离决策）。

import fs from 'node:fs';
import path from 'node:path';
import { DshConnection } from '../lib/connection.js';
import { TaskRunner } from '../lib/task.js';
import { LabelStore } from '../lib/labels.js';

export const name = 'dsh_run';

export const description =
  '把任务交给 DeepSeek Harness（dsh）执行：dsh 是完整编码 agent（官方 API、沙箱 bash 与文件系统工具、上下文压缩、subagent 级联），' +
  '任务文本作为用户消息发给 dsh agent，cwd 是其沙箱工作目录（缺省用插件配置 defaultCwd）。' +
  '默认异步：立即返回「已派单」，任务完成后宿主经后台消息自动唤醒、结果送达；传 wait=true 同步等待最终结果（长任务会阻塞当前回合）。' +
  '内置（headless）模式：无审批通道，越界操作被沙箱立即拒绝（fail closed），agent 在任务报告里说明；可带授权重派（permission=danger-full-access）。' +
  '外接模式：agent 请求越界权限时任务挂起，插件经 deferred 通道发审批通知（带 opId/approvalId/理由/参数原文），用 dsh_approve 应答；' +
  '无人应答超时自动拒绝（approvalTimeoutMs，0=禁用）。' +
  '注意：外接同步模式（wait=true）无审批通知（已知边界），挂起审批只能靠超时自动拒绝或在 dsh Web UI 处理。' +
  'resume：外接模式传 sessionId 复用已有会话继续（agent 保留上文）；内置模式不支持 resume。' +
  '进度与台账用 dsh_status 查看；止损用 dsh_cancel。';

export const parameters = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: '要 dsh 执行的任务书文本（作为用户消息发给 dsh agent，应包含完整上下文与明确交付物）',
    },
    cwd: {
      type: 'string',
      description: 'dsh agent 的沙箱工作目录（绝对路径）。缺省用插件配置 defaultCwd；resume（传 sessionId）时该值被忽略',
    },
    timeout: {
      type: 'number',
      description: '超时秒数，缺省用插件配置 defaultTimeoutMs（默认 600 秒）。长任务建议显式调大',
    },
    wait: {
      type: 'boolean',
      description:
        'false（默认）= 异步：立即返回已派单，完成后宿主唤醒、结果后台送达；' +
        'true = 同步：等任务跑完直接返回最终结果（长任务会阻塞当前回合；外接模式同步时无审批通知）',
    },
    sessionId: {
      type: 'string',
      description: '复用已有 dsh 会话（resume）：传上次任务的 sessionId 则在该会话继续，agent 保留上文。目标会话应已空闲。仅外接模式支持；内置 headless 模式传此参数会报错',
    },
    permission: {
      type: 'string',
      enum: ['workspace-write', 'danger-full-access', 'read-only'],
      description:
        '内置 headless 模式：本次派单的沙箱权限模式（覆盖插件配置 permissionMode，单次生效）。' +
        '带授权重派越界任务时用 danger-full-access（该模式下全程不审批）。外接模式传此参数会报错。' +
        '安全约束：仅当用户在对话中明确授权后方可由 Agent 使用；不得自行决定升级到 danger-full-access',
    },
  },
  required: ['task'],
};

export const sessionPermission = { kind: 'external_side_effect' };

// ---- deferred 通道（宿主唤醒），调用法与 DSHana 
// 
//   async function f({bus:e,sessionPath:t,taskId:r,label:s}){if(!e?.request||!t||!r)return!1;try{return await e.request("deferred:register",{taskId:r,sessionPath:t,meta:{type:"dsh-run",label:String(s||""),deliveryIntent:"trigger_parent_turn",notifyAgentOnFailure:!0}}),!0}catch{return!1}}
//   async function g({bus:e,taskId:t,result:r}){if(!e?.request||!t)return!1;try{return await e.request("deferred:resolve",{taskId:t,result:r}),!0}catch{return!1}}
//   async function h({bus:e,taskId:t,error:r}){if(!e?.request||!t)return!1;try{return await e.request("deferred:fail",{taskId:t,error:r}),!0}catch{return!1}}
// 通道不可用（bus 缺 request / 无 sessionPath）时全部静默返回 false，宿主侧降级为仅日志。

/** 任务完成通道注册：taskId=opId，meta.type='dsh-run'（对齐
async function registerDeferred({ bus, sessionPath, taskId, label }) {
  if (!bus?.request || !sessionPath || !taskId) return false;
  try {
    await bus.request('deferred:register', {
      taskId,
      sessionPath,
      meta: {
        type: 'dsh-run',
        label: String(label || ''),
        deliveryIntent: 'trigger_parent_turn',
        notifyAgentOnFailure: true,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** 任务完成通道唤醒：result 为结构化终态摘要（对齐
async function resolveDeferred({ bus, taskId, result }) {
  if (!bus?.request || !taskId) return false;
  try {
    await bus.request('deferred:resolve', { taskId, result });
    return true;
  } catch {
    return false;
  }
}

/** 任务失败通道唤醒（对齐
async function failDeferred({ bus, taskId, error }) {
  if (!bus?.request || !taskId) return false;
  try {
    await bus.request('deferred:fail', { taskId, error });
    return true;
  } catch {
    return false;
  }
}

/**
 * 审批挂起通知（对齐
 *   async function m({bus:e,sessionPath:t,opId:r,approval:s,task:n}){if(!e?.request||!t)return;let o=`${r}::approval::${s.approvalId}`;try{await e.request("deferred:register",{taskId:o,sessionPath:t,meta:{type:"dsh-approval",label:`dsh 审批: ${s.toolName||"tool"}`}}),await e.request("deferred:resolve",{taskId:o,result:{kind:"dsh-approval",opId:r,sessionId:s.sessionId,approvalId:s.approvalId,toolName:s.toolName,callId:s.callId,reason:s.reason??null,args:s.args??null,taskPreview:String(n??"").slice(0,120)}})}catch{}}
 * 独立 taskId=`${opId}::approval::${approvalId}`，与任务完成通道（taskId=opId）分离，不占任务完成回调。
 * 失败或通道不可用时降级为仅日志（审批仍可经 dsh Web UI 人工处理，或由超时自动拒绝兜底）。
 */
async function notifyApproval({ bus, sessionPath, opId, approval, task, log }) {
  if (!bus?.request || !sessionPath || !opId) {
    try {
      log?.warn?.(
        `[dsh-bridge] deferred 通道不可用，审批 ${approval?.approvalId ?? '?'} 无法通知宿主（仅记录日志）`
      );
    } catch {
      // 日志失败静默
    }
    return;
  }
  const taskId = `${opId}::approval::${approval.approvalId}`;
  try {
    await bus.request('deferred:register', {
      taskId,
      sessionPath,
      meta: { type: 'dsh-approval', label: `dsh 审批: ${approval.toolName || 'tool'}` },
    });
    await bus.request('deferred:resolve', {
      taskId,
      result: {
        kind: 'dsh-approval',
        opId,
        sessionId: approval.sessionId ?? null,
        approvalId: approval.approvalId,
        toolName: approval.toolName ?? null,
        callId: approval.callId ?? null,
        reason: approval.reason ?? null,
        args: approval.args ?? null,
        taskPreview: String(task ?? '').slice(0, 120),
      },
    });
  } catch (e) {
    try {
      log?.warn?.(`[dsh-bridge] 审批 deferred 通知失败：${e?.message || e}`);
    } catch {
      // 日志失败静默
    }
  }
}

// ---- 进程内单例与配置（与 index.js 的 globalThis.__dshBridge 共享） ----

function singleton(ctx) {
  const g = globalThis;
  if (!g.__dshBridge || typeof g.__dshBridge !== 'object') g.__dshBridge = {};
  const s = g.__dshBridge;
  // 兜底：Hana 按需加载 tools，工具可能先于 onload 拿到 ctx 字段
  if (ctx?.bus && !s.bus) s.bus = ctx.bus;
  if (ctx?.dataDir && !s.dataDir) s.dataDir = ctx.dataDir;
  if (ctx?.config && !s.cfgSnapshot) s.cfgSnapshot = ctx.config;
  return s;
}

/** liveConfig 合并（协议实测 6.2）：宿主快照打底，直读 dataDir/config.json 的 global 键覆盖（直读优先） */
function liveConfig(s) {
  const merged = { ...(s.cfgSnapshot ?? {}) };
  try {
    if (s.dataDir) {
      const file = path.join(s.dataDir, 'config.json');
      if (fs.existsSync(file)) {
        const g = JSON.parse(fs.readFileSync(file, 'utf8'))?.global;
        if (g && typeof g === 'object') {
          for (const [k, v] of Object.entries(g)) {
            if (v != null && v !== '') merged[k] = v;
          }
        }
      }
    }
  } catch {
    // config.json 损坏静默，用快照
  }
  return merged;
}

/** opId 生成（
function nextOpId() {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

/** 任务台账（对齐 DSHana 的 ops Map；仅内存，裁剪 50 条） */
function ledger(s) {
  if (!s.ops) s.ops = new Map();
  return s.ops;
}

/** 异步完成通道的 result 负载：结构化终态摘要（kind:'dsh-done' + 终态字段） */
function doneResult(opId, final, mode) {
  return {
    kind: 'dsh-done',
    opId,
    tool: 'dsh_run',
    tag: final?.tag ?? null,
    sessionId: final?.sessionId ?? null,
    mode,
    status: final?.status ?? 'error',
    stopReason: final?.stopReason ?? null,
    conclusion: String(final?.conclusion ?? '').slice(0, 4000), // design.md：结论 ≤4000 字符
    checkpoints: final?.checkpoints ?? [],
    artifacts: final?.artifacts ?? [],
    usage: final?.usage ?? null,
    durationMs: final?.durationMs ?? null,
    ...(final?.error ? { error: final.error } : {}),
  };
}

async function run(ctx) {
  const s = singleton(ctx);
  const cfg = liveConfig(s);
  const sessionPath = ctx?.sessionPath ?? null;
  const bus = ctx?.bus ?? s.bus ?? null;

  // ---- 参数处理：宿主把工具参数铺在 ctx 上（对齐 DSHana 
  const task = String(ctx?.task ?? '').trim();
  if (!task) throw new Error('task 不能为空：请给出要 dsh 执行的任务书文本');
  const sidParam = String(ctx?.sessionId ?? '').trim() || null;
  const cwd = String(ctx?.cwd ?? '').trim() || String(cfg.defaultCwd ?? '').trim() || '';
  const timeoutSec = Number(ctx?.timeout);
  const timeoutMs =
    Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.round(timeoutSec * 1000) : undefined;
  const isSync = ctx?.wait === true;
  const permission = String(ctx?.permission ?? '').trim() || null;
  if (permission && !['workspace-write', 'danger-full-access', 'read-only'].includes(permission)) {
    throw new Error('permission 只支持 workspace-write / danger-full-access / read-only');
  }

  // ---- 1. 连接：懒建单例 DshConnection 并 ensure() ----
  let conn = s.connection;
  if (!conn) {
    conn = new DshConnection({ mode: cfg.mode, cfg, dataDir: s.dataDir, logger: ctx?.log });
    s.connection = conn;
  }
  conn.cfg = cfg; // 每次派单刷新 live 配置（直读 config.json 优先，协议实测 6.2）
  try {
    await conn.ensure();
  } catch (e) {
    const msg = String(e?.message || e);
    // 失败转人话：外接模式报「DSH 服务未运行，请先启动」；内置模式 prepare 报错已是人话（node/dsh 缺失、apiKey 未配）
    if (cfg.mode === 'external' || /外接/.test(msg)) {
      const port = Number(cfg.externalPort || cfg.webPort || 3080);
      throw new Error(`DSH 服务未运行，请先启动（外接模式，127.0.0.1:${port}）。`);
    }
    // P1-2.2：apiKey 未配在 spawn 前就拦下，给指定话术（不等到进程跑起来报 MISSING_CREDENTIAL）
    if (/apiKey|DEEPSEEK_API_KEY/.test(msg)) {
      throw new Error('内置模式需要 apiKey。请到 Hana 的插件设置（DSH Envoy）填写 DeepSeek API Key 后再派单。');
    }
    throw new Error(`DSH 内置（headless）就绪失败：${msg}`);
  }
  const mode = conn.effectiveMode;

  // P1-1：external 模式不支持 permission（静默忽略比报错危险），明确报错且不派单
  if (mode === 'external' && permission) {
    throw new Error(
      'permission 参数仅内置 headless 模式有效。外接模式下 DSH 的权限由审批流程管理：审批挂起时用 dsh_approve 放行即可，无需 permission 参数。'
    );
  }
  // P1-2.1：生效模式标注（同步/异步返回文本都带）
  const modeLine =
    mode === 'external'
      ? `生效模式：external（直连您自跑的 DSH @127.0.0.1:${Number(cfg.externalPort || cfg.webPort || 3080)}）`
      : '生效模式：embedded-headless（插件自拉一次性进程，DSH_HOME 隔离于插件数据目录）';

  // ---- 2. 标签【MMdd-NN】 ----
  const labels = new LabelStore(s.dataDir);
  let tag = null;
  try {
    tag = labels.next(); // 取号失败不阻塞任务
  } catch {
    tag = null;
  }

  // ---- 3. 单例 runner（dsh_approve / dsh_cancel / dsh_status 依赖它）：
  //      embedded → conn.headless（HeadlessRunner，无审批无会话句柄）；external → TaskRunner ----
  let runner;
  if (mode === 'embedded') {
    if (sidParam) {
      throw new Error(
        '内置 headless 模式不支持 resume：每次任务都是全新独立会话（无会话句柄）。外接模式才可传 sessionId'
      );
    }
    runner = conn.headless;
    s.runner = runner;
  } else {
    runner = s.runner;
    if (!(runner instanceof TaskRunner)) {
      runner = new TaskRunner({
        client: conn.client,
        labels,
        defaultTimeoutMs: cfg.defaultTimeoutMs,
        approvalTimeoutMs: cfg.approvalTimeoutMs,
        dataDir: s.dataDir,
        logger: ctx?.log,
        onApproval: null, // 派单前挂载（需当单的 opId/bus/sessionPath 闭包）
        opLog: ledger(s), // P0-1：审批历史写台账（任务结束后可查）
        mode,
      });
      s.runner = runner;
    }
    runner.mode = mode;
  }
  // 每次派单刷新直读配置（协议实测 6.2）：执行超时与连接模式
  const defMs = Number(cfg.defaultTimeoutMs);
  if (Number.isFinite(defMs) && defMs > 0) runner.defaultTimeoutMs = defMs;

  // ---- 4. 台账登记与 opId ----
  const opId = nextOpId();
  const ops = ledger(s);
  const entry = {
    opId,
    tag,
    task: task.slice(0, 500),
    cwd: cwd || null,
    mode,
    status: 'running',
    startedAt: new Date().toISOString(),
    sessionId: sidParam,
    wait: isSync,
    output: null,
    approvals: [], // P0-1：审批历史（TaskRunner 挂起/解决/自动拒绝时写入，任务结束后保留）
  };
  ops.set(opId, entry);
  while (ops.size > 50) {
    // 台账裁剪（对齐
    const oldest = ops.keys().next().value;
    if (!oldest) break;
    ops.delete(oldest);
  }

  // ---- 5. 派单前的通道准备（deferred register 先行，
  // bus/sessionPath 已在 run() 开头从合并 ctx 提取（宿主 execute(input, ctx) 双参约定，第二参含会话上下文）
  // 通道不可用不阻塞派单：审批靠前台盯梢 + dsh_status 对账，结果靠主动查询，deferred 只是增强

  // 审批挂起回调：每单挂载（闭包携带当单的 opId/bus/sessionPath）；仅 external（headless 无审批事件）
  if (mode !== 'embedded') {
    runner.onApproval = (pending) => {
      // opId 反查：TaskRunner 运行台账 ctx.opKey 即派单时传入的 opId（ctx.sessionId 随会话建立写入）
      let approveOpId = opId;
      if (pending?.sessionId) {
        for (const c of (runner._runs ?? new Map()).values()) {
          if (c.sessionId === pending.sessionId) {
            approveOpId = c.opKey || opId;
            break;
          }
        }
      }
      notifyApproval({
        bus,
        sessionPath,
        opId: approveOpId,
        approval: pending,
        task: ops.get(approveOpId)?.task ?? task,
        log: ctx?.log,
      });
    };
  }

  // ---- 6. 执行 ----
  const runPromise = runner.run({
    task,
    cwd: cwd || undefined,
    tag: tag ?? undefined,
    sessionId: sidParam ?? undefined,
    timeoutMs,
    opId,
    signal: ctx?.signal ?? undefined, // 宿主中断联动（协议实测 5.3 的 abort）
    ...(mode === 'embedded' && permission
      ? { env: { DSH_PERMISSION_MODE: permission } } // 带授权重派（headless-behavior.md 实测结论）
      : {}),
    onProgress: (p) => {
      const e = ops.get(opId);
      if (!e) return;
      if (p?.sessionId) e.sessionId = p.sessionId; // P0-1：会话一建立就落台账（对账匹配键）
      if (p?.output != null) e.output = String(p.output).slice(-8000); // 输出尾部滚动，供 dsh_status
    },
  });

  // 终态落地到台账
  const settle = async (final) => {
    const e = ops.get(opId);
    if (e) {
      e.status = final?.ok ? 'completed' : (final?.status ?? 'error');
      e.stopReason = final?.stopReason ?? null;
      e.sessionId = final?.sessionId ?? e.sessionId;
      e.durationMs = final?.durationMs ?? null;
      e.usage = final?.usage ?? null;
      e.endedAt = new Date().toISOString();
      if (final?.error) e.error = String(final.error).slice(0, 2000);
      delete e.output; // 终态后完整输出见结构化结果 / details
    }
  };

  if (!isSync) {
    // ---- 异步模式（wait=false）：立即返回，后台完成后经 deferred 通道唤醒宿主 ----
    const registerPromise = registerDeferred({ bus, sessionPath, taskId: opId, label: task.slice(0, 120) });
    // 先挂 settle（防快速失败漏报），再等注册落地；resolve/fail 自带 try/catch 降级为仅日志
    runPromise.then(
      async (final) => {
        await settle(final);
        await registerPromise;
        await resolveDeferred({ bus, taskId: opId, result: doneResult(opId, final, mode) });
      },
      async (e) => {
        // run() 正常路径总会返回终态对象；此分支仅为兜底（如状态机自身缺陷）
        const msg = String(e?.message || e);
        const ent = ops.get(opId);
        if (ent) {
          ent.status = 'error';
          ent.error = msg.slice(0, 2000);
          ent.endedAt = new Date().toISOString();
        }
        await registerPromise;
        await failDeferred({ bus, taskId: opId, error: { message: msg.slice(0, 300) } });
      }
    );
    await registerPromise; // 对齐
    // P0-2：工具返回文本直接嵌入下一步指令（Agent 必读，不依赖 SKILL 自觉）
    const followup =
      mode === 'embedded'
        ? '内置 headless 模式无审批：等待终态即可，无需盯梢；任务完成后宿主经后台消息带回结果，随时可用 dsh_status 对账。' +
          '越界操作会被沙箱立即拒绝并在任务报告里说明，如需可带授权重派（permission=danger-full-access）。'
        : '⚠️ 派单后请立即盯梢：用 exec_command 等待 15~20 秒后调 dsh_status；若发现挂起审批，立即向用户内联问询' +
          '（呈现 DSH 审批标识、工具名、理由、命令原文），用户答复后调 dsh_approve；未发现审批且任务未结束则再盯 1~2 轮（共最多 5 轮），' +
          '之后如实告知用户任务仍在后台运行。';
    return {
      content: [
        {
          type: 'text',
          text:
            `已派单【${tag ?? '??'}】任务（opId: ${opId}${sidParam ? `，resume 会话 ${sidParam}` : ''}）。${modeLine}` +
            `完成后宿主经后台消息带回结果；进度与台账可随时用 dsh_status 查看，止损用 dsh_cancel。${followup}`,
        },
      ],
      details: {
        dsh: { opId, tag, sessionId: sidParam, status: 'running', mode, wait: false },
      },
    };
  }

  // ---- 同步模式（wait=true）：直接等终态返回 ----
  const final = await runPromise;
  await settle(final);
  const conclusion = String(final?.conclusion ?? '');
  const head = conclusion ? conclusion.slice(0, 4000) : '（dsh 未返回文本）';
  const statusLine =
    final?.status === 'completed'
      ? ''
      : `\n[status: ${final?.status}${final?.stopReason ? `, stopReason: ${final.stopReason}` : ''}]`;
  const syncNote =
    mode === 'embedded'
      ? '' // headless 无审批，同步模式无「审批挂死」问题（实测：越界立即 fail closed）
      : `\n（同步模式无审批通知：任务若中途挂起审批，只能等超时自动拒绝或在 dsh Web UI 处理）`;
  return {
    content: [
      {
        type: 'text',
        text:
          `【${final?.tag ?? tag ?? '??'}】${head}${statusLine}${syncNote}` +
          `\n${modeLine}`,
      },
    ],
    details: {
      dsh: {
        opId,
        tag: final?.tag ?? tag,
        sessionId: final?.sessionId ?? sidParam,
        mode,
        status: final?.status ?? 'error',
        stopReason: final?.stopReason ?? null,
        conclusion: conclusion.slice(0, 4000),
        fullOutput: final?.fullOutput ?? null,
        checkpoints: final?.checkpoints ?? [],
        artifacts: final?.artifacts ?? [],
        usage: final?.usage ?? null,
        durationMs: final?.durationMs ?? null,
        wait: true,
        ...(final?.error ? { error: final.error } : {}),
      },
    },
  };
}

/**
 * 宿主调用约定（0.446.6 源码实证）：execute(input, ctx) 双参数。
 *  input = 工具参数对象（task/cwd/timeout/wait/sessionId 铺在这里）；
 *  ctx   = 会话上下文（sessionPath/bus/dataDir/config/log 在这里）。
 * 旧单参契约（DSHana 时代「参数铺在 ctx 上」）实际是因为第一个参数就是参数对象；
 * 但 sessionPath 只在第二参数里，单参签名会丢 sessionPath，导致 deferred 通知全废（0815 实测）。
 * 兼容：单参调用（dev 通道等）时把第一参同时当参数与会话上下文。
 * 防污染：宿主会把当前 Hana 会话 id 注入会话上下文，若混进合并对象会被误读为
 * 工具的 sessionId 参数（resume 错误会话，0815-验收实测 aborted 实锤）。
 * 处理：合并后删掉 sessionId，只有工具参数显式传的才恢复。cwd 保留注入（作为合理缺省）。
 */
export async function execute(input, ctx) {
  const params = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sessionCtx = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
  const merged = { ...sessionCtx, ...params };
  delete merged.sessionId; // 宿主注入的当前会话 id，不得污染工具的 sessionId 参数
  if (params.sessionId != null && params.sessionId !== '') merged.sessionId = params.sessionId;
  try {
    return await run(merged);
  } catch (e) {
    try {
      merged?.log?.error?.('[dsh-bridge] dsh_run failed:', e?.stack || e?.message || String(e));
    } catch {
      // 日志失败静默
    }
    throw e;
  }
}

/** 清理单例连接（导出契约）：embedded 模式回收 dsh web host 子进程；与 index.js 注册的清理等价（幂等） */
export function closeProcess() {
  const s = globalThis.__dshBridge;
  const conn = s?.connection;
  if (conn && typeof conn.dispose === 'function') {
    return Promise.resolve(conn.dispose()).catch(() => {});
  }
}
