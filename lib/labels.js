// labels.js —— 工作标签计数器【MMdd-NN】
// 同天递增、跨天归零、文件损坏自愈、写失败静默（不影响本次取号）
// 数据文件放插件数据目录（ctx.dataDir/labels.json）；dataDir 缺失时仅内存取号（不落盘）
// 并发安全：文件读写非原子，同进程并发 next() 可能读到同一 seq 撞号；
//           模块级内存序列兜底（同进程内保证不重复，跨进程仍以文件为准）

import fs from 'node:fs';
import path from 'node:path';

// 进程内取号序列（并发防重：并发调用都读到文件同一 seq 时，跟随内存序列递增）
let memDate = '';
let memSeq = 0;

export class LabelStore {
  constructor(dataDir) {
    // dataDir 缺失（宿主未传）时 file 为 null：仅内存取号，不读写文件
    this.file = dataDir ? path.join(dataDir, 'labels.json') : null;
  }

  /** 取下一个标签，如 '0815-01' */
  next() {
    const now = new Date();
    const mmdd =
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');

    let date = mmdd;
    let seq = 1;

    if (this.file) {
      try {
        if (fs.existsSync(this.file)) {
          const raw = fs.readFileSync(this.file, 'utf8');
          const c = JSON.parse(raw);
          if (c && typeof c.date === 'string' && typeof c.seq === 'number' && c.seq >= 1) {
            if (c.date === mmdd) {
              date = c.date;
              seq = c.seq + 1;
            } else {
              // 跨天归零
              date = mmdd;
              seq = 1;
            }
          }
        }
      } catch {
        // 损坏自愈：按重建路径走
      }

      try {
        // 数据目录可能尚未创建（首次调用），先确保存在再写
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify({ date, seq }), 'utf8');
      } catch {
        // 写失败静默，本次标签照常返回
      }
    }

    // 并发兜底：同进程内内存序列已领先（并发调用都读到文件同一 seq）时，跟随内存序列
    if (memDate === date && memSeq >= seq) seq = memSeq + 1;
    memDate = date;
    memSeq = seq;

    return `${date}-${String(seq).padStart(2, '0')}`;
  }
}
