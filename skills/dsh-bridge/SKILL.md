---
name: dsh-bridge
description: DSH Bridge 插件（Hana 与 DeepSeek Harness 的交接层）使用指南。触发场景：用户想把 coding 类任务交给本机 DSH 执行时说「派给 DSH」「让 DSH 做」「用 DSH 帮我改」「交给 DSH 处理」「DSH 上」等，或上下文明显是「把工作派给 DeepSeek Harness」。插件提供 dsh_run / dsh_status / dsh_approve / dsh_cancel / dsh_diagnose 五个工具，双模式（内置 bundled 官方 SDK runtime / 外接 Web）自动切换。遇到 DSH 任务失败、审批应答、连接模式问题优先读本技能再动手。
---

# DSH Envoy 使用指南（dsh-bridge）

Hana 与 DeepSeek Harness（DSH）之间的交接层：Hana 把任务书外包给 DSH，拿回结构化结果。功能说明见 README，本技能只讲操作与排障。

## 双模式速记

- **external（外接）**：直连用户自跑的 DSH（默认 127.0.0.1:3080）。越界操作**挂起等审批**，可经 dsh_approve 应答或用户在 DSH 界面处理；无人应答 `approvalTimeoutMs`（默认 180s）自动拒绝。
- **bundled（内置）**：官方 SDK runtime（官方 npm 安装于插件数据目录 bundled/），无界面无审批——越界**立即被拒**（fail closed），agent 在报告里说明。想放行越界只能带授权重派（`permission=danger-full-access`）。
- **auto（默认）**：探测到外部服务走外接，否则内置。切换无需重启，对新任务生效。
- **双腿能力不对称（官方协议边界）**：agentPreset、sessionId 续跑、审批仅外接可用；内置无预设通道、每任务独立进程（进程亡即弃会话）。

## 工具速查

- `dsh_run(task, cwd?, timeout?, wait?, sessionId?, sessionPolicy?, agentPreset?, permission?)`：派活。默认异步（完成后宿主唤醒），`wait=true` 同步等结果。`sessionId`/`sessionPolicy`/`agentPreset` 仅外接（resume/路由/预设）；`permission` 仅内置。
- `dsh_status(sessionId?)`：查进度与任务记录（文本展示 20 条、details 全量 50 条）、挂起审批、会话路由表。
- `dsh_approve(approvalId, outcome?)`：应答审批（`allowed-once` 默认 / `rejected`）；内置模式调用返回说明性提示。
- `dsh_cancel(sessionId?)`：止损。外接传 sessionId、内置传 opId（省略取消唯一运行中任务）；幂等。
- `dsh_diagnose()`：连不上 DSH 时先体检——① Node（运行级验证+候选列表）② bundled 依赖（官方 SDK runtime 就位+装载验证抓假就绪）③ 连接 ④ 上次退出记录，每项带修复指引。

## 首次配置

external 零配置。bundled 需一次官方安装：把插件 bundled/ 目录（cordis.yml + package.json）同步到插件数据目录后执行官方命令 `npm install --prefix <插件数据目录>/bundled`，再在设置界面填 `apiKey`；`nodePath` 留空自动探测（Node 24+，找不到时 dsh_diagnose 给候选列表）。

## 派单工作流

### 0. 派单后盯梢（无条件必做，不依赖任何提示）

external 异步派单后**必须**盯梢循环：`exec_command` 等待 15~20 秒 → 调 `dsh_status` → 发现挂起审批转第 3 步内联问询；未发现审批且任务未结束，再盯 1~2 轮（共最多 5 轮）。到上限如实告知用户「任务仍在跑」，不要无限等。bundled 无审批，等终态即可，可用 `dsh_status` 对账。

### 0.5 会话延续（项目级路由，仅外接，派单前想一下）

- 默认 `sessionPolicy=auto`：按 cwd 查路由表，同工程有活跃会话自动复用（省 token）；未命中则新建并登记。`new`：强制新建，自动从旧会话提取交接摘要拼进任务书开头（「这是延续会话…请继续」）。显式传 sessionId 优先（不查表不写表）。
- 何时用 new：DSH 侧上下文太满、旧会话状态混乱、想干净重来（问用户或用户主动说）。
- `dsh_cancel` 后对应路由自动摘除；`dsh_status` 展示「会话路由表」供判断。bundled 无会话概念，sessionPolicy 不生效。

