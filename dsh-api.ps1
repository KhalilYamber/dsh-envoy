<#
.SYNOPSIS
dsh-api.ps1 —— DSH Web API 命令行桥接脚本（Hana 阶段一工程）

.DESCRIPTION
通过 HTTP JSON RPC 调用 DSH Web 服务。服务地址与工作区等参数从 config.json 读取，
config.json 缺失时自动从 config.example.json 复制生成；WorkspaceId 留空时按标题自动发现，
找不到则按 AssistWorkspacePath 自动创建并回写。

用法示例:
  powershell -NoProfile -File dsh-api.ps1 new
  powershell -NoProfile -File dsh-api.ps1 prompt [-Tag <标签>] <sessionId> "你好，请介绍一下自己"
  powershell -NoProfile -File dsh-api.ps1 history <sessionId>
  powershell -NoProfile -File dsh-api.ps1 status <sessionId>
  powershell -NoProfile -File dsh-api.ps1 run [-Tag <标签>] "请只回复四个字：工具就绪"

工作标签:
  每次工作分配唯一标签【MMdd-NN】（如【0814-02】），同一天序号递增，跨天从 01 重新开始。
  run / prompt 不带 -Tag 时，自动读取 .work-counter.json 生成新标签并写回计数器；
  带 -Tag 时跳过计数器逻辑，直接复用给定标签（同一工作内派生的子会话复用父标签）。
  标签作为前缀自动加到发送消息最前面，例如消息变成：【0814-02】原始消息。

子命令:
  new                    创建新会话（工作区由 config 指定或自动发现），向标准输出打印 sessionId
  prompt [-Tag <标签>] <sessionId> ...  向会话发送消息，向标准输出打印 accepted 状态（True/False）
  history <sessionId>    查询会话历史，把最后一条 assistant/message 的完整文本输出到标准输出
  status <sessionId>     查询会话状态摘要：状态（空会话/进行中/已完成）、事件计数与最新事件、
                         最近助手与最近用户文本（各截断 120 字符，换行折叠为空格）
  run [-Tag <标签>] <任务...>  一条龙：new -> prompt -> 每 6 秒轮询 history，直到出现
                         比派单时最大 seq 更新的 turn/end 事件（回合结束），或超过 1800 秒超时。
                         回合结束后，取该 turn/end 之前、派单之后最后一条含非空 text 的 assistant/message，把其文本输出到标准输出（Write-Output）；中间状态（开场白、汇报）一律忽略，轮询进度用 Write-Host 输出（不进管道、不触发错误流）

健壮性:
  - run / prompt / new / status 在执行任何请求前先探测 http://127.0.0.1:3080 是否可连；
    不可连时输出一行中文错误并以退出码 3 结束
  - 计数器缺失或损坏时自动重建为 {"date":"<今天MMdd>","seq":1} 并在 stderr 提示，
    本次标签仍按正常路径递增（重建后第一次取号为 <今天>-02）
  - 取号与写回计数器在命名互斥锁 Local\DSH-Bridge-Counter 内完成；等待锁超时 10 秒报错并以退出码 4 结束

依赖:
  - Windows 10 1803+ 自带的 curl.exe
  - DSH Web 服务地址由 config.json 的 BaseUrl 指定（默认 http://127.0.0.1:3080）
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

# 统一输出编码为 UTF-8，避免中文在管道/重定向时乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Curl                = 'curl.exe'

# ---------- 配置加载（config.json / config.example.json） ----------
$configExamplePath = Join-Path $PSScriptRoot 'config.example.json'
$configPath        = Join-Path $PSScriptRoot 'config.json'

# 默认配置表：config.example.json 缺失时用它生成两个文件；读取 config 时也用于补齐缺失字段
$DefaultConfig = [ordered]@{
    BaseUrl              = 'http://127.0.0.1:3080'
    WorkspaceId          = ''
    AssistWorkspaceTitle = '协助Hana'
    AssistWorkspacePath  = ''
    PollIntervalSeconds  = 6
    TimeoutSeconds       = 1800
}

