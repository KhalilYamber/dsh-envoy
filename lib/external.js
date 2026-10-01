// external.js —— 外接腿的凭据与客户端工厂（DSH 0.1.2+ 的 token 门；桌面端走本地密钥）
//
// 基址（双形态支持，向后兼容）：
//   Web 版 DSH 监听 127.0.0.1:3080；桌面版 DSH 监听 127.0.0.1:19387（桌面宿主写死 `--port 19387`）。
//   外接客户端同时拿这两个候选，逐个探测，谁活着连谁：Web 用户与桌面用户共用同一份插件、零配置。
//
// 凭据来源优先级（主路读“我们自己的文件”，日志只作兜底）：
//   1) 配置 webToken（手工粘贴，兜底用）
//   2) 环境变量 DSH_WEB_TOKEN
//   3) <webLogPath 同目录>/dsh-web.token —— 由启动脚本写入，格式固定，我们说了算
//   4) webLogPath 指向的那份 DSH 启动日志里的 ?token=...（旁路，格式由 DSH 决定，慎用）
//   5) 以上全落空（典型：桌面端不打印 token）时，读 $DSH_HOME/.credentials.yaml 的签名密钥，
//      本地铸一张 authority 绑定的浏览器 cookie（见 desktop-credentials.js）。
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
import { makeCookieMinter } from './desktop-credentials.js';

/** 最后兜底：本机启动脚本的输出日志（manifest 的 webLogPath 默认值优先） */
export const FALLBACK_WEB_LOG_PATH = 'D:\\DeepSeek-Harness\\dsh-web.out.log';

/** 桌面端 DSH 固定监听端口（桌面宿主启动参数写死 `--port 19387`）。 */
export const DESKTOP_DSH_PORT = 19387;

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

/**
 * 外接候选端口（有序去重）：
 *   主候选 = 配置 externalPort/webPort（默认 3080，Web 时代）；
 *   次候选 = 配置 desktopPort（默认 19387，桌面端）。
 * 多候选由客户端逐个探测，谁活着连谁；Web 用户与桌面用户共用同一份插件、零配置。
 */
export function candidatePorts(cfg = {}) {
  const out = [];
  const push = (v) => {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && n <= 65535 && !out.includes(n)) out.push(n);
  };
  push(cfg.externalPort || cfg.webPort || manifestDefault('webPort') || 3080);
  push(cfg.desktopPort || manifestDefault('desktopPort') || DESKTOP_DSH_PORT);
  return out;
}

/** 外接候选基址（127.0.0.1:<port>，按候选顺序）。 */
export function candidateBaseUrls(cfg = {}) {
  return candidatePorts(cfg).map((p) => `http://127.0.0.1:${p}`);
}

/** 外接主基址（候选之首；保留旧调用契约）。 */
export function externalBaseUrl(cfg = {}) {
  return candidateBaseUrls(cfg)[0] ?? `http://127.0.0.1:${DESKTOP_DSH_PORT}`;
}

/** cookie 缓存文件位置：优先落在插件数据目录。 */
export function authCacheFile(dataDir) {
  return dataDir
    ? path.join(dataDir, 'external-auth.json')
    : path.join(os.homedir(), '.dsh-bridge', 'external-auth.json');
}

/** 建一个已接好凭据的外接客户端（所有外接调用点共用这一个工厂）。
 *  传入 baseUrl 时只用它（单候选）；否则用候选列表（Web 3080 → 桌面 19387，逐个探测）。 */
export function makeExternalClient(cfg = {}, dataDir, logger, baseUrl) {
  const urls = baseUrl ? [baseUrl] : candidateBaseUrls(cfg);
  return new DshClient(urls[0], {
    baseUrls: urls,
    tokenProvider: makeTokenProvider(cfg),
    cookieMinter: makeCookieMinter(cfg), // 桌面端：无 token 时用本地签名密钥铸 cookie
    cookieFile: authCacheFile(dataDir),
    logger,
  });
}
