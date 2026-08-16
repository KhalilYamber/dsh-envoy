// task-log.js —— 任务记录落盘（tasks.jsonl，重启后可查任务历史）
// 背景：任务记录（op 快照）原只在内存（globalThis.__dshBridge.ops），宿主重启即丢失。
// 本模块提供终态任务快照的增量追加写与启动恢复：
//   - appendTaskRow：settle 终态后同步追加一行到 <dataDir>/tasks.jsonl（写失败静默）
//   - loadTaskLog：插件启动/首次工具调用时逐行解析恢复进内存 ops Map（幂等）
// 命名：本插件统一叫「任务记录」，文件用 tasks.jsonl（与 DSHana 的 ops.jsonl 保持命名差异）。
// 约束：落盘/恢复是增强机制，失败一律静默降级，绝不阻塞派单主流程；
//       序列化只在持久化时发生，不污染内存 Map（与 session-routes.json 各管一文件、互不干扰）。

import fs from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'tasks.jsonl';

/** 内存任务记录保留最近 N 条（dsh_run 内存裁剪与恢复后裁剪共用同一常量） */
export const OP_KEEP = 50;

/** 终态任务快照序列化：只留元数据，删 output 全文（完整输出见结构化结果 / dsh 会话记录） */
export function serializeTaskRow(op) {
  const row = { ...op };
  delete row.output;
  return row;
}

/**
 * 终态任务记录追加写：同步 append 一行到 <dataDir>/tasks.jsonl。
 * 幂等由调用方保证（settle 终态后每 op 只调一次）；status 为 running 的行拒绝写
 * （任务记录只落终态，恢复端会把 running 行标为上次中断）。
 * 写失败静默：任务记录是增强，不阻塞主流程。
 */
export function appendTaskRow(s, op) {
  if (!s?.dataDir || !op?.opId) return;
  if (op.status === 'running') return; // 只落终态
  try {
    fs.mkdirSync(s.dataDir, { recursive: true });
    fs.appendFileSync(
      path.join(s.dataDir, FILE_NAME),
      JSON.stringify(serializeTaskRow(op)) + '\n',
      'utf8'
    );
  } catch {
    // 落盘失败静默（磁盘满/文件占用都不阻塞主流程）
  }
}

/**
 * 启动恢复：从 <dataDir>/tasks.jsonl 逐行解析恢复进内存 ops Map。
 * 幂等（s._taskLogLoaded 标记：插件启动与首次工具调用双调用点只恢复一次）；
 * 单行损坏跳过只丢该条，不影响其余；同一 opId 多行以落盘最后一行为准覆盖；
 * status 为 running 的行恢复后标 interrupted（上次中断，让 dsh_status 可辨认）；
 * 恢复后遵守 OP_KEEP 裁剪并整体回写对齐（压缩历史行、持久化 interrupted 标记、防文件无界增长）；
 * 加载失败静默：空表启动。
 */
export function loadTaskLog(s) {
  if (!s || typeof s !== 'object') return;
  if (s._taskLogLoaded) return; // 幂等
  s._taskLogLoaded = true;
  if (!s.dataDir) return;
  const file = path.join(s.dataDir, FILE_NAME);
  const rows = [];
  try {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    const lastIdx = new Map(); // opId -> rows 下标（后行覆盖前行，保持文件行序）
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // 单行损坏：跳过该条，不影响其余
      }
      if (!row || typeof row !== 'object' || !row.opId) continue;
      const idx = lastIdx.get(row.opId);
      if (idx !== undefined) rows[idx] = row; // 后行覆盖前行
      else {
        lastIdx.set(row.opId, rows.length);
        rows.push(row);
      }
    }
  } catch {
    return; // 读失败：静默按空表启动
  }
  if (!rows.length) return;
  const interruptedAt = new Date().toISOString();
  if (!s.ops) s.ops = new Map();
  for (const row of rows) {
    // running 行恢复后标 interrupted（重启即中断，符合事实）；终态原样恢复
    s.ops.set(
      row.opId,
      row.status === 'running' ? { ...row, status: 'interrupted', interruptedAt } : row
    );
  }
  // 恢复后同样遵守 OP_KEEP：超出删最老（Map 按插入序，最老在前）
  while (s.ops.size > OP_KEEP) {
    const first = s.ops.keys().next().value;
    if (!first) break;
    s.ops.delete(first);
  }
  // 回写对齐：压缩历史行、持久化 interrupted 标记、防文件无界增长
  try {
    const rowsNow = [...s.ops.values()].map((op) => JSON.stringify(serializeTaskRow(op)));
    fs.mkdirSync(s.dataDir, { recursive: true });
    fs.writeFileSync(file, rowsNow.join('\n') + (rowsNow.length ? '\n' : ''), 'utf8');
  } catch {
    // 回写失败静默：下次 load 再对齐
  }
}
