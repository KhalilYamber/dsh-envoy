// lex-scan.mjs —— 词法扫描（防「注释吞函数」事故，发布前必跑）
// 背景：v0.2.1 曾因 /** 注释（对齐 缺 */ 吞掉 nextOpId 等函数，发布版靠文件内容重复侥幸能跑。
//       此后约定改代码后必跑词法扫描，但脚本长期是临时写的，且初版会误报
//       （行注释里的 glob tools/*.js、正则字面量里的 */、含引号字符类的正则）。
// 本脚本是正式版：正确识别字符串（' " `）、正则字面量、行注释、块注释，
// 只对真实问题报警：
//   - 块注释未闭合（吞函数事故的根源，必然导致后续代码被注释掉）
//   - 块注释配对数量不一致
//   - 字符串/正则/模板字面量未终止
// 用法：node scripts/lex-scan.mjs [根目录]
// 退出码：0 = 通过；1 = 存在未闭合/配对异常
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'index.js',
  ...fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f),
  ...fs.readdirSync(path.join(root, 'tools')).filter((f) => f.endsWith('.js')).map((f) => 'tools/' + f),
  ...fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => 'scripts/' + f),
];

// 判定 `/` 可能是正则开始：向前跳过空白，最近的非空白字符属于这些符号
const REGEX_START = new Set(['(', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', ',', '+', '-', '*', '%', '^', '~', '<', '>', '\n']);

let bad = 0;
for (const rel of files) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    bad++;
    console.log(`MISSING FILE: ${rel}`);
    continue;
  }
  const src = fs.readFileSync(full, 'utf8');
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let inStr = null;
  let inRegex = false;
  let opens = 0;
  let closes = 0;
  const blockStarts = [];
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      if (c === '\\') { i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (inRegex) {
      if (c === '\\') { i += 2; continue; }
      if (c === '/') inRegex = false;
      i++;
      continue;
    }
    if (inLine) {
      if (c === '\n') inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; closes++; i += 2; continue; }
      i++;
      continue;
    }
    // code 模式
    if (c === '"' || c === "'" || c === '`') { inStr = c; i++; continue; }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; opens++; blockStarts.push(i); i += 2; continue; }
    if (c === '/' && i > 0) {
      let j = i - 1;
      while (j > 0 && /\s/.test(src[j])) j--;
      if (REGEX_START.has(src[j]) && !/[A-Za-z0-9_)\]\\-]/.test(src[j])) {
        inRegex = true;
        i++;
        continue;
      }
    }
    i++;
  }
  if (inStr) { bad++; console.log(`UNTERMINATED LITERAL: ${rel}（字符串/模板未闭合）`); continue; }
  if (inRegex) { bad++; console.log(`UNTERMINATED REGEX: ${rel}（正则字面量未闭合）`); continue; }
  if (inBlock) {
    bad++;
    console.log(`UNCLOSED BLOCK COMMENT: ${rel}（第 ${src.slice(0, blockStarts[blockStarts.length - 1]).split('\n').length} 行附近，/* 未闭合——吞函数事故的根源）`);
    continue;
  }
  if (opens !== closes) { bad++; console.log(`PAIR MISMATCH: ${rel}（/*=${opens} */=${closes}）`); continue; }
}

console.log(bad === 0 ? `LEX SCAN PASS: ${files.length} files` : `LEX SCAN FAIL: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
