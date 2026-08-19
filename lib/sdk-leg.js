// sdk-leg.js —— bundled 腿：官方 SDK runtime（spawn + stdio JSON-RPC，官方 SDK client 驱动）
// 薄桥 2.0：砍掉自研 headless 解析与 junction 部署，全部走官方 npm 安装与官方 SDK client。
// 官方语义（spike 实测，见 research/spike/SPIKE-RESULTS.md）：
// - 每个任务一个 runtime 子进程（对齐 v0.2.5 embedded 的进程模型，dsh_cancel 精确到任务）
// - 进程内多任务 session 延续可用；跨进程 resume 官方不支持（进程亡即弃会话）
// - 无审批通道：越界操作被沙箱立即拒绝（fail closed），agent 在任务报告里说明；
//   带授权重派 = env DSH_PERMISSION_MODE=danger-full-access（该模式下审批策略 never）
// - dsh_cancel = harness.close()（官方协议 shutdown → stdin EOF → SIGTERM → SIGKILL 阶梯）
// 依赖部署：<dataDir>/bundled/ 是官方 SDK runtime 配置项目（cordis.yml + package.json + node_modules），
//   由官方安装命令产出：npm install --prefix <dataDir>/bundled（依赖清单即 bundled/package.json）。
//   插件从那里动态 import 官方 @deepseek-ai/dsh-sdk-client，零复刻、零 junction。
// 终态对象与 TaskRunner.run 同构：ok/status/stopReason/conclusion/fullOutput/checkpoints/artifacts/usage/durationMs/sessionId/tag

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCheckpoints, parseArtifacts } from './task.js';

const OUTPUT_TAIL = 8000; // fullOutput 截断保留尾部（对齐 task.js FULL_OUTPUT_TAIL）

export class SdkLeg {
  /**
   * @param {object} opts
   * @param {string} [opts.nodePath]   node.exe 绝对路径（缺省走 config.json global.nodePath，再 PATH 的 node）
   * @param {string} opts.dataDir      插件数据目录（bundled 配置项目落点）
   * @param {object} [opts.config]     插件配置快照（apiKey / permissionMode / defaultCwd）
   * @param {function} [opts.logger]   日志函数或 {info/warn/error} 对象
   */
  constructor({ nodePath, dataDir, config, logger } = {}) {
    this.nodePath = nodePath || '';
    this.dataDir = dataDir;
    this.config = config || null;
    this.logger = logger || (() => {});
    this._readyPromise = null; // prepare() 幂等缓存
    this._resolved = null;    // { node, apiKey, bundledDir, binJs, clientEntry }
    this._sdkModule = null;   // 官方 SDK client 模块缓存（动态 import 一次）
    this._runs = new Map();   // opKey -> 运行条目（dsh_status / dsh_cancel 读取）
  }

  /** SDK 腿无审批：挂起审批恒为空（dsh_approve / dsh_status 接口对齐 TaskRunner） */
  get pendingApprovals() {
    return [];
  }

  /** 依赖就位校验（不 spawn）：node / bundled 配置项目 / apiKey 三项解析，失败转人话 */
  async prepare() {
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = (async () => {
      const node = this._resolveNodePath();
      const apiKey = this._resolveApiKey();
      const bundledDir = path.join(this.dataDir, 'bundled');
      const binJs = path.join(
        bundledDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-jsonrpc-demo', 'lib', 'bin.js'
      );
      const clientEntry = path.join(
        bundledDir, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js'
      );
      const cordis = path.join(bundledDir, 'cordis.yml');
      if (!fs.existsSync(cordis)) {
        throw new Error(
          `bundled 配置缺失：${cordis} 不存在。请把插件 bundled/ 目录同步到插件数据目录（bundled/cordis.yml + bundled/package.json），` +
            `再执行官方安装命令：npm install --prefix "${bundledDir}"`
        );
      }
      if (!fs.existsSync(binJs) || !fs.existsSync(clientEntry)) {
        throw new Error(
          `bundled 依赖未安装（缺官方 SDK runtime/client）。请执行官方安装命令：npm install --prefix "${bundledDir}"`
        );
      }
      this._resolved = { node, apiKey, bundledDir, binJs, clientEntry };
      return this;
    })();
    try {
      return await this._readyPromise;
    } catch (e) {
      this._readyPromise = null;
      throw e;
    }
  }