function Initialize-Config {
    # 确保 config.example.json / config.json 存在（缺省链），读取 config 并补齐缺失字段，返回配置哈希表
    if (-not (Test-Path -LiteralPath $configExamplePath)) {
        $json = $DefaultConfig | ConvertTo-Json -Depth 5
        [System.IO.File]::WriteAllText($configExamplePath, $json, (New-Object System.Text.UTF8Encoding($false)))
        [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host '[配置] 未找到 config.example.json，已按默认值生成 config.example.json 与 config.json'
    }
    elseif (-not (Test-Path -LiteralPath $configPath)) {
        Copy-Item -LiteralPath $configExamplePath -Destination $configPath
        Write-Host '[配置] 未找到 config.json，已从 config.example.json 复制生成'
    }

    $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $cfg = @{}
    foreach ($k in $DefaultConfig.Keys) {
        $prop = $raw.PSObject.Properties[$k]
        if ($null -ne $prop -and $null -ne $prop.Value) {
            $cfg[$k] = $prop.Value
        }
        else {
            $cfg[$k] = $DefaultConfig[$k]
        }
    }
    return $cfg
}

function Save-Config {
    # 把配置哈希表按固定键序写回 config.json（UTF-8 无 BOM）
    param([hashtable]$Config)

    $json = [ordered]@{
        BaseUrl              = [string]$Config.BaseUrl
        WorkspaceId          = [string]$Config.WorkspaceId
        AssistWorkspaceTitle = [string]$Config.AssistWorkspaceTitle
        AssistWorkspacePath  = [string]$Config.AssistWorkspacePath
        PollIntervalSeconds  = [int]$Config.PollIntervalSeconds
        TimeoutSeconds       = [int]$Config.TimeoutSeconds
    } | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-AssistWorkspacePath {
    # AssistWorkspacePath 为空时推导：Split-Path $PSScriptRoot -Parent + \ + AssistWorkspaceTitle
    param([hashtable]$Config)

    if (-not [string]::IsNullOrWhiteSpace([string]$Config.AssistWorkspacePath)) {
        return [string]$Config.AssistWorkspacePath
    }
    return Join-Path (Split-Path $PSScriptRoot -Parent) ([string]$Config.AssistWorkspaceTitle)
}

function Resolve-WorkspaceId {
    # config 中 WorkspaceId 为空时：按 AssistWorkspaceTitle 自动发现；找不到则创建；
    # 成功后回写 config.json。创建失败输出人话错误并以退出码 5 结束
    param([hashtable]$Config)

    if (-not [string]::IsNullOrWhiteSpace([string]$Config.WorkspaceId)) {
        return [string]$Config.WorkspaceId
    }

    $title = [string]$Config.AssistWorkspaceTitle
    Write-Host "[workspace] config 中 WorkspaceId 为空，按标题「$title」自动发现 ..."

    # 1) workspace.list 按标题匹配
    $list  = Invoke-DshApi -Method 'workspace.list' -Payload @{}
    $found = $null
    foreach ($item in @($list.items)) {
        if ($item.title -eq $title) { $found = $item; break }
    }

    if ($null -ne $found) {
        $wid = [string]$found.workspaceId
        Write-Host "[workspace] 已找到工作区「$title」: $wid"
        $Config.WorkspaceId = $wid
        Save-Config -Config $Config
        Write-Host '[workspace] 已把 WorkspaceId 回写到 config.json'
        return $wid
    }

    # 2) 未找到 → 创建（目标目录不存在先创建）
    $path = Get-AssistWorkspacePath -Config $Config
    Write-Host "[workspace] 未找到「$title」工作区，尝试创建（路径: $path）..."
    try {
        if (-not (Test-Path -LiteralPath $path)) {
            New-Item -ItemType Directory -Path $path -Force | Out-Null
            Write-Host "[workspace] 已创建目录: $path"
        }
        $created = Invoke-DshApi -Method 'workspace.create' -Payload @{ path = $path }
        $wid     = [string]$created.workspace.workspaceId
        $Config.WorkspaceId = $wid
        Save-Config -Config $Config
        Write-Host "[workspace] 创建成功并回写 WorkspaceId: $wid"
        return $wid
    }
    catch {
        [Console]::Error.WriteLine("[错误] 创建协助工作区失败: $($_.Exception.Message)")
        [Console]::Error.WriteLine("[建议] 请检查目录（$path）是否存在且有写入权限，或直接在 config.json 中填写正确的 WorkspaceId 后重试。")
        exit 5
    }
}

# 加载配置并导出运行参数
$Config              = Initialize-Config
$BaseUrl             = [string]$Config.BaseUrl
$PollIntervalSeconds = [int]$Config.PollIntervalSeconds
$TimeoutSeconds      = [int]$Config.TimeoutSeconds

function New-RpcId {
    # 时间戳 + 随机片段，保证唯一
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $rand  = [guid]::NewGuid().ToString('N').Substring(0, 8)
    return "$stamp-$rand"
}

function Assert-DshServiceUp {
    # 探测 DSH 服务是否可连（超时 3 秒）；不可连时输出一行中文错误并以退出码 3 结束
    & $Curl -s -o NUL --max-time 3 $BaseUrl
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine("[错误] DSH 服务未运行（$BaseUrl 不可达）。请先双击桌面 DeepSeek Harness 快捷方式启动服务，再重试。")
        exit 3
    }
}

function Invoke-DshApi {
    # 发送一次 JSON RPC 请求，返回 result.value
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][hashtable]$Payload
    )

    $rpcId = New-RpcId
    $body  = @{
        type    = 'client-request'
        rpcId   = $rpcId
        method  = $Method
        payload = $Payload
    } | ConvertTo-Json -Depth 10 -Compress

    $bodyFile = [System.IO.Path]::GetTempFileName()
    $respFile = [System.IO.Path]::GetTempFileName()
    try {
        # 以 UTF-8（无 BOM）写请求体，保证中文消息编码正确
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($bodyFile, $body, $utf8NoBom)

        $url       = "$BaseUrl/api/$Method"
        $curlArgs  = @('-s', '-X', 'POST', '-H', 'Content-Type: application/json',
                       '--data-binary', "@$bodyFile", '-o', $respFile, $url)
        & $Curl @curlArgs
        if ($LASTEXITCODE -ne 0) {
            throw "curl 调用失败（exit code $LASTEXITCODE），请确认 DSH Web 服务运行在 $BaseUrl"
        }

        $raw  = [System.IO.File]::ReadAllText($respFile, [System.Text.Encoding]::UTF8)
        $resp = $raw | ConvertFrom-Json
        if (-not $resp.result.ok) {
            throw "API 返回错误: $raw"
        }
        return $resp.result.value
    }
    finally {
        Remove-Item -LiteralPath $bodyFile, $respFile -Force -ErrorAction SilentlyContinue
    }
}

