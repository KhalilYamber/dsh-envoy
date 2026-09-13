// client.js —— DSH Web API 客户端（认证 + unary 调用 + WebSocket 流）
// 适配 @deepseek-ai/dsh 0.1.5-rc.2（协议细节于 2026-09-12 对活服务逐条实测）
//
// 与 0.1.0-rc.6 时代的三处变化（均实测确认）：
//
// 1) 认证门
//    GET /?token=<launchToken> → 303 + Set-Cookie: dsh-auth-<sha256(authority)>=v1.<payload>.<sig>
//    （HttpOnly; SameSite=Strict; Max-Age 30 天）。签名密钥存在 credential provider 里，
//    宿主重启后 cookie 依然有效；每次启动会变的只有 launchToken。
//    无 cookie 访问 /api/* 一律 401；无 token/cookie 访问 / 也是 401。
//
// 2) 端点与信封
//    端点名由点号改斜杠：session.list → session/list。
//    信封本身没变：{type:'client-request', rpcId, method, payload}
//                  ↔ {type:'server-response', rpcId, result:{ok, value|error}}
//    payload 现在必须恰好包一层 args，且不同方法的 args 字段名不同：
//      session/list      → { args: { _request: { cursor? } } }      ← 注意下划线
//      session/create    → { args: { request: {...} } }
//      session/prompt    → { args: { request: {...} } }
//      session/cancel    → { args: { request: {...} } }
//      session/page      → { args: { request: {...} } }
//      workspace/create  → { args: { request: { path } } }
//
// 3) 流
//    session.history 与 workspace.list 已删除。前者并入 session/page（分页需 follow 开场帧的
//    cursor 作 throughSeq），后者只能从 workspace/follow 的首帧 baseline 里取。
//    流不能走普通 HTTP：POST /api/<stream 端点> 会回 gateway/signature-invalid
//    （stream Remote methods must be opened through the stream carrier）。
//    载体是 WebSocket /api/remote.mux：
//      出帧 { type:'open', streamId, endpoint, payload } / { type:'cancel', streamId }
//      入帧 { type:'item', streamId, value } / { type:'error', streamId, error } / { type:'end', streamId }
//    Node 22+ 自带全局 WebSocket，其第二参数接受 { headers }，cookie 由此带上。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RPC_PREFIX = 'dshb-';
const MUX_PATH = '/api/remote.mux';
const AUTH_MARGIN_MS = 60_000;
const DEFAULT_COOKIE_FILE = path.join(os.homedir(), '.dsh-bridge', 'external-auth.json');

let rpcSeq = 0;
function nextRpcId() {
  rpcSeq += 1;
  return `${RPC_PREFIX}${Date.now()}-${rpcSeq}`;
}

/** 会话请求身份（session/prompt 必填）。 */
function newRequestId() {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${RPC_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export class DshApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DshApiError';
    this.code = code;
    this.details = details;
  }
}

/** 把一个 Set-Cookie 头解析成可复用的 cookie 条目（只取 name=value 与 max-age）。 */
function parseSetCookie(headers, authority) {
  for (const raw of headers) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const [pair, ...attrs] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name.startsWith('dsh-auth-')) continue;
    let maxAgeSeconds = 0;
    for (const attr of attrs) {
      const [key, val] = attr.split('=');
      if (key && key.trim().toLowerCase() === 'max-age') maxAgeSeconds = Number(val);
    }
    const ttl = Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0 ? maxAgeSeconds * 1000 : 0;
    return {
      authority,
      cookie: `${name}=${value}`,
      expiresAt: ttl > 0 ? Date.now() + ttl : 0,
    };
  }
  return null;
}

export class DshClient {
  /**
   * @param {string} baseUrl - 形如 http://127.0.0.1:3080
   * @param {object} [options]
   * @param {string} [options.token] - 本次启动的 launchToken
   * @param {() => (string|Promise<string>)} [options.tokenProvider] - 惰性取 token（如读 DSH 启动日志）
   * @param {string} [options.cookieFile] - cookie 缓存文件；缺省 ~/.dsh-bridge/external-auth.json
   * @param {(msg: string) => void} [options.logger]
   */
  constructor(baseUrl, options = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = options.token ?? null;
    this.tokenProvider = options.tokenProvider ?? null;
    this.cookieFile = options.cookieFile ?? DEFAULT_COOKIE_FILE;
    this.logger = options.logger ?? null;
    this._auth = null;
    this._authInFlight = null;
  }

