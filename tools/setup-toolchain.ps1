# ESP32 Simulator 工具链自检脚本
# 用法：在仓库根执行 `./tools/setup-toolchain.ps1`
# 行为：检测 Node/pnpm/Git 版本；缺失或版本过低时给安装指引并 exit 1（不自动安装）
# 引擎B 工具链（arduino-cli/QEMU/esptool）检测见 02-§1.2，由后端 /api/health/tools 暴露

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Test-VersionSatisfied {
  param(
    [string]$Current,
    [string]$Required
  )
  $currentParts = $current.Split('.') | ForEach-Object { [int]$_ }
  $requiredParts = $required.Split('.') | ForEach-Object { [int]$_ }
  for ($i = 0; $i -lt $requiredParts.Count; $i++) {
    $c = if ($i -lt $currentParts.Count) { $currentParts[$i] } else { 0 }
    if ($c -gt $requiredParts[$i]) { return $true }
    if ($c -lt $requiredParts[$i]) { return $false }
  }
  return $true
}

$ok = $true
$report = @()

# ---- Node ----
$nodeVersion = $null
try {
  $nodeVersionOutput = (node --version 2>$null)
  if ($nodeVersionOutput -match 'v(\d+\.\d+\.\d+)') {
    $nodeVersion = $matches[1]
  }
} catch {
  $nodeVersion = $null
}

if (-not $nodeVersion) {
  $report += '[FAIL] Node.js 未找到（要求 >=20 LTS）'
  $report += '  安装指引：https://nodejs.org/ 下载 20 LTS（或更新 LTS）'
  $ok = $false
} elseif (-not (Test-VersionSatisfied -Current $nodeVersion -Required '20.0.0')) {
  $report += "[FAIL] Node.js 版本 v$nodeVersion 过低（要求 >=20 LTS）"
  $report += '  升级指引：https://nodejs.org/ 下载 20 LTS（或更新 LTS）'
  $ok = $false
} else {
  $report += "[OK]   Node.js v$nodeVersion"
}

# ---- pnpm ----
$pnpmVersion = $null
try {
  $pnpmVersionOutput = (pnpm --version 2>$null)
  if ($pnpmVersionOutput -match '^(\d+\.\d+\.\d+)') {
    $pnpmVersion = $matches[1]
  }
} catch {
  $pnpmVersion = $null
}

if (-not $pnpmVersion) {
  $report += '[FAIL] pnpm 未找到（要求 >=9）'
  $report += '  安装指引：corepack enable && corepack prepare pnpm@latest --activate'
  $ok = $false
} elseif (-not (Test-VersionSatisfied -Current $pnpmVersion -Required '9.0.0')) {
  $report += "[FAIL] pnpm 版本 $pnpmVersion 过低（要求 >=9）"
  $report += '  升级指引：corepack prepare pnpm@latest --activate'
  $ok = $false
} else {
  $report += "[OK]   pnpm $pnpmVersion"
}

# ---- Git ----
$gitVersion = $null
try {
  $gitVersionOutput = (git --version 2>$null)
  if ($gitVersionOutput -match 'version (\d+\.\d+\.\d+)') {
    $gitVersion = $matches[1]
  }
} catch {
  $gitVersion = $null
}

if (-not $gitVersion) {
  $report += '[FAIL] Git 未找到（要求 >=2.x）'
  $report += '  安装指引：https://git-scm.com/'
  $ok = $false
} elseif (-not (Test-VersionSatisfied -Current $gitVersion -Required '2.0.0')) {
  $report += "[FAIL] Git 版本 $gitVersion 过低（要求 >=2.x）"
  $report += '  升级指引：https://git-scm.com/'
  $ok = $false
} else {
  $report += "[OK]   Git $gitVersion"
}

# ---- 引擎B 工具链（仅提示，不强制；02-§1.2 由后端 /api/health/tools 暴露）----
$report += ''
$report += '--- 引擎B 工具链（M4 起，缺失时引擎B入口置灰，引擎A 不受影响）---'
$report += '  arduino-cli / esptool / QEMU 由后端启动时检测，详见 /api/health/tools'
$report += '  本脚本不强制要求这些工具，仅作提示'

Write-Host ''
$report | ForEach-Object { Write-Host $_ }
Write-Host ''

if ($ok) {
  Write-Host '✓ 基础环境就绪，可执行 pnpm install' -ForegroundColor Green
  exit 0
} else {
  Write-Host '✗ 基础环境缺失或不达标，请按上述指引修复后重试' -ForegroundColor Red
  exit 1
}
