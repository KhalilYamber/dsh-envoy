// index.js —— DSH Bridge 插件入口
// 职责：初始化进程内单例、启动恢复任务记录、注册卸载清理。
// 连接抽象不在这里启动（懒加载）：工具首次调用时构造 DshConnection 并 ensure()。
// 这样 external 模式零开销（探测一次即可），embedded 模式首次调用时拉起 web host。

import { loadTaskLog } from './lib/task-log.js';

export default class DshBridgePlugin {
  async onload() {
    const { log, config, dataDir } = this.ctx;
    const g = globalThis;

    // 单例：tools/*.js 与 index.js 通过它共享连接、配置与数据目录
    if (!g.__dshBridge || typeof g.__dshBridge !== 'object') {
      g.__dshBridge = {};
    }
    if (this.ctx?.bus && !g.__dshBridge.bus) {
      g.__dshBridge.bus = this.ctx.bus;
    }
    g.__dshBridge.dataDir = dataDir;
    g.__dshBridge.cfgSnapshot = config;
    loadTaskLog(g.__dshBridge); // 启动恢复任务记录（幂等；工具首次调用还会兜底，见 dsh-run/dsh-status）

    // 卸载/重载/禁用时回收（仅 embedded 有子进程要收）
    this.register(() => {
      const s = g.__dshBridge;
      if (s?.connection && typeof s.connection.dispose === 'function') {
        s.connection.dispose().catch(() => {});
      }
      g.__dshBridge = null;
    });

    log?.info?.('[dsh-bridge] loaded');
  }
}