### 1. 任务分级与复述对齐（必做；机制细节不明说给用户）

| 级别 | 判定 | 复述要求 |
|---|---|---|
| **强制** | 破坏性/高风险：删改文件、越界写、装依赖、跑危险命令、大范围改动 | 先复述理解与计划，等确认后才执行 |
| **默认** | 常规任务（大部分） | 先复述理解（2~3 句），等确认后执行 |
| **跳过** | 极简任务（建文件、查信息、只读命令） | 不加复述要求 |

任务书最前插入复述指令：

```
【第一步·必做】请先复述你对本任务的理解与执行计划（2~3 句话）。
复述完成后停止，等待确认；未收到确认前不要执行任何操作。
```

- **外接（两阶段确认）**：DSH 复述后回合结束 → Agent 核对（目标/边界/交付物；拿不准转问用户）→ 正确发「理解正确，开始执行」；有偏差指出偏差，DSH 重新复述后再确认。
- **bundled（单发无交互）**：任务书改为「先复述理解（写在报告开头），然后执行」，Agent 在终态核对理解与产出一致性，有偏差向用户说明并重派。

### 2. 预授权问询

任务可能触碰工作区外/敏感路径时（读系统敏感文件、写工作区外、装全局依赖、危险命令等），先问用户一句；得到允许后把授权写进任务书，必要时同步传 `permission=danger-full-access`。没把握该不该问的，就问。

### 3. 发现审批（外接）：内联问询 + 审批卡片

调 `show_card` 呈现审批卡片（模板见下），卡片外正文问用户「DSH 申请越界执行（见卡片），允许一次吗？」；用户答复后调 `dsh_approve`（拒绝传 `outcome=rejected`）。`args`（命令原文）是决策依据，reason 只是 agent 自述。审批消解后无需更新卡片，正文补一句结果即可。

### 4. 任务终态：转述 + 重派

- 先调 `show_card` 呈现任务卡片（按终态选状态徽章色），卡片外正文附一句简洁转述（结论 + DSH 报告要点）；DSH 的完整验证报告放正文，不塞进卡片。按 checkpoints 逐项实测验收后再向用户汇报。
- 内置模式 agent 报告被拒：「DSH 申请执行 XX 被沙箱拒绝。若您允许，Agent 带授权重派（permission=danger-full-access）」。外接模式换「审批超时被自动拒绝」。

### 5. danger-full-access 安全约束（必守）

重派带 `permission=danger-full-access` 前必须经内联问询获得用户**明确同意**；同意后在任务书首行注明「用户已授权 danger-full-access」再调 dsh_run。不得自行决定升级。用户没明确同意就维持默认 workspace-write，如实说明被拒原因与可选方案。

### 6. 兜底：对账先行

deferred 后台结果可能不来（宿主重启等）。用户再次开口问任务时，先 `dsh_status` 对账再答话，不要说「还在跑」这类没核实的判断。

## 卡片模板库（show_card，Hana 原生卡片）

任务结果与审批均用 `show_card` 呈现（卡片随界面主题自动变色，全部颜色走 CSS 变量）。调用前若未加载过设计手册，先调 `hana_card_guide`。硬规则：无 emoji、无注释、内联样式、内嵌标题用 sr-only 样式、表格字体用 var(--font-ui)、数字四舍五入、徽章色只选状态对应色。

### 任务卡片（任务完成时调用）

设计原则：默认只显示最常用的三项（状态、耗时、输入/输出），其余全部折叠（`<details>`，展开才看）。

状态徽章配色：completed → `rgba(74,107,74,0.08)` 底 `#4A6B4A` 字；aborted/timeout → `rgba(157,95,77,0.08)` 底 `#9D5F4D` 字；error → `rgba(139,44,31,0.08)` 底 `#8B2C1F` 字；running → `var(--accent-light)` 底 `var(--accent-hover)` 字。

