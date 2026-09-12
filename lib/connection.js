// connection.js —— DSH 连接工厂（薄桥 2.0 传输层）
// 双传输腿共享状态机：
//   external：HTTP 直连用户自跑的 DSH web host（默认 127.0.0.1:3080），审批完整，沿用 v0.2.5 帧处理
//   bundled：官方 SDK runtime（spawn + stdio JSON-RPC，官方 SDK client 驱动），fail-closed 无审批
// mode: 'auto'（默认）探测外部服务，有则 external，无则 bundled。
// 能力探针：external = HTTP 可达性（200 或 401 都算活着，凭据单独校验）；bundled = 官方 SDK
//           initialize 的 serverInfo（deepseek-harness-sdk-runtime）。
// 一个 DSH 原则：不写 patch、不改用户配置、不建 junction；bundled 只依赖官方 npm 安装命令的产出。
//
// 0.1.2+ 变化：根地址无凭据回 401，所以「服务在不在」与「凭据行不行」拆成两步——
//   可达性用 reachable()，凭据用 ensureAuth()。旧版拿 health() 当存活探针的写法会误判。

import { makeExternalClient, externalBaseUrl } from './external.js';
import { SdkLeg } from './sdk-leg.js';
import { manifestDefault } from './manifest-defaults.js';

export class DshConnection {
  constructor({ mode, cfg, dataDir, logger }) {
    this.mode = mode;            // 'auto' | 'bundled' | 'external'
    this.cfg = cfg;              // 插件配置（含直读 config.json 的最新值，见 resolveLiveConfig）
    this.dataDir = dataDir;
    this.logger = logger || (() => {});
    this._impl = null;           // 'bundled' | 'external'
    this._client = null;
    this._sdkLeg = null;
  }

  get effectiveMode() {
    return this._impl;
  }

  get client() {
    if (!this._client) throw new Error('DSH 连接尚未就绪，请先调用 ensure()');
    return this._client;
  }

  /** SdkLeg 实例（bundled 模式；external 模式为 null） */
  get sdkLeg() {
    return this._sdkLeg;
  }

  /** 外接基址（排障提示复用） */
  externalBase() {
    return externalBaseUrl(this.cfg);
  }

  /** 重建一个外接客户端（带 token 提供者与 cookie 缓存） */
  externalClient() {
    return makeExternalClient(this.cfg, this.dataDir, this.logger);
  }

  /** 解析最终模式（auto 探测；判定原因写日志供排障） */
  async resolveMode() {
    const want = this.cfg.mode || 'auto';
    if (want === 'bundled' || want === 'embedded') return 'bundled'; // embedded 为历史配置值，等价 bundled
    if (want === 'external') return 'external';
    // auto：探测外部服务（只判可达，不要求凭据），可用则外接
    const probe = this.externalClient();
    if (await probe.reachable()) {
      this._log('info', `[dsh-bridge] auto 探测：${this.externalBase()} 可达 → external`);
      return 'external';
    }
    this._log('info', `[dsh-bridge] auto 探测：${this.externalBase()} 不可达 → bundled`);
    return 'bundled';
  }

  /** 确保连接可用；external 校验可达与凭据，bundled 校验官方 SDK runtime 就位（不 spawn） */
  async ensure() {
    const mode = await this.resolveMode();
    this._log('info', `[dsh-bridge] 生效模式：${mode}（配置 mode=${this.cfg.mode || 'auto'}）`);
    if (mode === 'external') {
      const client = this.externalClient();
      // 存活：失败时给出「服务未启动」的人话提示（auto 模式下可能是闲置看护停了服务）
      if (!(await client.reachable())) {
        throw new Error(
          `外接模式：DSH 服务未运行（${this.externalBase()}）。请先启动您的 DSH，或改用 bundled 模式。`
        );
      }
      // 凭据：token → cookie。cookie 缓存有效时不打扰用户。
      try {
        await client.ensureAuth();
      } catch (e) {
        if (e?.code === 'auth-token-missing' || e?.code === 'auth-failed') {
          throw new Error(
            `外接模式：DSH 服务在跑，但没有可用访问凭据。${e.message}`
          );
        }
        throw e;
      }
      this._impl = 'external';
      this._client = client;
      this._sdkLeg = null;
      return this;
    }

    // bundled：SdkLeg 就位校验（官方 npm 安装产出：node / bundled 配置项目 / apiKey；失败不阻塞，工具调用时重试）
    if (!this._sdkLeg) {
      this._sdkLeg = new SdkLeg({
        nodePath: this.cfg.nodePath,
        dataDir: this.dataDir,
        config: this.cfg, // apiKey / permissionMode / defaultCwd 来源
        logger: this.logger,
      });
    }
    await this._sdkLeg.prepare();
    this._impl = 'bundled';
    this._client = null;
    return this;
  }

  /** 卸载/重载时回收（仅 bundled 有子进程要收） */
  async dispose() {
    if (this._sdkLeg) {
      await this._sdkLeg.dispose().catch(() => {});
      this._sdkLeg = null;
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
