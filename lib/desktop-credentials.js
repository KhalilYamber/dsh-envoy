// desktop-credentials.js —— 桌面端 DSH 的本地凭据（外接模式免 token 路线）
//
// 背景：Web 版 DSH（`dsh web`）会打印带 ?token=... 的应用 URL，并把 token 留在启动脚本的
// 文件/日志里，插件据此换一张浏览器 cookie。桌面版 DSH 不打印、也不落盘任何 token——
// 它的启动令牌只活在进程内存里，外部进程拿不到。
//
// 但桌面端把「cookie 签名密钥」持久化了：`$DSH_HOME/.credentials.yaml` 里
// `client-connection/browser-session` 这条 grant 记录的 secret。有了它，插件可以在本地
// 自己铸一张 authority 绑定的浏览器 cookie，效果等同于「手动登录一次并保存 cookie」，
// 无需用户粘任何东西。
//
// 协议依据（@deepseek-ai/dsh-client-connection 的 browser-auth 实现，2026-10-01 对活服务实测）：
//   1) cookie 名 = `dsh-auth-` + base64url(sha256(authority))，authority 形如 `127.0.0.1:19387`
//   2) cookie 值 = `v1.<body>.<sig>`
//        body = base64url(JSON({version:1, authority, issuedAt, expiresAt}))
//        sig  = base64url(HMAC-SHA256(secret, body))
//   3) 服务端校验：payload.authority 一致、未过期，且 expiresAt - issuedAt <= cookieMaxAgeDays（默认 30 天）
//   4) secret = base64url 解码后 32 字节
// 因为有效期上限由 DSH 侧配置决定，这里默认只铸 1 天（远小于任何合理上限），过期即重铸——
// 铸 cookie 是纯本地计算，代价可忽略，换来的是不依赖 DSH 的具体 maxAge 配置。
//
// 只读：本模块只读 .credentials.yaml，不写任何文件、不改任何状态。找不到密钥时返回 null，
// 调用方回落原有 token 老路或给出人话提示。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';

/** 铸出的 cookie 有效期（天）。故意取小值以兼容任何 cookieMaxAgeDays 配置。 */
export const MINT_DAYS = 1;

/** base64url 编码（无填充）。 */
function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** base64url 解码；非法字符或长度不合法时返回 null。 */
function decodeB64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) return null;
  if (value.length % 4 === 1) return null;
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  try {
    return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + pad, 'base64');
  } catch {
    return null;
  }
}

/**
 * DSH 家目录：配置 dshHome → 环境变量 DSH_HOME → ~/.dsh。
 * @param {object} cfg 插件配置
 * @returns {string} 绝对路径
 */
export function dshHome(cfg = {}) {
  const explicit = String(cfg?.dshHome ?? '').trim();
  if (explicit) return explicit;
  const fromEnv = String(process.env.DSH_HOME ?? '').trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

/** 凭据文件路径（`<DSH 家目录>/.credentials.yaml`）。 */
export function credentialsFilePath(cfg = {}) {
  return path.join(dshHome(cfg), '.credentials.yaml');
}

/**
 * 从凭据文件的 YAML 文本里取 `client-connection/browser-session` 的 secret。
 * 只做定向提取：定位该记录的键，扫到下一个同级/更浅的键为止，再在其中取 secret。
 * 不实现通用 YAML，也不解析其它记录。
 * @param {string} text 凭据文件全文
 * @returns {string|null} base64url 形式的 secret，取不到返回 null
 */
export function extractBrowserSessionSecret(text) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*client-connection\/browser-session\s*:/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const indent = (lines[start].match(/^(\s*)/)?.[1] ?? '').length;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j += 1) {
    const line = lines[j];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const ind = (line.match(/^(\s*)/)?.[1] ?? '').length;
    if (ind <= indent) { end = j; break; }
  }
  for (let j = start; j < end; j += 1) {
    const m = lines[j].match(/^\s*secret\s*:\s*([A-Za-z0-9_-]+)\s*$/);
    if (m) return m[1];
  }
  return null;
}

/**
 * 读凭据文件并取签名密钥（读不到文件/记录时返回 null，不抛）。
 * @param {object} cfg 插件配置
 * @returns {string|null} base64url secret
 */
export function readBrowserSessionSecret(cfg = {}) {
  try {
    const text = fs.readFileSync(credentialsFilePath(cfg), 'utf8');
    return extractBrowserSessionSecret(text);
  } catch {
    return null;
  }
}

/**
 * 用签名密钥本地铸一张 authority 绑定的浏览器 cookie。
 * @param {string} authority 形如 `127.0.0.1:19387`（客户端实际发出的 Host）
 * @param {string} secretB64url base64url 形式的 32 字节签名密钥
 * @param {object} [options]
 * @param {number} [options.days] 有效期（天），默认 1
 * @returns {{authority:string, cookie:string, expiresAt:number}|null} 铸不出返回 null
 */
export function mintBrowserCookie(authority, secretB64url, { days = MINT_DAYS } = {}) {
  const auth = String(authority ?? '').trim();
  if (!auth) return null;
  const secret = decodeB64url(secretB64url);
  if (!secret || secret.byteLength !== 32) return null;
  const effectiveDays = Number(days) > 0 ? Number(days) : MINT_DAYS;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + effectiveDays * 24 * 60 * 60 * 1000;
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: auth, issuedAt, expiresAt }), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  const name = `dsh-auth-${b64url(createHash('sha256').update(auth).digest())}`;
  return { authority: auth, cookie: `${name}=v1.${body}.${sig}`, expiresAt };
}

/**
 * 组装外接客户端用的惰性凭据提供者：被问到时才读密钥、铸 cookie。
 * 找不到密钥返回 null（调用方回落 token 老路 / 报人话错误）。
 * @param {object} cfg 插件配置
 * @returns {(authority: string) => Promise<object|null>}
 */
export function makeCookieMinter(cfg = {}) {
  return async (authority) => {
    const secret = readBrowserSessionSecret(cfg);
    if (!secret) return null;
    return mintBrowserCookie(authority, secret);
  };
}
