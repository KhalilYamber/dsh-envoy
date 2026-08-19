# DSH Envoy（dsh-bridge）

> 一个 Hana（HanaAgent）插件：说一句「派给 DSH」，任务就流向本机 DeepSeek Harness 执行：审批同步回 Hana 里决策，结果自动带回，全程不必切换界面。

## 谁是 host？Hana，不是 DSH

**本插件的宿主是 Hana**（HanaAgent 桌面应用，原名 OpenHanako）：它安装进 Hana、运行在 Hana 进程内、由 Hana 的 Agent 调用。DSH 是它对接的**下游执行方**，关系如下：

```
Hana（宿主：装插件 · 发指令 · 收结果）
 └─ dsh-bridge（本插件，桥）
     └─ DSH（DeepSeek Harness，本机沙箱执行）
```

- **Hana**（HanaAgent / 原 OpenHanako）：AI 助手桌面应用，本插件的运行环境与交互界面。对 Hana 说话，就是对插件下指令
- **DSH**（DeepSeek Harness）：DeepSeek 官方的编码 Agent 框架（类似 Codex CLI），在本机沙箱里执行写代码、跑命令等长任务

## 这是什么

DSH Envoy 是一个 Hana 插件，桥接 Hana 与本机 DeepSeek Harness（DSH）。

- **派活**：Hana 把任务书写给 DSH，DSH 在沙箱里长时间干活
- **审批**：DSH 请求越界权限时，审批同步到 Hana 对话里问您（允许一次 / 拒绝）；DSH 界面的原生审批弹窗保留作兜底
- **结果卡片**：任务完成自动带回结构化结果，Hana 用原生卡片呈现（状态、耗时、token 用量、交付物、审批记录，明细折叠可展开）
- **任务记录**：每次工作自动打日期标签（如 0815-01），可查进度、可止损、会话可续跑；终态元数据落盘 tasks.jsonl，重启后可查
- **自愈诊断**：连不上 DSH 时调 `dsh_diagnose` 体检（Node / 依赖 / 连接 / 上次退出四项，全部运行级验证），每项带人话修复指引

## 效果示例

```
您   ：派给 DSH：给项目补一个单元测试并跑通
Hana ：正在派单【0815-01】…（external 模式）
       DSH 已开工：写代码 → 自检 → 交活
       [结果卡片] completed · 耗时 45s · 交付物与用量一览
```

任务执行中 DSH 申请越界时，Hana 会把审批同步到对话里问您；您回答「允许」或「拒」，无需切换到 DSH 界面。

## 开始之前：先判断您的情况

本插件是「桥」，外接模式直连您自跑的 DSH；内置模式由插件经官方 npm 安装的 SDK runtime 执行（只触发官方安装命令，不自带、不复刻 DSH 本体）。请对照下面三种情况：

