#Requires -Version 7.2
# Customer replay (BUILD-PLAN P4; DEP-01, DEP-04): the current staged driver reads the customer's pseudonymized config
# and the state sealed with the deployed commit's driver (harness/customer/Seal-FixtureState.ps1). Every stage the
# deployed code accepted must still be accepted; the stages that were already stale at the customer must still be
# reported stale, and nothing else may be refused. No Azure call: Read-StgConfig and Get-StgStage read files only.
$ErrorActionPreference = 'Stop'
$replayRoot = Split-Path $PSScriptRoot -Parent
$replayFixture = Join-Path $replayRoot 'tests/fixtures/customer'
$passed = 0
function Assert-That([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAIL: $Message" }; $script:passed++ }

$replaySeal = Get-Content -LiteralPath (Join-Path $replayFixture 'seal.json') -Raw | ConvertFrom-Json -AsHashtable
$replayScratch = Join-Path $replayRoot ".env.public-test-scratch/customer-replay-$PID"
New-Item -ItemType Directory -Force -Path $replayScratch | Out-Null
Copy-Item -LiteralPath (Join-Path $replayFixture 'state.sealed.json') -Destination (Join-Path $replayScratch 'state.json')

try {
    # The driver (and the quickstart it loads) reuses common variable names: everything here is prefixed or read above.
    . (Join-Path $replayRoot 'infra/staged/Invoke-StagedDeployment.ps1') -DotSourceOnly
    $ErrorActionPreference = 'Stop'
    $script:StateDir = $replayScratch

    $replayCfg = $null
    try { $replayCfg = Read-StgConfig (Join-Path $replayFixture 'staged.config.json') } catch { throw "FAIL: the current config reader refuses the customer's config: $($_.Exception.Message)" }
    Assert-That ($null -ne $replayCfg) 'the current config reader accepts the customer configuration'

    $replayState = $null
    try { $replayState = Read-StgState $replayCfg } catch { throw "FAIL: the current driver cannot read the customer's state: $($_.Exception.Message)" }
    Assert-That ($replayState.stageLayout -ge 2) 'the customer state is read without a layout migration error'

    foreach ($replayStageKey in @($replaySeal.expected.Keys | Sort-Object { [int]$_ })) {
        $replayWant = $replaySeal.expected[$replayStageKey]
        $replayOutcome = try { $null = Get-StgStage $replayCfg ([int]$replayStageKey); 'fresh' } catch {
            $m = $_.Exception.Message
            if ($m -match '^stage_(config|dependency)_changed') { 'stale' } else { "error: $m" }
        }
        if ($replayWant -eq 'fresh') {
            Assert-That ($replayOutcome -eq 'fresh') "stage $replayStageKey was fresh with the deployed code ($($replaySeal.deployedCommit)) but the current code reports: $replayOutcome (DEP-04)"
        } else {
            Assert-That ($replayOutcome -eq 'stale') "stage $replayStageKey was already stale at the customer and must still be reported stale, not: $replayOutcome"
        }
        Write-Host "PASS: stage $replayStageKey $replayOutcome (deployed code: $replayWant)"
    }
} finally {
    Remove-Item -LiteralPath $replayScratch -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Customer replay: $passed checks passed against deployed commit $($replaySeal.deployedCommit). No Azure calls."
