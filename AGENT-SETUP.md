# AGENT-SETUP.md：hana-dsh-bridge 部署手册（给 Agent 读）

> 你是一个 Agent，正帮助你的主人部署 hana-dsh-bridge。
> 请按本文档的决策树逐步执行。每步都有检查命令与判定标准。
> 目标：让 dsh-api.ps1 在本机可用，且一条 `run` 命令能驱动主人的 DSH 完成对话。

## 安全红线（必须遵守）

1. 全程不得读取、复制、打印主人的任何 API Key（DSH 凭证在 ~/.dsh/.credentials.yaml，由 DSH 自己管理）
2. 不得修改主人的 DSH 已有配置（profiles、sessions、workspace 存量数据）
3. 所有安装操作只增不删；确需删除前必须向主人确认

## 阶段 0：环境探测

依次执行，记录结果：

```
A. node --version          → 是否 >= 24（dsh 要求 Node 22+，建议 24）
B. npm --version           → npm 是否可用
C. curl.exe 测 127.0.0.1:3080 → DSH 服务是否已在运行（HTTP 200 为运行中）
D. 检查 ~/.dsh 目录        → DSH 是否安装使用过（profiles/sessions 存在即用过）
E. 检查 npm 网络           → 官方 registry 直连是否可达（见异常附录 A1）
```

## 阶段 1：分支决策

按探测结果选分支：

| 条件 | 走哪条 |
|------|--------|
| C 运行中 且 D 已使用过 | 分支①：跳过安装，直接部署桥（阶段 3） |
| D 已使用过，但 C 未运行 | 分支②：启动已有 DSH 服务，再部署桥 |
| D 未使用过 | 分支③：全新安装 DSH，再部署桥 |

## 阶段 2：DSH 安装（仅分支③）

1. 选目录：向主人询问或默认 `D:\DeepSeek-Harness`（可自行选择，记住它，后面配置要用）
2. 进入该目录执行：

```
npm install @deepseek-ai/dsh
```

3. 若网络慢/失败：用国内镜像（一次性参数，不改全局配置）：

```
npm install @deepseek-ai/dsh --registry=https://registry.npmmirror.com
```

4. 验证安装：

```
.\node_modules\.bin\dsh.cmd --version    → 应输出 0.1.x-rc.x
```

5. 启动服务（隐藏窗口）：

```
Start-Process -FilePath "node.exe路径" -ArgumentList "<安装目录>\node_modules\@deepseek-ai\dsh\lib\bin.js","web" -WorkingDirectory "<安装目录>" -WindowStyle Hidden
```

6. 验证：curl 127.0.0.1:3080 返回 200 且页面标题含 DeepSeek Harness

7. 让主人在浏览器打开 http://127.0.0.1:3080 配好 DeepSeek API Key（凭证由 DSH 界面管理，你不参与）

## 阶段 3：桥接部署（所有分支）

1. 把本仓库内容放入任意目录（建议与 DSH 安装目录平级或在其子目录，如 `<安装目录>\协助Hana\dsh-bridge`）
2. 运行 `powershell -NoProfile -File dsh-api.ps1 new`
   - 自动生成 config.json（复制自 config.example.json）
   - 自动发现或创建「协助Hana」工作区并回写 WorkspaceId
   - 输出一个 sessionId 即成功
3. 若主人的 DSH 里没有「协助Hana」工作区，脚本会自动创建一个同名目录并绑定。这正是期望行为，无需手动干预

## 阶段 4：验收自检（必须全部通过才算部署成功）

```
1. powershell -NoProfile -File dsh-api.ps1 run "请只回复：桥接成功"
   → 应等待回合结束并输出「桥接成功」
2. powershell -NoProfile -File dsh-api.ps1 status <上一步的会话id>
   → 应显示「状态: 已完成」
3. 提示主人打开 DSH 界面，确认「协助Hana」工作区里能看到刚才的会话
```

三项全过，向主人汇报部署完成，并附上日常派单用法：

```
powershell -NoProfile -File <桥目录>\dsh-api.ps1 run "任务描述"
```

## 异常附录

### A1 npm 网络不可达

现象：npm install 长时间无进度或 TLS 报错。
排查：curl 官方 registry 直连 10 秒内无 200，且代理端口（常见 7890/7897）未监听。
解法：改用国内镜像（阶段 2 第 3 步）。若镜像也不通，检查主人 VPN 是否开启，向主人说明网络状况再继续。

### A2 PowerShell 5.1 中文乱码/语法错误

现象：脚本报大量语法错误或中文变问号。
原因：脚本必须带 UTF-8 BOM。检查文件头三字节为 EF BB BF；缺失则补写 BOM 后重试。

### A3 服务 3080 端口被其他程序占用

现象：启动 DSH 报端口冲突，或 curl 返回非 DSH 页面。
解法：netstat 查占用进程，向主人确认后处理。不要盲目杀进程。

### A4 派单无响应或超时

现象：run 一直轮询超过 30 分钟。
排查：DSH 服务是否还在运行；主人的 API Key 是否已配置且额度充足；查看 DSH 界面该会话是否在正常跑。

### A5 Windows 下 npm 全局安装路径异常

现象：dsh 命令不存在或指向旧版本。
解法：不要用全局 npx 缓存，始终用安装目录内 `node_modules\.bin\dsh.cmd` 绝对路径调用（本桥脚本内部也是这么做的思路）。

## 完成汇报格式

部署完成后，向主人汇报：
1. 走的分支（①/②/③）
2. DSH 安装目录与桥目录
3. 验收三项结果
4. 主人日常使用的一句话命令
