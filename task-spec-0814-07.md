# 任务书 0814-07：dsh-api.ps1 全面参数化改造

## 背景

先读 `D:\DeepSeek-Harness\协助Hana\dsh-bridge\COLLAB.md` 协作协议，按对齐流程执行（先复述要点，停下等 Hana 确认）。

本项目将开源给其他 HanaAgent 用户。当前脚本含本机硬编码，需改造为任何电脑都能直接用。

## 改造目标

脚本运行时，不依赖任何硬编码的本机路径或 id。全部从配置文件读取或自动推导/发现。

## 规格

### 1. 配置文件机制

- 新增 `config.example.json`（进开源仓库），字段：
  - `BaseUrl`：默认 `http://127.0.0.1:3080`
  - `WorkspaceId`：默认空字符串，空=运行时自动发现
  - `AssistWorkspaceTitle`：默认 `协助Hana`（自动发现/创建时用这个名字匹配）
  - `AssistWorkspacePath`：默认空，空=取脚本所在目录的上一级（即 bridge 目录的父目录）拼接 `\协助Hana`
  - `PollIntervalSeconds`：默认 6
  - `TimeoutSeconds`：默认 1800
- 新增 `config.json`（运行时实际配置，**不进开源仓库**，加到 .gitignore）
- 脚本启动时若 config.json 不存在：复制 config.example.json 为 config.json
- 脚本启动时若 config.example.json 也不存在：用上述默认值生成两个文件

### 2. workspaceId 自动发现与创建

run / new 需要 workspaceId 时（config 里为空）：
1. 调 workspace.list，找 title 等于 AssistWorkspaceTitle 的工作区，取它的 workspaceId，并回写进 config.json（下次直接用）
2. 若不存在该工作区：调 workspace.create，payload { path: <AssistWorkspacePath 解析值> }。若目标目录不存在先创建。创建成功后把返回的 workspaceId 回写 config.json
3. 创建失败（目录权限等）：输出人话错误（含解决建议），退出码 5

### 3. 路径推导

- 脚本自身路径 `$PSScriptRoot` 已知（即 bridge 目录）
- 计数器文件路径：`$PSScriptRoot\.work-counter.json`（跟随脚本，不再硬编码）
- AssistWorkspacePath 为空时：`Split-Path $PSScriptRoot -Parent` + `\` + AssistWorkspaceTitle

### 4. 不变项

- 五个子命令（new/prompt/history/run/status）行为完全不变
- 健康检查、计数器自愈、互斥锁、turn/end 语义、UTF-8 BOM、Write-Host 约定全部保持
- 标签体系保持

### 5. 新增 .gitignore（bridge 目录内）

内容至少包含：`config.json`、`tmp/`、`.work-counter.json`

## 自检要求

1. 备份当前 config 后，模拟全新环境：删除 config.json 和 .work-counter.json，跑 `new`，确认自动生成 config、自动发现/创建工作区、标签正常
2. 跑 `run -Tag 0814-07 "请只回复：参数化成功"` 验证主链路
3. 自检后**恢复原状态**：把测试期间改动的 config.json 恢复为指向现有协助Hana 工作区的配置（WorkspaceId 填回 fdaf8c20 开头的值），计数器恢复 seq 7
4. 语法检查、BOM 检查

最终回复按协议格式，附验收检查点。
