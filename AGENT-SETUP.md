# AGENT-SETUP.md：hana-dsh-bridge 部署手册（给 Agent 读）

> 你是一个 Agent，正帮助你的主人部署 hana-dsh-bridge。
> 请按本文档的决策树逐步执行。每步都有可直接复制的命令与判定标准。
> 目标：让 dsh-api.ps1 在本机可用，且能驱动主人的 DSH 完成对话。

## 安全红线（必须遵守）

1. 全程不得读取、复制、打印主人的任何 API Key（DSH 凭证在 DSH 自己的目录里，由 DSH 管理）
2. 不得修改主人的 DSH 已有配置（profiles、sessions、workspace 存量数据）
3. 所有安装操作只增不删；确需删除前必须向主人确认

## 阶段 0：环境探测

依次执行下列命令，记录每项结果：

```
A1. 检查 Node 是否安装：
    where.exe node
    → 无输出 = Node 未安装，走阶段 2 的第 0 步（先装 Node）
    → 有输出 = 继续 A2

A2. 检查 Node 版本：
    node --version
    → 版本 >= 22 才可用（建议 24），低于 22 走阶段 2 的第 0 步（升级 Node）

B. 检查 npm：
    npm --version
    → 报错则随 Node 问题一并处理

C. 检查 DSH 服务是否在运行：
    curl.exe -s -o NUL -w "%{http_code}" --max-time 5 http://127.0.0.1:3080/
    → 输出 200 = 运行中
    → 非 200 或无输出 = 未运行

D. 检查 DSH 是否安装使用过：
    目录位置（Windows）：C:\Users\<当前用户名>\.dsh
    若该目录下存在 profiles 或 sessions 子目录 = 安装使用过
    （在 PowerShell 里可用 $env:USERPROFILE 取当前用户目录，即 $env:USERPROFILE\.dsh）

E. 检查 npm 网络：
    curl.exe -s -o NUL -w "%{http_code}" --max-time 10 https://registry.npmjs.org/
    → 200 = 官方源可达
    → 超时或报错 = 网络受限，见异常附录 A1
```

## 阶段 1：分支决策

| 条件 | 走哪条 |
|------|--------|
| C 运行中 且 D 已使用过 | 分支①：跳过安装，直接部署桥（阶段 3） |
| D 已使用过，但 C 未运行 | 分支②：启动已有 DSH 服务（阶段 2 第 5~7 步），再部署桥 |
| D 未使用过 | 分支③：全新安装 DSH（阶段 2 全部），再部署桥 |
| Node 不达标 | 先装/升级 Node（阶段 2 第 0 步），再按上表走 |

## 阶段 2：DSH 安装

### 第 0 步（仅 Node 不达标时）：安装 Node

- Windows：从 https://nodejs.org 下载 LTS 安装包，默认安装，装完重开终端
- 重跑阶段 0 的 A1/A2 确认版本 >= 22

### 第 1 步：选安装目录

向主人询问或默认 `D:\DeepSeek-Harness`。记住这个目录，后面配置要用。

### 第 2 步：安装

```
cd /d <安装目录>
npm install @deepseek-ai/dsh
```

### 第 3 步（仅网络受限时）：用国内镜像安装

```
npm install @deepseek-ai/dsh --registry=https://registry.npmmirror.com
```

### 第 4 步：验证安装

```
.\node_modules\.bin\dsh.cmd --version
```
应输出 0.1.x-rc.x。

### 第 5 步：启动服务（隐藏窗口）

先找 node.exe 的完整路径：`where.exe node`

然后执行（把 <node路径> 和 <安装目录> 换成实际值）：

```powershell
Start-Process -FilePath "<node路径>" -ArgumentList "<安装目录>\node_modules\@deepseek-ai\dsh\lib\bin.js","web" -WorkingDirectory "<安装目录>" -WindowStyle Hidden
```

### 第 6 步：验证服务

重跑阶段 0 的 C 命令，应输出 200。

### 第 7 步：请主人配置凭证

