// connection.js —— DSH 连接抽象
// 一个连接，两种实现：
//   external：直连用户自跑的 DSH 服务（默认 127.0.0.1:3080），会话记录归用户
//   embedded：HeadlessRunner（spawn dsh --profile headless），DSH_HOME 锁进插件数据目录
// mode: 'auto'（默认）探测外部服务，有则 external，无则 embedded
// v0.2 换芯：embedded 不再拉起 web host（host.js 废弃），无端口、无 WebSocket、无审批事件。

import { DshClient } from './client.js';
import { HeadlessRunner } from './headless.js';

export class DshConnection {
  constructor({ mode, cfg, dataDir, logger }) {
    this.mode = mode;            // 'auto' | 'embedded' | 'external'
    this.cfg = cfg;              // 插件配置（含直读 config.json 的最新值，见 resolveLiveConfig）
    this.dataDir = dataDir;
    this.logger = logger || (() => {});
    this._impl = null;           // 'embedded' | 'external'
    this._client = null;
    this._headless = null;
  }

  get effectiveMode() {
    return this._impl;
  }

  get client() {
    if (!this._client) throw new Error('DSH 连接尚未就绪，请先调用 ensure()');
    return this._client;
  }

  /** HeadlessRunner 实例（embedded 模式；external 模式为 null） */
  get headless() {
    return this._headless;
  }

  /** 解析最终模式（auto 探测；P1-2.3：判定原因写日志供排障） */
  async resolveMode() {
    const want = this.cfg.mode || 'auto';
    if (want === 'embedded') return 'embedded';
    if (want === 'external') return 'external';
    // auto：探测外部服务（带健康检查），可用则外接
    const externalPort = this.cfg.externalPort || this.cfg.webPort || 3080;
    const probe = new DshClient(`http://127.0.0.1:${externalPort}`);
    try {
      await probe.health();
      this._log('info', `[dsh-bridge] auto 探测：127.0.0.1:${externalPort} 健康检查通过 → external`);
      return 'external';
    } catch {
      this._log('info', `[dsh-bridge] auto 探测：127.0.0.1:${externalPort} 不可达 → embedded-headless`);
      return 'embedded';
    }
  }

  /** 确保连接可用；external 探测健康，embedded 校验 node/binJs/apiKey（不做端口探测，不 spawn） */
  async ensure() {
    const mode = await this.resolveMode();
    this._log('info', `[dsh-bridge] 生效模式：${mode}（配置 mode=${this.cfg.mode || 'auto'}）`);
    if (mode === 'external') {
      const port = this.cfg.externalPort || this.cfg.webPort || 3080;
      const client = new DshClient(`http://127.0.0.1:${port}`);
      // 健康检查：失败时给出「服务未启动」的人话提示（auto 模式下可能是闲置看护停了服务）
      const ok = await client.health().catch(() => false);
      if (!ok) {
        throw new Error(
          `外接模式：DSH 服务未运行（127.0.0.1:${port}）。请先启动您的 DSH，或改用 embedded 模式。`
        );
      }
      this._impl = 'external';
      this._client = client;
      this._headless = null;
      return this;
    }

    // embedded：HeadlessRunner 就位校验（node / dshBinJs junction / apiKey；失败不阻塞，工具调用时重试）
    if (!this._headless) {
      this._headless = new HeadlessRunner({
        nodePath: this.cfg.nodePath,
        dataDir: this.dataDir,
        config: this.cfg, // apiKey / toolsMode / permissionMode / dshInstallDir 来源
        logger: this.logger,
      });
    }
    await this._headless.prepare();
    this._impl = 'embedded';
    this._client = null;
    return this;
  }

  /** 卸载/重载时回收（仅 embedded 有子进程要收） */
  async dispose() {
    if (this._headless) {
      await this._headless.dispose().catch(() => {});
      this._headless = null;
    }
    this._impl = null;
    this._client = null;
  }

  /** 日志落点（logger 为函数或 {info/warn/error} 对象，两者皆兼容） */
  _log(level, msg) {
    try {
      if (typeof this.logger === 'function') this.logger(msg);
      else if (this.logger && typeof this.logger[level] === 'function') this.logger[level](msg);
    } catch {
      // 日志失败静默
    }
  }
}
