---
name: dsh-bridge
description: DSH Bridge 插件（Hana 与 DeepSeek Harness 的交接层）使用指南。触发场景：用户想把 coding 类任务交给本机 DSH 执行时说「派给 DSH」「让 DSH 做」「用 DSH 帮我改」「交给 DSH 处理」「DSH 上」等，或上下文明显是「把工作派给 DeepSeek Harness」。插件提供 dsh_run / dsh_status / dsh_approve / dsh_cancel 四个工具，双模式（内置 headless / 外接 Web）自动切换。遇到 DSH 任务失败、审批应答、连接模式问题优先读本技能再动手。
---

# DSH Envoy 使用指南（dsh-bridge）

Hana 与 DeepSeek Harness（DSH）之间的交接层。DSH 是独立 agent，擅长在沙箱里长时间写代码；本插件让 Hana 把任务外包给它，拿回结构化结果。

## 双连接模式

| 模式 | 含义 | 会话记录位置 |
|---|---|---|
| external（外接） | 直连用户自跑的 DSH（默认 127.0.0.1:3080） | 用户自己的 DSH 目录 |
| embedded（内置） | 插件用 headless 模式拉起 dsh（无界面、无端口、无审批通道） | 插件数据目录 dsh-home/ |

默认 `auto`：探测到外部 DSH 服务就走外接，否则内置。配置在插件设置界面（mode 手动指定可覆盖）。切换无需重启，对新任务生效。

## 两个模式的关键差异（Agent必记）

- **内置 headless**：越界操作**立即被沙箱拒绝**（fail closed，不挂起），agent 在任务报告里说明。全程没有审批可答。退出码不可靠（越界被拒也退 0），判断成败**以任务报告文本为准**。想放行越界操作，唯一办法是带授权重派（dsh_run 传 `permission=danger-full-access`，该模式下全程不审批）。
- **外接 Web**：越界操作会**挂起等审批**，用户也可以在 DSH 界面自己点。审批挂起期间执行超时暂停；无人应答 `approvalTimeoutMs`（默认 180s）自动拒绝。

## 工具速查

### dsh_run(task, cwd?, timeout?, wait?, sessionId?, sessionPolicy?, permission?)

派活。`task` 为任务书文本（自包含：目标、约束、验收检查点、产物位置）。默认异步（立即返回 `{ tag, opId, status: 'running' }`，完成后宿主唤醒）；`wait=true` 同步等结果。

- `sessionId` 仅外接模式支持（resume）；内置模式传了会报错。显式传 sessionId 时优先于 sessionPolicy（不查路由表、不写路由表）。
- `sessionPolicy` 仅外接模式生效：`auto`（默认）= 按 cwd 查会话路由表，同工程有活跃会话则自动复用（省 token）；未命中则新建并登记。`new` = 强制新建会话，自动从旧会话提取交接摘要拼进任务书开头。何时用 new：DSH 上下文太满、旧会话状态混乱、想干净重来（决定权在用户口头指示）。
- `permission` 仅内置模式生效：`workspace-write`（默认）/ `danger-full-access`（带授权重派）/ `read-only`。
- 完成时返回结构化结果：`{ ok, tag, opId, mode, status, conclusion, checkpoints, artifacts, usage, durationMs }`。

### dsh_status(sessionId?)

查进度与任务记录（只读）。返回：连接模式与健康、运行中任务（内置模式显示 headless 进程状态与输出尾部）、近期任务记录（文本展示最近 20 条，details 全量最多 50 条）、挂起审批（外接模式）。

### dsh_approve(approvalId, outcome?, ...)

应答外接模式的挂起审批。`outcome`：`allowed-once`（默认）/ `rejected`。内置模式调用会得到说明性提示（无审批可答）。

### dsh_cancel(sessionId?)

止损。外接模式传 sessionId；内置模式传 opId（或省略取消唯一运行中的任务）。幂等。

## 首次配置

外接模式零配置。内置模式需要：设置界面填 `apiKey`（DeepSeek API Key）；`nodePath` 留空自动探测（Node 24+）；`dshInstallDir` 留空自动探测 `D:\DeepSeek-Harness` 与 `~/.dsh`。找不到本机 DSH 安装时插件会给出明确报错。

## 派单工作流（Agent的标准操作流程）

### 0. 派单后盯梢（无条件必做，不依赖任何提示）

