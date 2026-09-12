// task.js —— DSH 任务状态机（dsh_run 核心）
// 协议细节以 DSH 官方实现与实测行为为准（DSH 0.1.5-rc.2，2026-09-12 对活服务实测）。
//
// 两条通道，各管一件事：
//   ① 会话事件：Remote 流 session/follow —— 开场一帧 snapshot（含 records），其后 event / assistant-stream
//   ② 越界审批：Remote 流 $events 上的 waterfall 帧，应答走 POST /api/$events/result
// 旧的全局 /api/events.mux 在 0.1.5 已不存在，旧的 /api/respond 信封一并作废。
//
// 全链路：会话归属 → session.create → 开两条流 → session.prompt（任务书）
//         → turn/end 终态判定 → 审批挂起/应答 → 超时可暂停/恢复
//         → 外部取消 → 断流兜底 → 结构化终态回收
// 审批身份以 $events 的 eventId 为准（waterfall 帧不带 approvalId）；
// 归属按帧里的 agentId 判，它在 0.1.5 实测就是会话 id（2026-09-12 实单验证）。

import fs from 'node:fs';
import path from 'node:path';
import { manifestDefault } from './manifest-defaults.js';

// 默认值单一事实源（manifest.json 的 contributes.configuration.properties[].default）：
// 改默认值只改 manifest.json 一处；此处兜底仅防 manifest 缺失/损坏（降级链最后一环）。
const DEFAULT_TIMEOUT_MS = (() => {
  const v = Number(manifestDefault('defaultTimeoutMs'));
  return Number.isFinite(v) && v > 0 ? v : 600000;
})();
const DEFAULT_APPROVAL_TIMEOUT_MS = (() => {
  const v = Number(manifestDefault('approvalTimeoutMs'));
  return Number.isFinite(v) && v > 0 ? v : 180000;
})();
const FULL_OUTPUT_TAIL = 8000;               // fullOutput 截断保留最后 8000 字符（任务书流程 7）
const SUMMARY_FOLD_LIMIT = 2100;             // conclusion 折叠阈值（协议实测 3.2）
const SUMMARY_HEAD = 1500;                   // 折叠时头部长度（协议实测 3.2）
const SUMMARY_TAIL = 600;                    // 折叠时尾部长度（协议实测 3.2）

/**
 * 会话事件流（session/follow）：开场一帧 snapshot（含 records / cursor / hasMore），
 * 之后逐条给 {type:'event', event}（持久事件）与 {type:'assistant-stream', frame}（流式增量）。
 * 0.1.2+ 起事件面由全局 events.mux 改为按会话订阅，这里如实照搬。
 */
async function* sessionFeed(client, sessionId, signal) {
  yield* client.stream(
    'session/follow',
    { request: { address: { kind: 'session', sessionId }, assistantStream: true } },
    { signal },
  );
}

/**
 * 审批事件流（$events）：首帧 ready 带 clientId，waterfall 帧即待答请求。
 * waterfall 的 request 形如 { toolName, callId?, reason? }，不带 approvalId，
 * 所以桥这边以 eventId 作为审批身份。
 */
async function* approvalFeed(client, signal) {
  yield* client.stream('$events', {}, { signal });
}

/** 从 assistant-stream 的 chunk 里取可见文本增量（形状与旧 data.chunk 同源） */
function textDeltaOf(chunk) {
  if (!chunk || typeof chunk !== 'object') return '';
  if (chunk.type !== 'text-delta') return '';
  const t = chunk.text ?? (chunk.delta && chunk.delta.text) ?? '';
  return typeof t === 'string' ? t : '';
}

/** 从 assistant-stream 的 chunk 里取 usage（若有） */
function usageOfChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return null;
  return chunk.usage && typeof chunk.usage === "object" ? chunk.usage : null;
}

/** turn/end 终态判定（协议实测 3.1 原文分支） */
function judgeTurnEnd(ev) {
  const reason = ev.reason ?? (ev.data && ev.data.reason) ?? {};
  const kind = reason.kind;
  if (kind === 'completed') return { stopReason: 'end_turn' };
  if (kind === 'max-tokens') return { stopReason: 'max_tokens' };
  if (kind === 'aborted') return { stopReason: 'aborted' };
  if (reason.failure) return { stopReason: 'error', failure: reason.failure };
  return { stopReason: kind || 'end_turn' };
}

