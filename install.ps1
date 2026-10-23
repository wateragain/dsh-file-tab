<#
.SYNOPSIS
  安装 / 卸载 / 体检 dsh-session-files 插件（Windows PowerShell 5.1 兼容）。

.DESCRIPTION
  默认只预览，不改任何文件；加 -Run 才真正执行。

  安装做三件事：
    1. 把插件包复制到 <profile>\plugins\dsh-session-files；
    2. 在 <profile>\node_modules 下建目录联接指向它；
    3. 在 <profile>\package.json 里补依赖和 bundle 条目。

  针对 PS 5.1 的已知坑做了处理：
    - 写 JSON 一律 UTF-8 无 BOM（Set-Content -Encoding UTF8 会带 BOM，Node 的 JSON.parse 会崩）；
    - 写回后立即复验：无 BOM、首字符 {、能被 ConvertFrom-Json 解析；
    - 如果 profile 的 package.json 已带 BOM，先自动修掉；
    - 不用自动变量名做参数（$Profile / $Pid / $Host / $Error / $Input / $Args）；
    - $PSScriptRoot 为空时回落到 $MyInvocation 的脚本路径；
    - 删联接用 .NET 的 Directory.Delete(path, $false)，不用 Remove-Item -Recurse（会顺着联接进目标目录）；
    - 数组用 @() 包裹后再写，避免 ConvertTo-Json 把单元素数组折叠成标量。

.PARAMETER ProfileName
  profile 名称，默认取 $env:DSH_PROFILE，没有则 desktop。

.PARAMETER DshHome
  DSH 主目录，默认取 $env:DSH_HOME，没有则 ~\.dsh。测试时可指向临时目录。

.PARAMETER Source
  插件包目录，默认脚本所在目录。

.PARAMETER BaseUrl
  可选，Web GUI 根地址（默认取 $env:DSH_WEB_URL）。给出时用一次 400 探测确认 Host 路由在线。

.PARAMETER Run
  真正执行；不加时只打印计划。

.PARAMETER Uninstall
  卸载模式。

.PARAMETER Check
  只体检，不写任何文件。

.PARAMETER Force
  跳过敏捷确认（卸载时的 Y/N）。

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Run
  .\install.ps1 -Check -BaseUrl http://127.0.0.1:57585
  .\install.ps1 -Uninstall -Run
#>
[CmdletBinding()]
param(
  [string]$ProfileName = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }),
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [string]$Source,
  [string]$BaseUrl = $env:DSH_WEB_URL,
  [switch]$Run,
  [switch]$Uninstall,
  [switch]$Check,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

function Write-Section([string]$text) {
  Write-Host ''
  Write-Host "== $text" -ForegroundColor Cyan
}

