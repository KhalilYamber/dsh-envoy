// client.js —— DSH Web API 客户端（信封封装）
// 适配 @deepseek-ai/dsh 0.1.0-rc.6
// 协议细节以 DSH 官方实现与实测行为为准（DSH 0.1.0-rc.6）。

const RPC_PREFIX = 'dshb-';

let rpcSeq = 0;
function nextRpcId() {
  rpcSeq += 1;
  return `${RPC_PREFIX}${Date.now()}-${rpcSeq}`;
}

export class DshApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DshApiError';
    this.code = code;
    this.details = details;
  }
}

export class DshClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** 健康检查：GET / 返回 200 即视为服务可用 */
  async health() {
    const res = await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new DshApiError('unhealthy', `DSH 服务响应异常: HTTP ${res.status}`);
    return true;
  }

  /** 信封调用：POST /api/<method>，校验 result.ok */
  async call(method, payload = {}) {
    const rpcId = nextRpcId();
    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new DshApiError('network', `DSH API 调用失败（${this.baseUrl}）：${e.message}`);
    }
    if (!res.ok) {
      throw new DshApiError('http', `DSH API HTTP ${res.status} (${method})`);
    }
    const data = await res.json();
    if (data.type !== 'server-response' || data.rpcId !== rpcId) {
      throw new DshApiError('bad-envelope', `DSH API 信封异常 (${method})`);
    }
    if (!data.result || data.result.ok !== true) {
      const err = (data.result && data.result.error) || { code: 'unknown', message: '未知错误' };
      throw new DshApiError(err.code || 'unknown', err.message || '未知错误', err.details);
    }
    return data.result.value;
  }

  // ---------- 会话域 ----------

  async listSessions() {
    return this.call('session.list', {});
  }

  async createSession({ workspaceId, cwd, sessionId, agentPreset } = {}) {
    const payload = {};
    if (workspaceId) payload.workspaceId = workspaceId;
    if (cwd) payload.cwd = cwd;
    if (sessionId) payload.sessionId = sessionId;
    if (agentPreset) payload.agentPreset = agentPreset;
    return this.call('session.create', payload);
  }

  async prompt(sessionId, text, { mode = 'queue' } = {}) {
    return this.call('session.prompt', {
      sessionId,
      mode,
      content: [{ type: 'text', text }],
    });
  }

  /** 读事件流，返回事件数组（含 type/seq/time/data） */
  async history(sessionId) {
    const value = await this.call('session.history', { sessionId });
    return Array.isArray(value.events) ? value.events : [];
  }

  async cancel(sessionId) {
    return this.call('session.cancel', { sessionId });
  }

  // ---------- 工作区 ----------

  async listWorkspaces() {
    return this.call('workspace.list', {});
  }

  async createWorkspace(path) {
    return this.call('workspace.create', { path });
  }
}