function Get-MaxSeq {
    # 返回历史中当前最大事件 seq（无历史或查询失败时返回 0）
    param([string]$SessionId)

    $max = 0
    try {
        $value = Invoke-DshApi -Method 'session.history' -Payload @{ sessionId = $SessionId }
        foreach ($ev in @($value.events)) {
            if ($ev.event.seq -gt $max) { $max = [int]$ev.event.seq }
        }
    }
    catch {
        Write-Host "[run] 获取历史失败（按空历史处理）: $($_.Exception.Message)"
    }
    return $max
}

function Get-LatestAssistantText {
    # 返回历史中最后一条（seq 最大）assistant/message 的完整文本；没有则返回 $null
    param([string]$SessionId)

    $value  = Invoke-DshApi -Method 'session.history' -Payload @{ sessionId = $SessionId }
    $events = @($value.events)

    $latest = $null
    foreach ($ev in $events) {
        if ($ev.event.type -eq 'assistant/message') {
            if ($null -eq $latest -or $ev.event.seq -gt $latest.seq) {
                $latest = $ev.event
            }
        }
    }
    if ($null -eq $latest) {
        return $null
    }

    return Get-ReplyText -Event $latest
}

function Get-ContentArray {
    # 提取事件中的内容段数组，兼容 data.message.content 与 data.content 两种结构
    param($Event)

    $d = $Event.data
    if ($null -ne $d.message -and $null -ne $d.message.content) {
        return @($d.message.content)
    }
    if ($null -ne $d.content) {
        return @($d.content)
    }
    return @()
}

function Get-ReplyText {
    # 从一条 assistant/message 事件中提取所有 text 段拼接成的完整文本
    param($Event)

    $texts = @()
    foreach ($c in @(Get-ContentArray -Event $Event)) {
        if ($c.type -eq 'text') {
            $texts += [string]$c.text
        }
    }
    return ($texts -join "`n")
}

