// session-routes.js —— 项目级会话延续机制（cwd → 活跃 sessionId 路由表）
// 背景：dsh_run 每次派单若不显式传 sessionId 就新建会话，同一工程多次派单后
//       DSH 侧产生大量碎片会话，重复读项目文件、重复理解工程，浪费 token。
// 职责：维护 cwd → sessionId 的映射，落盘到 <dataDir>/session-routes.json（原子写）。
// 约束：只保留每个 cwd 最近一个活跃会话（不积累历史，防止表无限膨胀）；
//       路由失效（会话不存在/已归档）由调用方负责摘除；
//       读写失败一律静默降级（会话延续是增强机制，不阻塞派单主流程）。

import fs from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'session-routes.json';

export class SessionRoutes {
  /**
   * @param {string} [dataDir] 插件数据目录；为空时不落盘（仅内存，进程内有效）
   */
  constructor(dataDir) {
    this.dataDir = dataDir || null;
    this._file = this.dataDir ? path.join(this.dataDir, FILE_NAME) : null;
    this._routes = {}; // { [cwd]: { sessionId, updatedAt } }
    this._loaded = false;
  }

  /** 加载路由表（插件启动/首次使用时调用；文件缺失/损坏 → 空表） */
  load() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this._file) return;
    try {
      if (fs.existsSync(this._file)) {
        const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
        const routes = raw?.routes && typeof raw.routes === 'object' ? raw.routes : {};
        for (const [cwd, v] of Object.entries(routes)) {
          if (
            typeof cwd === 'string' &&
            cwd &&
            v &&
            typeof v.sessionId === 'string' &&
            v.sessionId
          ) {
            this._routes[cwd] = {
              sessionId: v.sessionId,
              updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : new Date().toISOString(),
            };
          }
        }
      }
    } catch {
      // 文件损坏：静默用空表（路由机制是增强，不阻塞）
      this._routes = {};
    }
  }

  /** 按 cwd 查活跃会话 id（未命中返回 null） */
  get(cwd) {
    this.load();
    if (!cwd) return null;
    const hit = this._routes[cwd];
    return hit?.sessionId ?? null;
  }

  /** 登记/更新路由并落盘；dataDir 缺失时仅内存生效 */
  set(cwd, sessionId) {
    this.load();
    if (!cwd || !sessionId) return;
    this._routes[cwd] = { sessionId, updatedAt: new Date().toISOString() };
    this._save();
  }

  /** 摘除指定 cwd 的路由并落盘 */
  remove(cwd) {
    this.load();
    if (!cwd) return;
    if (Object.prototype.hasOwnProperty.call(this._routes, cwd)) {
      delete this._routes[cwd];
      this._save();
    }
  }

  /** 按 sessionId 摘除所有匹配路由（dsh_cancel 后调用，不依赖 cwd） */
  removeBySessionId(sessionId) {
    this.load();
    if (!sessionId) return 0;
    let removed = 0;
    for (const [cwd, v] of Object.entries(this._routes)) {
      if (v.sessionId === sessionId) {
        delete this._routes[cwd];
        removed += 1;
      }
    }
    if (removed) this._save();
    return removed;
  }

  /** 路由表副本（dsh_status 展示用） */
  all() {
    this.load();
    const out = {};
    for (const [cwd, v] of Object.entries(this._routes)) {
      out[cwd] = { ...v };
    }
    return out;
  }

  /** 原子写：临时文件 + rename（避免半截文件）；失败静默 */
  _save() {
    if (!this._file) return;
    try {
      const payload = JSON.stringify({ version: 1, routes: this._routes }, null, 2);
      const tmp = `${this._file}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this._file);
    } catch {
      // 落盘失败静默（路由机制是增强，不阻塞派单）
    }
  }
}
