# DSH Envoy（dsh-bridge）

> 给 Hana 接一个「外包 coding 的开关」。说一句「派给 DSH」，任务就流向本机 DeepSeek Harness 执行：审批同步回 Hana 里决策，结果自动带回，全程不必切换界面。

## 这是什么

DSH Envoy 是一个 Hana 插件，桥接 Hana 与本机 DeepSeek Harness（DSH）。

- **派活**：Hana 把任务书写给 DSH，DSH 在沙箱里长时间干活
- **审批**：DSH 请求越界权限时，审批同步到 Hana 对话里问您（允许一次 / 拒绝）；DSH 界面的原生审批弹窗保留作兜底
- **回执**：任务完成自动带回结构化结果，Hana 用原生卡片呈现（状态、耗时、token 用量、交付物、审批记录）
- **台账**：每次工作自动打日期标签（如 0815-01），可查进度、可止损、会话可续跑

## 效果示例

```
您   ：派给 DSH：给项目补一个单元测试并跑通
Hana ：正在派单【0815-01】…（external 模式）
       DSH 已开工：写代码 → 自检 → 交活
       [回执卡片] completed · 耗时 45s · 交付物与用量一览
```

任务执行中 DSH 申请越界时，Hana 会把审批同步到对话里问您；您回答「允许」或「拒」，无需切换到 DSH 界面。

## 开始之前：先判断您的情况

本插件是「桥」，**DSH 本体必须已安装**（插件内置模式也复用本机 DSH 安装）。请对照下面三种情况：

| 情况 | 特征 | 您的路径 |
|---|---|---|
| **A. 已在跑 DSH** | 您的 DSH（Web UI 或桌面版）正在运行，浏览器能打开 `http://127.0.0.1:3080` | 装完插件即可用，**零配置**（外接模式） |
| **B. 装了 DSH 没在跑** | 本机有 DSH 安装，但服务没启动 | 二选一：启动 DSH 走外接；或不启动，用插件内置模式（需填 apiKey） |
| **C. 还没装 DSH** | 本机没有 DSH | 先按 [DSH 官方文档](https://github.com/deepseek-ai/deepseek-harness) 安装（CLI 或桌面版均可，请以官方说明为准），装完回到 A 或 B |

不确定自己属于哪种？装完插件后对 Hana 说「派给 DSH：在工作区建个测试文件」，插件会自动探测并给出人话提示。

## 安装（手动解压，已验证）

1. 下载 `dist/dsh-bridge-0.2.3.zip`
2. 解压到 Hana 的插件目录，目录名必须是 `dsh-bridge`：
   - Windows：`C:\Users\<您的用户名>\.hanako\plugins\dsh-bridge`
   - macOS / Linux：`~/.hanako/plugins/dsh-bridge`
3. 重启 Hana

> 若您的 Hana 版本有插件管理界面，也可尝试从界面导入（各版本能力不同，以手动解压为准）。

## 平台支持

- **外接模式**：跨平台（Node.js 22+，需要全局 WebSocket）
- **内置模式**：目前 Windows 实测（进程管理与依赖复用依赖 Windows 命令）；macOS / Linux 建议用外接模式

## 配置（插件设置界面）

| 配置项 | 何时需要 |
|---|---|
| `mode` | 默认 `auto`（探测到 3080 有 DSH 就走外接，否则内置）。想固定走某一种再改 |
| `apiKey` | **仅内置模式需要**（外接模式凭证由 DSH 自己管理，不填）。填 DeepSeek API Key，只经环境变量传给任务进程，不落盘 |
| `defaultCwd` | 可留空。留空时外接模式任务落进 DSH 的「协助Hana」工作区 |
| `dshInstallDir` | 可留空。内置模式找不到 DSH 安装时，填它的安装根目录 |

## 使用

对 Hana 说：

```
派给 DSH：<任务描述>
```

Hana 会：派单前对敏感操作向您预授权问询 → 派单后盯梢 → DSH 申请越界时把审批同步给您决策 → 完成后用卡片向您汇报回执。

## 审批机制

| 模式 | 越界操作的行为 |
|---|---|
| 外接（external） | DSH 挂起等审批。Hana 侧内联问询您；180 秒无人应答自动拒绝；DSH 界面原弹窗也可点 |
| 内置（headless） | 立即拒绝（fail closed），DSH 在报告里说明被拒原因。您明确授权后，Hana 可带授权重派（danger-full-access） |

## 仓库结构

```
README.md                本文件
manifest.json            插件清单（版本、配置项）
index.js                 插件入口
lib/                     连接抽象、DSH 客户端、headless 运行器、任务状态机、标签
tools/                   四个工具：dsh_run / dsh_status / dsh_approve / dsh_cancel
skills/dsh-bridge/       配套技能（Hana 的操作手册，自动加载）
dist/                    可安装的插件包
pack.ps1                 开发者打包脚本（生成 dist）
LICENSE                  MIT
```

## 常见问题

**Q：派单后没反应？**
先看 Hana 是否提示了连接模式与错误。外接模式请确认 DSH 服务在跑（浏览器能打开 127.0.0.1:3080）；内置模式请确认 apiKey 已填、本机 DSH 安装可被探测到。

**Q：内置模式与「跑着 DSH」有什么区别？**
外接模式直连您日常在用的 DSH（账本、会话、界面都是您自己的）；内置模式由插件拉起一次性无界面进程，账本隔离在插件数据目录，适合不想跑 DSH 界面的场景。

**Q：审批我不想管，能全自动吗？**
外接模式 180 秒无人应答自动拒绝（可配置 `approvalTimeoutMs`，0 为禁用）；内置模式越界直接拒绝，均不会默默放行。

**Q：任务跑一半 Hana 重启了？**
向 Hana 问一句任务进度，它会自动与 DSH 侧对账，如实说明状态。

## 适配与免责

- 适配 DeepSeek Harness `0.1.0-rc.6`。DSH 处于开发者预览期，接口可能有破坏性变更
- 本仓库不含任何 API Key 或凭据
- 内置模式的 `danger-full-access` 会解除沙箱边界，仅在您明确授权后使用

## License

MIT
