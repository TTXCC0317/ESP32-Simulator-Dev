# ESP32 Simulator 测试库种子脚本
# 用法：在仓库根执行 `./tools/seed-test-db.ps1`
# 行为：调用后端 seed 命令（M3 后实现），写入示例工程与元件 catalog 到 data/simulator.db
# M0 阶段占位，实际实现见 02-§4 M3 里程碑

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Write-Host '种子脚本占位 — M3 里程碑实现 catalog.service 后启用' -ForegroundColor Yellow
Write-Host '届时：pnpm --filter server seed'
exit 0
