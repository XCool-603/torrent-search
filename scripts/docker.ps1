#Requires -Version 5.1
<#
种子搜索 —— Docker 一键部署 / 一键升级（Windows PowerShell 版）

  .\scripts\docker.ps1 deploy               首次部署（构建并启动，等待健康检查）
  .\scripts\docker.ps1 upgrade              升级到最新 main（失败自动回滚）
  .\scripts\docker.ps1 upgrade --ref v1.1.0 升级到指定 tag/分支
  .\scripts\docker.ps1 upgrade --no-cache   不使用构建缓存
  .\scripts\docker.ps1 status               容器状态 + 健康检查
  .\scripts\docker.ps1 logs                 跟随日志（Ctrl+C 退出）
  .\scripts\docker.ps1 down                 停止并移除容器（下载文件保留）

下载文件与任务记录都在 ./downloads（或 .env 里的 TORRENT_SEARCH_DOWNLOADS）卷里，
升级、重建、删除容器都不会动它们。
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$Service = 'torrent-search'
$DefaultPort = 8787
# 健康检查的等待次数与间隔（慢机器可以调大）
$HealthAttempts = if ($env:TORRENT_SEARCH_HEALTH_ATTEMPTS) { [int]$env:TORRENT_SEARCH_HEALTH_ATTEMPTS } else { 30 }
$HealthInterval = if ($env:TORRENT_SEARCH_HEALTH_INTERVAL) { [int]$env:TORRENT_SEARCH_HEALTH_INTERVAL } else { 2 }

function Write-Info([string]$Message) { Write-Host "  $Message" }

function Stop-WithError([string]$Message) {
  Write-Host ""
  Write-Host "x $Message" -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------- 环境检查

$script:ComposeArgs = $null
$script:UseLegacyCompose = $false

function Initialize-Compose {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-WithError '找不到 docker 命令。请安装 Docker Desktop（Windows/macOS）或 docker engine + compose 插件（Linux）。'
  }

  & docker compose version *> $null
  if ($LASTEXITCODE -eq 0) {
    $script:ComposeArgs = @('compose')
    return
  }

  if (Get-Command docker-compose -ErrorAction SilentlyContinue) {
    $script:UseLegacyCompose = $true
    Write-Info '提示：用的是老式 docker-compose，建议升级到 docker compose（v2）'
    return
  }

  Stop-WithError 'docker compose 不可用。请安装 compose 插件，或升级 Docker。'
}

# 注意：参数名不能叫 $Args（PowerShell 的自动变量）；
# 也不能写成 `& docker @($a + $b)`——那会把整个数组当成一个参数传过去，必须用 @变量 展开。
function Invoke-Compose {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$ComposeCmdArgs)

  if ($script:UseLegacyCompose) {
    & docker-compose @ComposeCmdArgs
  }
  else {
    $fullArgs = $script:ComposeArgs + $ComposeCmdArgs
    & docker @fullArgs
  }
}

