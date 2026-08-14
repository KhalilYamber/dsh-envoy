// headless.js —— HeadlessRunner（embedded 后端换芯，SPEC-v0.2 T3）
// 官方程序调用路径：spawn `node <dshBinJs> --profile headless <task>`（@deepseek-ai/dsh-headless）
// 实测事实（research/headless-behavior.md）：
// - 无 Host / HTTP / 浏览器层，不开端口；session flush 后最后一条非空 assistant 文本写 stdout
// - turn/end completed → 退出码 0；否则 1；驱动崩溃 code+message 写 stderr（`dsh: <code>: <message>`）
// - 越界操作无审批通道 → 立即 fail closed（不挂起），agent 照常收尾汇报（**此时退出码仍为 0**）
// - 沙箱模式由 env DSH_PERMISSION_MODE 控制（默认 workspace-write；danger-full-access 时审批策略 never）
// - 工具呈现模式由 env DSH_TOOLS_MODE 控制（native / code / both）
// 依赖部署（SPEC §6）：插件数据目录建 junction dsh-node_modules → 本机 DSH 的 node_modules（离线复用）
// 终态对象与 TaskRunner.run 同构：ok/status/stopReason/conclusion/fullOutput/usage/durationMs 等
// 无审批事件、无 WebSocket、无会话句柄；进程退出即终态。宿主重启进程成孤儿 → dispose 尽力 kill。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseCheckpoints, parseArtifacts } from './task.js';

const DEFAULT_TIMEOUT_MS = 600_000; // 默认执行超时 10 分钟（对齐 task.js）
const OUTPUT_TAIL = 8000;           // stdout 滚动缓冲尾部长度（对齐 task.js FULL_OUTPUT_TAIL）
const STDERR_TAIL = 2000;           // 报错时 stderr 尾部长度

/** 判断某路径是否为 junction/symlink（readlink 成功即视为链接） */
function isLink(p) {
  try {
    return typeof fs.readlinkSync(p) === 'string';
  } catch {
    return false;
  }
}

export class HeadlessRunner {
  /**
   * @param {object} opts
   * @param {string} [opts.nodePath]   node.exe 绝对路径（缺省走 config.json global.nodePath，再 PATH 的 node）
   * @param {string} opts.dataDir      插件数据目录（dsh-home 与 dsh-node_modules junction 落点）
   * @param {object} [opts.config]     插件配置快照（apiKey / toolsMode / permissionMode / dshInstallDir）
   * @param {function} [opts.logger]   日志函数或 {info/warn/error} 对象
   */
  constructor({ nodePath, dataDir, config, logger } = {}) {
    this.nodePath = nodePath || '';
    this.dataDir = dataDir;
    this.config = config || null;
    this.logger = logger || (() => {});
    this.defaultTimeoutMs = DEFAULT_TIMEOUT_MS;
    this._readyPromise = null; // prepare() 幂等缓存（node/bin/key 解析）
    this._binPath = null;
    this._runs = new Map();    // opKey -> 运行条目（dsh_status / dsh_cancel 读取）
  }

  /** headless 无审批：挂起审批恒为空（dsh_approve / dsh_status 接口对齐 TaskRunner） */
  get pendingApprovals() {
    return [];
  }

  /** 依赖就位校验（不 spawn）：node / dshBinJs（junction 自动建）/ apiKey 三项解析，失败转人话 */
  async prepare() {
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = (async () => {
      this._binPath = await this._resolveBinJs();
      this._nodePath = this._resolveNodePath();
      this._apiKey = this._resolveApiKey();
      return this;
    })();
    try {
      return await this._readyPromise;
    } catch (e) {
      this._readyPromise = null;
      throw e;
    }
  }