```html
<h2 class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">DSH task card {tag}</h2>
<div style="background:var(--bg-card);border-radius:var(--radius-chat-card);padding:1rem 1.25rem">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:0.6rem">
    <div style="width:40px;height:40px;border-radius:var(--radius-chat-card);background:var(--accent-light);display:flex;align-items:center;justify-content:center;color:var(--accent);font-weight:500;font-family:var(--font-ui)">DSH</div>
    <div style="flex:1">
      <div style="font-weight:600;color:var(--text);font-family:var(--font-serif);font-size:1.05rem">{tag}</div>
      <div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">{mode}</div>
    </div>
    <span style="display:inline-flex;padding:2px 8px;font-size:0.75rem;font-weight:500;border-radius:var(--radius-chat-card);font-family:var(--font-ui);background:{状态底色};color:{状态字色}">{status}</span>
  </div>
  <div style="font-size:0.9rem;color:var(--text);font-family:var(--font-ui);line-height:1.5;margin-bottom:0.7rem">{conclusion 前 80 字；空则显示「（dsh 未返回文本）」；status=error 时后面加一行错误摘要}</div>
  <div style="display:flex;flex-wrap:wrap;gap:12px 20px;margin-bottom:0.5rem">
    <div style="min-width:72px"><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">耗时</div><div style="font-size:1.4rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums;font-family:var(--font-ui)">{秒}s</div></div>
    <div style="min-width:72px"><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">输入</div><div style="font-size:1.4rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums;font-family:var(--font-ui)">{n}</div></div>
    <div style="min-width:72px"><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">输出</div><div style="font-size:1.4rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums;font-family:var(--font-ui)">{n}</div></div>
    <div style="min-width:72px"><div id="cache-label" style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">缓存命中率</div><div style="display:flex;align-items:center;gap:6px"><div id="cache-val" style="font-size:1.4rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums;font-family:var(--font-ui)">{99%}</div><button id="cache-toggle" style="border:0.5px solid var(--border);border-radius:var(--radius-chat-card);background:transparent;color:var(--accent);padding:1px 6px;font-size:0.7rem;font-family:var(--font-ui);cursor:pointer">切换</button></div></div>
  </div>
  <details style="font-size:0.8rem;font-family:var(--font-ui)">
    <summary style="cursor:pointer;color:var(--text-muted);padding:2px 0">明细</summary>
    <table style="width:100%;border-collapse:collapse;font-size:0.85rem;font-family:var(--font-ui);margin-top:0.4rem">
      <tr><td style="padding:5px 8px;color:var(--text-muted);width:30%">交付物</td><td style="padding:5px 8px;color:var(--text)">{artifacts 首个或 conclusion 里解析的产物路径；解析不到整行省略}</td></tr>
      <tr><td style="padding:5px 8px;color:var(--text-muted)">审批记录</td><td style="padding:5px 8px;color:var(--text)">{放行 x 次 · 拒绝 y 次；无则整行省略}</td></tr>
      <tr><td style="padding:5px 8px;color:var(--text-muted)">会话</td><td style="padding:5px 8px;color:var(--text)">{sessionId 前 12 字符}…（{mode}）</td></tr>
    </table>
  </details>
</div>
<script>
  const cacheBtn = document.getElementById('cache-toggle');
  const cacheLabel = document.getElementById('cache-label');
  const cacheVal = document.getElementById('cache-val');
  if (cacheBtn && cacheLabel && cacheVal) {
    const modes = [
      { label: '缓存命中率', value: '{99%}' },
      { label: '缓存增量', value: '{+1280}' },
    ];
    let i = 0;
    cacheBtn.addEventListener('click', () => { i = 1 - i; cacheLabel.textContent = modes[i].label; cacheVal.textContent = modes[i].value; });
  }
</script>
```

数据缺失处理：usage 为 null 时「输入/输出/缓存」格省略（指标区只留耗时）；缓存命中率 = cacheReadTokens ÷ (inputTokens + cacheReadTokens) 四舍五入百分比（该指标反映 DeepSeek 前缀缓存，几乎所有任务都接近 100%，参考意义有限，会话延续收益看缓存增量）；缓存增量**直接取 dsh_status details.ledger[].cacheDelta 字段**（插件已按同 sessionId 上一终态算好），正数带 + 号，cacheDelta 为 null（首单/窗口外无对比基准）时显示「—」，**禁止自行估算或按本次值显示**；两者同格互斥显示，标签随切换变（缓存命中率 ⇄ 缓存增量），点「切换」轮换；status=error 时结论下方加「错误：{error 摘要}」；错误摘要也一并折叠进明细区（默认区保持四项）。