# 从 .env 读取一个键（没有则返回 $null）
function Get-EnvValue([string]$Key) {
  if (-not (Test-Path '.env')) { return $null }
  foreach ($line in Get-Content '.env') {
    if ($line -match "^\s*$([regex]::Escape($Key))=(.*)$") {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

function Get-Port {
  $port = Get-EnvValue 'TORRENT_SEARCH_PORT'
  if ([string]::IsNullOrWhiteSpace($port)) { return $DefaultPort }
  return $port
}

function Get-DownloadsDir {
  $dir = Get-EnvValue 'TORRENT_SEARCH_DOWNLOADS'
  if ([string]::IsNullOrWhiteSpace($dir)) { return './downloads' }
  return $dir
}

function Wait-Healthy {
  for ($i = 0; $i -lt $HealthAttempts; $i++) {
    $probe = "fetch('http://127.0.0.1:'+(process.env.TORRENT_SEARCH_PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    Invoke-Compose exec -T $Service node -e $probe *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    Start-Sleep -Seconds $HealthInterval
  }
  return $false
}

function Show-Result {
  $port = Get-Port
  Write-Host ""
  Write-Host "  Web UI   http://127.0.0.1:$port/"
  Write-Host "  JSON API http://127.0.0.1:$port/api/search?q=ubuntu"
  Write-Host "  下载目录 $(Get-DownloadsDir)（宿主机）"
}

function Initialize-EnvFile {
  if (-not (Test-Path '.env') -and (Test-Path '.env.example')) {
    Copy-Item '.env.example' '.env'
    Write-Info '已从 .env.example 生成 .env（可修改端口、下载目录、下载后端）'
  }
}

# ---------------------------------------------------------------- 命令

function Invoke-Deploy {
  Initialize-Compose
  Initialize-EnvFile

  Write-Host ""
  Write-Host '> 构建并启动容器（首次构建需要几分钟）'
  Invoke-Compose up -d --build
  if ($LASTEXITCODE -ne 0) { Stop-WithError '构建或启动失败，请检查上面的输出。' }

  Write-Host ""
  Write-Host '> 等待健康检查通过'
  if (Wait-Healthy) {
    Write-Host ""
    Write-Host 'v 部署完成' -ForegroundColor Green
    Show-Result
    Write-Host ""
    Write-Host '  后续升级：.\scripts\docker.ps1 upgrade'
    return
  }

  Write-Host ""
  Write-Host 'x 容器已启动但健康检查未通过。日志：' -ForegroundColor Red
  Invoke-Compose logs --tail 50 $Service
  exit 1
}

function Invoke-Upgrade {
  Initialize-Compose
  Initialize-EnvFile

  $ref = $null
  $noCache = $false
  for ($i = 0; $i -lt $Rest.Count; $i++) {
    switch ($Rest[$i]) {
      '--ref' {
        if ($i + 1 -ge $Rest.Count) { Stop-WithError '--ref 需要一个参数（tag 或分支名）' }
        $ref = $Rest[$i + 1]
        $i++
      }
      '--no-cache' { $noCache = $true }
      default { Stop-WithError "upgrade 不支持这个参数：$($Rest[$i])" }
    }
  }

  $before = $null

  if (-not (Test-Path '.git')) {
    Write-Info '这不是 git 仓库（可能来自 tarball），跳过代码更新，直接重建镜像'
  }
  else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Stop-WithError '需要 git 才能升级代码' }

    # 只把「已跟踪文件的改动」视为本地改动：.env、downloads/ 这类未跟踪文件不该挡住升级
    $dirty = & git status --porcelain --untracked-files=no
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'git status 执行失败，请确认这是一个正常的 git 工作区。' }
    if ($dirty) {
      Write-Host ""
      Write-Host 'x 检测到本地未提交的改动，已中止以免丢失你的修改：' -ForegroundColor Red
      Write-Host ""
      & git status --short --untracked-files=no | ForEach-Object { Write-Host "  $_" }
      Write-Host ""
      Write-Host '  先提交（git commit）或暂存（git stash）后再升级。'
      exit 1
    }

    $before = (& git rev-parse --short HEAD).Trim()
    Write-Host ""
    Write-Host "> 拉取代码（当前 $before）"
    & git fetch --tags --prune
    if ($LASTEXITCODE -ne 0) { Stop-WithError 'git fetch 失败，请检查网络或远端配置。' }

    if ($ref) {
      & git checkout --quiet $ref
      if ($LASTEXITCODE -ne 0) { Stop-WithError "切换到 $ref 失败。" }
    }
    else {
      $branch = & git symbolic-ref --quiet --short HEAD
      if ($LASTEXITCODE -eq 0 -and $branch) {
        & git pull --ff-only
        if ($LASTEXITCODE -ne 0) { Stop-WithError 'git pull 失败（可能有分叉），请手动处理后重试。' }
      }
      else {
        # detached HEAD（通常是上次用 --ref 升级留下的）
        $defaultBranch = (& git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>$null)
        if ($defaultBranch) { $defaultBranch = $defaultBranch.Trim() -replace '^origin/', '' }
        if ([string]::IsNullOrWhiteSpace($defaultBranch)) { $defaultBranch = 'main' }
        Write-Info "当前不在分支上（detached HEAD），切回 $defaultBranch"
        & git checkout --quiet $defaultBranch
        if ($LASTEXITCODE -ne 0) { Stop-WithError "切回 $defaultBranch 失败，请手动处理。" }
        & git pull --ff-only
        if ($LASTEXITCODE -ne 0) { Stop-WithError 'git pull 失败（可能有分叉），请手动处理后重试。' }
      }
    }

    $after = (& git rev-parse --short HEAD).Trim()
    if ($before -eq $after) {
      Write-Info "代码已是最新（$after），继续重建镜像以确保一致"
    }
    else {
      Write-Info "代码：$before -> $after"
    }
  }

  Write-Host ""
  Write-Host '> 重建并重启容器（下载文件与任务记录不受影响）'
  if ($noCache) { Invoke-Compose build --no-cache }
  Invoke-Compose up -d --build
  if ($LASTEXITCODE -ne 0) { Stop-WithError '构建或启动失败，请检查上面的输出。' }

  Write-Host ""
  Write-Host '> 等待健康检查通过'
  if (Wait-Healthy) {
    Write-Host ""
    Write-Host 'v 升级完成' -ForegroundColor Green
    Show-Result
    return
  }

  Write-Host ""
  Write-Host 'x 升级后健康检查未通过' -ForegroundColor Red
  Invoke-Compose logs --tail 50 $Service

  if ($before -and (Test-Path '.git')) {
    Write-Host ""
    Write-Host "> 回滚到 $before" -ForegroundColor Red
    & git checkout --quiet $before
    Invoke-Compose up -d --build
    Write-Host '  已回滚。请把上面的日志作为 issue 反馈。'
  }
  else {
    Write-Host '  无法自动回滚（不是 git 仓库或没有记录升级前版本）。'
  }
  exit 1
}

