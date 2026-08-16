// dsh-diagnose.js —— 自愈诊断工具（dsh_diagnose，只读）
// 体检四检（对齐 DSHana 就位校验链精神 + 运行级验证原则「能跑才算好」，杜绝「文件存在 = 就绪」的假就绪）：
//   t1 Node.js：配置存在性 + 真跑 node --version + npm-cli.js 存在性；未配置时给出本机候选列表
//   t2 依赖：cliBin（@deepseek-ai/dsh/lib/bin.js）存在性 + 真跑 node cliBin --version，
//            沿依赖图加载，专门抓 ERR_MODULE_NOT_FOUND 类「假就绪」
//   t3 连接：external 对 3080 做健康检查；embedded 输出就位校验结果
//   t4 上次退出记录：dataDir/last-exit.json（headless 进程每次终态落盘，重启后可查）
// 门禁链：t1 不过 → t2/t3 结果标注「不可信」；每项检查给人话修复指引（坏在哪/为什么坏/怎么修）
// 降级链：单项检查失败记 {ok:false, error} 不抛；整体读取失败静默降级；只读工具
//         （sessionPermission readOnly），不建立连接、不拉起任何服务、不写任何文件。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DshClient } from '../lib/client.js';
import { manifestDefault } from '../lib/manifest-defaults.js';

export const name = 'dsh_diagnose';

export const description =
  'dsh 连接自愈体检（只读，无副作用）：四项检查定位「连不上 DSH」到底坏在哪一环——' +
  '① Node.js（真跑 node --version 验证 + npm-cli.js 存在性，未配置时给出本机候选列表）；' +
  '② 依赖（真跑 node <dsh cliBin> --version，沿依赖图加载，抓 ERR_MODULE_NOT_FOUND 类假就绪）；' +
  '③ 连接（external 对 3080 健康检查 / embedded 就位校验结果）；' +
  '④ 上次退出记录（headless 进程上次退出码/时间/stderr 尾部，重启后可查）。' +
  '每项附人话修复指引（坏在哪/为什么坏/怎么修）；t1 不过时 t2/t3 结果标注不可信。' +
  '不建立连接、不拉起服务，纯只读。';

export const parameters = {
  type: 'object',
  properties: {},
  required: [],
};

export const sessionPermission = { readOnly: true };

// ---- 进程内单例（与 dsh-run.js 同构）----

function singleton(ctx) {
  const g = globalThis;
  if (!g.__dshBridge || typeof g.__dshBridge !== 'object') g.__dshBridge = {};
  const s = g.__dshBridge;
  if (ctx?.bus && !s.bus) s.bus = ctx.bus;
  if (ctx?.dataDir && !s.dataDir) s.dataDir = ctx.dataDir;
  if (ctx?.config && !s.cfgSnapshot) s.cfgSnapshot = ctx.config;
  return s;
}

/** liveConfig 合并（协议实测 6.2）：宿主快照打底，直读 dataDir/config.json 的 global 键覆盖（直读优先） */
function liveConfig(s) {
  const merged = { ...(s.cfgSnapshot ?? {}) };
  try {
    if (s.dataDir) {
      const file = path.join(s.dataDir, 'config.json');
      if (fs.existsSync(file)) {
        const g = JSON.parse(fs.readFileSync(file, 'utf8'))?.global;
        if (g && typeof g === 'object') {
          for (const [k, v] of Object.entries(g)) {
            if (v != null && v !== '') merged[k] = v;
          }
        }
      }
    }
  } catch {
    // config.json 损坏静默，用快照
  }
  return merged;
}

// ---- t1：Node.js（配置存在性 + 运行级验证 + 候选列表）----

