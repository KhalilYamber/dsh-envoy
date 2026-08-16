// dsh-status.js —— 查进度工具（dsh_status，只读）
// 协议细节以 DSH 官方实现与实测行为为准（DSH 0.1.0-rc.6）。
// 返回：连接模式与健康（external 探测 / embedded headless 任务进程状态）、运行中任务、
//       近期任务台账（globalThis.__dshBridge.ops，含审批历史）、挂起审批列表（用 dsh_approve 应答；内置模式恒无）、
//       DSH 侧对账（P0-1：external 健康时列活动会话，找出「不在本地台账」的会话，只呈现事实不自动接管）。
// 外接模式传 sessionId 时尝试从 DSH 查该会话状态（client.listSessions）。
// 只读原则：不建立连接、不拉起任何服务；连接与 runner 不可用时给提示。

import fs from 'node:fs';
import path from 'node:path';
import { DshClient } from '../lib/client.js';
import { SessionRoutes } from '../lib/session-routes.js';

export const name = 'dsh_status';

export const description =
  '查 dsh 连接状态与任务台账（只读，无副作用）：连接模式与健康（外接服务探测 / 内置 headless 任务进程状态）、运行中任务、' +
  '近期任务台账（最近 50 条，含每条任务的审批历史）、挂起审批列表（approvalId/toolName/args 摘要/理由，用 dsh_approve 应答；内置 headless 模式恒无审批）、' +
  'DSH 侧对账（外接健康时自动列出「DSH 侧活动会话但不在本地台账」的情况，宿主重启后对账用）。' +
  '外接模式传 sessionId 可查询该 dsh 会话是否在当前账本。';

export const parameters = {
  type: 'object',
  properties: {
    sessionId: {
      type: 'string',
      description:
        '可选（仅外接模式有意义）：查询指定 dsh 会话是否在当前账本（存在/不存在，尽力返回 cwd 等摘要）。内置 headless 模式无会话句柄',
    },
  },
  required: [],
};

export const sessionPermission = { readOnly: true };