  get authority() {
    return new URL(this.baseUrl).host;
  }

  _log(msg) {
    try {
      if (typeof this.logger === 'function') this.logger(msg);
    } catch {
      // 日志失败静默
    }
  }

  // ---------- 认证 ----------

  _readJar() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cookieFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  _writeJar(entry) {
    try {
      fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
      const jar = this._readJar();
      jar[entry.authority] = { cookie: entry.cookie, expiresAt: entry.expiresAt };
      fs.writeFileSync(this.cookieFile, JSON.stringify(jar, null, 2), 'utf8');
    } catch {
      // 缓存写失败不影响本次会话（下次重换即可）
    }
  }

  async _resolveToken() {
    if (this.token) return this.token;
    if (typeof this.tokenProvider === 'function') {
      const provided = await this.tokenProvider();
      if (provided) return String(provided).trim();
    }
    const fromEnv = process.env.DSH_WEB_TOKEN;
    return fromEnv ? String(fromEnv).trim() : null;
  }

  _valid(entry) {
    if (!entry || !entry.cookie) return false;
    if (!entry.expiresAt) return true;
    return entry.expiresAt > Date.now() + AUTH_MARGIN_MS;
  }

  /** 确保有可用 cookie：缓存命中直接用，否则用 launchToken 换一次并落盘。 */
  async ensureAuth({ force = false } = {}) {
    if (!force && this._auth && this._valid(this._auth)) return this._auth;
    if (this._authInFlight) return this._authInFlight;
    this._authInFlight = (async () => {
      if (!force) {
        const cached = this._readJar()[this.authority];
        if (cached && this._valid(cached)) {
          this._auth = cached;
          return cached;
        }
      }
      const token = await this._resolveToken();
      if (!token) {
        throw new DshApiError(
          'auth-token-missing',
          '缺少 DSH 访问凭据：请从 DSH 启动日志（dsh web 打印的 ?token=... 那行）取得 token，'
          + `填入插件配置或环境变量 DSH_WEB_TOKEN。缓存文件：${this.cookieFile}`,
        );
      }
      let res;
      try {
        res = await fetch(`${this.baseUrl}/?token=${encodeURIComponent(token)}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
        });
      } catch (e) {
        throw new DshApiError('network', `换取 DSH cookie 失败（${this.baseUrl}）：${e.message}`);
      }
      const setCookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      const entry = parseSetCookie(setCookies, this.authority);
      if (!entry) {
        throw new DshApiError(
          'auth-failed',
          `换取 DSH cookie 失败（HTTP ${res.status}）。token 每次 DSH 启动都会更换，请取启动日志里最新的一条。`,
        );
      }
      this._auth = entry;
      this._writeJar(entry);
      this._log(`[dsh-bridge] 已获取 DSH 浏览器 cookie（authority=${entry.authority}）`);
      return entry;
    })();
    try {
      return await this._authInFlight;
    } finally {
      this._authInFlight = null;
    }
  }

  _headers(extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra };
    if (this._auth?.cookie) headers.cookie = this._auth.cookie;
    return headers;
  }

  /** 服务是否在监听（不要求认证）：根地址回 200 或 401 都算活着。 */
  async reachable({ timeoutMs = 3000 } = {}) {
    try {
      const res = await fetch(`${this.baseUrl}/`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.status === 200 || res.status === 401;
    } catch {
      return false;
    }
  }

  async _probeAuthed() {
    try {
      const res = await fetch(`${this.baseUrl}/`, {
        headers: this._headers(),
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** 健康检查：服务在跑，且当前凭据可用。 */
  async health() {
    if (!(await this.reachable())) {
      throw new DshApiError('unhealthy', `DSH 服务不可达（${this.baseUrl}）`);
    }
    await this.ensureAuth();
    if (await this._probeAuthed()) return true;
    await this.ensureAuth({ force: true });
    if (await this._probeAuthed()) return true;
    throw new DshApiError('unhealthy', `DSH 服务在跑，但当前凭据被拒（${this.baseUrl}）`);
  }

  // ---------- unary 调用 ----------

  /**
   * 信封调用：POST /api/<method>，payload 为 { args }。
   * @param {string} method - 斜杠形式端点，如 'session/list'
   * @param {object} args - 已按方法约定包好的 args
   */
  async call(method, args = {}) {
    await this.ensureAuth();
    let res = await this._post(method, args);
    if (res.status === 401) {
      await this.ensureAuth({ force: true });
      res = await this._post(method, args);
    }
    if (res.status === 404) {
      throw new DshApiError('not-found', `DSH 端点不存在：${method}（版本不匹配？）`);
    }
    if (!res.ok) {
      throw new DshApiError('http', `DSH API HTTP ${res.status} (${method})`);
    }
    const data = await res.json();
    if (!data || data.type !== 'server-response' || !data.result) {
      throw new DshApiError('bad-envelope', `DSH API 信封异常 (${method})`);
    }
    if (data.result.ok === true) return data.result.value;
    const err = data.result.error || { code: 'unknown', message: '未知错误' };
    throw new DshApiError(err.code || 'unknown', err.message || '未知错误', err.details);
  }

  async _post(method, args) {
    const rpcId = nextRpcId();
    const body = JSON.stringify({
      type: 'client-request', rpcId, method, payload: { args },
    });
    try {
      return await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: this._headers(),
        body,
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new DshApiError('network', `DSH API 调用失败（${this.baseUrl}）：${e.message}`);
    }
  }

  // ---------- WebSocket 流 ----------

  /**
   * 打开一条 Remote 流，逐个 yield 每个 item 的 value；end 结束，error 抛出。
   * @param {string} endpoint - 斜杠形式流端点，如 'workspace/follow'
   * @param {object} args
   * @param {object} [options]
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.openTimeoutMs]
   */
  async *stream(endpoint, args = {}, { signal, openTimeoutMs = 20000 } = {}) {
    await this.ensureAuth();
    const url = `${this.baseUrl.replace(/^http/, 'ws')}${MUX_PATH}`;
    const ws = new WebSocket(url, { headers: this._headers() });
    const streamId = nextRpcId();
    const queue = [];
    let notify = null;
    let closed = false;
    let failure = null;

    const wake = () => { if (notify) { const n = notify; notify = null; n(); } };
    const push = (item) => { queue.push(item); wake(); };

    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.streamId !== streamId) return;
      if (frame.type === 'item') push({ kind: 'item', value: frame.value });
      else if (frame.type === 'error') push({ kind: 'error', error: frame.error });
      else if (frame.type === 'end') push({ kind: 'end' });
    };
    ws.onerror = () => {
      failure = failure || new DshApiError('stream', `DSH 流连接失败：${endpoint}`);
      closed = true;
      push({ kind: 'end' });
    };
    ws.onclose = () => { closed = true; push({ kind: 'end' }); };

    const onAbort = () => { try { ws.close(); } catch { /* ignore */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new DshApiError('stream-timeout', `DSH 流打开超时：${endpoint}`)),
          openTimeoutMs > 0 ? openTimeoutMs : 60000,
        );
        ws.addEventListener('open', () => {
          clearTimeout(timer);
          try {
            ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
          } catch (e) {
            reject(new DshApiError('stream', `DSH 流发起失败（${endpoint}）：${e.message}`));
            return;
          }
          resolve();
        }, { once: true });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new DshApiError('stream', `DSH 流连接失败（${endpoint}）`));
        }, { once: true });
      });

      while (true) {
        while (queue.length === 0) {
          if (closed) return;
          await new Promise((resolve) => { notify = resolve; });
        }
        const next = queue.shift();
        if (next.kind === 'item') { yield next.value; continue; }
        if (next.kind === 'error') {
          const err = next.error || {};
          throw new DshApiError(err.code || 'stream', err.message || `DSH 流错误：${endpoint}`, err.details);
        }
        if (next.kind === 'end') {
          if (failure) throw failure;
          return;
        }
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      try { ws.send(JSON.stringify({ type: 'cancel', streamId })); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  /** 取一条流的前 n 帧后即关闭（用于只要开场 baseline / snapshot 的场景）。 */
  async streamTake(endpoint, args = {}, count = 1, options = {}) {
    const out = [];
    for await (const value of this.stream(endpoint, args, options)) {
      out.push(value);
      if (out.length >= count) break;
    }
    return out;
  }

  // ---------- 会话域 ----------

  /** 全部可见会话摘要（含冷会话）。 */
  async listSessions() {
    const value = await this.call('session/list', { _request: {} });
    return Array.isArray(value?.items) ? value.items : [];
  }

  /** @returns {{sessionId: string, agentPreset?: string}} */
  async createSession({ workspaceId, cwd, sessionId, agentPreset } = {}) {
    const request = {};
    if (workspaceId) request.workspaceId = workspaceId;
    if (cwd) request.cwd = cwd;
    if (sessionId) request.sessionId = sessionId;
    if (agentPreset) request.agentPreset = agentPreset;
    return this.call('session/create', { request });
  }

  /**
   * 模型目录（协议：session/modelCatalog）：部署默认选择 + 各 provider 可用模型。
   * @returns {Promise<{default?: object, routableProviders?: string[], groups?: object[], failures?: object[]}>}
   */
  async modelCatalog() {
    return this.call('session/modelCatalog', {});
  }

  /**
   * 会话级模型/强度选择（协议：session/selectModel），落定后作用于该会话后续提问。
   * @param {object} sel
   * @param {string} sel.sessionId 目标会话
   * @param {string} [sel.provider] provider id（如 deepseek-official）
   * @param {string} [sel.model] 模型 id
   * @param {string} [sel.reasoningEffort] 推理强度（该模型支持的档位之一）
   * @returns {Promise<{selected?: object}>}
   */
  async selectModel({ sessionId, provider, model, reasoningEffort } = {}) {
    const request = { sessionId };
    if (provider) request.provider = provider;
    if (model) request.model = model;
    if (reasoningEffort) request.reasoningEffort = reasoningEffort;
    return this.call('session/selectModel', { request });
  }

  async prompt(sessionId, text, { mode = 'queue', requestId } = {}) {
    return this.call('session/prompt', {
      request: {
        requestId: requestId || newRequestId(),
        sessionId,
        mode,
        content: [{ type: 'text', text }],
      },
    });
  }

  /**
   * 回复一个 Host 发来的 Remote 事件（0.1.2+ 的 `$events` waterfall 应答通道）。
   * @param {object} reply
   * @param {string} reply.clientId - `$events` 首帧 ready 里的 clientId
   * @param {string} reply.eventId - waterfall 帧的 eventId
   * @param {object} reply.outcome - {kind:'result',value} | {kind:'next'} | {kind:'rejected',error}
   */
  async answerRemoteEvent({ clientId, eventId, outcome }) {
    return this.call('$events/result', { clientId, eventId, outcome });
  }

  /** 会话历史（旧 session.history 的替代）：follow 开场快照给出 records。 */
  async history(sessionId, { maxMessages = 200, signal } = {}) {
    const frames = await this.streamTake('session/follow', {
      request: { address: { kind: 'session', sessionId }, maxMessages },
    }, 1, { signal });
    const snapshot = frames[0];
    if (!snapshot || snapshot.type !== 'snapshot') return [];
    return Array.isArray(snapshot.records) ? snapshot.records : [];
  }

  /** 向后翻页（冷历史）；throughSeq 取 follow 开场帧的 cursor。 */
  async page(sessionId, { throughSeq, beforeSeq, maxMessages } = {}) {
    const request = { address: { kind: 'session', sessionId }, throughSeq };
    if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
    if (maxMessages !== undefined) request.maxMessages = maxMessages;
    return this.call('session/page', { request });
  }

  async cancel(sessionId) {
    return this.call('session/cancel', { request: { sessionId } });
  }

  // ---------- 工作区 ----------

  /** 工作区列表：旧 workspace.list 已删，改从 workspace/follow 首帧 baseline 取。 */
  async listWorkspaces({ signal } = {}) {
    const frames = await this.streamTake('workspace/follow', {}, 1, { signal });
    const baseline = frames[0];
    return Array.isArray(baseline?.value?.items) ? baseline.value.items : [];
  }

  async createWorkspace(workspacePath) {
    return this.call('workspace/create', { request: { path: workspacePath } });
  }
}