/** node 候选链（按通用性排序：配置 → PATH → 常见安装位置 → 工具环境变量 nvm/volta） */
function nodeCandidates(cfg) {
  const list = [];
  const push = (p) => {
    if (p && typeof p === 'string' && p.trim() && !list.includes(p)) list.push(p.trim());
  };
  push(cfg.nodePath); // 1. 插件配置（设置界面 / config.json 直读 / manifest 默认）
  if (process.env.NVM_SYMLINK) push(path.join(process.env.NVM_SYMLINK, 'node.exe')); // nvm-windows
  if (process.env.VOLTA_HOME) push(path.join(process.env.VOLTA_HOME, 'bin', 'node.exe')); // volta
  if (process.env.FNM_DIR) push(path.join(process.env.FNM_DIR, 'node.exe')); // fnm
  push('D:\\NodeJS\\node.exe'); // 常见安装位置（本机实测）
  push('C:\\Program Files\\nodejs\\node.exe');
  push('C:\\Program Files (x86)\\nodejs\\node.exe');
  push(path.join(os.homedir(), 'AppData', 'Roaming', 'nvm', 'node.exe')); // nvm-windows 默认
  return list;
}

/** 真跑 node --version（10s 超时）；返回 {ok, version, error} */
function runNodeVersion(nodePath) {
  try {
    const r = spawnSync(nodePath, ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0 && String(r.stdout ?? '').trim()) {
      return { ok: true, version: String(r.stdout).trim() };
    }
    const err = String(r.stderr ?? '').trim() || `退出码 ${r.status}`;
    return { ok: false, error: err.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** 定位 PATH 中的 node（where/which 首条；找不到返回 null） */
function findPathNode() {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) {
      const line = String(r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (line) return line;
    }
  } catch {
    // 静默：PATH 定位失败不影响候选链
  }
  return null;
}

/** npm-cli.js 存在性（node 安装目录的 npm 入口；找不到返回 null） */
function findNpmCli(nodePath) {
  const dir = path.dirname(nodePath);
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // 单个候选检查失败静默
    }
  }
  return null;
}

/** t1 检查：候选链逐个「存在 + 真跑 --version」；全失败时 PATH 兜底；返回修复指引。
 *  配置的 nodePath 无效但 PATH 兜底成功时，结果标注 configBroken（A2 场景：改坏 nodePath 也能被指出）。 */