function Invoke-Status {
  Initialize-Compose
  Invoke-Compose ps
  Write-Host ""
  Write-Host '> 健康检查'
  if (Wait-Healthy) {
    Write-Host 'v 服务正常' -ForegroundColor Green
    Show-Result
    return
  }
  Write-Host 'x 健康检查未通过' -ForegroundColor Red
  exit 1
}

function Invoke-Logs {
  Initialize-Compose
  Invoke-Compose logs -f --tail 100 $Service
}

function Invoke-Down {
  Initialize-Compose
  Invoke-Compose down
  Write-Host ""
  Write-Host "v 已停止并移除容器。下载文件仍在 $(Get-DownloadsDir)（未被删除）。" -ForegroundColor Green
}

function Show-Usage {
  Write-Host @'
种子搜索 —— Docker 一键部署 / 一键升级（Windows）

用法：.\scripts\docker.ps1 <命令> [参数]

命令：
  deploy                 首次部署：构建镜像并启动，等待健康检查通过
  upgrade [参数]         升级：拉取最新代码 -> 重建镜像 -> 重启 -> 健康检查（失败自动回滚）
                         --ref <tag|分支>   升级到指定版本，例如 --ref v1.1.0
                         --no-cache         不使用构建缓存
  status                 查看容器状态与健康检查
  logs                   跟随日志
  down                   停止并移除容器（下载文件保留）

说明：
  下载文件与任务记录保存在 ./downloads 卷（可用 .env 的 TORRENT_SEARCH_DOWNLOADS 改），
  升级、重建、删容器都不会影响它们；重启后未完成的下载会自动续传。
'@
}

switch ($Command) {
  'deploy' { Invoke-Deploy }
  'upgrade' { Invoke-Upgrade }
  'status' { Invoke-Status }
  'logs' { Invoke-Logs }
  'down' { Invoke-Down }
  { $_ -in 'help', '-h', '--help', '' } { Show-Usage }
  default {
    Show-Usage
    Stop-WithError "未知命令：$Command"
  }
}
