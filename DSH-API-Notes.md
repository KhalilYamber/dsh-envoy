# DeepSeek Harness Web API 逆向笔记

> 适配版本：@deepseek-ai/dsh 0.1.0-rc.6（2026-08-13 开源时的最新版）
> 本文档通过阅读本地安装包源码、实际调用验证整理。官方目前未公开此 RPC 契约，API 随版本变动风险高，使用前请确认版本。

## 1. 概览

DSH Web 服务（默认 http://127.0.0.1:3080）提供一套 JSON RPC 接口，浏览器前端与后端全部通过它通信。任何外部程序（Agent、脚本）都可以直接调用它驱动 DSH。

## 2. 信封格式

所有 POST /api/<method> 请求体：

```json
{
  "type": "client-request",
  "rpcId": "<任意唯一字符串>",
  "method": "<方法名>",
  "payload": { ... }
}
```

响应体：

```json
{
  "type": "server-response",
  "rpcId": "<回显请求的 rpcId>",
  "result": { "ok": true, "value": { ... } }
}
```

失败时 `result.ok` 为 false，携带 `{ code, message, details }`。

关键约束：
- Content-Type 必须是 application/json，否则 415
- 请求体里的 method 必须与 URL 路径一致，否则报错
- rpcId 是纯回显令牌，客户端自己生成

## 3. 核心方法

### 会话域

| 方法 | payload 要点 | 说明 |
|------|-------------|------|
| session.list | {} | 列出全部会话摘要 |
| session.create | { workspaceId? , cwd? , sessionId? } | 创建会话；workspaceId 与 cwd 二选一，带 workspaceId 则直接归属该工作区 |
| session.prompt | { sessionId, mode: 'queue'\|'steer', content: [{type:'text',text}, {type:'image',...}] } | 提交消息。mode=queue 排队进下一轮 |
| session.history | { sessionId } | 读取事件流。结果在 value.events[].event |
| session.cancel | { sessionId } | 中断当前回合 |
| session.rename / fork / models / selectModel / updateQueue / search / attachment | 略 | 见源码 sessions.schema.js |

### 工作区域

| 方法 | payload 要点 | 说明 |
|------|-------------|------|
| workspace.list | {} | 列出工作区，含各自的 sessionIds |
| workspace.create | { path } | 绑定一个目录为工作区，标题取目录名 |
| workspace.rename / delete / insertBefore / insertSessionBefore | 略 | 管理操作 |
| workspace.archiveSession | { sessionId } | 归档会话（从界面隐藏，可恢复） |

### 其他域

- host.* ：主机描述、目录选择、打开路径
- settings.* / credentials.* ：配置页读写（credentials.describe 不返回 key 值）
- llm.* ：provider/model 目录
- skill.list / command.* ：技能与斜杠命令
- subagent.* ：子代理管理
- goal.* ：目标管理
- agentPreset.* ：预设管理

## 4. 事件流

### 会话事件（session.history 返回）

每行一个事件 `{ type, seq, time, data }`。关键类型：

- turn/start / turn/end ：回合边界。**判定「任务是否完成」看 turn/end**
- user/message ：用户消息（含主人的插话）
- assistant/message ：助手消息。文本在 data.message.content 下 type=text 的段
- assistant/chunk ：流式分块
- tool/call / tool/result ：工具调用
- permission/preset / approval/policy ：权限状态
- step/start / step/end ：步骤边界

注意：assistant/message 的 data 结构是 `{ message: { content: [...] } }`，而 user/message 的文本在 `data.content` 下。两处路径不同，容易踩坑。

### 实时推送

- GET /api/events.mux ：复用事件流（会话投影、状态帧），**需要 WebSocket 升级**（普通 GET 返回 upgrade required）
- GET /api/events.host ：主机事件流，同样走 WebSocket
- SSE 帧格式：`data: {"type":"server-request","rpcId":...,"method":"<frame type>","payload":{...}}`

如果只需要按需查看进度，轮询 session.history 完全够用，不必接 WebSocket。

## 5. 会话持久化

- 会话文件在 `~/.dsh/sessions/` 下，按「工作区路径编码目录」分组
- 每个会话一个目录，内含 session.jsonl.zstd（zstd 压缩）
- 未分组会话的目录名只含 cwd 编码；分组会话的目录名含工作区路径编码
- Web UI 导出：GET /api/session.export?sessionId=xxx（返回 zip，内含明文 jsonl）

## 6. 工作区归组机制（实测结论）

- 界面显示一个会话属于哪个工作区，取决于 workspace 的 sessionIds 记账 + 会话文件实际路径匹配工作区 path
- 用 session.create 带 workspaceId 创建会话，文件会自动落进对应目录
- **直接改 workspace.json 文件不生效**：运行中的 DSH 服务持有内存状态，外部文件改动要等服务重启才重读
- 正确姿势：一切归组操作走 API（session.create / workspace.archiveSession 等）

## 7. 权限审批缝

- dsh-user-approval 提供 `ctx.approval.request(req)`，返回 allowed-once / rejected / cancelled / unavailable
- 无 answerer 时 fail closed（headless 下所有需要审批的操作被拒绝）
- 支持外部 answerer 插件监听 approval/request 事件做机器决策，这是把 DSH 权限请求桥接到其他审批 UI 的官方通道
- 会话事件流里的 approval/policy 事件记录当前策略（ask / never）

## 8. 已知坑

1. npx 偶尔解析到缓存的旧包（MODULE_NOT_FOUND bin.js），直接用 node_modules\.bin\dsh.cmd 更稳
2. 中文 JSON 用 PowerShell curl.exe 时，--data-binary @文件 最稳，避免命令行转义问题
3. Windows PowerShell 5.1 运行 .ps1 需要 UTF-8 BOM，否则中文按 GBK 解码报语法错误
4. headless profile 首次运行自动初始化（~/.dsh/profiles/headless/）
5. dsh plugin 管理命令依赖 pnpm，未装 pnpm 时该命令不可用（不影响 web/headless 运行）