/** 工具调用参数缓存（协议实测 4.1 的 b Map / $()），键含 opId 与 callId，供审批 args 反查 */
function cacheToolCall(ctx, ev) {
  const callId = ev.callId ?? (ev.data && ev.data.callId);
  if (typeof callId !== 'string' || !callId) return;
  const name = ev.name ?? ev.toolName ?? (ev.data && (ev.data.name ?? ev.data.toolName));
  const args =
    ev.args ?? ev.arguments ?? (ev.data && (ev.data.args ?? ev.data.arguments)) ?? null;
  ctx.calls.set(`${ctx.opKey}::${callId}`, { name: name ?? 'tool', args });
}

/** conclusion 摘要三态（协议实测 3.2 的 t() 原文语义） */
function buildConclusion(finalMessage, full) {
  const a = String(finalMessage ?? '').trim();
  if (a) return a; // 有最后一条 assistant 消息 → final-message，直接用
  const t = String(full ?? '');
  if (t.length > SUMMARY_FOLD_LIMIT) {
    const mid = t.length - SUMMARY_HEAD - SUMMARY_TAIL;
    return `${t.slice(0, SUMMARY_HEAD)}\n…[中间过程 ${mid} 字符已折叠，完整输出见 fullOutput]…\n${t.slice(-SUMMARY_TAIL)}`;
  }
  return t;
}

/** 尽力解析验收检查点条目（任务书流程 7；解析不到返回空数组）。
 *  启发式：行首复选框 / 对勾标记，或含「检查点/验收/checkpoint」的短行。
 *  导出供 sdk-leg.js 复用（终态对象同构）。 */
export function parseCheckpoints(text) {
  const out = [];
  if (!text) return out;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const marked =
      /^(?:[-*•]\s*)?\[[ xX]\]/.test(line) ||
      /^[✅☑✔✓]/.test(line) ||
      (/(?:检查点|验收|checkpoint)/i.test(line) && line.length <= 120);
    if (!marked) continue;
    const clean = line
      .replace(/^(?:[-*•]\s*)?\[[ xX]\]\s*/, '')
      .replace(/^[✅☑✔✓]\s*/, '')
      .trim();
    if (clean && !out.includes(clean)) out.push(clean.length > 200 ? clean.slice(0, 200) : clean);
    if (out.length >= 20) break;
  }
  return out;
}

/** 尽力解析产物路径（任务书流程 7；解析不到返回空数组）。
 *  启发式：匹配形似带扩展名的文件路径（盘符 / UNC / 绝对 / . 与 .. 相对路径）。
 *  导出供 sdk-leg.js 复用（终态对象同构）。 */
export function parseArtifacts(text) {
  const out = [];
  if (!text) return out;
  const re = /(?:[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\s"'<>|]+|(?:\/|\.\.?[\\/])[^\s"'<>|]+)/g;
  for (const m of String(text).matchAll(re)) {
    const p = m[0].replace(/[),.;:\]]+$/, '');
    if (!/\.[A-Za-z0-9]{1,8}$/.test(p)) continue; // 只保留形似带扩展名的文件
    if (!out.includes(p)) out.push(p);
    if (out.length >= 50) break;
  }
  return out;
}

/** usage 归一化（协议实测 3.3 字段）：inputTokens/outputTokens/cacheReadTokens/reasoningTokens
 *  → { input, output, cache, thinking }；四者皆非数字时返回 null */
function normalizeUsage(raw) {
  const src = raw?.usage && typeof raw.usage === 'object' ? raw.usage : raw;
  if (!src || typeof src !== 'object') return null;
  const input = src.inputTokens;
  const output = src.outputTokens;
  const cache = src.cacheReadTokens;
  const thinking = src.reasoningTokens;
  const anyNum = [input, output, cache, thinking].some(
    (v) => typeof v === 'number' && Number.isFinite(v)
  );
  if (!anyNum) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { input: num(input), output: num(output), cache: num(cache), thinking: num(thinking) };
}