function checkT1(cfg) {
  const candidates = nodeCandidates(cfg);
  const seen = new Set();
  let broken = null; // 存在但跑不起来的首个候选（供「为什么坏」说明）

  // 配置的 nodePath 有效性预判（即使 PATH 兜底成功也要报告配置问题）
  let configBroken = false;
  let configError = null;
  const cfgNode = cfg.nodePath && String(cfg.nodePath).trim();
  if (cfgNode) {
    let exists = false;
    try {
      exists = fs.existsSync(cfgNode);
    } catch {
      exists = false;
    }
    if (!exists) {
      configBroken = true;
      configError = `配置的 nodePath=${cfgNode} 不存在`;
    } else {
      const r = runNodeVersion(cfgNode);
      if (!r.ok) {
        configBroken = true;
        configError = `配置的 nodePath=${cfgNode} 存在但运行失败（${r.error}）`;
      }
    }
  }

  for (const cand of candidates) {
    if (seen.has(cand)) continue;
    seen.add(cand);
    let exists = false;
    try {
      exists = fs.existsSync(cand);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    const run = runNodeVersion(cand);
    if (run.ok) {
      return {
        ok: true,
        nodePath: cand,
        version: run.version,
        npmCli: findNpmCli(cand),
        source: cand === cfgNode ? '配置 nodePath' : '候选探测',
        configBroken,
        configError,
        candidates,
      };
    }
    broken = broken ?? { path: cand, error: run.error };
  }
  // PATH 兜底：真跑 PATH 的 node
  const pathRun = runNodeVersion('node');
  if (pathRun.ok) {
    const resolved = findPathNode() ?? 'node（PATH）';
    return {
      ok: true,
      nodePath: resolved,
      version: pathRun.version,
      npmCli: resolved === 'node（PATH）' ? null : findNpmCli(resolved),
      source: 'PATH',
      configBroken,
      configError,
      candidates,
    };
  }
  // 全失败：给修复指引
  const how =
    `安装 Node 24+（https://nodejs.org），或在插件设置「nodePath」填写 node.exe 绝对路径` +
    (candidates.length ? `；本机候选：${candidates.slice(0, 3).join('、')}` : '');
  return {
    ok: false,
    error: configError ?? (broken ? `候选 ${broken.path} 存在但运行失败（${broken.error}）` : '未找到可用的 node.exe（PATH/常见位置/nvm/volta 均未命中）'),
    fix: {
      where: configError ?? `配置的 nodePath=${cfgNode || '（未配置）'} 不可用`,
      why: '找不到能跑起来的 node.exe（文件不存在，或存在但启动失败）',
      how,
    },
    configBroken,
    configError,
    candidates,
  };
}

// ---- t2：依赖（cliBin 存在性 + 运行级验证，抓 ERR_MODULE_NOT_FOUND 假就绪）----

/** cliBin 候选链（对齐 headless._resolveBinJs：junction → 配置 dshInstallDir → 常见安装位置） */
function cliBinCandidates(cfg, s) {
  const list = [];
  const push = (p) => {
    if (p && typeof p === 'string' && p.trim() && !list.includes(p)) list.push(p.trim());
  };
  if (s.dataDir) {
    push(path.join(s.dataDir, 'dsh-node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  const cfgRoot = cfg.dshInstallDir;
  if (cfgRoot) push(path.join(cfgRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  push(path.join('D:\\DeepSeek-Harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  push(path.join(os.homedir(), '.dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  return list;
}

/** 真跑 node <cliBin> --version（30s 超时）；专门识别 ERR_MODULE_NOT_FOUND 类「假就绪」 */
function runCliBin(nodePath, cliBin) {
  try {
    const r = spawnSync(nodePath, [cliBin, '--version'], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = String(r.stdout ?? '').trim();
    const stderr = String(r.stderr ?? '').trim();
    if (r.status === 0 && stdout) return { ok: true, version: stdout };
    // 假就绪：文件在但依赖图加载失败（node_modules 不完整/损坏/junction 断链）
    const fakeReady = /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_REQUIRE_ESM/i.test(stderr);
    return { ok: false, fakeReady, error: stderr.slice(0, 300) || `退出码 ${r.status}` };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** t2 检查：cliBin 存在性 + 运行级验证；依赖 t1 提供的可用 node */
function checkT2(cfg, s, nodePath) {
  const candidates = cliBinCandidates(cfg, s);
  const seen = new Set();
  for (const cand of candidates) {
    if (seen.has(cand)) continue;
    seen.add(cand);
    let exists = false;
    try {
      exists = fs.existsSync(cand);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    const run = runCliBin(nodePath, cand);
    if (run.ok) {
      return { ok: true, cliBin: cand, version: run.version, source: '运行级验证通过', candidates };
    }
    return {
      ok: false,
      exists: true,
      cliBin: cand,
      error: run.error,
      fakeReady: Boolean(run.fakeReady),
      fix: {
        where: `dsh cliBin 存在（${cand}）但运行失败`,
        why: run.fakeReady
          ? '依赖图加载失败（ERR_MODULE_NOT_FOUND 类）：node_modules 不完整/损坏，或 junction 断链——典型的「文件在但没就绪」'
          : `启动失败：${run.error}`,
        how: '重新安装/修复本机 DSH 的 node_modules（如 npm ci），或在插件设置「dshInstallDir」指向完整安装根目录；junction 断链可删除插件数据目录 dsh-node_modules 后重试',
      },
      candidates,
    };
  }
  return {
    ok: false,
    exists: false,
    error: '未找到 dsh 依赖（cliBin）',
    fix: {
      where: 'dsh cliBin 不存在（已探测：' + (candidates.slice(0, 2).join('、') || '无候选') + '）',
      why: '本机未安装 DeepSeek Harness，或安装位置不在探测链内',
      how: '安装 DeepSeek Harness（https://github.com/deepseek-ai/deepseek-harness），或在插件设置「dshInstallDir」填写安装根目录',
    },
    candidates,
  };
}

// ---- t3：连接（external 健康检查 / embedded 就位校验结果）----

async function checkT3(cfg) {
  const mode = cfg.mode || manifestDefault('mode') || 'auto';
  if (mode === 'embedded') {
    // embedded 无端口无连接：就位校验（node/bin/key 解析）由 t1/t2 与首次派单覆盖
    return {
      mode: 'embedded',
      ok: null,
      note: '内置模式无端口无连接：Node/dsh 依赖见 t1/t2；apiKey 由 dsh_run 首次派单时校验',
    };
  }
  const port = Number(cfg.externalPort || cfg.webPort || manifestDefault('webPort'));
  const healthy = await new DshClient(`http://127.0.0.1:${port}`)
    .health()
    .then(() => true)
    .catch(() => false);
  return {
    mode: mode === 'external' ? 'external' : 'auto（探测 external）',
    port,
    ok: healthy,
    fix: healthy
      ? null
      : {
          where: `DSH 服务 127.0.0.1:${port} 不可达`,
          why: '服务未启动、端口被占用、或监听地址不是 127.0.0.1',
          how: `启动您的 DSH（浏览器打开 http://127.0.0.1:${port} 验证）；不想跑服务可把 mode 改为 embedded（需 apiKey）`,
        },
  };
}

// ---- t4：上次退出记录（dataDir/last-exit.json，headless 进程每次终态落盘）----

function checkT4(s) {
  if (!s.dataDir) {
    return { ok: false, error: 'dataDir 未知（宿主未注入），无法读取上次退出记录' };
  }
  try {
    const file = path.join(s.dataDir, 'last-exit.json');
    if (!fs.existsSync(file)) {
      return { ok: true, exists: false, note: '无上次退出记录（首次诊断或从未有 headless 进程退出）' };
    }
    return { ok: true, exists: true, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false, error: 'last-exit.json 读取失败（文件损坏），可删除后由下次 headless 任务重建' };
  }
}

// ---- 主流程：四检 + 门禁链 + 文本组装 ----

async function diagnose(ctx) {
  const s = singleton(ctx);
  const cfg = liveConfig(s);

  // t1（门禁之源）
  const t1 = checkT1(cfg);
  const trusted = Boolean(t1.ok && t1.nodePath);

  // t2：依赖 t1 的可用 node；t1 不过 → 只报存在性并标不可信
  const t2 = trusted
    ? checkT2(cfg, s, t1.nodePath)
    : {
        ok: false,
        note: '无可用 Node（t1 未通过），无法做依赖运行级验证',
        trusted: false,
        candidates: cliBinCandidates(cfg, s),
      };

  // t3：独立健康检查（信息仍有用），门禁链标注可信度
  let t3;
  try {
    t3 = await checkT3(cfg);
  } catch (e) {
    t3 = { ok: false, error: e?.message || String(e) }; // 降级：连接检查失败不抛
  }
  t3.trusted = trusted;

  // t4
  const t4 = checkT4(s);

  // ---- 文本组装（人话体检报告）----
  const lines = [];
  lines.push('【dsh 体检报告】');
  lines.push(
    `① Node.js：${t1.ok ? `✅ 可用（${t1.nodePath}，${t1.version}${t1.npmCli ? '；npm-cli.js 存在' : '；npm-cli.js 未找到'}）` : '❌ 不可用'}`
  );
  if (t1.ok && t1.configBroken) {
    lines.push(`   ⚠️ ${t1.configError}，已回退 ${t1.source}；本机候选：${(t1.candidates ?? []).slice(0, 3).join('、') || '无'}`);
  }
  if (!t1.ok && t1.fix) {
    lines.push(`   坏在哪：${t1.fix.where}`);
    lines.push(`   为什么坏：${t1.fix.why}`);
    lines.push(`   怎么修：${t1.fix.how}`);
  } else if (t1.error) {
    lines.push(`   ${t1.error}`);
  }
  lines.push(`② 依赖（dsh cliBin）：${t2.ok ? `✅ 就绪（${t2.cliBin}，${t2.version}；运行级验证通过）` : `❌ ${t2.note || (t2.fakeReady ? '依赖不完整（假就绪：运行级验证失败）' : '不可用')}`}${t2.trusted === false ? '（不可信：t1 未通过）' : ''}`);
  if (!t2.ok && t2.fix) {
    lines.push(`   坏在哪：${t2.fix.where}`);
    lines.push(`   为什么坏：${t2.fix.why}`);
    lines.push(`   怎么修：${t2.fix.how}`);
  } else if (!t2.ok && t2.error) {
    lines.push(`   ${t2.error}`);
  }
  lines.push(`③ 连接：${t3.ok === null ? `（${t3.mode}）${t3.note ?? ''}` : t3.ok ? `✅ ${t3.mode} 127.0.0.1:${t3.port} 健康` : `❌ ${t3.mode} 127.0.0.1:${t3.port} 不可达`}${t3.trusted === false ? '（不可信：t1 未通过）' : ''}`);
  if (t3.fix) {
    lines.push(`   坏在哪：${t3.fix.where}`);
    lines.push(`   为什么坏：${t3.fix.why}`);
    lines.push(`   怎么修：${t3.fix.how}`);
  } else if (t3.error) {
    lines.push(`   ${t3.error}`);
  }
  lines.push(`④ 上次退出记录：${t4.exists ? `✅ ${t4.mode === 'embedded' ? '内置进程' : '记录'} ${t4.endedAt ?? '时间未知'}，exit=${t4.exitCode ?? '-'}${t4.stderrTail ? `，stderr 尾部：${String(t4.stderrTail).slice(0, 120)}` : ''}` : t4.note || `❌ ${t4.error || '读取失败'}`}`);
  if (t4.ok === false && t4.error) {
    lines.push(`   怎么修：${t4.error}`);
  }
  lines.push(`可信度：${trusted ? '✅ 全链可信（t1 通过，t2/t3 结果有效）' : '⚠️ t1 未通过，t2/t3 结果不可信（先修 Node 再复诊）'}`);
  if (!trusted) {
    lines.push('   （t2/t3 即使显示可用也请先修好 Node 后再判定）');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    details: {
      dsh: {
        reportAt: new Date().toISOString(),
        trusted,
        mode: cfg.mode || manifestDefault('mode') || 'auto',
        t1,
        t2: {
          ok: t2.ok,
          trusted: t2.trusted !== false,
          note: t2.note ?? null,
          exists: t2.exists ?? null,
          cliBin: t2.cliBin ?? null,
          version: t2.version ?? null,
          error: t2.error ?? null,
          fakeReady: t2.fakeReady ?? null,
          candidates: t2.candidates ?? [],
        },
        t3: {
          ok: t3.ok,
          trusted: t3.trusted !== false,
          mode: t3.mode ?? null,
          port: t3.port ?? null,
          note: t3.note ?? null,
          error: t3.error ?? null,
        },
        t4: {
          exists: Boolean(t4.exists),
          mode: t4.mode ?? null,
          exitCode: t4.exitCode ?? null,
          signal: t4.signal ?? null,
          endedAt: t4.endedAt ?? null,
          stderrTail: t4.stderrTail ?? null,
          note: t4.note ?? null,
          error: t4.error ?? null,
        },
      },
    },
  };
}

/** 宿主调用约定：execute(input, ctx) 双参（0.446.6 实证）；合并兼容单参。 */
export async function execute(input, ctx) {
  const params = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const sessionCtx = ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
  const merged = { ...sessionCtx, ...params };
  try {
    return await diagnose(merged);
  } catch (e) {
    try {
      merged?.log?.error?.('[dsh-bridge] dsh_diagnose failed:', e?.stack || e?.message || String(e));
    } catch {
      // 日志失败静默
    }
    // 降级链：诊断失败也给人话报告（不抛原始错误）
    return {
      content: [{ type: 'text', text: `【dsh 体检报告】检查收集失败：${e?.message || String(e)}（诊断是只读增强，可稍后重试）` }],
      details: { dsh: { reportAt: new Date().toISOString(), trusted: false, error: e?.message || String(e) } },
    };
  }
}

/** 清理单例连接（导出契约，与其余工具同构）：embedded 模式回收 dsh 子进程；幂等 */
export function closeProcess() {
  const s = globalThis.__dshBridge;
  const conn = s?.connection;
  if (conn && typeof conn.dispose === 'function') {
    return Promise.resolve(conn.dispose()).catch(() => {});
  }
}