提示主人在浏览器打开 http://127.0.0.1:3080 ，在界面里配置 DeepSeek API Key。
（这是与主人的交互点：若主人不在，先暂停并告知，不要自行操作凭证。）

## 阶段 3：桥接部署（所有分支）

### 第 1 步：获取本仓库

方式一（推荐）：git clone
```
git clone https://github.com/KhalilYamber/hana-dsh-bridge.git <目标目录>
```
方式二：下载 zip
浏览器打开 https://github.com/KhalilYamber/hana-dsh-bridge ，点 Code → Download ZIP，解压。

目标目录建议放在 DSH 安装目录旁，例如 `<安装目录>\hana-dsh-bridge`。若主人的 HanaAgent 有 skills 目录（如 `~/.hanako/skills`），可直接放进去当 Skill 安装，装上即生效。

### 第 2 步：首次运行（自动配置）

```
cd /d <目标目录>
powershell -NoProfile -File scripts\dsh-api.ps1 new
```

预期行为（缺一即异常）：
- 输出「[配置] 未找到 config.json，已从 config.example.json 复制生成」
- 输出「[workspace] ...自动发现...」并找到或创建「协助Hana」工作区
- 最后输出一个 session- 开头的会话 id

## 阶段 4：验收自检（必须全部通过才算部署成功）

按三步走（每一步的会话 id 都从上一步输出中直接获得）：

```
第 1 步：创建会话并记录 id
    powershell -NoProfile -File scripts\dsh-api.ps1 new
    → 记下输出的 sessionId（记为 SID）

第 2 步：向该会话发测试任务
    powershell -NoProfile -File scripts\dsh-api.ps1 prompt SID "请只回复：桥接成功"
    → 应输出 True

第 3 步：轮询状态直到完成
    powershell -NoProfile -File scripts\dsh-api.ps1 status SID
    → 间隔 15 秒重复查询，直到「状态: 已完成」
    → 「最近助手」中应包含「桥接成功」
```

三项全过后，提示主人打开 DSH 界面（http://127.0.0.1:3080），确认「协助Hana」工作区里能看到刚才的会话。

## 异常附录

### A1 npm 网络不可达

现象：阶段 0 的 E 命令超时或报错。
排查：检查主人的代理/VPN 是否开启（常见本地代理端口 7890/7897）。
解法：若代理可用则 npm 走代理；否则改用国内镜像（阶段 2 第 3 步）。若镜像也不通，向主人说明网络状况，暂停部署。

### A2 PowerShell 中文乱码或语法错误

现象：运行脚本报大量语法错误或中文变问号。
原因：脚本必须带 UTF-8 BOM。
排查：读脚本文件前三个字节，应为 EF BB BF。缺失则用支持 BOM 的编辑器重新保存为 UTF-8 with BOM。

### A3 服务 3080 端口被其他程序占用

现象：启动 DSH 报端口冲突，或阶段 0 的 C 返回 200 但页面内容不是 DSH。
解法：`netstat -ano | findstr :3080` 查占用进程，向主人确认后处理。不要盲目杀进程。

### A4 派单无响应或超时

现象：阶段 4 第 3 步轮询超过 30 分钟仍未「已完成」。
排查：DSH 服务是否还在运行（重跑阶段 0 的 C）；主人的 API Key 是否已配置且额度充足；打开 DSH 界面看该会话是否正常。

### A5 dsh 命令不存在或指向旧版本

现象：`dsh.cmd --version` 报错或版本过旧。
解法：不要依赖 npx 缓存或全局安装，始终用安装目录内的绝对路径：
`<安装目录>\node_modules\.bin\dsh.cmd`
（桥脚本 dsh-api.ps1 走 HTTP API，与 dsh.cmd 无关，不受此问题影响。）

## 完成汇报格式

部署完成后，向主人汇报：
1. 走的分支（①/②/③，是否补装 Node）
2. DSH 安装目录与桥目录
3. 阶段 4 三项验收结果
4. 主人日常使用的一句话命令：
   `powershell -NoProfile -File <桥目录>\scripts\dsh-api.ps1 run "任务描述"`
