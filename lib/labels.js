// labels.js —— 工作标签计数器【MMdd-NN】
// 同天递增、跨天归零、文件损坏自愈、写失败静默（不影响本次取号）
// 数据文件放插件数据目录（ctx.dataDir/labels.json）

import fs from 'node:fs';
import path from 'node:path';

export class LabelStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'labels.json');
  }

  /** 取下一个标签，如 '0815-01' */
  next() {
    const now = new Date();
    const mmdd =
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');

    let date = mmdd;
    let seq = 1;

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

    return `${date}-${String(seq).padStart(2, '0')}`;
  }
}