function Write-Info([string]$text) { Write-Host "   $text" }
function Write-Ok([string]$text) { Write-Host "   [OK] $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "   [警告] $text" -ForegroundColor Yellow }
function Write-Fail([string]$text) { Write-Host "   [失败] $text" -ForegroundColor Red }

function Test-HasBom([byte[]]$bytes) {
  if ($null -eq $bytes -or $bytes.Length -lt 3) { return $false }
  return ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
}

function Read-TextFile([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  $offset = 0
  if (Test-HasBom $bytes) { $offset = 3 }
  return $script:Utf8Strict.GetString($bytes, $offset, $bytes.Length - $offset)
}

function ConvertFrom-StrictJson([string]$text, [string]$path) {
  $trimmed = $text.Trim()
  if (-not $trimmed.StartsWith('{')) {
    throw "$path 不是以 { 开头，内容可能已被写坏"
  }
  return ($trimmed | ConvertFrom-Json)
}

function Format-Json([string]$compact) {
  # PS 5.1 的 ConvertTo-Json 会把嵌套对象排成"对齐到列"的怪样子，这里统一成 2 空格缩进。
  # 输入是 -Compress 的单行 JSON，字符串内的括号/逗号靠 inString 跳过。
  $sb = New-Object System.Text.StringBuilder
  $indent = 0
  $inString = $false
  $escaped = $false
  $length = $compact.Length
  for ($i = 0; $i -lt $length; $i++) {
    $ch = $compact[$i]
    if ($inString) {
      $null = $sb.Append($ch)
      if ($escaped) { $escaped = $false }
      elseif ($ch -eq '\') { $escaped = $true }
      elseif ($ch -eq '"') { $inString = $false }
      continue
    }
    switch ($ch) {
      '"' { $inString = $true; $null = $sb.Append($ch) }
      '{' {
        if ($i + 1 -lt $length -and $compact[$i + 1] -eq '}') { $null = $sb.Append('{}'); $i++ }
        else {
          $indent++
          $null = $sb.Append("{`r`n").Append(' ' * ($indent * 2))
        }
      }
      '}' {
        $indent--
        $null = $sb.Append("`r`n").Append(' ' * ($indent * 2)).Append('}')
      }
      '[' {
        if ($i + 1 -lt $length -and $compact[$i + 1] -eq ']') { $null = $sb.Append('[]'); $i++ }
        else {
          $indent++
          $null = $sb.Append("[`r`n").Append(' ' * ($indent * 2))
        }
      }
      ']' {
        $indent--
        $null = $sb.Append("`r`n").Append(' ' * ($indent * 2)).Append(']')
      }
      ',' { $null = $sb.Append(",`r`n").Append(' ' * ($indent * 2)) }
      ':' { $null = $sb.Append(': ') }
      default { $null = $sb.Append($ch) }
    }
  }
  return $sb.ToString()
}

function Write-JsonFile($json, [string]$path) {
  $compact = $json | ConvertTo-Json -Depth 32 -Compress
  $text = Format-Json $compact
  $bytes = $script:Utf8NoBom.GetBytes($text + "`r`n")
  [IO.File]::WriteAllBytes($path, $bytes)

  # 写回后立刻复验，别等 DSH 启动时才炸。
  $after = [IO.File]::ReadAllBytes($path)
  if (Test-HasBom $after) { throw "写回后 $path 仍带 BOM，已中止" }
  $back = $script:Utf8Strict.GetString($after, 0, $after.Length)
  $null = ConvertFrom-StrictJson $back $path
}

function Repair-Bom([string]$path) {
  $bytes = [IO.File]::ReadAllBytes($path)
  if (-not (Test-HasBom $bytes)) { return $false }
  $text = $script:Utf8Strict.GetString($bytes, 3, $bytes.Length - 3)
  [IO.File]::WriteAllBytes($path, $script:Utf8NoBom.GetBytes($text))
  return $true
}

function Test-Junction([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $item = Get-Item -LiteralPath $path -Force
  return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

function Remove-Link([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  if (Test-Junction $path) {
    # 只删联接本身，不进入目标目录。
    [IO.Directory]::Delete($path, $false)
    return
  }
  if ($Force) {
    Remove-Item -LiteralPath $path -Recurse -Force
    return
  }
  throw "$path 不是目录联接，可能是实体目录；确认无误后加 -Force 再删。"
}

function Get-DshProcess {
  return Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
}

$expectedFiles = @(
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'package.json',
  'icon.png',
  'locale\zh.json',
  'locale\en.json'
)

# ---- 定位 ----------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($Source)) { $Source = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($Source)) {
  $commandPath = $MyInvocation.MyCommand.Path
  if (-not [string]::IsNullOrWhiteSpace($commandPath)) { $Source = Split-Path -Parent $commandPath }
}
if ([string]::IsNullOrWhiteSpace($Source)) { throw '无法确定插件包目录，请用 -Source 指定。' }
if (-not (Test-Path -LiteralPath $Source)) { throw "找不到插件包目录：$Source" }
$Source = (Resolve-Path -LiteralPath $Source).Path

if ([string]::IsNullOrWhiteSpace($ProfileName)) { throw 'ProfileName 不能为空。' }
if (-not (Test-Path -LiteralPath $DshHome)) { throw "找不到 DSH 主目录：$DshHome（用 -DshHome 指定）" }

$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$packageJson = Join-Path $profileDir 'package.json'
$target = Join-Path $profileDir 'plugins\dsh-session-files'
$link = Join-Path $profileDir 'node_modules\dsh-session-files'

Write-Section '环境'
Write-Info ("PowerShell {0} / {1}" -f $PSVersionTable.PSVersion, $PSVersionTable.PSEdition)
Write-Info ("执行策略 {0}" -f (Get-ExecutionPolicy))
Write-Info ("DSH 主目录 {0}" -f $DshHome)
Write-Info ("profile {0}" -f $profileDir)

if (-not (Test-Path -LiteralPath $packageJson)) {
  throw "找不到 profile 配置：$packageJson（用 -ProfileName 指定正确的 profile）"
}

$bomPresent = Test-HasBom ([IO.File]::ReadAllBytes($packageJson))
if ($bomPresent) {
  Write-Warn 'profile package.json 开头有 UTF-8 BOM：DSH 启动会报 Unexpected token，-Run 时会自动修掉。'
}

$jsonText = Read-TextFile $packageJson
$json = ConvertFrom-StrictJson $jsonText $packageJson

# ---- 状态 ----------------------------------------------------------------

function Get-State {
  $state = New-Object PSObject -Property @{
    Dependency  = $false
    Bundle      = $false
    TargetOk    = $false
    LinkOk      = $false
    FilesOk     = $false
    BuiltOk     = $false
  }
  if ($json.dependencies -and $json.dependencies.PSObject.Properties.Name -contains 'dsh-session-files') { $state.Dependency = $true }
  if ($json.dsh -and $json.dsh.profile -and (@($json.dsh.profile.bundles) -contains 'dsh-session-files')) { $state.Bundle = $true }
  $state.TargetOk = Test-Path -LiteralPath (Join-Path $target 'package.json')
  $state.LinkOk = ((Test-Junction $link) -and (Test-Path -LiteralPath (Join-Path $link 'client.js')))
  $missing = @($expectedFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $target $_)) })
  $state.FilesOk = ($missing.Count -eq 0)
  $clientJs = Join-Path $Source 'client.js'
  $indexJs = Join-Path $Source 'index.js'
  $state.BuiltOk = $false
  if ((Test-Path -LiteralPath $clientJs) -and (Test-Path -LiteralPath $indexJs)) {
    $clientText = Read-TextFile $clientJs
    $indexText = Read-TextFile $indexJs
    $state.BuiltOk = ($clientText.Contains('conversation.view') -and $indexText.Contains('export function apply'))
  }
  return $state
}

function Test-SearchRoute([string]$baseUrl) {
  if ([string]::IsNullOrWhiteSpace($baseUrl)) { return '跳过（未提供 -BaseUrl）' }
  $url = $baseUrl.TrimEnd('/') + '/plugins/dsh-session-files/list'
  try {
    $null = Invoke-WebRequest -Uri $url -Method Post -Headers @{ 'x-dsh-session-files' = '1' } -ContentType 'application/json' -Body '{}' -UseBasicParsing -TimeoutSec 5
    return "在线（HTTP 200）"
  } catch {
    if ($null -ne $_.Exception.Response) {
      $code = $_.Exception.Response.StatusCode.value__
      if ($code -eq 400) { return '在线（路由已注册）' }
      return "路由异常（HTTP $code）"
    }
    return '连不上（DSH 可能没启动）'
  }
}

$state = Get-State

# ---- 体检 ----------------------------------------------------------------

if ($Check) {
  Write-Section '体检'
  Write-Info ("profile JSON 的 BOM : {0}" -f $(if ($bomPresent) { '有（会让 DSH 启动失败）' } else { '无' }))
  Write-Info ("profile package.json : {0}" -f $(if ($state.Dependency -and $state.Bundle) { '已登记' } else { '未登记' }))
  Write-Info ("依赖条目 dsh-session-files  : {0}" -f $(if ($state.Dependency) { '有' } else { '无' }))
  Write-Info ("bundle 条目         : {0}" -f $(if ($state.Bundle) { '有' } else { '无' }))
  Write-Info ("插件目录            : {0}" -f $(if ($state.TargetOk) { $target } else { '缺失' }))
  Write-Info ("node_modules 联接   : {0}" -f $(if ($state.LinkOk) { '有效' } else { '无效或缺失' }))
  Write-Info ("运行文件齐全        : {0}" -f $(if ($state.FilesOk) { '是' } else { '否' }))
  Write-Info ("源码构建产物        : {0}" -f $(if ($state.BuiltOk) { '正常（含 conversation.view 注册）' } else { '异常，先跑 node scripts/build.mjs' }))
  Write-Info ("Host 路由           : {0}" -f (Test-SearchRoute $BaseUrl))

  $failed = (-not ($state.Dependency -and $state.Bundle -and $state.TargetOk -and $state.LinkOk -and $state.FilesOk -and $state.BuiltOk))
  if ($failed) { Write-Fail '体检未通过，按上面的缺失项处理。'; exit 1 }
  Write-Ok '体检通过。'
  exit 0
}

# ---- 计划 ----------------------------------------------------------------

$process = Get-DshProcess
if ($process) { Write-Warn "DSH 正在运行（PID $($process.Id -join ',')），改动要重启后生效。" }

if ($Uninstall) {
  Write-Section '卸载计划'
  Write-Info "删除 node_modules 联接：$link"
  Write-Info "删除插件目录：$target"
  Write-Info "移除 profile 配置里的 dsh-session-files 依赖与 bundle 条目"
  if (-not $Run) {
    Write-Host ''
    Write-Host '预览模式：未修改任何文件。确认后加 -Run 执行。' -ForegroundColor Yellow
    exit 0
  }
  if (-not $Force) {
    $answer = Read-Host '  真的卸载？输入 Y 继续'
    if ($answer -notmatch '^[Yy]$') { Write-Host '  已取消。'; exit 0 }
  }

  Write-Section '卸载'
  if ($bomPresent) { $null = Repair-Bom $packageJson; Write-Info '已修掉 profile package.json 的 BOM' }
  if ($json.dependencies -and ($json.dependencies.PSObject.Properties.Name -contains 'dsh-session-files')) {
    $json.dependencies.PSObject.Properties.Remove('dsh-session-files')
    Write-Info '已移除 dependencies.dsh-session-files'
  }
  if ($json.dsh -and $json.dsh.profile -and (@($json.dsh.profile.bundles) -contains 'dsh-session-files')) {
    $json.dsh.profile.bundles = @(@($json.dsh.profile.bundles) | Where-Object { $_ -ne 'dsh-session-files' })
    Write-Info '已移除 dsh.profile.bundles 里的 dsh-session-files'
  }
  Write-JsonFile $json $packageJson
  Write-Info "已写回 $packageJson（UTF-8 无 BOM）"

  Remove-Link $link
  Write-Info '已删除 node_modules 联接'
  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Info '已删除插件目录'
  }

  Write-Section '完成'
  Write-Ok '卸载完成，重启 DSH 后生效。'
  exit 0
}

Write-Section '安装计划'
Write-Info "来源：$Source"
Write-Info "复制到：$target"
Write-Info "联接：$link -> $target"
if ($state.Dependency -and $state.Bundle) {
  Write-Info 'profile 配置：已登记，跳过'
} else {
  Write-Info 'profile 配置：补 dsh-session-files 依赖和 bundle 条目'
}
if (-not $state.BuiltOk) { Write-Fail '源码构建产物异常：client.js 缺内嵌图片或 index.js 缺 apply，先跑 node scripts/build.mjs' }
if (-not $Run) {
  Write-Host ''
  Write-Host '预览模式：未修改任何文件。确认后加 -Run 执行。' -ForegroundColor Yellow
  exit 0
}
if (-not $state.BuiltOk) { exit 1 }

# ---- 安装 ----------------------------------------------------------------

Write-Section '安装'
if ($bomPresent) { $null = Repair-Bom $packageJson; Write-Info '已修掉 profile package.json 的 BOM' }
if (-not (Test-Path -LiteralPath $target)) { New-Item -ItemType Directory -Force -Path $target | Out-Null }
foreach ($file in @('index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'icon.png', 'README.md')) {
  Copy-Item -LiteralPath (Join-Path $Source $file) -Destination $target -Force
}
foreach ($dir in @('locale', 'assets')) {
  $from = Join-Path $Source $dir
  if (-not (Test-Path -LiteralPath $from)) { continue }
  $to = Join-Path $target $dir
  if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
  Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
}
Write-Info "文件已复制（$($expectedFiles.Count) 个运行文件）"

if (Test-Junction $link) {
  $current = (Get-Item -LiteralPath $link -Force).Target
  if ($current -ne $target) {
    Remove-Link $link
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    Write-Info '联接已重建'
  } else {
    Write-Info '联接已存在且指向正确'
  }
} else {
  if (Test-Path -LiteralPath $link) { Remove-Link $link }
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  Write-Info '已建立 node_modules 联接'
}

$changed = $false
if (-not $json.dependencies) {
  $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
  $changed = $true
}
if (-not ($json.dependencies.PSObject.Properties.Name -contains 'dsh-session-files')) {
  $json.dependencies | Add-Member -NotePropertyName 'dsh-session-files' -NotePropertyValue 'link:plugins/dsh-session-files' -Force
  $changed = $true
}
if (-not ($json.dsh -and $json.dsh.profile)) {
  throw 'profile package.json 缺 dsh.profile，脚本不动它；请手动把 "dsh-session-files" 加到 dsh.profile.bundles。'
}
if (-not (@($json.dsh.profile.bundles) -contains 'dsh-session-files')) {
  $json.dsh.profile.bundles = @(@($json.dsh.profile.bundles) + 'dsh-session-files')
  $changed = $true
}

if ($changed) {
  $backup = "$packageJson.bak-dshsearch"
  if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $packageJson -Destination $backup }
  Write-JsonFile $json $packageJson
  Write-Info "已写回 $packageJson（UTF-8 无 BOM，已复验可解析）"
} else {
  Write-Info 'profile 配置已包含 dsh-session-files，未改动'
}

# ---- 收尾 ----------------------------------------------------------------

$state = Get-State
Write-Section '结果'
Write-Info ("依赖条目 {0} / bundle 条目 {1}" -f $(if ($state.Dependency) { '有' } else { '无' }), $(if ($state.Bundle) { '有' } else { '无' }))
Write-Info ("插件目录 {0}" -f $(if ($state.FilesOk) { '完整' } else { '缺文件' }))
Write-Info ("联接 {0}" -f $(if ($state.LinkOk) { '有效' } else { '无效' }))
Write-Info ("Host 路由 {0}" -f (Test-SearchRoute $BaseUrl))
if (Get-DshProcess) {
  Write-Ok '安装完成。重启 DSH（或刷新界面）后，会话 tab 条出现「文件」。'
} else {
  Write-Ok '安装完成。下次启动 DSH 时生效。'
}