export class TaskRunner {
  /**
   * @param {object} opts
   * @param {DshClient} opts.client            DshClient 实例
   * @param {LabelStore} [opts.labels]         标签计数器（run 未传 tag 时取号）
   * @param {number} [opts.defaultTimeoutMs]   默认执行超时
   * @param {number} [opts.approvalTimeoutMs]  审批无人应答自动拒绝超时（兜底值；每审批直读 config.json）
   * @param {string} [opts.dataDir]            插件数据目录（直读 config.json 用，协议实测 4.4/6.2 模式）
   * @param {function} [opts.logger]           日志函数或 {info/warn/error} 对象
   * @param {function} [opts.onApproval]       审批挂起回调（传入完整审批对象含 rpcId）
   * @param {Map} [opts.opLog]                 任务记录 ops Map（P0-1：审批历史写入所属 op 条目 approvals[]）
   * @param {string} [opts.mode]               'external' | 'embedded'；external 时优先归入「协助Hana」工作区
   */
  constructor({
    client,
    labels,
    defaultTimeoutMs,
    approvalTimeoutMs,
    dataDir,
    logger,
    onApproval,
    opLog,
    mode,
  } = {}) {
    this.client = client;
    this.labels = labels || null;
    this.defaultTimeoutMs =
      Number(defaultTimeoutMs) > 0 ? Number(defaultTimeoutMs) : DEFAULT_TIMEOUT_MS;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.dataDir = dataDir || null;
    this.logger = logger || (() => {});
    this.onApproval = onApproval || null;
    this.opLog = opLog || null; // 审批历史落点（dsh_run 的 ops Map；为 null 时不记录）
    this.mode = mode || 'embedded'; // 连接层应传 connection.effectiveMode
    this._runs = new Map(); // opKey -> 运行上下文（对齐协议实测的 ops Map，仅内存，不落盘）
  }

  /** 所有运行中任务的挂起审批（供 dsh_status / dsh_approve 工具层读取；只含 status=pending 的，已解决/已应答的不在此列） */
  get pendingApprovals() {
    const all = [];
    for (const ctx of this._runs.values()) {
      for (const p of ctx.pending) {
        if (p.status === 'pending') all.push(p);
      }
    }
    return all;
  }