外部模式异步派单后，**必须**立即执行盯梢循环：用 `exec_command` 等待 15~20 秒 → 调 `dsh_status` → 若发现挂起审批，转第 4 步内联问询；未发现审批且任务未结束，再盯 1~2 轮（共最多 5 轮）。轮询到上限还没结果就如实告知用户「任务仍在跑」，不要无限等。内置 headless 模式无审批，等待终态即可，可用 `dsh_status` 对账。

### 0.5 会话延续（项目级路由，仅外接模式，派单前想一下）

- 默认 `sessionPolicy=auto`：按 cwd 查路由表，同工程已有活跃会话则自动复用（不传 sessionId，内部自动续用；DSH 保留上文，省去重复读项目的 token）。首次派单自动新建并登记。
- 何时该用 `sessionPolicy=new`（问用户或用户主动说）：DSH 侧上下文太满、旧会话状态混乱、想干净重来。new 会自动从旧会话提取交接摘要拼进任务书开头（「这是延续会话…旧会话背景摘要…请继续」），新会话登记进路由表。
- 显式传 sessionId 时优先（不查表不写表）。取消任务（dsh_cancel）后对应路由自动摘除。
- 查看路由：dsh_status 会展示「会话路由表（cwd → sessionId）」，方便判断何时该开新会话。
- 内置 headless 模式无会话概念，sessionPolicy 不生效（行为与现状一致）。

### 1. 派单前：任务分级与复述对齐（必做，机制细节不明说给用户）

派单前先给任务分级，决定复述对齐的强度：

| 级别 | 判定 | 复述要求 |
|---|---|---|
| **强制** | 破坏性/高风险：删改文件、越界写、装依赖、跑危险命令、大范围改动 | 任务书强制要求 DSH 先复述理解与计划，等确认后才执行 |
| **默认** | 常规任务（大部分） | 任务书要求 DSH 先复述理解（2~3 句），等确认后执行 |
| **跳过** | 极简任务（建个文件、查个信息、跑个只读命令） | 不加复述要求，直接执行 |

**任务书里的复述指令**（强制/默认级别，写在任务书最前）：

```
【第一步·必做】请先复述你对本任务的理解与执行计划（2~3 句话）。
复述完成后停止，等待确认；未收到确认前不要执行任何操作。
```

**外接模式（两阶段确认）**：DSH 收到任务后复述并停下（回合结束）→ Agent 核对复述理解（关键点：目标、边界、交付物；拿不准时转问用户）→ 理解正确：向该会话发消息「理解正确，开始执行」→ DSH 继续干活；有偏差：发消息指出偏差与正确理解，DSH 重新复述后再确认。

**内置 headless 模式（单发无交互，弱化为报告内复述）**：headless 一次任务跑到底，无法中途确认。任务书改为要求「先复述理解（写在报告开头），然后执行」——Agent 在终态核对报告里的理解复述与产出是否一致，有偏差向用户说明并重派。

### 2. 派单前：预授权问询

任务可能触碰工作区外/敏感路径时（读 system 敏感文件、写工作区外、装全局依赖、执行危险命令等），先问用户一句，例如：「DSH 可能需要在 XX 写文件，允许吗？」得到允许后把授权写进任务书（例如「用户已授权写入 XX」），必要时同步传 `permission=danger-full-access`。没把握该不该问的，就问。

### 3. 派单后：前台盯梢
异步派单后，同一回合内用 `exec_command sleep 15-20s` 短间隔 + `dsh_status` 轮询，直到出现其一：发现挂起审批（外接）/ 任务终态 / 轮询上限（最多 5 轮）。轮询到上限还没结果就如实告知用户「任务仍在跑」，不要无限等。

### 4. 发现审批（外接模式）：内联问询 + 审批小卡片

调 `show_card` 呈现审批卡片（模板见「卡片模板库」审批卡片），卡片外正文问用户：「用户，DSH 申请越界执行（见卡片），允许一次吗？」用户答复后调 `dsh_approve`。用户拒绝就传 `outcome=rejected`。注意 `args`（命令原文）是决策依据，reason 只是 agent 自述。审批消解后无需更新卡片，正文补一句结果即可。

### 5. 任务终态：转述 + 重派