  /** 动态 import 官方 SDK client（幂等；import 失败转人话） */
  async _ensureSdkModule() {
    if (this._sdkModule) return this._sdkModule;
    const r = this._resolved;
    try {
      this._sdkModule = await import(pathToFileURL(r.clientEntry).href);
      if (!this._sdkModule?.DeepSeekHarness) {
        throw new Error('官方 SDK client 模块缺少 DeepSeekHarness 导出');
      }
      return this._sdkModule;
    } catch (e) {
      this._sdkModule = null;
      throw new Error(`官方 SDK client 装载失败（${r.clientEntry}）：${e?.message || e}`);
    }
  }

  /** 新建一个 SDK runtime 会话句柄（每任务一个进程；不 spawn，run 时才拉起） */
  async _newHarness({ cwd, timeoutMs, envOverrides }) {
    const { DeepSeekHarness } = await this._ensureSdkModule();
    const r = this._resolved;
    const env = { ...process.env, DEEPSEEK_API_KEY: r.apiKey };
    if (cwd) env.DSH_CWD = cwd;
    env.DSH_SESSION_ROOT = path.join(r.bundledDir, 'sessions');
    if (this.config?.permissionMode) env.DSH_PERMISSION_MODE = String(this.config.permissionMode);
    if (envOverrides && typeof envOverrides === 'object') Object.assign(env, envOverrides);
    return new DeepSeekHarness({
      launch: {
        command: r.node,
        args: [r.binJs, path.join(r.bundledDir, 'cordis.yml')],
        cwd: r.bundledDir,
        env,
        requestTimeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : 600000,
      },
      provider: 'deepseek-official',
      model: this.config?.model || 'deepseek-v4-flash',
      maxTokens: 32768,
    });
  }

