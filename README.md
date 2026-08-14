# hana-dsh-bridge

> HanaAgent 与 DeepSeek Harness 的协作桥：让你的 Hana 把 coding 工作派给 DSH 执行，实时可见、自动归组、带工作标签。

## 这是什么

一个让 [HanaAgent](https://github.com/liliMozi/openhanako) 的 Agent（Hana）与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）协同工作的工具包：

- Hana 通过 HTTP API 把任务派给本机 DSH 服务
- 会话自动归入「协助Hana」工作区，界面上可见全过程
- 每次工作自动打日期标签（如 0814-07），同一次工作的多个会话可分组辨认
- 含双 agent 协作协议（复述对齐、自检、验收检查点）

## 快速开始

1. 确认已装 DSH（`npx @deepseek-ai/dsh web` 能启动）和 PowerShell 5.1+
2. 把本仓库放进你的工作目录，或任意位置
3. 首次运行自动生成 config.json（或复制 config.example.json 改名）
4. 派单测试：`powershell -NoProfile -File dsh-api.ps1 run "请只回复：桥接成功"`
5. 打开 DSH 界面（http://127.0.0.1:3080），在「协助Hana」工作区看到会话

## 五个子命令

| 命令 | 作用 |
|------|------|
| `new` | 创建新会话（自动归属协助Hana 工作区） |
| `prompt [-Tag 标签] <sessionId> <消息...>` | 向会话发消息 |
| `history <sessionId>` | 输出会话最后一条助手回复 |
| `run [-Tag 标签] <任务...>` | 一条龙：建会话→派单→等回合结束→输出最终回复 |
| `status <sessionId>` | 会话状态摘要（进行中/已完成/空） |

## 给 Agent 看的手册

如果你是用 HanaAgent 部署，让你的 Agent 读 [AGENT-SETUP.md](AGENT-SETUP.md)，它能按你的电脑环境自动完成安装与配置。

## 目录

```
dsh-api.ps1            桥接脚本（唯一核心代码）
config.example.json    配置模板（复制为 config.json 使用）
COLLAB.md              双 agent 协作协议模板
AGENT-SETUP.md         Agent 部署手册
DSH-API-Notes.md       DSH Web API 逆向笔记
task-spec-*.md         任务书留档（含示例性环境值，仅供参考格式）
```

## 安全说明

- 本仓库不含任何 API Key。DSH 的凭证由其自身管理（~/.dsh/.credentials.yaml），桥脚本不接触
- config.json、tmp/、计数器文件已加入 .gitignore

## 适配与免责

适配 DSH 0.1.0-rc.6。DSH 处于开发者预览期，API 可能有破坏性变更，升级后请对照 DSH-API-Notes.md 验证。

## License

MIT
