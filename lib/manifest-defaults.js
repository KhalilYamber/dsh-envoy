// manifest-defaults.js —— 配置默认值单一事实源（manifest.json）
// 背景：配置默认值原散在代码常量（task.js DEFAULT_TIMEOUT_MS 等），改默认值要改代码。
// 本模块启动时静态读取 manifest.json 的 contributes.configuration.properties[].default
// （含 mode/defaultCwd/defaultTimeoutMs/approvalTimeoutMs/webPort 等，以那里为准），
// 供各模块取默认值；改默认值只改 manifest.json 一处。
// 降级链：manifest 缺失/损坏/JSON 语法错 → 返回内置兜底小集（仅四个关键运行项，
//         其余键 undefined 由调用方各自兜底）；读取全程 try/catch 静默，不阻塞主流程。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件根定位：从本文件向上找 manifest.json（源码形态 lib/ 下与安装形态一致） */
function locateRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // 已到盘符根
    dir = parent;
  }
}

// manifest 损坏/缺失时的内置兜底（仅关键运行项；正常路径以 manifest.json 为准）
const FALLBACK = {
  mode: 'auto',
  defaultTimeoutMs: 600000,
  approvalTimeoutMs: 180000,
  webPort: 3080,
};

let cache = null;

/** 读取全部默认值（首次调用后缓存；manifest 键覆盖兜底键） */
function load() {
  if (cache) return cache;
  cache = { ...FALLBACK };
  try {
    const root = locateRoot();
    if (!root) return cache;
    const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const props = m?.contributes?.configuration?.properties || {};
    for (const [k, v] of Object.entries(props)) {
      if (v && 'default' in v) cache[k] = v.default;
    }
  } catch {
    // manifest 读取失败静默：用兜底值（默认值缺失只影响默认行为，不阻塞主流程）
  }
  return cache;
}

/** 取单个配置默认值（manifest.properties[].default；manifest 缺失时返回兜底/undefined） */
export function manifestDefault(key) {
  return load()[key];
}

/** 全部默认值副本（dsh_diagnose 体检展示用） */
export function allManifestDefaults() {
  return { ...load() };
}