  /**
   * 运行一次任务，返回结构化终态对象（与 TaskRunner.run 同构）。
   * @param {object} opts
   * @param {string} opts.task             任务书文本
   * @param {string} [opts.cwd]            沙箱工作目录（DSH_CWD；缺省用 defaultCwd/数据目录）
   * @param {string} [opts.tag]            工作标签【MMdd-NN】（终态回带）
   * @param {number} [opts.timeoutMs]      本次执行超时（requestTimeoutMs 与执行预算）
   * @param {object} [opts.env]            单次派单的 env 覆盖（带授权重派：DSH_PERMISSION_MODE 等）
   * @param {AbortSignal} [opts.signal]    外部取消信号（宿主中断）
   * @param {function} [opts.onProgress]   输出回调 onProgress({ sessionId, tag, output })
   * @param {string} [opts.opId]           任务记录键（dsh_cancel 入口键）
   */
  async run({ task, cwd, tag, timeoutMs, env, signal, onProgress, opId } = {}) {
    const text = String(task ?? '').trim();
    if (!text) throw new Error('task 不能为空：请给出要 dsh 执行的任务书文本');
    await this.prepare();
    const startedAt = Date.now();
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 600000;
    const key = opId ?? `sdk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    const entry = {
      opKey: key,
      tag: tag ?? null,
      task: text.slice(0, 500),
      cwd: cwd || null,
      startedAt: new Date().toISOString(),
      status: 'running',
      harness: null,
      output: '',
      cancelled: false,
    };
    this._runs.set(key, entry);

    const fireProgress = () => {
      if (typeof onProgress !== 'function') return;
      Promise.resolve(onProgress({ sessionId: entry.sessionId ?? null, tag, output: entry.output })).catch(() => {});
    };
    const pushOutput = (d) => {
      entry.output = (entry.output + String(d)).slice(-OUTPUT_TAIL);
      fireProgress();
    };

    const buildTerminal = (ok, status, stopReason, extra = {}) => {
      const conclusion = entry.lastMessage ?? entry.output.trim();
      return {
        ok,
        status,
        stopReason,
        conclusion,
        fullOutput: entry.output,
        checkpoints: parseCheckpoints(conclusion),
        artifacts: parseArtifacts(entry.output || conclusion),
        usage: entry.usage ?? null,
        durationMs: Date.now() - startedAt,
        sessionId: entry.sessionId ?? null,
        tag: tag || null,
        ...extra,
      };
    };

    const onNotification = (n) => {
      if (!n || typeof n.method !== 'string') return;
      if (n.method === 'session.status') {
        entry.status = n.params?.status === 'idle' && !entry.settled ? 'finishing' : entry.status;
        return;
      }
      if (n.method !== 'session.event') return;
      const ev = n.params?.event ?? {};
      if (ev.type === 'assistant/chunk') {
        const chunk = ev.chunk ?? ev.data?.chunk;
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
          pushOutput(chunk.text);
        } else if (chunk?.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
          const u = chunk.usage;
          entry.usage = {
            input: Number(u.inputTokens ?? 0),
            output: Number(u.outputTokens ?? 0),
            cache: Number(u.cacheReadTokens ?? 0),
            thinking: Number(u.reasoningTokens ?? 0),
          };
        }
      } else if (ev.type === 'assistant/message') {
        const msg = ev.message ?? ev.data?.message;
        if (msg && Array.isArray(msg.content)) {
          const t = msg.content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('');
          if (t) entry.lastMessage = t;
        }
      }
    };

    // 终态判定：events 尾部 turn/end 的 reason.kind（SDK 无 prompt 级 status，官方语义）
    const judgeStop = (events) => {
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev?.type === 'turn/end') {
          const kind = ev.reason?.kind ?? ev.data?.reason?.kind;
          if (kind === 'completed') return { ok: true, status: 'completed', stopReason: 'end_turn' };
          if (kind === 'max-tokens') return { ok: true, status: 'completed', stopReason: 'max_tokens' };
          if (kind === 'aborted') return { ok: false, status: 'aborted', stopReason: 'aborted' };
          return { ok: false, status: 'error', stopReason: 'error' };
        }
      }
      // 无 turn/end（断流兜底）
      return { ok: true, status: 'completed', stopReason: 'end_turn' };
    };

    const settle = (terminal) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.status = terminal.status;
      entry.endedAt = new Date().toISOString();
      this._recordLastExit(terminal); // t4 数据源：上次退出记录落盘（写失败静默）
      this._runs.delete(key);
    };

    let harness = null;
    try {
      harness = await this._newHarness({ cwd: cwd || this.config?.defaultCwd || this.dataDir, timeoutMs: timeout, envOverrides: env });
      entry.harness = harness;
      const r = await harness.run(text, { onNotification });
      entry.sessionId = r.sessionId ?? null;
      if (!entry.lastMessage && r.finalResponse) {
        entry.lastMessage = r.finalResponse;
        pushOutput(r.finalResponse);
      }
      const judged = entry.cancelled
        ? { ok: false, status: 'aborted', stopReason: 'aborted' }
        : judgeStop(r.events ?? []);
      const terminal = buildTerminal(judged.ok, judged.status, judged.stopReason);
      settle(terminal);
      return terminal;
    } catch (e) {
      if (entry.cancelled) {
        const terminal = buildTerminal(false, 'aborted', 'aborted', { error: 'dsh 内置任务已取消' });
        settle(terminal);
        return terminal;
      }
      const msg = String(e?.message || e);
      const isTimeout = /timeout|超时/i.test(msg) && !/shutdown/i.test(msg);
      const terminal = buildTerminal(
        false,
        isTimeout ? 'error' : 'error',
        isTimeout ? 'timeout' : 'error',
        { error: msg.slice(0, 2000) }
      );
      settle(terminal);
      return terminal;
    } finally {
      // 终态回收进程（官方 close 阶梯；失败不阻塞终态）
      if (harness) {
        try {
          await harness.close();
        } catch {
          // close 失败静默：进程可能已自行退出
        }
      }
    }
  }

  /** 上次退出记录落盘（dsh_diagnose t4 数据源）：SDK 腿每次终态都记，重启后可查。
   *  降级链：写失败静默（诊断记录是增强，不阻塞任务主流程）。 */
  _recordLastExit(terminal) {
    try {
      if (!this.dataDir) return;
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.dataDir, 'last-exit.json'),
        JSON.stringify({
          mode: 'bundled',
          exitCode: null, // SDK 腿无进程退出码语义（成功/失败读 status/stopReason）
          signal: null,
          status: terminal?.status ?? null,
          stopReason: terminal?.stopReason ?? null,
          endedAt: new Date().toISOString(),
          stderrTail: String(terminal?.error ?? '').slice(0, 500),
        }),
        'utf8'
      );
    } catch {
      // 落盘失败静默
    }
  }

  /** dsh_cancel 工具入口：close 运行中的 runtime（官方放弃语义）。幂等；无匹配任务返回 false。 */
  cancelRequested(opKeyOrNull) {
    let entry = null;
    if (opKeyOrNull != null) {
      entry = this._runs.get(String(opKeyOrNull)) ?? null;
    } else if (this._runs.size === 1) {
      entry = [...this._runs.values()][0];
    }
    if (!entry) return false;
    entry.cancelled = true;
    if (entry.harness) {
      Promise.resolve()
        .then(() => entry.harness.close())
        .catch(() => {
          // close 失败静默：requestTimeoutMs 或进程退出兜底
        });
    }
    return true;
  }

  /** dsh_approve 工具入口（对齐 TaskRunner.respondApproval 签名）：SDK 腿无审批可答 */
  async respondApproval() {
    throw new Error(
      '内置 SDK 模式无挂起审批：越界操作会被沙箱立即拒绝（fail closed），agent 在任务报告里说明。' +
        '若您允许该操作，请带授权重派（permission=danger-full-access）'
    );
  }

  /** 卸载/重载回收：close 全部存活 runtime */
  async dispose() {
    const entries = [...this._runs.values()];
    this._runs.clear();
    for (const entry of entries) {
      if (entry.harness) {
        try {
          await entry.harness.close();
        } catch {
          // 尽力而为
        }
      }
    }
  }

  /** node 可执行文件解析（对齐 v0.2.5）：构造参数 → config.json global.nodePath → PATH 的 node */
  _resolveNodePath() {
    if (this.nodePath && String(this.nodePath).trim()) return String(this.nodePath).trim();
    try {
      const file = path.join(this.dataDir, 'config.json');
      if (fs.existsSync(file)) {
        const p = JSON.parse(fs.readFileSync(file, 'utf8'))?.global?.nodePath;
        if (typeof p === 'string' && p.trim()) return p.trim();
      }
    } catch {
      // 静默，用 PATH 里的 node 兜底
    }
    return 'node';
  }

  /** apiKey 解析链（对齐 v0.2.5）：配置 → config.json → credentials.yaml → 进程环境 */
  _resolveApiKey() {
    const cfg = this.config;
    if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) return cfg.apiKey.trim();
    try {
      const file = path.join(this.dataDir, 'config.json');
      if (fs.existsSync(file)) {
        const key = JSON.parse(fs.readFileSync(file, 'utf8'))?.global?.apiKey;
        if (typeof key === 'string' && key.trim()) return key.trim();
      }
    } catch {
      // 文件损坏静默，落入下一级
    }
    const re = /^\s*DEEPSEEK_API_KEY\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m;
    for (const file of [
      path.join(this.dataDir, 'dsh-home', '.credentials.yaml'),
      path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    ]) {
      try {
        if (!fs.existsSync(file)) continue;
        const m = fs.readFileSync(file, 'utf8').match(re);
        const key = m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
        if (key) return key;
      } catch {
        // 单个文件损坏静默，尝试下一个
      }
    }
    if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim()) {
      return process.env.DEEPSEEK_API_KEY.trim();
    }
    throw new Error(
      '找不到 DEEPSEEK_API_KEY：请在插件设置中配置 apiKey，或把 key 写入插件数据目录 ' +
        'dsh-home/.credentials.yaml（也可用 ~/.dsh/.credentials.yaml）'
    );
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
