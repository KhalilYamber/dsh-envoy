---
name: dsh-bridge
description: DSH Bridge 插件（Hana 与 DeepSeek Harness 的交接层）使用指南。触发场景：用户想把 coding 类任务交给本机 DSH 执行时说「派给 DSH」「让 DSH 做」「用 DSH 帮我改」「交给 DSH 处理」「DSH 上」等，或上下文明显是「把工作派给 DeepSeek Harness」。插件提供 dsh_run / dsh_status / dsh_approve / dsh_cancel 四个工具，双模式（内置 headless / 外接 Web）自动切换。遇到 DSH 任务失败、审批应答、连接模式问题优先读本技能再动手。
---

# DSH Envoy 使用指南（dsh-bridge）

Hana 与 DeepSeek Harness（DSH）之间的交接层。DSH 是独立 agent，擅长在沙箱里长时间写代码；本插件让 Hana 把任务外包给它，拿回结构化结果。

## 双连接模式

| 模式 | 含义 | 账本位置 |
|---|---|---|
| external（外接） | 直连用户自跑的 DSH（默认 127.0.0.1:3080） | 用户自己的 DSH 目录 |
| embedded（内置） | 插件用 headless 模式拉起 dsh（无界面、无端口、无审批通道） | 插件数据目录 dsh-home/ |

默认 `auto`：探测到外部 DSH 服务就走外接，否则内置。配置在插件设置界面（mode 手动指定可覆盖）。切换无需重启，对新任务生效。

## 两个模式的关键差异（Agent必记）

- **内置 headless**：越界操作**立即被沙箱拒绝**（fail closed，不挂起），agent 在任务报告里说明。全程没有审批可答。退出码不可靠（越界被拒也退 0），判断成败**以任务报告文本为准**。想放行越界操作，唯一办法是带授权重派（dsh_run 传 `permission=danger-full-access`，该模式下全程不审批）。
- **外接 Web**：越界操作会**挂起等审批**，用户也可以在 DSH 界面自己点。审批挂起期间执行超时暂停；无人应答 `approvalTimeoutMs`（默认 180s）自动拒绝。

## 工具速查

### dsh_run(task, cwd?, timeout?, wait?, sessionId?, permission?)

派活。`task` 为任务书文本（自包含：目标、约束、验收检查点、产物位置）。默认异步（立即返回 `{ tag, opId, status: 'running' }`，完成后宿主唤醒）；`wait=true` 同步等结果。

- `sessionId` 仅外接模式支持（resume）；内置模式传了会报错。
- `permission` 仅内置模式生效：`workspace-write`（默认）/ `danger-full-access`（带授权重派）/ `read-only`。
- 完成时返回结构化结果：`{ ok, tag, opId, mode, status, conclusion, checkpoints, artifacts, usage, durationMs }`。

### dsh_status(sessionId?)

查进度与台账（只读）。返回：连接模式与健康、运行中任务（内置模式显示 headless 进程状态与输出尾部）、近期台账（50 条）、挂起审批（外接模式）。

### dsh_approve(approvalId, outcome?, ...)

应答外接模式的挂起审批。`outcome`：`allowed-once`（默认）/ `rejected`。内置模式调用会得到说明性提示（无审批可答）。

### dsh_cancel(sessionId?)

止损。外接模式传 sessionId；内置模式传 opId（或省略取消唯一运行中的任务）。幂等。

## 首次配置

外接模式零配置。内置模式需要：设置界面填 `apiKey`（DeepSeek API Key）；`nodePath` 留空自动探测（Node 24+）；`dshInstallDir` 留空自动探测 `D:\DeepSeek-Harness` 与 `~/.dsh`。找不到本机 DSH 安装时插件会给出明确报错。

## 派单工作流（Agent的标准操作流程）

### 0. 派单后盯梢（无条件必做，不依赖任何提示）

外部模式异步派单后，**必须**立即执行盯梢循环：用 `exec_command` 等待 15~20 秒 → 调 `dsh_status` → 若发现挂起审批，转第 3 步内联问询；未发现审批且任务未结束，再盯 1~2 轮（共最多 5 轮）。轮询到上限还没结果就如实告知用户「任务仍在跑」，不要无限等。内置 headless 模式无审批，等待终态即可，可用 `dsh_status` 对账。

### 1. 派单前：预授权问询

任务可能触碰工作区外/敏感路径时（读 system 敏感文件、写工作区外、装全局依赖、执行危险命令等），先问用户一句，例如：「DSH 可能需要在 XX 写文件，允许吗？」得到允许后把授权写进任务书（例如「用户已授权写入 XX」），必要时同步传 `permission=danger-full-access`。没把握该不该问的，就问。

### 2. 派单后：前台盯梢

异步派单后，同一回合内用 `exec_command sleep 15-20s` 短间隔 + `dsh_status` 轮询，直到出现其一：发现挂起审批（外接）/ 任务终态 / 轮询上限（最多 5 轮）。轮询到上限还没结果就如实告知用户「任务仍在跑」，不要无限等。

### 3. 发现审批（外接模式）：内联问询 + 审批小卡片

调 `show_card` 呈现审批小卡片（模板见「卡片模板库」B 型），卡片外正文问用户：「用户，DSH 申请越界执行（见卡片），允许一次吗？」用户答复后调 `dsh_approve`。用户拒绝就传 `outcome=rejected`。注意 `args`（命令原文）是决策依据，reason 只是 agent 自述。审批消解后无需更新卡片，正文补一句结果即可。

