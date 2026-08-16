// verify-zip.mjs —— zip 真实性校验（CI 与本地打包共用）
// 校验三项：
//   1. PK 魔数（zip 前 2 字节 = 50 4B）——防「后缀是 zip 其实是 tar/文本」的假 zip
//   2. EOCD 结束标记（文件尾 64KB 内含 50 4B 05 06）——防截断/半成品
//   3. sha256 比对（提供 .sha256 文件或期望哈希时）——防内容被篡改
// 降级链：文件不可读/参数缺失 → 明确报错并退出码 1（校验失败必须可见，不静默）；
//         未提供 sha256 → 只做前两项并注明（打包脚本必传，CI 必传）。
// 用法：node scripts/verify-zip.mjs <zip路径> [sha256文件路径 | 期望哈希]
// 退出码：0 = 通过；1 = 失败
import fs from 'node:fs';
import crypto from 'node:crypto';

const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const SCAN_TAIL = 65557; // EOCD 最小 22 字节 + ZIP64 注释可达 65535，扫描尾 64KB+22

function fail(msg) {
  console.error(`❌ verify-zip: ${msg}`);
  process.exit(1);
}

const zipPath = process.argv[2];
if (!zipPath) fail('缺少参数：用法 node scripts/verify-zip.mjs <zip路径> [sha256文件路径|期望哈希]');

let buf;
try {
  buf = fs.readFileSync(zipPath);
} catch (e) {
  fail(`无法读取 ${zipPath}：${e?.message || e}`);
}

// 1) PK 魔数
if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
  fail(`${zipPath} 不是合法 zip（魔数应为 PK/50 4B，实际 ${buf.length < 2 ? '文件过短' : buf.subarray(0, 2).toString('hex')}）——疑似假 zip（改名文件）`);
}
console.log(`✅ PK 魔数：${zipPath.slice(0, 4)}…（50 4B）`);

// 2) EOCD 结束标记（尾 64KB+22 内扫描）
const tail = buf.subarray(Math.max(0, buf.length - SCAN_TAIL));
const eocdIdx = tail.indexOf(EOCD_SIG);
if (eocdIdx < 0) {
  fail(`缺少 EOCD 结束标记（文件截断或非合法 zip）`);
}
console.log(`✅ EOCD 结束标记：位于尾部偏移 ${eocdIdx} 字节处`);

// 3) sha256 比对（第二参：.sha256 文件路径或期望哈希）
const shaArg = process.argv[3];
if (shaArg) {
  let expected = null;
  try {
    if (fs.existsSync(shaArg) && fs.statSync(shaArg).isFile()) {
      expected = fs.readFileSync(shaArg, 'utf8').replace(/^\uFEFF/, '').trim().split(/\s+/)[0];
    } else {
      expected = shaArg.trim();
    }
  } catch (e) {
    fail(`sha256 参数不可读：${e?.message || e}`);
  }
  expected = String(expected ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    fail(`sha256 期望值格式非法：${expected || '（空）'}`);
  }
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) {
    fail(`sha256 不匹配：期望 ${expected}，实际 ${actual}`);
  }
  console.log(`✅ sha256 匹配：${actual.slice(0, 16)}…`);
} else {
  console.log(`⚠️ 未提供 sha256，仅校验 PK + EOCD`);
}

console.log(`✅ verify-zip 通过：${zipPath}（${buf.length} 字节）`);