  /**
   * 运行一次 headless 任务，返回结构化终态对象（与 TaskRunner.run 同构）。
   * @param {object} opts
   * @param {string} opts.task             任务书文本（headless 把它作为用户消息发给全新持久化 Agent）
   * @param {string} [opts.cwd]            沙箱工作目录（= spawn cwd，即 workspaceRoot）
   * @param {string} [opts.tag]            工作标签【MMdd-NN】（终态回带）
   * @param {number} [opts.timeoutMs]      本次执行超时（覆盖默认值）
   * @param {object} [opts.env]            单次派单的 env 覆盖（带授权重派：DSH_PERMISSION_MODE 等）
   * @param {AbortSignal} [opts.signal]    外部取消信号（宿主中断）
   * @param {function} [opts.onProgress]   输出回调 onProgress({ sessionId:null, tag, output })
   * @param {string} [opts.opId]           任务台账键（dsh_cancel 入口键）
   */
  async run({ task, cwd, tag, timeoutMs, env, signal, onProgress, opId } = {}) {
    const text = String(task ?? '').trim();
    if (!text) throw new Error('task 不能为空：请给出要 dsh 执行的任务书文本');
    await this.prepare();
    const startedAt = Date.now();
    const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.defaultTimeoutMs;
    const key = opId ?? `hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    // ---- 运行条目（dsh_status 读取；进程退出/终态后移除） ----
    const entry = {
      opKey: key,
      tag: tag ?? null,
      task: text.slice(0, 500),
      cwd: cwd || this.dataDir,
      startedAt: new Date().toISOString(),
      status: 'running',
      child: null,
      exitCode: null,
      signal: null,
      output: '',
      cancelled: false,
    };
    this._runs.set(key, entry);

    // ---- spawn 环境：DSH_HOME 隔离进插件数据目录；key 显式注入（实测 2.1：headless 读不到 web 的浏览器凭证） ----
    const dshHome = path.join(this.dataDir, 'dsh-home');
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.mkdirSync(dshHome, { recursive: true });
    } catch (e) {
      this._runs.delete(key);
      throw new Error(`插件数据目录不可写：${e?.message || e}`);
    }
    const spawnEnv = { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: this._apiKey };
    if (this.config?.toolsMode) spawnEnv.DSH_TOOLS_MODE = String(this.config.toolsMode);
    if (this.config?.permissionMode) spawnEnv.DSH_PERMISSION_MODE = String(this.config.permissionMode);
    if (env && typeof env === 'object') Object.assign(spawnEnv, env);

    const fireProgress = () => {
      if (typeof onProgress !== 'function') return;
      Promise.resolve(onProgress({ sessionId: null, tag, output: entry.output })).catch(() => {});
    };
    const pushOutput = (d) => {
      entry.output = (entry.output + String(d)).slice(-OUTPUT_TAIL);
      fireProgress();
    };

    let stderrTail = '';
    const pushStderr = (d) => {
      stderrTail = (stderrTail + String(d)).slice(-STDERR_TAIL);
    };

    const killTree = (child) => {
      if (!child || child.exitCode !== null) return;
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        // 尽力而为
      }
      try {
        child.kill();
      } catch {
        // 已退出则忽略
      }
    };

    const buildTerminal = (ok, status, stopReason, extra = {}) => {
      const conclusion = entry.output.trim();
      return {
        ok,
        status,
        stopReason,
        conclusion,
        fullOutput: entry.output,
        checkpoints: parseCheckpoints(conclusion),
        artifacts: parseArtifacts(entry.output),
        usage: null,
        durationMs: Date.now() - startedAt,
        sessionId: null,
        tag: tag || null,
        ...extra,
      };
    };

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let child = null;
      const settle = (terminal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        entry.status = terminal.status;
        entry.exitCode = terminal.exitCode ?? entry.exitCode;
        entry.signal = terminal.signal ?? entry.signal;
        entry.endedAt = new Date().toISOString();
        this._runs.delete(key);
        resolve(terminal);
      };
      const onAbort = () => {
        entry.cancelled = true;
        killTree(child);
        settle(buildTerminal(false, 'aborted', 'aborted', { error: 'dsh 内置任务已取消', exitCode: child?.exitCode ?? null }));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return; // 派单前已中止：不 spawn，直接终态
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        child = spawn(this._nodePath, [this._binPath, '--profile', 'headless', text], {
          cwd: entry.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: spawnEnv,
          windowsHide: true, // Windows 下不弹窗
        });
      } catch (e) {
        settle(
          buildTerminal(false, 'error', 'error', {
            error: `dsh headless 启动失败（无法执行 ${this._nodePath}）：${e?.message || e}`,
          })
        );
        return;
      }
      entry.child = child;
      child.stdout.on('data', pushOutput);
      child.stderr.on('data', pushStderr);
      child.once('error', (e) => {
        settle(buildTerminal(false, 'error', 'error', { error: `dsh headless 进程错误：${e?.message || e}` }));
      });
      child.once('exit', (code, signalName) => {
        if (settled) return;
        // dsh_cancel 已请求取消：taskkill 强杀后退出码多为 1，但语义是 aborted（对齐 TaskRunner 终态）
        if (entry.cancelled) {
          settle(
            buildTerminal(false, 'aborted', 'aborted', {
              error: 'dsh 内置任务已取消',
              exitCode: code,
              signal: signalName,
            })
          );
          return;
        }
        // 实测 2.3：退出码 0 只代表 turn 正常收尾（越界被拒也退 0），成功与否读 stdout 文本
        if (code === 0) {
          settle(buildTerminal(true, 'completed', 'end_turn', { exitCode: 0, signal: signalName }));
        } else {
          const err = stderrTail.trim() || `dsh 内置任务异常退出（code=${code} signal=${signalName ?? '-'}）`;
          settle(
            buildTerminal(false, 'error', 'error', { error: err, exitCode: code, signal: signalName })
          );
        }
      });
      // 超时 kill 进程树（宿主重启后进程成孤儿，本计时器随插件进程消失；dsh_status 对账时按失联处理）
      timer = setTimeout(() => {
        killTree(child);
        settle(
          buildTerminal(false, 'error', 'timeout', {
            error: `dsh 内置任务超时（${Math.round(timeout / 1000)}s），进程已回收`,
            exitCode: child?.exitCode ?? null,
          })
        );
      }, timeout);
    });
  }

  /** dsh_cancel 工具入口：kill 运行中的 headless 进程树。幂等；无匹配任务返回 false。 */
  cancelRequested(opKeyOrNull) {
    let entry = null;
    if (opKeyOrNull != null) {
      entry = this._runs.get(String(opKeyOrNull)) ?? null;
    } else if (this._runs.size === 1) {
      entry = [...this._runs.values()][0];
    }
    if (!entry) return false;
    entry.cancelled = true;
    this._killEntry(entry);
    return true;
  }

  /** dsh_approve 工具入口（对齐 TaskRunner.respondApproval 签名）：headless 无审批可答 */
  async respondApproval() {
    throw new Error(
      '内置 headless 模式无挂起审批：越界操作会被沙箱立即拒绝（fail closed），agent 在任务报告里说明。' +
        '若您允许该操作，请带授权重派（permission=danger-full-access）'
    );
  }

  /** 卸载/重载回收：kill 全部存活进程（宿主重启直接杀进程时，此路可能不执行，孤儿靠 dsh 自身收尾） */
  async dispose() {
    for (const entry of this._runs.values()) this._killEntry(entry);
    this._runs.clear();
  }

  _killEntry(entry) {
    const child = entry.child;
    if (!child || child.exitCode !== null) return;
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      // 尽力而为
    }
    try {
      child.kill();
    } catch {
      // 已退出则忽略
    }
  }

  /** node 可执行文件解析（对齐 host.js 同模式）：构造参数 → config.json global.nodePath → PATH 的 node */
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

  /** apiKey 解析链（对齐 host.js resolveApiKey）：配置 → config.json → credentials.yaml → 进程环境 */
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

  /** dshBinJs 解析（SPEC §6 junction 复用）：dataDir/dsh-node_modules junction → 本机 DSH node_modules 直用 */
  async _resolveBinJs() {
    const linkDir = path.join(this.dataDir, 'dsh-node_modules');
    const viaLink = path.join(linkDir, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (fs.existsSync(viaLink)) return viaLink;
    // 本机 DSH 安装根候选：配置 dshInstallDir → D:\DeepSeek-Harness → ~/.dsh
    const roots = [];
    const cfgRoot = this.config?.dshInstallDir;
    if (cfgRoot && String(cfgRoot).trim()) roots.push(String(cfgRoot).trim());
    roots.push('D:\\DeepSeek-Harness', path.join(os.homedir(), '.dsh'));
    for (const root of roots) {
      if (!root) continue;
      const direct = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (!fs.existsSync(direct)) continue;
      // 建 junction 复用依赖（离线部署，SPEC §6）；残留断链先清，非链接目录不碰
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
        if (fs.existsSync(linkDir) || isLink(linkDir)) {
          if (!isLink(linkDir)) {
            throw new Error(`${linkDir} 已存在且不是 junction，请移除后重试`);
          }
          fs.rmSync(linkDir, { recursive: true, force: true }); // 断链清理（rmSync 只删链接不碰目标）
        }
        const r = spawnSync('cmd', ['/c', 'mklink', '/J', linkDir, path.join(root, 'node_modules')], {
          windowsHide: true,
          stdio: 'ignore',
        });
        if (r.status === 0 && fs.existsSync(viaLink)) return viaLink;
        this._log('warn', `[dsh-bridge] dsh-node_modules junction 建立失败（status=${r.status}），直用 ${direct}`);
      } catch (e) {
        this._log('warn', `[dsh-bridge] dsh-node_modules junction 建立失败，直用 ${direct}：${e?.message || e}`);
      }
      return direct;
    }
    throw new Error(
      '找不到本机 DSH 安装（已探测 D:\\DeepSeek-Harness 与 ~/.dsh）：请先安装 DeepSeek Harness，' +
        '或在插件设置 dshInstallDir 中填写安装根目录'
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