### 4. 任务终态：转述 + 重派

- 先调 `show_card` 呈现任务回执卡片（模板见「卡片模板库」A 型，按终态选状态徽章色），卡片外正文附一句简洁转述（结论 + DSH 报告要点）。DSH 的完整验证报告放正文，不要塞进卡片。
- 按 checkpoints 逐项实测验收后再向用户汇报。
- 内置模式下 agent 报告被拒（越界）：「DSH 申请执行 XX 被沙箱拒绝。若您允许，Agent带授权重派（permission=danger-full-access）」。
- 外接模式同样话术换成「审批超时被自动拒绝」。

### 4.1 danger-full-access 安全约束（必守）

重派带 `permission=danger-full-access` 前必须经内联问询获得用户**明确同意**；获得同意后在任务书首行注明「用户已授权 danger-full-access」，再调 dsh_run。不得自行决定升级到 danger-full-access。用户没明确同意就维持默认 workspace-write，并如实说明被拒原因与可选方案。

### 5. 兜底：对账先行

deferred 后台回执可能不来（宿主重启等）。用户再次开口问任务时，先 `dsh_status` 对账再答话，不要说「还在跑」这类没核实的判断。

## 卡片模板库（show_card，Hana 原生卡片）

回执与审批均用 `show_card` 呈现（卡片随界面主题自动变色，全部颜色走 CSS 变量）。调用前若未加载过设计手册，先调 `hana_card_guide`。硬规则：无 emoji、无注释、内联样式、内嵌标题用 sr-only 样式、表格字体用 var(--font-ui)、数字四舍五入、徽章色只选状态对应色。

### A 型：任务回执卡片（dsh-done 到达或盯梢发现终态时调用）

状态徽章配色：completed → `rgba(74,107,74,0.08)` 底 `#4A6B4A` 字；aborted/timeout → `rgba(157,95,77,0.08)` 底 `#9D5F4D` 字；error → `rgba(139,44,31,0.08)` 底 `#8B2C1F` 字；running → `var(--accent-light)` 底 `var(--accent-hover)` 字。

```html
<h2 class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">DSH task receipt {tag}</h2>
<div style="background:var(--bg-card);border-radius:var(--radius-chat-card);padding:1rem 1.25rem">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:0.9rem">
    <div style="width:40px;height:40px;border-radius:var(--radius-chat-card);background:var(--accent-light);display:flex;align-items:center;justify-content:center;color:var(--accent);font-weight:500;font-family:var(--font-ui)">DSH</div>
    <div style="flex:1">
      <div style="font-weight:500;color:var(--text);font-family:var(--font-serif);font-size:1.05rem">DSH 任务回执 · {tag}</div>
      <div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">{sessionId 前 12 字符}… · {mode} · {秒}s</div>
    </div>
    <span style="display:inline-flex;padding:2px 8px;font-size:0.75rem;font-weight:500;border-radius:var(--radius-chat-card);font-family:var(--font-ui);background:{状态底色};color:{状态字色}">{status}</span>
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:12px 20px;margin-bottom:0.9rem">
    <div style="min-width:72px"><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">耗时</div><div style="font-size:1.4rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums;font-family:var(--font-ui)">{秒}s</div></div>
    <div style="min-width:72px"><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">输入</div><div style="font-size:1.4rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums;font-family:var(--font-ui)">{n}</div></div>
    <div style="min-width:72px"><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">输出</div><div style="font-size:1.4rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums;font-family:var(--font-ui)">{n}</div></div>
    <div style="min-width:72px"><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">缓存命中</div><div style="font-size:1.4rem;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums;font-family:var(--font-ui)">{n}</div></div>
    <div style="min-width:72px"><div style="font-size:0.75rem;color:var(--text-muted);font-family:var(--font-ui)">审批</div><div style="font-size:1.4rem;font-weight:600;color:#9D5F4D;font-variant-numeric:tabular-nums;font-family:var(--font-ui)">{n}</div></div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:0.85rem;font-family:var(--font-ui)">
    <tr><td style="padding:5px 8px;color:var(--text-muted);width:30%">交付物</td><td style="padding:5px 8px;color:var(--text)">{artifacts 首个或 conclusion 里的产物路径}</td></tr>
    <tr><td style="padding:5px 8px;color:var(--text-muted)">结论</td><td style="padding:5px 8px;color:var(--text)">{conclusion 前 80 字}</td></tr>
    <tr><td style="padding:5px 8px;color:var(--text-muted)">审批记录</td><td style="padding:5px 8px;color:var(--text)">{放行 x 次 · 拒绝 y 次 · 已消解 z 次；无则「无」}</td></tr>
  </table>
</div>
```

数据缺失处理：usage 为 null 时指标区只留「耗时」与「审批」；artifacts 为空时「交付物」行用 conclusion 里解析的产物路径，解析不到就整行省略；status=error 时加一行「错误」显示 error 摘要。指标最多 5 个，超了裁剪。

### B 型：审批小卡片（发现挂起审批时调用）

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
- 插件层不做历史落盘、搜索、自建卡片 UI（轻量化）；但Agent行为层用宿主原生 show_card 呈现回执与审批卡片（见「卡片模板库」）