| 情况 | 特征 | 您的路径 |
|---|---|---|
| **A. 已在跑 DSH** | 您的 DSH（Web UI 或桌面版）正在运行，浏览器能打开 `http://127.0.0.1:3080` | 装完插件即可用，**零配置**（外接模式） |
| **B. 装了 DSH 没在跑** | 本机有 DSH 安装，但服务没启动 | 二选一：启动 DSH 走外接；或不启动，用插件内置模式（需一次官方 npm 安装 + 填 apiKey） |
| **C. 还没装 DSH** | 本机没有 DSH | 先按 [DSH 官方文档](https://github.com/deepseek-ai/deepseek-harness) 安装（CLI 或桌面版均可，请以官方说明为准），装完回到 A 或 B |

不确定自己属于哪种？装完插件后对 Hana 说「派给 DSH：在工作区建个测试文件」，插件会自动探测并给出人话提示。

内置模式（bundled）的官方安装命令：把插件 bundled/ 目录（cordis.yml + package.json）同步到插件数据目录后，执行 `npm install --prefix <插件数据目录>/bundled`。依赖全部来自官方 npm（@deepseek-ai/*，0.1.0 发布线）。

## 安装（手动解压，已验证）

1. 从 [Releases 页面](https://github.com/KhalilYamber/dsh-envoy/releases) 下载最新版 zip（如 `dsh-bridge-0.2.5.zip`，具体版本号以 Releases 页面为准；或直接用仓库 `dist/` 目录里的同名文件）
2. 解压到 Hana 的插件目录，目录名必须是 `dsh-bridge`：
   - Windows：`C:\Users\<您的用户名>\.hanako\plugins\dsh-bridge`
   - macOS / Linux：`~/.hanako/plugins/dsh-bridge`
3. 重启 Hana

> 若您的 Hana 版本有插件管理界面，也可尝试从界面导入（各版本能力不同，以手动解压为准）。

## 平台支持

- **外接模式**：跨平台（Node.js 22+，需要全局 WebSocket）
- **内置模式**：官方 SDK runtime 官方支持 Windows/macOS/Linux（沙箱组合按平台自动切换）；本插件在 Windows 实测（spike 验证 fail-closed 与带授权重派）

## 配置（插件设置界面）

| 配置项 | 何时需要 |
|---|---|
| `mode` | 默认 `auto`（探测到 3080 有 DSH 就走外接，否则内置）。想固定走某一种再改 |
| `apiKey` | **仅内置模式需要**（外接模式凭证由 DSH 自己管理，不填）。填 DeepSeek API Key，只经环境变量传给任务进程，不落盘 |
| `defaultCwd` | 可留空。留空时外接模式任务落进 DSH 的「协助Hana」工作区 |
| `agentPreset` | 仅外接模式生效：dsh_run 显式传 agentPreset 时透传 session.create（插件不存任何预设定义）；留空不传，尊重您 DSH 的默认预设 |
| `nodePath` | 可留空。内置模式启动官方 SDK runtime 的 node.exe（留空自动探测） |

> 配置默认值以 `manifest.json` 的 `contributes.configuration.properties[].default` 为单一事实源：改默认值（超时、审批超时、端口、模式等）只改 manifest 一处，无需改代码。

## 使用

对 Hana 说：

```
派给 DSH：<任务描述>
```

Hana 会：派单前对敏感操作向您预授权问询 → 派单后盯梢 → DSH 申请越界时把审批同步给您决策 → 完成后用卡片向您汇报结果。

**同工程自动延续会话**：默认情况下，同一个工程目录（cwd）的多次派单会自动复用同一 DSH 会话（agent 保留上下文，不必反复重读项目，省 token）。当 DSH 侧上下文太满或状态混乱时，说一句「开新会话」即可强制新建，并自动携带旧会话的交接摘要继续。

## 审批机制

| 模式 | 越界操作的行为 |
|---|---|
| 外接（external） | DSH 挂起等审批。Hana 侧内联问询您；180 秒无人应答自动拒绝；DSH 界面原弹窗也可点 |
| 内置（bundled） | 立即拒绝（fail closed），DSH 在报告里说明被拒原因。您明确授权后，Hana 可带授权重派（danger-full-access） |

## 仓库结构

```
README.md                本文件
manifest.json            插件清单（版本、配置项；配置默认值的单一事实源）
index.js                 插件入口
lib/                     连接工厂（双传输腿）、DSH 客户端、SDK 腿、任务状态机、任务记录落盘、会话路由、配置默认值、标签
tools/                   五个工具：dsh_run / dsh_status / dsh_approve / dsh_cancel / dsh_diagnose
bundled/                 内置模式配置项目（官方 cordis.yml 模板 + 依赖清单，官方安装命令的材料）
skills/dsh-bridge/       配套技能（Hana 的操作手册，自动加载）
scripts/verify-zip.mjs   zip 真实性校验（PK 魔数 + EOCD + sha256，pack 与 CI 共用）
scripts/lex-scan.mjs     词法扫描（注释配对/未闭合检查，防「注释吞函数」，发布前必跑）
scripts/run-tests.ps1    回归测试一键入口（-SkipDsh 可跳过需本机 DSH 的用例）
.github/workflows/       发版流水线（create-release → build → verify）
dist/                    可安装的插件包
pack.ps1                 开发者打包脚本（生成 dist，打包后自动 verify-zip）
LICENSE                  MIT
```

## 常见问题

**Q：派单后没反应？**
先看 Hana 是否提示了连接模式与错误。外接模式请确认 DSH 服务在跑（浏览器能打开 127.0.0.1:3080）；内置模式请确认 apiKey 已填、bundled 官方 npm 安装已完成（dsh_diagnose ② 会给官方安装命令）。

**Q：内置模式与「跑着 DSH」有什么区别？**
外接模式直连您日常在用的 DSH（会话、界面、配置、凭据都是您自己的，原样保留；插件任务记录 tasks.jsonl 在插件数据目录，重启后可查）；内置模式由插件经官方 SDK runtime 执行（官方 npm 安装于插件数据目录，无界面无审批，越界自动拒绝），适合不想跑 DSH 界面的场景。

**Q：审批我不想管，能全自动吗？**
外接模式 180 秒无人应答自动拒绝（可配置 `approvalTimeoutMs`，0 为禁用）；内置模式越界直接拒绝，均不会默默放行。

**Q：任务跑一半 Hana 重启了？**
向 Hana 问一句任务进度，它会自动与 DSH 侧对账，如实说明状态。

## 适配与免责

- 适配 DeepSeek Harness `0.1.0-rc.7`（官方 npm @deepseek-ai/* 0.1.0 发布线）。DSH 处于开发者预览期，接口可能有破坏性变更
- 本仓库不含任何 API Key 或凭据
- 内置模式的 `danger-full-access` 会解除沙箱边界，仅在您明确授权后使用

## 致谢

本项目开发中借鉴了 [Nyasers/dsh-hanako](https://github.com/Nyasers/dsh-hanako)（DSHana，MIT License）的设计思路：宿主 deferred 通道的调用方式、审批应答的信封结构、任务记录与标签的组织模式。代码为独立重写，传输层为官方 SDK（外接 HTTP 信封 / 内置官方 SDK runtime），谨此致谢原作者的优秀工作。

## License

MIT
