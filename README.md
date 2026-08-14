# hana-dsh-bridge

> 给你的 Hana 装一个「外包 coding 的开关」。
> 说一句「派给 DSH」，任务就流向本机 DeepSeek Harness：界面实时可见，过程随时可插话，结果自动带回。
> 标准 Hana Skill 包，放进 skills 目录即生效。

## 效果示例

```
你   ：派给 DSH：给 dsh-api.ps1 加一个 status 子命令
Hana ：收到，正在派单【0815-01】…
       DSH 已开工：读任务书 → 复述要点 → 等确认 → 动手 → 自检
       DSH 交活：自检三项全过，附 4 个验收检查点。Hana 已按点实测，全部通过~
```

DSH 界面里，「协助Hana」工作区同步出现会话，全过程实时可见。你随时可以点进去看它干到哪一步，甚至直接插话打断。

## 为什么需要它

- **各干各的**：Hana 擅长拆任务、派单、验收；DSH 擅长终端里长时间写代码。本 Skill 让两者组队，互不越权
- **不迷路**：每次工作自动打日期标签（如 0815-01），同一次工作的多个会话共用一个标签，DSH 界面里一眼分组
- **有刹车**：DSH 开工前先复述任务要点，等 Hana 确认才动手；交活后附验收检查点，Hana 逐项实测
- **零凭证风险**：桥脚本只调本机 3080 的 HTTP API，API Key 由 DSH 自己管理，仓库不含任何秘密

## 前置要求

| 项 | 要求 |
|----|------|
| 操作系统 | Windows（PowerShell 5.1+） |
| Node.js | >= 22（建议 24） |
| DeepSeek Harness | 已安装（适配 0.1.0-rc.6），服务在 127.0.0.1:3080 |
| DSH 凭证 | 主人在 DSH 界面配好 DeepSeek API Key |

## 安装（1 分钟）

1. 把本仓库放进 HanaAgent 的 skills 目录（如 `~/.hanako/skills/hana-dsh-bridge`）
2. 确认本机 DSH 已安装并运行（http://127.0.0.1:3080）
3. 初始化：`powershell -NoProfile -File <本目录>\scripts\dsh-api.ps1 new`
   （自动生成配置、自动发现「协助Hana」工作区）
4. 完成。对你的 Hana 说「派给 DSH：<任务>」即可

全新安装 DSH 的场景，让 Agent 读 [AGENT-SETUP.md](AGENT-SETUP.md)（决策树式部署手册，含网络、权限、编码等异常分支）。

## 工作原理

```
你 → Hana（读 SKILL.md，识别"派给 DSH"）
      │  powershell 调 scripts\dsh-api.ps1
      ▼
   DSH Web API（本机 127.0.0.1:3080，JSON RPC）
      │  session.create（归入协助Hana 工作区）
      │  session.prompt（带工作标签）
      ▼
   DSH 干活（多回合 agent 循环，界面实时投影）
      │  session.history 轮询（turn/end 判定完成）
      ▼
Hana 拿到最终回复 → 向你汇报
```

## 五个子命令

| 命令 | 作用 |
|------|------|
| `new` | 创建新会话（自动归属协助Hana 工作区） |
| `prompt [-Tag 标签] <sessionId> <消息...>` | 向会话发消息（同工作内追加用 -Tag 继承标签） |
| `history <sessionId>` | 输出会话最后一条助手回复 |
| `run [-Tag 标签] <任务...>` | 一条龙：建会话→派单→等回合结束→输出最终回复 |
| `status <sessionId>` | 会话状态摘要（进行中/已完成/空） |

## 常见问题

**Q：派单后没反应？**
A：先确认 DSH 服务在跑（浏览器能打开 127.0.0.1:3080）。服务被闲置看护停掉时，脚本会给出人话提示。

**Q：DSH 界面里会话在哪？**
A：都在「协助Hana」工作区（脚本自动创建）。按标题上的【日期-序号】标签分组辨认。

**Q：主人能中途插话吗？**
A：能。在 DSH 界面该会话里直接输入即可，Agent 用 `status` 就能看到插话内容。

**Q：标签序号乱了怎么办？**
A：计数器文件损坏会自动重建，无需手动处理。跨天序号自动归零。

## 目录

```
SKILL.md                Skill 开关（触发词与工作流，Agent 自动读取）
scripts/dsh-api.ps1     桥接脚本（唯一核心代码）
config.example.json     配置模板
AGENT-SETUP.md          给 Agent 读的部署手册
COLLAB.md               双 agent 协作协议（复述对齐、自检、验收检查点）
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
