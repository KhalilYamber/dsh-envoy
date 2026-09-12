// external.js —— 外接腿的凭据与客户端工厂（DSH 0.1.2+ 的 token 门）
//
// 凭据来源优先级（主路读“我们自己的文件”，日志只作兜底）：
//   1) 配置 webToken（手工粘贴，兜底用）
//   2) 环境变量 DSH_WEB_TOKEN
//   3) <webLogPath 同目录>/dsh-web.token —— 由启动脚本写入，格式固定，我们说了算
//   4) webLogPath 指向的那份 DSH 启动日志里的 ?token=...（旁路，格式由 DSH 决定，慎用）
//
// webLogPath 在这里是“锚点”：它的目录同时给出 token 文件与日志两处位置。
//
// 换到的浏览器 cookie 缓存到 <dataDir>/external-auth.json（无 dataDir 时 ~/.dsh-bridge/）。
// 该 cookie 由持久密钥签名、Max-Age 约 30 天、跨宿主重启有效；每次启动会变的只有 launchToken。
// 所以正常情况下用户只需让插件自己读一次，之后一个月内都不必再管。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshClient } from './client.js';
import { manifestDefault } from './manifest-defaults.js';

/** 最后兜底：本机启动脚本的输出日志（manifest 的 webLogPath 默认值优先） */
export const FALLBACK_WEB_LOG_PATH = 'D:\\DeepSeek-Harness\\dsh-web.out.log';

/** 启动脚本落下的 token 文件名（与日志同目录） */
export const TOKEN_FILE_NAME = 'dsh-web.token';

/** 由日志路径推出 token 文件路径（同目录、固定文件名） */
export function tokenFilePath(logPath) {
  return path.join(path.dirname(logPath), TOKEN_FILE_NAME);
}

/** 读一份 token 文件；读不到或内容不像 token 时返回 null。 */
export function readTokenFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return /^[A-Za-z0-9_-]{8,}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 从一份 DSH 启动日志里取最近一次打印的 launchToken；取不到返回 null。 */
export function readTokenFromLog(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const hits = [...text.matchAll(/token=([A-Za-z0-9_-]+)/g)];
    return hits.length > 0 ? hits[hits.length - 1][1] : null;
  } catch {
    return null;
  }
}

/** 锚点路径：配置 → manifest 默认 → 内置兜底 */
export function anchorLogPath(cfg = {}) {
  return String(cfg.webLogPath ?? '').trim()
    || manifestDefault('webLogPath')
    || FALLBACK_WEB_LOG_PATH;
}

/** 组装惰性 token 提供者（配置 → 环境变量 → token 文件 → 启动日志）。 */
export function makeTokenProvider(cfg = {}) {
  const explicit = String(cfg.webToken ?? '').trim();
  const logPath = anchorLogPath(cfg);
  return async () => {
    if (explicit) return explicit;
    const fromEnv = String(process.env.DSH_WEB_TOKEN ?? '').trim();
    if (fromEnv) return fromEnv;
    const fromFile = readTokenFile(tokenFilePath(logPath));
    if (fromFile) return fromFile;
    return readTokenFromLog(logPath);
  };
}

/** 外接基址（127.0.0.1:<webPort>）。 */
export function externalBaseUrl(cfg = {}) {
  const port = Number(cfg.externalPort || cfg.webPort || manifestDefault('webPort') || 3080);
  return `http://127.0.0.1:${port}`;
}

/** cookie 缓存文件位置：优先落在插件数据目录。 */
export function authCacheFile(dataDir) {
  return dataDir
    ? path.join(dataDir, 'external-auth.json')
    : path.join(os.homedir(), '.dsh-bridge', 'external-auth.json');
}

/** 建一个已接好凭据的外接客户端（所有外接调用点共用这一个工厂）。 */
export function makeExternalClient(cfg = {}, dataDir, logger) {
  return new DshClient(externalBaseUrl(cfg), {
    tokenProvider: makeTokenProvider(cfg),
    cookieFile: authCacheFile(dataDir),
    logger,
  });
}