- 先调 `show_card` 呈现任务卡片（模板见「卡片模板库」任务卡片，按终态选状态徽章色），卡片外正文附一句简洁转述（结论 + DSH 报告要点）。DSH 的完整验证报告放正文，不要塞进卡片。
- 按 checkpoints 逐项实测验收后再向用户汇报。
- 内置模式下 agent 报告被拒（越界）：「DSH 申请执行 XX 被沙箱拒绝。若您允许，Agent带授权重派（permission=danger-full-access）」。
- 外接模式同样话术换成「审批超时被自动拒绝」。

### 5.1 danger-full-access 安全约束（必守）

重派带 `permission=danger-full-access` 前必须经内联问询获得用户**明确同意**；获得同意后在任务书首行注明「用户已授权 danger-full-access」，再调 dsh_run。不得自行决定升级到 danger-full-access。用户没明确同意就维持默认 workspace-write，并如实说明被拒原因与可选方案。

### 6. 兜底：对账先行

deferred 后台结果可能不来（宿主重启等）。用户再次开口问任务时，先 `dsh_status` 对账再答话，不要说「还在跑」这类没核实的判断。

## 卡片模板库（show_card，Hana 原生卡片）

任务结果与审批均用 `show_card` 呈现（卡片随界面主题自动变色，全部颜色走 CSS 变量）。调用前若未加载过设计手册，先调 `hana_card_guide`。硬规则：无 emoji、无注释、内联样式、内嵌标题用 sr-only 样式、表格字体用 var(--font-ui)、数字四舍五入、徽章色只选状态对应色。

### 任务卡片（任务完成时调用）

设计原则：默认只显示最常用的三项（状态、耗时、输入/输出），其余全部折叠（`<details>`，展开才看），保持卡片体积最小。

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

数据缺失处理：usage 为 null 时「输入/输出/缓存」格省略（指标区只留耗时）；缓存命中率 = cacheReadTokens ÷ (inputTokens + cacheReadTokens) 四舍五入百分比；缓存增量 = 本次 cacheReadTokens − 同会话上一条任务（从插件数据目录 tasks.jsonl 按 sessionId 匹配查上一终态）的 cacheReadTokens，正数带 + 号，查不到上一条（新会话首单）时按本次值显示；两者同格互斥显示，标签随切换变（缓存命中率 ⇄ 缓存增量），点「切换」轮换；status=error 时结论下方加「错误：{error 摘要}」；错误摘要也一并折叠进明细区（默认区保持四项）。

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

**复述指令（按第 1 步分级）**：强制/默认级别在任务书最前插入：

```
【第一步·必做】请先复述你对本任务的理解与执行计划（2~3 句话）。复述完成后停止，等待确认；未收到确认前不要执行任何操作。
```

- 外接模式：DSH 复述后回合结束，Agent 核对后发「理解正确，开始执行」或指出偏差（见第 1 步）。
- 内置 headless 模式：改为「先复述理解（写在报告开头），然后执行」，Agent 在终态核对理解与产出一致性。
- 极简任务：不加复述指令。

内置 headless 模式每次任务都是全新会话（无上文），任务书更要自包含；外接模式可传 sessionId 续跑保留上文。

## 排错表

| 现象 | 处理 |
|---|---|
| dsh_run 报「DSH 服务未运行」 | 外接模式确认用户 DSH 在跑（127.0.0.1:3080），或改 embedded 模式 |
| dsh_run 报「内置（headless）就绪失败」 | 读报错：apiKey 未配填 apiKey；找不到 DSH 安装填 dshInstallDir；node 不存在填 nodePath |
| 内置任务「完成」但报告说被拒 | 越界 fail closed。问用户是否带授权重派（permission=danger-full-access） |
| 外接任务一直 running | dsh_status 看是否有挂起审批；用户可在 DSH 界面处理，或调 dsh_approve；超时自动拒绝（180s） |
| 任务失败 status=error | 读 conclusion 中的错误信息；stopReason=timeout 说明超时，可调大 timeout 重派 |
| 改了配置不生效 | 重启 Hana（宿主缓存配置快照） |
| 标签对不上 | 标签【MMdd-NN】跨天归零属正常 |

## 边界

- 不碰 DSH 本体，不重复造界面（外接模式的 DSH Web UI 就是观察窗）
- 不做任务调度队列（一次一个，DSH 自己排）
- 插件层不做搜索、自建卡片 UI（轻量化）；历史记录只落终态元数据（tasks.jsonl，重启后 dsh_status 可查）；Agent行为层用宿主原生 show_card 呈现任务结果与审批卡片（见「卡片模板库」）
