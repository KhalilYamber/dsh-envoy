<#
run-tests.ps1 —— dsh-envoy 一键回归入口
====================================================================
按依赖顺序依次运行 research/ 下的正式回归测试（全部 node 脚本，
cwd = 项目根）。单个测试失败不中断，继续跑后面的测试，最后输出
汇总表；只要有一个失败，退出码就是 1。

用法示例：
  powershell -NoProfile -File scripts\run-tests.ps1
  powershell -NoProfile -File scripts\run-tests.ps1 -SkipDsh
    # -SkipDsh：跳过需要本机 DSH（127.0.0.1:3080）的测试

测试清单（依赖顺序）：
  0. scripts/lex-scan.mjs     词法扫描（注释配对/未闭合，防吞函数，无需 DSH）
  1. research/test-labels.mjs          标签计数器（无需 DSH）
  2. research/smoke-routes.mjs         路由表（无需 DSH）
  3. research/test-diagnose.mjs        诊断四检 + manifest 单一事实源（无需 DSH）
  4. research/test-task-log.mjs        任务记录落盘（需本机 DSH 在跑）
  5. research/test-task-log-extra.mjs  并发/终态补充（需本机 DSH 在跑）
#>
param(
    [switch]$SkipDsh
)

$ErrorActionPreference = 'Stop'

# 项目根 = 本脚本所在 scripts\ 的上一级目录
$Root = Split-Path -Parent $PSScriptRoot

# 让中文与 emoji 在 PS5.1 控制台正常显示（无控制台场景静默跳过）
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error '未找到 node 命令：请先安装 Node.js 并加入 PATH'
    exit 1
}

# 测试清单：名称 / 相对路径 / 是否需要本机 DSH
$Tests = @(
    @{ Name = 'lex-scan（词法扫描，防吞函数）';      File = 'scripts\lex-scan.mjs';            NeedsDsh = $false },
    @{ Name = 'test-labels（标签计数器）';         File = 'research\test-labels.mjs';         NeedsDsh = $false },
    @{ Name = 'smoke-routes（路由表）';            File = 'research\smoke-routes.mjs';        NeedsDsh = $false },
    @{ Name = 'test-diagnose（诊断四检+B1）';      File = 'research\test-diagnose.mjs';       NeedsDsh = $false },
    @{ Name = 'test-task-log（任务记录落盘）';     File = 'research\test-task-log.mjs';       NeedsDsh = $true },
    @{ Name = 'test-task-log-extra（并发/终态）';  File = 'research\test-task-log-extra.mjs'; NeedsDsh = $true }
)

$Total = [System.Diagnostics.Stopwatch]::StartNew()
$Results = New-Object System.Collections.Generic.List[object]
$HasFailure = $false

Write-Output '==================== dsh-envoy 回归测试 ===================='
Write-Output ("项目根：{0}" -f $Root)
if ($SkipDsh) { Write-Output '模式：-SkipDsh（跳过需要本机 DSH 的测试）' }
Write-Output ''

foreach ($t in $Tests) {
    $FullPath = Join-Path $Root $t.File
    if (-not (Test-Path $FullPath)) {
        Write-Output ("[失败] {0}：找不到脚本 {1}" -f $t.Name, $t.File)
        [void]$Results.Add([pscustomobject]@{ 测试 = $t.Name; 结果 = '失败（脚本缺失）'; 用时 = '-' })
        $HasFailure = $true
        continue
    }
    if ($SkipDsh -and $t.NeedsDsh) {
        Write-Output ("[跳过] {0}（-SkipDsh 模式，跳过需 DSH 的测试）" -f $t.Name)
        [void]$Results.Add([pscustomobject]@{ 测试 = $t.Name; 结果 = '跳过'; 用时 = '-' })
        continue
    }

    $Sw = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Output ("----- {0} 开始 -----" -f $t.Name)
    Push-Location $Root
    try {
        # 透传测试自身输出；node 退出码 0 = 通过
        & node $FullPath
        $ExitCode = $LASTEXITCODE
    } catch {
        $ExitCode = 1
        Write-Output ("[异常] {0}：{1}" -f $t.Name, $_.Exception.Message)
    } finally {
        Pop-Location
    }
    $Sw.Stop()
    $Passed = ($ExitCode -eq 0)
    if (-not $Passed) { $HasFailure = $true }
    $Verdict = if ($Passed) { '通过 ✅' } else { "失败 ❌（退出码 $ExitCode）" }
    Write-Output ("[通过/失败] {0}：{1}，用时 {2:N1}s" -f $t.Name, $Verdict, $Sw.Elapsed.TotalSeconds)
    Write-Output ''
    [void]$Results.Add([pscustomobject]@{ 测试 = $t.Name; 结果 = $Verdict; 用时 = ('{0:N1}s' -f $Sw.Elapsed.TotalSeconds) })
}

$Total.Stop()
Write-Output '==================== 汇总表 ===================='
$Results | Format-Table -AutoSize | Out-String -Stream | Write-Output
Write-Output ("总用时：{0:N1}s" -f $Total.Elapsed.TotalSeconds)
if ($HasFailure) {
    Write-Output '结论：存在失败 ❌'
    exit 1
} else {
    Write-Output '结论：全部通过 ✅'
    exit 0
}
