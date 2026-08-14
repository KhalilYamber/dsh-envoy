# hana-dsh-bridge

> HanaAgent 与 DeepSeek Harness 的协作桥：让你的 Hana 把 coding 工作派给 DSH 执行，实时可见、自动归组、带工作标签。
> 本仓库是标准 Hana Skill 包：**放进 skills 目录即生效**，你的 Hana 会自动学会「派给 DSH」这个能力。

## 安装（1 分钟）

1. 把本仓库放进 HanaAgent 的 skills 目录（如 `~/.hanako/skills/hana-dsh-bridge`）
2. 确保本机 DSH 已安装并运行（http://127.0.0.1:3080）
3. 跑一次初始化：`powershell -NoProfile -File <本目录>\scripts\dsh-api.ps1 new`
   （自动生成配置、自动发现「协助Hana」工作区）
4. 完成。现在对你的 Hana 说「派给 DSH：<任务>」，它就会自动处理

详细部署手册见 [AGENT-SETUP.md](AGENT-SETUP.md)（给 Agent 读的决策树）。

## 五个子命令

| 命令 | 作用 |
|------|------|
| `new` | 创建新会话（自动归属协助Hana 工作区） |
| `prompt [-Tag 标签] <sessionId> <消息...>` | 向会话发消息 |
| `history <sessionId>` | 输出会话最后一条助手回复 |
| `run [-Tag 标签] <任务...>` | 一条龙：建会话→派单→等回合结束→输出最终回复 |
| `status <sessionId>` | 会话状态摘要（进行中/已完成/空） |

## 目录

```
SKILL.md                Skill 开关（触发词与工作流，Agent 自动读取）
scripts/dsh-api.ps1     桥接脚本（唯一核心代码）
config.example.json     配置模板
AGENT-SETUP.md          给 Agent 读的部署手册
COLLAB.md               双 agent 协作协议
DSH-API-Notes.md        DSH Web API 逆向笔记
task-specs/             任务书留档（含示例性环境值，仅供参考格式）
```

## 安全说明

- 本仓库不含任何 API Key。DSH 的凭证由其自身管理（~/.dsh/.credentials.yaml），桥脚本不接触
- config.json、计数器文件已加入 .gitignore

## 适配与免责

适配 DSH 0.1.0-rc.6。DSH 处于开发者预览期，API 可能有破坏性变更，升级后请对照 DSH-API-Notes.md 验证。

## License

MIT