  /**
   * 运行一次任务，返回结构化终态对象（任务书流程 7）。
   * @param {object} opts
   * @param {string} opts.task             任务书文本
   * @param {string} [opts.cwd]            沙箱工作目录（embedded / external 无匹配工作区时建会话用）
   * @param {string} [opts.tag]            工作标签【MMdd-NN】；缺省用 labels.next()
   * @param {string} [opts.sessionId]      resume：复用已有会话（传 sessionId 不传 cwd）
   * @param {string} [opts.agentPreset]    预设 id：新建会话时经 session.create 透传（resume 时不传）
   * @param {number} [opts.timeoutMs]      本次执行超时（覆盖默认值）
   * @param {AbortSignal} [opts.signal]    外部取消信号（宿主中断）
   * @param {function} [opts.onProgress]   输出流式回调 onProgress({ sessionId, tag, output })
   * @param {string} [opts.opId]           任务记录键（工具层 dsh_cancel 入口键），缺省用 sessionId
   */
  async run({ task, cwd, tag, sessionId, agentPreset, timeoutMs, signal, onProgress, opId } = {}) {
    const startedAt = Date.now();
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.defaultTimeoutMs;
    if (!tag) {
      try {
        tag = this.labels ? this.labels.next() : '';
      } catch {
        tag = ''; // 取号失败不阻塞任务
      }
    }

    // ---- 运行上下文（每 run 独立，支持并发任务；对齐协议实测 ops Map 元素）----
    const ctx = {
      opKey: opId ?? null,      // 缓存/计时器键前缀（协议实测 4.1/4.4 的 ${opId}::）
      sessionId: sessionId ?? null,
      cancelled: false,         // 协议实测 5.2 的 op.cancelledRequested
      controller: new AbortController(),
      pending: [],              // pendingApprovals（协议实测 4.5）
      timers: new Map(),        // approvalTimers：key=`${opKey}::${approvalId}`（协议实测 4.4 的 w）
      calls: new Map(),         // toolCallCache：key=`${opKey}::${callId}`（协议实测 4.1 的 b）
      pauseTimeout: null,       // U()
      resumeTimeout: null,      // B()
    };

    // ---- 执行超时状态机（协议实测 5.1 的 F/J/L/q + U()/B() 原文）----
    let remaining = timeout;
    let timer = null;
    let timerStart = null;
    let timeoutReject = null;
    const timeoutError = () =>
      Object.assign(new Error(`dsh_run 超时（${Math.round(timeout / 1000)}s）`), {
        code: 'DSH_TIMEOUT',
      });
    const timeoutPromise = new Promise((_, reject) => {
      timeoutReject = reject;
    });
    timeoutPromise.catch(() => {}); // 防未处理拒绝：竞速未建立就出错时，超时 reject 会无人接
    ctx.pauseTimeout = () => {
      // U()：暂停（审批挂起时调用），剩余时间扣掉已走时长
      if (timer) {
        remaining -= Date.now() - timerStart;
        clearTimeout(timer);
        timer = null;
      }
    };
    ctx.resumeTimeout = () => {
      // B()：启动/恢复；剩余时间不足立即 reject（协议实测 5.1：F<=0 立即 q(...)）
      if (timer) return;
      if (remaining <= 0) {
        timeoutReject(timeoutError());
        return;
      }
      timerStart = Date.now();
      timer = setTimeout(() => {
        timeoutReject(timeoutError());
      }, remaining);
    };

    // ---- 外部取消（协议实测 5.3 的 z promise + abort 联动）----
    const abortError = () => Object.assign(new Error('dsh_run 已取消'), { code: 'DSH_ABORTED' });
    let abortReject = null;
    const abortPromise = new Promise((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {}); // 防未处理拒绝：竞速未建立就出错时，abort() 的 reject 会无人接
    const onAbort = () => {
      ctx.cancelled = true;
      abortReject(abortError());
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    ctx.controller.signal.addEventListener('abort', onAbort, { once: true });

    // ---- 输出累积（协议实测 3.2 的 T/A/R/M/D）----
    let sid = null;       // 本次会话 id
    let T = '';           // chunk 累积全文
    let A = '';           // 最后一条 assistant 消息文本
    let sawChunk = false; // 是否见过 chunk（协议实测 3.2 的 R）
    let D = null;         // usage 原始收集（协议实测 3.2 的 D）
    const seenMsgIds = new Set(); // assistant/message 按 id 去重（协议实测 3.2 的 M）
    let terminal = null;  // { stopReason, failure? }

    const fireProgress = () => {
      if (typeof onProgress !== 'function') return;
      Promise.resolve(onProgress({ sessionId: sid, tag, output: T })).catch((e) => {
        this._log('warn', `[dsh-bridge] onProgress 回调失败：${e?.message || e}`);
      });
    };

    // ---- 单条会话事件的归并（snapshot 里的历史与流里的实时事件走同一条路）----
    // 返回 true 表示已判定终态，调用方应立即收束。
    const onSessionEvent = (ev) => {
      if (!ev || typeof ev.type !== 'string') return false;
      if (ev.type === 'assistant/message') {
        const msg = ev.message ?? (ev.data && ev.data.message);
        if (msg && typeof msg.id === 'string' && !seenMsgIds.has(msg.id)) {
          seenMsgIds.add(msg.id);
          const text = Array.isArray(msg.content)
            ? msg.content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
            : '';
          if (!sawChunk && text) { T += text; fireProgress(); }
          if (text) A = text;
        }
        const usage = ev.usage ?? (ev.data && ev.data.usage) ?? (msg && msg.usage);
        if (usage && typeof usage === 'object') D = { ...(D ?? {}), ...usage };
        return false;
      }
      if (ev.type === 'turn/end') {
        terminal = judgeTurnEnd(ev);
        return true;
      }
      if (ev.type === 'tool/call' || ev.type === 'tool/code-dispatch-start' || ev.type === 'tool/result') {
        cacheToolCall(ctx, ev);
        return false;
      }
      return false;
    };

    // ---- 会话事件消费（0.1.5：session/follow 的 snapshot.records + 后续 event / assistant-stream）----
    const consume = async () => {
      for await (const frame of sessionFeed(this.client, sid, ctx.controller.signal)) {
        if (!frame || typeof frame.type !== 'string') continue;
        if (frame.type === 'snapshot') {
          for (const rec of frame.records ?? []) {
            if (rec && rec.type === 'event' && onSessionEvent(rec.event)) return terminal;
          }
          continue;
        }
        if (frame.type === 'event') {
          if (onSessionEvent(frame.event)) return terminal;
          continue;
        }
        if (frame.type === 'assistant-stream') {
          const f = frame.frame ?? {};
          if (f.type === 'chunk') {
            const delta = textDeltaOf(f.chunk);
            if (delta) { sawChunk = true; T += delta; fireProgress(); }
            const u = usageOfChunk(f.chunk);
            if (u) D = { ...(D ?? {}), ...u };
          }
          continue;
        }
      }
      // 断流无终态兜底：已请求取消则 aborted，否则按正常完成
      if (!terminal) {
        terminal = ctx.cancelled ? { stopReason: 'aborted' } : { stopReason: 'end_turn' };
      }
      return terminal;
    };

    try {
      if (signal?.aborted) throw abortError();

      // 1. 会话归属与建立（任务书流程 1/2）：
      //    external 优先归入「协助Hana」工作区；找不到或 bundled 用 cwd；resume 传 sessionId 不传 cwd
      //    agentPreset 仅新建会话时透传（resume 延续已有会话的预设）
      sid = await this._ensureSession({ sessionId, cwd, agentPreset });
      ctx.sessionId = sid;
      if (!ctx.opKey) ctx.opKey = sid;
      this._runs.set(ctx.opKey, ctx);

      // 2. 提交任务书（任务书流程 3；协议实测 5.1：mode queue，content 文本形如【标签】任务书）
      const promptText = tag ? `【${tag}】${task}` : String(task ?? '');
      await this.client.prompt(sid, promptText, { mode: 'queue' });

      // 3. prompt 成功后启动执行超时（协议实测 5.1 时序：prompt → B() → race）
      ctx.resumeTimeout();

      // 4. 竞速：会话事件消费 vs 执行超时 vs 外部取消；审批流独立跑，不参与竞速
      ctx.approvalPump = this._pumpApprovals(ctx, ctx.controller.signal).catch((e) => {
        this._log('warn', `[dsh-bridge] 审批流异常（不影响任务本体）：${e?.message || e}`);
      });
      terminal = await Promise.race([consume(), timeoutPromise, abortPromise]);
      if (timer) clearTimeout(timer);
    } catch (e) {
      // 5. 善后：统一 best-effort session.cancel（协议实测 5.3）；abort 关断事件流
      try {
        ctx.controller.abort();
      } catch {
        // 幂等
      }
      if (e?.code === 'DSH_TIMEOUT' || e?.code === 'DSH_ABORTED') {
        if (sid) {
          try {
            await this.client.cancel(sid);
          } catch {
            // 尽力而为（协议实测 5.3：catch{}）
          }
        }
        terminal = { stopReason: e.code === 'DSH_TIMEOUT' ? 'timeout' : 'aborted' };
      } else {
        terminal = { stopReason: 'error', failure: { message: e?.message ?? String(e) } };
      }
    } finally {
      // 6. 清理：收两条流、清审批计时器、移除运行记录、解绑外部 signal
      try {
        ctx.controller.abort();
      } catch {
        // 幂等
      }
      for (const t of ctx.timers.values()) clearTimeout(t);
      ctx.timers.clear();
      if (ctx.opKey) this._runs.delete(ctx.opKey);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    // 7. 结构化终态对象（任务书流程 7 + 协议实测 3.2 摘要三态）
    const stopReason = terminal?.stopReason ?? 'end_turn';
    const conclusion = buildConclusion(A, T);
    const fullOutput = T.slice(-FULL_OUTPUT_TAIL);
    const usage = normalizeUsage(D);
    let ok;
    let status;
    if (stopReason === 'end_turn' || stopReason === 'max_tokens') {
      ok = true;
      status = 'completed';
    } else if (stopReason === 'aborted') {
      ok = false;
      status = 'aborted';
    } else {
      ok = false;
      status = 'error';
    }

    return {
      ok,
      status,
      stopReason,
      conclusion,
      fullOutput,
      checkpoints: parseCheckpoints(conclusion),
      artifacts: parseArtifacts(T || conclusion),
      usage,
      durationMs: Date.now() - startedAt,
      sessionId: sid ?? sessionId ?? null,
      tag: tag || null,
      ...(terminal?.failure?.message ? { error: String(terminal.failure.message) } : {}),
    };
  }

  /** 会话归属与建立（任务书流程 1/2） */
  async _ensureSession({ sessionId, cwd, agentPreset }) {
    if (sessionId) {
      // resume：传 sessionId，不传 cwd/workspaceId（任务书流程 2）
      // 实测（0816）：DSH 对已存在会话做 createSession 时校验 cwd，
      // 不传 cwd 会用默认工作区（如 D:\DeepSeek-Harness）→ 冲突。
      // 0.1.5 起错误码改斜杠形式（session/conflict），兼容旧的连字符写法。
      // 修复：冲突时从错误 details.existingCwd 提取会话真实 cwd，带 cwd 重试一次。
      try {
        const res = await this.client.createSession({ sessionId });
        return this._sessionIdFrom(res, sessionId);
      } catch (e) {
        if ((e?.code === 'session/conflict' || e?.code === 'session-conflict') && e?.details?.existingCwd) {
          const res2 = await this.client.createSession({ sessionId, cwd: e.details.existingCwd });
          return this._sessionIdFrom(res2, sessionId);
        }
        throw e;
      }
    }
    let payload = {};
    if (agentPreset) payload.agentPreset = agentPreset; // 预设传递不复制：只传 id（薄桥设计原则）
    if (this.mode === 'external') {
      // external 优先归入「协助Hana」工作区：listWorkspaces 找 title 匹配则用其 workspaceId；
      // 找不到不乱建工作区，回退 cwd 建会话（任务书流程 1 / design.md 验收 1）
      try {
        const raw = await this.client.listWorkspaces();
        const list = Array.isArray(raw) ? raw : (raw?.workspaces ?? []);
        const hit = list.find((w) => {
          const title = w?.title ?? w?.name ?? '';
          return typeof title === 'string' && title.includes('协助Hana');
        });
        const wid = hit && (hit.workspaceId ?? hit.id);
        if (wid) payload = { workspaceId: wid };
      } catch (e) {
        this._log('warn', `[dsh-bridge] 列工作区失败，回退 cwd 建会话：${e?.message || e}`);
      }
    }
    if (!payload.workspaceId && cwd) payload = { cwd };
    const res = await this.client.createSession(payload);
    return this._sessionIdFrom(res, null);
  }

  /** session.create 响应尽力取 sessionId */
  _sessionIdFrom(res, fallback) {
    if (typeof res === 'string' && res) return res;
    const sid = res?.sessionId ?? res?.id ?? fallback;
    if (typeof sid !== 'string' || !sid) {
      throw new Error('session.create 未返回 sessionId');
    }
    return sid;
  }

  /** args 摘要（P0-1）：对象/数组转 JSON，超过 300 字符截断（供任务记录审批历史） */
  _summarizeArgs(args) {
    if (args == null) return null;
    let s;
    try {
      s = typeof args === 'string' ? args : JSON.stringify(args);
    } catch {
      s = String(args);
    }
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  }

  /** 审批历史写任务记录（P0-1）：按 approvalId 定位所属 op 条目的 approvals[]，patch 或 push（上限 20 条/op）。
   *  任务结束后保留在任务记录条目里；opLog 为 null（未挂任务记录）时静默。 */
  _recordApproval(ctx, rec) {
    const log = this.opLog;
    if (!log || !ctx?.opKey) return;
    try {
      const entry = log.get(ctx.opKey);
      if (!entry) return;
      if (!Array.isArray(entry.approvals)) entry.approvals = [];
      const i = entry.approvals.findIndex((a) => a.approvalId === rec.approvalId);
      if (i >= 0) entry.approvals[i] = { ...entry.approvals[i], ...rec };
      else {
        entry.approvals.push(rec);
        if (entry.approvals.length > 20) entry.approvals.shift();
      }
    } catch {
      // 任务记录写入失败静默（不影响审批主流程）
    }
  }

  /** 审批流泵：接 waterfall 帧，转成挂起审批并通知宿主；流断由调用方记日志，不抛进任务本体 */
  async _pumpApprovals(ctx, signal) {
    for await (const frame of approvalFeed(this.client, signal)) {
      if (!frame || typeof frame.type !== 'string') continue;
      if (frame.type === 'ready') {
        ctx.eventClientId = frame.clientId ?? null; // 应答时要带回的事件流身份
        continue;
      }
      if (frame.type === 'waterfall') {
        // waterfall 按 Agent 作用域投递。agentId 是不透明的 Agent 标识，
        // 实测（2026-09-12 实单）它等于会话 id，所以这里直接按会话 id 过滤：
        // 只接本会话的审批，避免误抓用户在 DSH 界面里其他会话的审批。
        if (ctx.sessionId && frame.agentId && frame.agentId !== ctx.sessionId) {
          this._log('warn', `[dsh-bridge] 跳过不属于本会话的审批（agentId=${frame.agentId}）`);
          continue;
        }
        this._onApprovalRequested(ctx, frame);
        continue;
      }
      // emit / cancel：本桥不消费
    }
  }

  /** 审批收尾（用户应答与超时自动拒绝共用）：清计时器、置状态、落任务记录、无挂起则恢复执行超时 */
  _settleApproval(ctx, pending, outcome, { auto = null, answered = true } = {}) {
    const key = `${ctx.opKey}::${pending.approvalId}`;
    const t = ctx.timers.get(key);
    if (t) {
      clearTimeout(t);
      ctx.timers.delete(key);
    }
    pending.status = answered ? 'answered' : 'resolved';
    pending.outcome = outcome;
    pending.answeredAt = new Date().toISOString();
    if (auto) pending.auto = auto;
    this._recordApproval(ctx, {
      approvalId: pending.approvalId,
      status: pending.status,
      outcome: auto ? `${outcome}(auto)` : outcome,
      answeredAt: pending.answeredAt,
      auto,
    });
    if (!ctx.pending.some((p) => p.status === 'pending')) ctx.resumeTimeout();
  }

  /** 审批挂起（0.1.5 的 waterfall 帧）：去重入列 → onApproval 通知 → 暂停执行超时 → 审批超时计时器 */
  _onApprovalRequested(ctx, frame) {
    const eventId = typeof frame.eventId === 'string' ? frame.eventId : null;
    if (!eventId) return;
    if (ctx.pending.some((p) => p.approvalId === eventId)) return; // 去重
    const req = frame.request ?? {};

    // args 反查：toolCallCache key=`${opKey}::${callId}`；miss 时剥 :code:N 后缀回退 run_code 根调用
    let cached = null;
    if (typeof req.callId === 'string' && req.callId) {
      cached = ctx.calls.get(`${ctx.opKey}::${req.callId}`) ?? null;
      if (!cached) {
        const rootCallId = req.callId.replace(/:\w+:\d+$/, '');
        if (rootCallId !== req.callId) {
          const root = ctx.calls.get(`${ctx.opKey}::${rootCallId}`);
          if (root && root.name === 'run_code') {
            cached = { name: 'run_code(code-dispatch)', args: root.args };
          }
        }
      }
    }

    const pending = {
      approvalId: eventId,   // 审批身份 = waterfall 的 eventId（帧里没有 approvalId）
      eventId,
      clientId: ctx.eventClientId ?? null,
      agentId: frame.agentId ?? null,
      sessionId: ctx.sessionId,
      toolName: req.toolName ?? null,
      callId: req.callId ?? null,
      reason: req.reason ?? null,
      args: cached?.args ?? null,
      at: new Date().toISOString(),
      status: 'pending',
    };
    ctx.pending.push(pending);

    // 任务记录审批历史：挂起即记，任务结束后可查
    this._recordApproval(ctx, {
      approvalId: pending.approvalId,
      toolName: pending.toolName,
      reason: pending.reason,
      argsPreview: this._summarizeArgs(pending.args),
      at: pending.at,
      status: 'pending',
      outcome: null,
      answeredAt: null,
      auto: null,
    });

    // 通知宿主（onApproval 回调，不阻塞主循环）
    if (typeof this.onApproval === 'function') {
      Promise.resolve()
        .then(() => this.onApproval({ ...pending }))
        .catch((e) => {
          this._log('warn', `[dsh-bridge] onApproval 回调失败：${e?.message || e}`);
        });
    }
    // 审批等待不计入执行超时：先暂停
    ctx.pauseTimeout();
    this._armApprovalTimer(ctx, pending);
  }

  /** 审批超时计时器（协议实测 4.4）：approvalTimeoutMs 到期自动应答 rejected，标记 auto:expired，失败静默 */
  _armApprovalTimer(ctx, pending) {
    const ms = this._approvalTimeoutMs();
    if (!(ms > 0)) return; // 0 禁用（协议实测 4.4）
    const key = `${ctx.opKey}::${pending.approvalId}`;
    const timer = setTimeout(() => {
      ctx.timers.delete(key);
      if (pending.status !== 'pending') return;
      this._respond(pending, 'rejected')
        .then(() => {
          if (pending.status === 'pending') {
            this._settleApproval(ctx, pending, 'rejected', { auto: 'expired' });
          }
        })
        .catch(() => {
          // 失败静默：dsh 侧会自行感知（协议实测 4.4 的 .catch(()=>{})）
        });
    }, ms);
    ctx.timers.set(key, timer);
  }

  /** 审批超时取值（协议实测 4.4）：直读 dataDir/config.json 的 global.approvalTimeoutMs 优先，
   *  数字且有限时 >0 启用、0 禁用；落空用构造兜底值（默认 30s） */
  _approvalTimeoutMs() {
    if (this.dataDir) {
      try {
        const file = path.join(this.dataDir, 'config.json');
        if (fs.existsSync(file)) {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          const v = parsed?.global?.approvalTimeoutMs;
          if (typeof v === 'number' && Number.isFinite(v)) return v > 0 ? v : 0;
        }
      } catch {
        // 静默，用兜底值
      }
    }
    const v = Number(this.approvalTimeoutMs);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /** 审批应答：POST /api/$events/result（0.1.2+ 的 Remote 事件回执；旧 /api/respond 已作废） */
  async _respond(pending, outcome) {
    const clientId = pending.clientId;
    if (!clientId) {
      throw new Error('审批缺少事件流身份（clientId）：事件流可能已重连，本次无法应答');
    }
    await this.client.answerRemoteEvent({
      clientId,
      eventId: pending.eventId ?? pending.approvalId,
      outcome: {
        kind: 'result',
        value: outcome === 'rejected' ? 'rejected' : 'allowed-once',
      },
    });
    return true;
  }

  /** dsh_approve 工具入口：应答挂起审批（对齐协议实测 4.3 的校验链） */
  async respondApproval(approvalId, outcome = 'allowed-once') {
    const id = String(approvalId ?? '').trim();
    if (!id) throw new Error('approvalId 必填');
    const finalOutcome = outcome === 'rejected' ? 'rejected' : 'allowed-once';
    const entry = this._findApproval(id);
    if (!entry) {
      throw new Error(`审批 ${id} 不存在或已过期（只可应答本会话近期提交的 dsh 任务审批）`);
    }
    if (entry.pending.status !== 'pending') {
      const done =
        entry.pending.status === 'answered'
          ? `应答（${entry.pending.outcome}）`
          : entry.pending.status;
      throw new Error(`审批 ${id} 已${done}，勿重复应答`);
    }
    const ok = await this._respond(entry.pending, finalOutcome);
    // 用户应答立即落账（不等任何后续信号）
    this._settleApproval(entry.ctx, entry.pending, finalOutcome, { auto: null });
    return ok;
  }

  _findApproval(approvalId) {
    for (const ctx of this._runs.values()) {
      const pending = ctx.pending.find((p) => p.approvalId === approvalId);
      if (pending) return { ctx, pending };
    }
    return null;
  }

  /** dsh_cancel 工具入口：请求取消运行中的任务（协议实测 5.2 的 cancelledRequested + abort 联动）。
   *  幂等；无匹配运行任务时返回 false。 */
  cancelRequested(sessionIdOrOpId) {
    let ctx = null;
    if (sessionIdOrOpId != null) {
      const key = String(sessionIdOrOpId);
      ctx =
        this._runs.get(key) ??
        [...this._runs.values()].find((c) => c.sessionId === key) ??
        null;
    } else if (this._runs.size === 1) {
      ctx = [...this._runs.values()][0];
    }
    if (!ctx) return false;
    ctx.cancelled = true;
    try {
      ctx.controller.abort();
    } catch {
      // 幂等
    }
    return true;
  }

  _log(level, msg) {
    try {
      if (typeof this.logger === 'function') this.logger(msg);
      else if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg);
    } catch {
      // 日志失败静默
    }
  }
}