### 审批卡片（发现挂起审批时调用）

```html
<h2 class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">DSH approval {approvalId 前 8 字符}</h2>
<div style="background:var(--bg-card);border-radius:var(--radius-chat-card);padding:1rem 1.25rem">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:0.8rem">
    <div style="width:40px;height:40px;border-radius:var(--radius-chat-card);background:var(--accent-light);display:flex;align-items:center;justify-content:center;color:var(--accent);font-weight:500;font-family:var(--font-ui)">DSH</div>
    <div style="flex:1">
      <div style="font-weight:500;color:var(--text);font-family:var(--font-serif);font-size:1.05rem">DSH 审批 · {toolName}</div>
      <div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">{approvalId 前 12 字符}… · {tag}</div>
    </div>
    <span style="display:inline-flex;padding:2px 8px;font-size:0.75rem;font-weight:500;border-radius:var(--radius-chat-card);font-family:var(--font-ui);background:var(--accent-light);color:var(--accent-hover)">waiting</span>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:0.85rem;font-family:var(--font-ui)">
    <tr><td style="padding:5px 8px;color:var(--text-muted);width:30%">理由</td><td style="padding:5px 8px;color:var(--text)">{reason 前 100 字}</td></tr>
    <tr><td style="padding:5px 8px;color:var(--text-muted)">命令</td><td style="padding:5px 8px;color:var(--text)"><code style="font-family:var(--font-mono);font-size:0.8rem;color:var(--text)">{命令原文，超 120 字截断}</code></td></tr>
  </table>
</div>
```

卡片外正文向用户问询（允许一次 / 拒绝），不把问询塞进卡片。

## 任务书规范

任务书必须自包含（DSH 看不到我们的对话）：

```
任务：<一句话目标>
背景：<必要的上下文，含仓库/文件路径>
要求：<具体步骤或产出物>
约束：<不许碰的目录、不许做的事>
验收：<可检查的验收标准，编号列出>
```

**复述指令（按第 1 步分级）**：强制/默认级别在任务书最前插入复述指令（见第 1 步）；极简任务不加。bundled 模式每次任务都是全新进程（无上文），任务书更要自包含，且复述指令改为「先复述理解（写在报告开头），然后执行」；外接模式可传 sessionId 续跑保留上文。

## 排错表

| 现象 | 处理 |
|---|---|
| 连不上 DSH，报错含糊 | 调 `dsh_diagnose` 体检：按 ①Node ②依赖 ③连接 ④上次退出 定位坏在哪一环，每项带修复指引 |
| dsh_run 报「DSH 服务未运行」 | 外接模式确认用户 DSH 在跑（127.0.0.1:3080），或改 bundled 模式 |
| dsh_run 报「内置（bundled）就绪失败」 | 读报错：apiKey 未配填 apiKey；bundled 依赖未装跑官方安装命令（见「首次配置」）；node 不存在填 nodePath（候选见 dsh_diagnose ①） |
| dsh_diagnose ② 报「依赖不完整（假就绪）」 | bundled node_modules 缺失/损坏：重新执行官方安装命令 `npm install --prefix <插件数据目录>/bundled` |
| 内置任务「完成」但报告说被拒 | 越界 fail closed。问用户是否带授权重派（permission=danger-full-access） |
| 外接任务一直 running | dsh_status 看是否有挂起审批；用户可在 DSH 界面处理，或调 dsh_approve；超时自动拒绝（180s） |
| 任务失败 status=error | 读 conclusion 中的错误信息；stopReason=timeout 说明超时，可调大 timeout 重派 |
| 改了配置不生效 | 重启 Hana（宿主缓存配置快照） |
| 标签对不上 | 标签【MMdd-NN】跨天归零属正常 |

## 边界

- 不碰 DSH 本体，不重复造界面（外接模式的 DSH Web UI 就是观察窗）；不做任务调度队列（一次一个，DSH 自己排）
- 插件层不做搜索、自建卡片 UI（轻量化）；历史记录只落终态元数据（tasks.jsonl，重启后 dsh_status 可查）；Agent行为层用宿主原生 show_card 呈现任务结果与审批卡片（见「卡片模板库」）
