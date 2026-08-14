# 任务书：编写 dsh-api.ps1 桥接脚本

你（DSH）正在协助 Hana 完成阶段一工程。请编写一个 PowerShell 脚本，作为 Hana 调用你的 Web API 的命令行工具。

## 背景（已实测验证的事实）

你的 Web 服务在 http://127.0.0.1:3080 提供 JSON RPC API。已确认可用的接口：

- POST /api/session.create，body 信封格式：
  {"type":"client-request","rpcId":"<任意唯一字符串>","method":"session.create","payload":{"workspaceId":"fdaf8c20-a0de-41a1-9966-59a1af000635"}}
  响应：{"type":"server-response","rpcId":"...","result":{"ok":true,"value":{"sessionId":"session-xxx"}}}
- POST /api/session.prompt，payload：
  {"sessionId":"session-xxx","mode":"queue","content":[{"type":"text","text":"<消息内容>"}]}
  响应 result.value.accepted 为 true 表示受理
- POST /api/session.history，payload：{"sessionId":"session-xxx"}
  响应 result.value.events 是事件数组，每条 {"event":{"type":"...","seq":N,"data":{...}}}。
  最终回复在 type 为 "assistant/message" 的事件里，data.content 是数组，取其中 type 为 "text" 的 text 拼接。

所有请求要求请求头 Content-Type: application/json。

## 交付物

文件：D:\DeepSeek-Harness\协助Hana\dsh-bridge\dsh-api.ps1

## 功能规格

脚本支持 4 个子命令（第一个参数为子命令名）：

1. `new`：创建新会话（workspaceId 固定用上面那个 fdaf8c20 开头的值），输出 sessionId
2. `prompt <sessionId> <消息...>`：向会话发送消息，输出 accepted 状态
3. `history <sessionId>`：查询会话历史，把最后一条 assistant/message 的完整文本输出到标准输出
4. `run <任务...>`：一条龙。new → prompt → 每 6 秒查一次 history，直到最后一条 assistant/message 的 seq 大于派单时的最大 seq（即等到新回复出现），或超过 10 分钟超时。完成后输出最终回复文本。运行中可以把中间状态输出到 stderr。

## 技术要求

- 用 curl.exe 或 Invoke-RestMethod 均可，任选
- rpcId 用时间戳+随机数生成，保证唯一
- 中文消息必须正确处理 UTF-8 编码
- 脚本头部注释写清用法示例
- 超时判定用秒数（600 秒）

## 自检要求

写完后，自己在你的工作目录里实际运行一次：
`powershell -NoProfile -File D:\DeepSeek-Harness\协助Hana\dsh-bridge\dsh-api.ps1 run "请只回复四个字：工具就绪"`

确认能打印出最终回复。若超时或报错，修复后重试，最多重试 3 次。最后把脚本文件路径和自检结果写进你的最终回复。