/** 进程内单例兜底（与 dsh-run.js 同构；Hana 按需加载 tools，工具可能先于 onload 被调用） */
function singleton(ctx) {
  const g = globalThis;
  if (!g.__dshBridge || typeof g.__dshBridge !== 'object') g.__dshBridge = {};
  const s = g.__dshBridge;
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

/** 审批 args 摘要：对象/数组转 JSON，超过 300 字符截断（供 Agent 决策） */
function summarizeArgs(args) {
  if (args == null) return null;
  let s;
  try {
    s = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

/** 尽力抽取会话摘要字段（schema 未知，取常见键；全空时给 JSON 截断兜底） */
function pickSessionFields(raw) {
  if (!raw || typeof raw !== 'object') return { raw: String(raw).slice(0, 300) };
  const out = {};
  for (const k of [
    'sessionId',
    'id',
    'cwd',
    'title',
    'workspaceId',
    'updatedAt',
    'createdAt',
    'status',
    'model',
  ]) {
    if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  }
  if (Object.keys(out).length === 0) {
    try {
      out.raw = JSON.stringify(raw).slice(0, 300);
    } catch {
      out.raw = String(raw).slice(0, 300);
    }
  }
  return out;
}

async function status(ctx) {
  const s = singleton(ctx);
  const cfg = liveConfig(s);
  const mode = cfg.mode || 'auto';
  const sessionId = ctx?.sessionId != null ? String(ctx.sessionId).trim() : '';
  const runner = s.runner ?? null;
  const conn = s.connection ?? null;

  // ---- 1. 连接模式与健康 ----
  const effectiveMode = conn?.effectiveMode ?? null;
  let external = null;
  if (mode !== 'embedded') {
    // external 探测：轻量 GET /（3s 超时），只读，不起任何服务
    const port = Number(cfg.externalPort || cfg.webPort || 3080);
    const healthy = await new DshClient(`http://127.0.0.1:${port}`)
      .health()
      .then(() => true)
      .catch(() => false);
    external = { port, healthy };
  }
  let embedded = null;
  const headless = conn?.headless ?? null; // DshConnection 内部句柄，只读列任务进程状态
  if (headless) {
    const procs = [...(headless._runs ?? new Map()).values()];
    embedded = {
      ready: Boolean(headless._binPath),
      processes: procs.map((e) => ({
        opId: e.opKey ?? null,
        tag: e.tag ?? null,
        status: e.status,
        cwd: e.cwd ?? null,
        startedAt: e.startedAt ?? null,
        exitCode: e.exitCode ?? null,
        outputTail: String(e.output ?? '').slice(-300),
      })),
      running: procs.filter((e) => e.status === 'running').length,
    };
  }

  // ---- 2. 运行中任务（TaskRunner 运行台账，dsh_cancel 入口键即 opId/sessionId） ----
  const running = [];
  if (runner) {
    for (const c of (runner._runs ?? new Map()).values()) {
      running.push({
        opId: c.opKey ?? null,
        sessionId: c.sessionId ?? null,
        cancelled: Boolean(c.cancelled),
      });
    }
  }

  // ---- 3. 近期任务台账（dsh_run 维护的 ops Map，最新在前，最多 50 条） ----
  const ops = s.ops ? [...s.ops.values()].slice().reverse() : [];

  // ---- 4. 挂起审批列表（对齐协议实测 4.5 字段） ----
  const pendingApprovals = (runner?.pendingApprovals ?? []).map((p) => {
    let opId = null;
    if (p.sessionId) {
      for (const c of (runner._runs ?? new Map()).values()) {
        if (c.sessionId === p.sessionId) {
          opId = c.opKey ?? p.sessionId;
          break;
        }
      }
    }
    return {
      approvalId: p.approvalId,
      opId,
      toolName: p.toolName ?? null,
      reason: p.reason ?? null,
      argsPreview: summarizeArgs(p.args),
      status: p.status,
      outcome: p.outcome ?? null,
      at: p.at ?? null,
      auto: p.auto ?? null,
    };
  });

  // ---- 4.5 DSH 侧对账（P0-1）：external 健康时列活动会话，找「不在本地台账」的会话 ----
  // 只呈现事实（sessionId / 更新时间 / 状态），不猜测归属、不自动接管；DSH 无「列挂起审批」接口（实测）
  let reconcile = null;
  if (external?.healthy) {
    try {
      let client = null;
      try {
        client = conn?.client ?? null;
      } catch {
        client = null;
      }
      if (!client) client = new DshClient(`http://127.0.0.1:${external.port}`);
      const raw = await client.listSessions();
      const items = Array.isArray(raw) ? raw : (raw?.items ?? []);
      // 按 updatedAt 倒序取最近 10 个（schema：{items:[{sessionId, updatedAt, running, blank, cwd, …}]}）
      const sorted = items.slice().sort((a, b) => Number(b?.updatedAt ?? 0) - Number(a?.updatedAt ?? 0));
      const recent = sorted.slice(0, 10);
      const localSids = new Set(
        (s.ops ? [...s.ops.values()] : []).map((o) => o.sessionId).filter(Boolean)
      );
      const agoText = (ts) => {
        const n = Number(ts);
        if (!Number.isFinite(n) || n <= 0) return '更新时间未知';
        const ms = n < 1e12 ? n * 1000 : n; // 防御：秒/毫秒皆兼容
        const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
        return `更新于 ${mins} 分钟前`;
      };
      const unknown = [];
      for (const it of recent) {
        const sid = it?.sessionId ?? it?.id;
        if (!sid || localSids.has(sid)) continue;
        if (it?.running !== true) continue; // 仅活动会话；空闲会话不算「失联任务」
        let state = 'turn 运行中';
        try {
          // session.history：{events:[{event:{type,seq,time,data},view?}],hasMore}（client 侧 schema 实证）
          const events = await client.history(sid);
          let lastStart = -1;
          let lastEnd = -1;
          let lastReq = -1;
          let lastRes = -1;
          for (const item of events ?? []) {
            const ev = item?.event ?? item;
            const t = ev?.type;
            const seq = Number(ev?.seq ?? -1);
            if (t === 'turn/start') lastStart = Math.max(lastStart, seq);
            else if (t === 'turn/end') lastEnd = Math.max(lastEnd, seq);
            else if (t === 'approval/requested') lastReq = Math.max(lastReq, seq);
            else if (t === 'approval/resolved') lastRes = Math.max(lastRes, seq);
          }
          state = lastReq > lastRes ? '审批挂起' : lastStart > lastEnd ? 'turn 运行中' : '空闲';
        } catch {
          state = '（历史读取失败）';
        }
        unknown.push({
          sessionId: sid,
          updatedAt: it.updatedAt ?? null,
          updatedAgo: agoText(it.updatedAt),
          state,
        });
      }
      reconcile = { checked: recent.length, unknown };
    } catch (e) {
      reconcile = { checked: 0, unknown: [], error: e?.message ?? String(e) };
    }
  }

  // ---- 4.7 会话路由表（项目级会话延续：cwd → 活跃 sessionId） ----
  // 只读展示（含更新时间），方便用户观察和判断何时该开新会话（sessionPolicy=new）
  let routes = {};
  if (s.dataDir) {
    try {
      const routesStore = new SessionRoutes(s.dataDir);
      routesStore.load();
      routes = routesStore.all();
    } catch {
      routes = {}; // 读取失败静默（路由是增强机制）
    }
  }

  // ---- 5. 会话查询（外接模式传 sessionId 时尝试从 DSH 查该会话状态） ----
  let session = null;
  let sessionNote = null;
  if (sessionId) {
    if (effectiveMode === 'embedded') {
      sessionNote =
        '内置 headless 模式无会话句柄（每次任务独立会话），无法按 sessionId 查询；用 opId 看台账即可';
    } else {
      let client = null;
      try {
        client = conn?.client ?? null; // 未 ensure() 时 getter 会抛，转 null
      } catch {
        client = null;
      }
      if (!client && external?.healthy) {
        client = new DshClient(`http://127.0.0.1:${external.port}`); // 外接健康时直连查询
      }
      if (!client) {
        sessionNote = '当前无可用 DSH 连接（尚未派过单且无外部服务），无法查询会话；先调 dsh_run 派一单即可建立连接';
      } else {
        try {
          const raw = await client.listSessions();
          const items = Array.isArray(raw) ? raw : (raw?.items ?? raw?.sessions ?? []);
          const hit = items.find((it) => (it?.sessionId ?? it?.id) === sessionId);
          if (hit) {
            session = { found: true, ...pickSessionFields(hit) };
          } else {
            session = { found: false, sessionId };
            sessionNote = `会话 ${sessionId} 不存在于当前 DSH 账本（可能已归档或属于另一个 DSH 服务）`;
          }
        } catch (e) {
          sessionNote = `查询会话失败：${e?.message || e}`;
        }
      }
    }
  }

  // ---- 6. 组装文本（content 人话摘要 + details.dsh 结构化数据） ----
  const lines = [];
  lines.push(
    `连接模式：${mode}${effectiveMode ? `（当前生效：${effectiveMode}）` : '（连接尚未建立）'}`
  );
  if (external) {
    lines.push(`外部 DSH：http://127.0.0.1:${external.port} ${external.healthy ? '✅ 健康' : '❌ 不可达'}`);
  }
  if (embedded) {
    lines.push(
      `内置 headless：${embedded.running > 0 ? `${embedded.running} 个任务进程运行中` : '无运行中的任务进程'}` +
        `（无端口、无审批通道，越界操作自动拒绝${embedded.ready ? '' : '，依赖尚未就绪'}）`
    );
    for (const p of embedded.processes.slice(-5)) {
      lines.push(
        `· ${p.opId ?? '?'} ${p.status}${p.tag ? ` ${p.tag}` : ''}` +
          `${p.exitCode != null ? ` exit=${p.exitCode}` : ''}` +
          `${p.outputTail ? `｜${p.outputTail.replace(/\s+/g, ' ')}` : ''}`
      );
    }
  }
  if (!conn && !runner) {
    lines.push('提示：尚未派过单（dsh 连接与任务运行器未初始化），dsh_run 首次调用时会自动建立连接');
  }
  if (running.length) {
    lines.push(
      `运行中 ${running.length} 个：` +
        running
          .map(
            (r) =>
              `${r.opId ?? '?'}${r.sessionId ? `（会话 ${String(r.sessionId).slice(0, 12)}…）` : ''}` +
              `${r.cancelled ? '[已请求取消]' : ''}`
          )
          .join('；')
    );
  } else {
    lines.push('运行中：无');
  }
  if (pendingApprovals.length) {
    lines.push(
      `挂起审批 ${pendingApprovals.length} 个（用 dsh_approve 应答）：` +
        pendingApprovals
          .map(
            (p) =>
              `${p.approvalId} [${p.toolName ?? 'tool'}]` +
              `${p.reason ? `（${String(p.reason).slice(0, 80)}）` : ''}`
          )
          .join('；')
    );
  } else {
    lines.push('挂起审批：无');
  }
  if (reconcile?.unknown?.length) {
    lines.push(
      `⚠️ DSH 侧有 ${reconcile.unknown.length} 个活动会话不在本地台账（可能宿主重启过）：` +
        reconcile.unknown
          .map((u) => `${u.sessionId}（${u.updatedAgo ?? '更新时间未知'}，状态 ${u.state}）`)
          .join('；')
    );
    lines.push('如需接管请向用户说明并派新任务或 resume');
  }
  if (ops.length) {
    lines.push(`近期台账（${ops.length} 条，最新在前）：`);
    for (const o of ops.slice(0, 20)) {
      lines.push(
        `· ${o.opId} ${o.status} ${o.tag ?? ''} ` +
          `${o.durationMs != null ? `${(o.durationMs / 1000).toFixed(1)}s` : '-'} ` +
          `${String(o.task ?? '').slice(0, 40)}` +
          `${o.approvals?.length ? `（审批 ${o.approvals.length} 条）` : ''}`
      );
    }
  } else {
    lines.push('近期台账：空');
  }
  if (sessionId) {
    if (session?.found) {
      lines.push(
        `会话 ${sessionId}：存在` +
          `${session.cwd ? `（cwd: ${session.cwd}` : ''}` +
          `${session.title ? `，title: ${String(session.title).slice(0, 80)}` : ''}）`
      );
    } else if (sessionNote) {
      lines.push(sessionNote);
    }
  }
  const routeEntries = Object.entries(routes);
  if (routeEntries.length) {
    lines.push(`会话路由表（${routeEntries.length} 个工程，auto 模式自动延续）：`);
    for (const [cwd, v] of routeEntries) {
      const ago =
        v.updatedAt && Number.isFinite(Date.parse(v.updatedAt))
          ? `${Math.max(0, Math.round((Date.now() - Date.parse(v.updatedAt)) / 60000))} 分钟前更新`
          : '更新未知';
      lines.push(`· ${cwd} → ${String(v.sessionId).slice(0, 12)}…（${ago}）`);
    }
    lines.push('想开新会话：对 Agent 说「开新会话」即可（sessionPolicy=new，自动带交接摘要）');
  } else {
    lines.push('会话路由表：空（同工程任务将新建会话并自动登记）');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: {
      dsh: {
        mode,
        effectiveMode,
        external,
        embedded,
        running,
        ledger: ops.map((o) => ({
          opId: o.opId,
          tag: o.tag ?? null,
          status: o.status,
          sessionId: o.sessionId ?? null,
          startedAt: o.startedAt ?? null,
          endedAt: o.endedAt ?? null,
          durationMs: o.durationMs ?? null,
          stopReason: o.stopReason ?? null,
          usage: o.usage ?? null,
          mode: o.mode ?? null,
          wait: o.wait ?? null,
          task: String(o.task ?? '').slice(0, 80),
          error: o.error ?? null,
          approvals: Array.isArray(o.approvals) ? o.approvals : [], // P0-1：审批历史（含 rejected(auto)）
        })),
        pendingApprovals,
        reconcile, // P0-1：DSH 侧对账结果 {checked, unknown[]}
        session,
        sessionNote,
        routes, // 会话路由表（cwd → {sessionId, updatedAt}）
      },
    },
  };
}

/** 宿主调用约定：execute(input, ctx) 双参（0.446.6 实证）；合并兼容单参。
 *  防污染：宿主注入的当前会话 sessionId 不得污染工具的 sessionId 参数（0815 实测教训）。 */
export async function execute(input, ctx) {
  const params = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sessionCtx = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
  const merged = { ...sessionCtx, ...params };
  delete merged.sessionId;
  if (params.sessionId != null && params.sessionId !== '') merged.sessionId = params.sessionId;
  try {
    return await status(merged);
  } catch (e) {
    try {
      merged?.log?.error?.('[dsh-bridge] dsh_status failed:', e?.stack || e?.message || String(e));
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