function Test-HasNonEmptyText {
    # 判断事件 content 中是否存在 type=text 且文本非空（含纯空白视为空）的段
    param($Event)

    foreach ($c in @(Get-ContentArray -Event $Event)) {
        if ($c.type -eq 'text' -and -not [string]::IsNullOrWhiteSpace([string]$c.text)) {
            return $true
        }
    }
    return $false
}

function Format-StatusText {
    # status 摘要用：折叠换行为空格并截断 120 字符
    param([string]$Text)

    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $flat = ($Text -replace "`r`n", ' ') -replace "`n", ' '
    if ($flat.Length -gt 120) { return $flat.Substring(0, 120) }
    return $flat
}

# ---------- 工作标签 ----------
function Write-WorkCounter {
    # 手动构造 JSON 写回计数器，保持 date/seq 键序稳定（与任务书示例格式一致）
    param([string]$Path, [string]$Date, [int]$Seq)

    $json = '{"date":"' + $Date + '","seq":' + $Seq + '}'
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-NextWorkTag {
    # 命名互斥锁内完成「读计数器 → 计算新值 → 写回 → 返回标签」；
    # 计数器缺失或损坏时先重建为 {date:今天, seq:1} 再走正常递增，本次取 02；
    # 等待锁超时 10 秒报错并以退出码 4 结束
    $counterFile = Join-Path $PSScriptRoot '.work-counter.json'
    $today       = (Get-Date).ToString('MMdd')

    $mutex = New-Object System.Threading.Mutex($false, 'Local\DSH-Bridge-Counter')
    try {
        if (-not $mutex.WaitOne(10000)) {
            [Console]::Error.WriteLine('[错误] 等待计数器互斥锁超时（10 秒），本次取号失败')
            exit 4
        }
        try {
            $date    = ''
            $seq     = 0
            $rebuilt = $false

            if (Test-Path -LiteralPath $counterFile) {
                try {
                    $c = Get-Content -LiteralPath $counterFile -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ($null -eq $c -or $null -eq $c.date -or $null -eq $c.seq) {
                        $rebuilt = $true
                    }
                    else {
                        $date = [string]$c.date
                        $seq  = [int]$c.seq
                    }
                }
                catch {
                    $rebuilt = $true
                }
            }
            else {
                $rebuilt = $true
            }

            if ($rebuilt) {
                $date = $today
                $seq  = 1
                Write-WorkCounter -Path $counterFile -Date $date -Seq $seq
                [Console]::Error.WriteLine('[提示] 计数器缺失或损坏，已重建')
            }

            if ($date -ne $today) {
                $date = $today
                $seq  = 1
            }
            else {
                $seq++
            }

            Write-WorkCounter -Path $counterFile -Date $date -Seq $seq
            return "$date-{0:D2}" -f $seq
        }
        finally {
            [void]$mutex.ReleaseMutex()
        }
    }
    finally {
        $mutex.Dispose()
    }
}

function Resolve-WorkTag {
    # 有 -Tag 则直接复用（剥掉可能的外层方括号）；无 -Tag 则自动生成并写回计数器
    param([string]$Tag)

    if ([string]::IsNullOrEmpty($Tag)) {
        return Get-NextWorkTag
    }
    return ($Tag -replace '^【|】$', '')
}

function Split-TagArg {
    # 从参数列表提取 -Tag <标签>（大小写不敏感），返回 @{ Tag; Rest }，Rest 为剩余参数
    param([string[]]$ParamList)

    $tag = $null
    $out = New-Object System.Collections.Generic.List[string]
    $i   = 0
    while ($i -lt $ParamList.Count) {
        if ($ParamList[$i] -eq '-Tag') {
            if ($i + 1 -ge $ParamList.Count) {
                throw '-Tag 参数缺少标签值'
            }
            $tag = $ParamList[$i + 1]
            $i += 2
            continue
        }
        [void]$out.Add($ParamList[$i])
        $i++
    }
    return @{ Tag = $tag; Rest = @($out) }
}

# ---------- 子命令分发 ----------
$cmd = $Rest[0]
switch ($cmd) {
    'new' {
        Assert-DshServiceUp
        $wid   = Resolve-WorkspaceId -Config $Config
        $value = Invoke-DshApi -Method 'session.create' -Payload @{ workspaceId = $wid }
        Write-Output $value.sessionId
    }

    'prompt' {
        $p = Split-TagArg -ParamList $Rest
        if ($p.Rest.Count -lt 3) { throw '用法: dsh-api.ps1 prompt [-Tag <标签>] <sessionId> <消息...>' }
        Assert-DshServiceUp
        $sessionId = $p.Rest[1]
        $message   = ($p.Rest[2..($p.Rest.Count - 1)] -join ' ')
        $tag  = Resolve-WorkTag -Tag $p.Tag
        $text = "【$tag】$message"
        $value = Invoke-DshApi -Method 'session.prompt' -Payload @{
            sessionId = $sessionId
            mode      = 'queue'
            content   = @(@{ type = 'text'; text = $text })
        }
        Write-Output $value.accepted
    }

    'history' {
        if ($Rest.Count -lt 2) { throw '用法: dsh-api.ps1 history <sessionId>' }
        $sessionId = $Rest[1]
        $text = Get-LatestAssistantText -SessionId $sessionId
        if ($null -eq $text) {
            [Console]::Error.WriteLine('[history] 未找到 assistant/message 事件')
            exit 1
        }
        Write-Output $text
    }

    'status' {
        if ($Rest.Count -lt 2) { throw '用法: dsh-api.ps1 status <sessionId>' }
        Assert-DshServiceUp
        $sessionId = $Rest[1]

        # 新建会话时由服务自动写入的初始事件；只有这些（或无事件）时视为空会话
        $initialTypes = @('permission/preset', 'sandbox/mode', 'approval/policy')

        $value  = Invoke-DshApi -Method 'session.history' -Payload @{ sessionId = $sessionId }
        $events = @($value.events)

        $latest     = $null   # seq 最大的事件（不限类型）
        $turnStart  = 0
        $turnEnd    = 0
        $onlyInitial = $true
        foreach ($ev in $events) {
            $e = $ev.event
            if ($null -eq $latest -or [int]$e.seq -gt [int]$latest.seq) { $latest = $e }
            if ($e.type -eq 'turn/start') { $turnStart++ }
            if ($e.type -eq 'turn/end')   { $turnEnd++ }
            if ($initialTypes -notcontains $e.type) { $onlyInitial = $false }
        }

        # 状态判定（顺序敏感：先空会话，再进行中，最后已完成）
        if ($events.Count -eq 0 -or $onlyInitial) {
            $state = '空会话'
        }
        elseif ($turnStart -gt $turnEnd) {
            $state = '进行中'
        }
        else {
            $state = '已完成'
        }

        # 最近助手 / 最近用户：seq 最大的、含非空 text 的对应消息
        $latestAssistant = $null
        $latestUser      = $null
        foreach ($ev in $events) {
            $e = $ev.event
            if ($e.type -eq 'assistant/message' -and (Test-HasNonEmptyText -Event $e)) {
                if ($null -eq $latestAssistant -or [int]$e.seq -gt [int]$latestAssistant.seq) { $latestAssistant = $e }
            }
            elseif ($e.type -eq 'user/message' -and (Test-HasNonEmptyText -Event $e)) {
                if ($null -eq $latestUser -or [int]$e.seq -gt [int]$latestUser.seq) { $latestUser = $e }
            }
        }

        Write-Output "会话: $sessionId"
        Write-Output "状态: $state"
        if ($null -ne $latest) {
            $localTime = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$latest.time).LocalDateTime.ToString('HH:mm:ss')
            Write-Output "事件: 共 $($events.Count) 条，最新事件 $($latest.type)，时间 $localTime"
        }
        else {
            Write-Output "事件: 共 0 条"
        }
        if ($null -ne $latestAssistant) {
            Write-Output "最近助手: $(Format-StatusText (Get-ReplyText -Event $latestAssistant))"
        }
        if ($null -ne $latestUser) {
            Write-Output "最近用户: $(Format-StatusText (Get-ReplyText -Event $latestUser))"
        }
    }

    'run' {
        $p = Split-TagArg -ParamList $Rest
        if ($p.Rest.Count -lt 2) { throw '用法: dsh-api.ps1 run [-Tag <标签>] <任务...>' }
        Assert-DshServiceUp
        $task = ($p.Rest[1..($p.Rest.Count - 1)] -join ' ')
        $tag  = Resolve-WorkTag -Tag $p.Tag
        Write-Host "[run] 标签: $tag"
        $task = "【$tag】$task"

        # 1) 创建会话
        Write-Host '[run] 创建新会话 ...'
        $wid       = Resolve-WorkspaceId -Config $Config
        $value     = Invoke-DshApi -Method 'session.create' -Payload @{ workspaceId = $wid }
        $sessionId = $value.sessionId
        Write-Host "[run] 会话已创建: $sessionId"

        # 2) 派单前记录当前最大 seq
        $beforeMaxSeq = Get-MaxSeq -SessionId $sessionId
        Write-Host "[run] 派单前最大 seq: $beforeMaxSeq"

        # 3) 发送任务
        $accepted = (Invoke-DshApi -Method 'session.prompt' -Payload @{
            sessionId = $sessionId
            mode      = 'queue'
            content   = @(@{ type = 'text'; text = $task })
        }).accepted
        if (-not $accepted) {
            throw "消息未被受理（accepted=false），会话 $sessionId 保留"
        }
        Write-Host "[run] 消息已受理，任务: $task"

        # 4) 轮询等待回合结束（每 6 秒一次，最多 1800 秒）
        #    完成判定：出现 seq 大于派单时最大 seq 的 turn/end 事件；
        #    中间的 assistant/message（开场白、汇报等）一律不触发返回
        $startTime = [DateTime]::UtcNow
        $attempt   = 0
        while ($true) {
            Start-Sleep -Seconds $PollIntervalSeconds
            $attempt++
            $elapsed = [math]::Floor(([DateTime]::UtcNow - $startTime).TotalSeconds)
            if ($elapsed -ge $TimeoutSeconds) {
                [Console]::Error.WriteLine("[run] 等待回合结束已超时（超过 $TimeoutSeconds 秒），会话 $sessionId 保留以供后续查询")
                exit 2
            }

            $value = $null
            try {
                $value = Invoke-DshApi -Method 'session.history' -Payload @{ sessionId = $sessionId }
            }
            catch {
                Write-Host "[run] 第 $attempt 次查询失败: $($_.Exception.Message)"
                continue
            }

            # 扫描本快照：最新事件 seq 用于日志；首个 seq > beforeMaxSeq 的 turn/end 即完成信号
            $events    = @($value.events)
            $latestSeq = 0
            $turnEnd   = $null
            foreach ($ev in $events) {
                $seq = [int]$ev.event.seq
                if ($seq -gt $latestSeq) { $latestSeq = $seq }
                if ($ev.event.type -eq 'turn/end' -and $seq -gt $beforeMaxSeq) {
                    if ($null -eq $turnEnd -or $seq -lt [int]$turnEnd.seq) {
                        $turnEnd = $ev.event
                    }
                }
            }

            if ($null -eq $turnEnd) {
                Write-Host "[run] 第 $attempt 次查询：任务仍在进行（已等待 $elapsed 秒，最新事件 seq $latestSeq）"
                continue
            }

            # 回合已结束：取该 turn/end 之前、派单之后最后一条含非空 text 的 assistant/message
            $finalReply = $null
            foreach ($ev in $events) {
                if ($ev.event.type -eq 'assistant/message' -and
                    ([int]$ev.event.seq -gt $beforeMaxSeq) -and
                    ([int]$ev.event.seq -lt [int]$turnEnd.seq) -and
                    (Test-HasNonEmptyText -Event $ev.event)) {
                    if ($null -eq $finalReply -or [int]$ev.event.seq -gt [int]$finalReply.seq) {
                        $finalReply = $ev.event
                    }
                }
            }

            if ($null -eq $finalReply) {
                [Console]::Error.WriteLine("[run] 回合已结束（turn/end seq $($turnEnd.seq)），但范围内未找到含非空文本的 assistant/message，会话 $sessionId 保留以供后续查询")
                exit 1
            }

            Write-Host "[run] 回合结束（turn/end seq $($turnEnd.seq)，用时 $elapsed 秒），输出最终回复（assistant/message seq $($finalReply.seq)）"
            Write-Output (Get-ReplyText -Event $finalReply)
            break
        }
    }

    default {
        [Console]::Error.WriteLine("未知子命令: $cmd")
        [Console]::Error.WriteLine('用法: dsh-api.ps1 <new|prompt|history|status|run> [参数...]  详见脚本头部注释')
        exit 1
    }
}
