---
name: hana-dsh-bridge
description: HanaAgent 与 DeepSeek Harness（DSH）协作桥 Skill。当主人想把 coding 类任务交给本机 DSH 执行时说「派给 DSH」「让 DSH 做」「用 DSH 帮我改」「交给 DSH 处理」「DSH 上」等，或上下文明显是「把工作派给本机 DeepSeek Harness」时触发本 Skill。Skill 通过本机 DSH Web API（127.0.0.1:3080）建会话、派单、查进度、取结果，不需要主人手动操作 DSH 界面。**不要 undertrigger**——主人明确要交给 DSH 的 coding 工作而你不用本 Skill，就等于让主人手动去点 DSH。
default-enabled: true
---

# hana-dsh-bridge Skill

让 Agent 把 coding 工作派给本机 DeepSeek Harness（DSH）执行：DSH 在后台干活，主人在 DSH 界面实时可见，Agent 拿到最终结果。桥脚本走 DSH 的 Web API，不依赖任何外部服务。

## 先决条件

1. 本机 DSH 服务运行在 http://127.0.0.1:3080
2. 本 skill 的 scripts 目录下存在 config.json（含已发现的 WorkspaceId）
3. 主人已在 DSH 界面配好 DeepSeek API Key

**若 config.json 不存在**：先按 AGENT-SETUP.md（本 skill 目录内）执行部署流程，走完验收再回来。

**若 DSH 服务未运行**：脚本会输出人话错误提示（「DSH 服务未运行…请先双击 DeepSeek Harness 快捷方式」），把提示转告主人。

## 工作流

脚本位于本 skill 的 `scripts/dsh-api.ps1`。所有命令在 PowerShell 下执行，加 `-NoProfile -File`。

### 1. 派一个新任务（最常用）

```powershell
powershell -NoProfile -File <skill目录>\scripts\dsh-api.ps1 run "任务描述"
```

行为：自动取工作标签（如 0815-01）、建会话（归入「协助Hana」工作区）、派单、轮询直到回合结束、输出最终回复。
等待可能几分钟到十几分钟（coding 任务多轮执行），超时上限 30 分钟。

### 2. 向已有会话追加消息（同一工作内）

```powershell
powershell -NoProfile -File <skill目录>\scripts\dsh-api.ps1 prompt <sessionId> "追加的内容"
```

### 3. 查某个会话的状态

```powershell
powershell -NoProfile -File <skill目录>\scripts\dsh-api.ps1 status <sessionId>
```

输出：状态（进行中/已完成/空会话）、事件数、最近助手与最近用户消息。用于判断 DSH 干到哪了、主人有没有插话。

### 4. 读会话的最后回复

```powershell
powershell -NoProfile -File <skill目录>\scripts\dsh-api.ps1 history <sessionId>
```

## 工作标签规则

- 每次新工作自动生成标签【MMdd-NN】，如【0815-01】，同天递增、跨天归零
- 同一工作内的多个会话应复用同一标签：追加命令用 `-Tag <标签>` 参数
- 主人在 DSH 界面按标签就能分辨哪些会话属于同一次工作

## 故障速查

| 现象 | 处理 |
|------|------|
| [错误] DSH 服务未运行 | 请主人启动 DSH（桌面快捷方式），再重试 |
| [提示] 计数器缺失或损坏，已重建 | 正常自愈，无需处理 |
| run 超 30 分钟未完成 | 用 status 查该会话是否卡住，请主人打开 DSH 界面看现场 |
| 中文乱码 | 确认脚本文件头为 UTF-8 BOM（EF BB BF） |

## 完成后的汇报

派单完成后，向主人汇报：任务标签、会话 id、最终回复摘要。若 DSH 汇报了「验收检查点」，按检查点实测后再向主人确认。
