#Requires -Version 7.2
<#
.SYNOPSIS
    Seals the pseudonymized customer state with the deployed commit's own hashes (BUILD-PLAN P4, DEP-04).

.DESCRIPTION
    Pseudonymizing the fixture changes every input of the stage hashes, so the copied state.json no longer matches
    its config. This script checks out the deployed commit (manifest.json deployedCommit) in a temporary git worktree
    and, with that commit's staged driver, recomputes the config hash of every stage that was fresh at collection
    (freshness.json) and the dependency hash of every dependency that was fresh. Stages that were stale stay stale.
    It writes state.sealed.json and seal.json beside the fixture. tests/Test-HarnessCustomerReplay.ps1 then reads the
    sealed state with the current driver: a stage the deployed code accepted must still be accepted.
    Run it again after each re-collection. Reads git only; no Azure call.
#>
[CmdletBinding()]
param([string]$FixtureDir, [string]$Commit)
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$fixture = if ($FixtureDir) { [IO.Path]::GetFullPath($FixtureDir) } else { Join-Path $repo 'tests/fixtures/customer' }
$manifest = Get-Content -LiteralPath (Join-Path $fixture 'manifest.json') -Raw | ConvertFrom-Json
$deployed = if ($Commit) { $Commit } else { $manifest.deployedCommit }
if (-not $manifest.stagedConfig) { throw 'fixture_without_state: collect with -ConfigPath so the fixture holds staged.config.json and state.json' }

$worktree = Join-Path ([IO.Path]::GetTempPath()) "ccof-seal-$deployed-$PID"
git -C $repo worktree add --detach $worktree $deployed 2>&1 | Out-Null
if ($LASTEXITCODE) { throw "worktree_failed: git cannot check out $deployed (fetch full history first)" }
try {
    $child = @'
param($Worktree, $Fixture)
$ErrorActionPreference = 'Stop'
. (Join-Path $Worktree 'infra/staged/Invoke-StagedDeployment.ps1') -DotSourceOnly
$ErrorActionPreference = 'Stop'
$cfg = Read-StgConfig (Join-Path $Fixture 'staged.config.json')
$state = Get-Content -LiteralPath (Join-Path $Fixture 'state.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 100
$fresh = @{}; foreach ($f in (Get-Content -LiteralPath (Join-Path $Fixture 'freshness.json') -Raw | ConvertFrom-Json -AsHashtable)) { $fresh["$($f.stage)"] = $f }
$expected = [ordered]@{}
foreach ($key in @($state.stages.Keys | Sort-Object { [int]$_ })) {
    $record = $state.stages[$key]; $f = $fresh[$key]
    if ($f.configFresh) { $record.configHash = Get-StgStageInput $cfg ([int]$key) }
    foreach ($d in @($f.dependenciesFresh.Keys)) {
        if ($f.dependenciesFresh[$d] -and $record.dependencyHashes) { $record.dependencyHashes[$d] = Get-StgOutputHash $state.stages[$d].outputs }
    }
    $expected[$key] = if ($f.configFresh -and -not @($f.dependenciesFresh.Values | Where-Object { -not $_ }).Count) { 'fresh' } else { 'stale' }
}
$state | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Join-Path $Fixture 'state.sealed.json') -Encoding utf8NoBOM
$expected | ConvertTo-Json -Compress
'@
    $childPath = Join-Path $worktree 'seal-child.ps1'
    Set-Content -LiteralPath $childPath -Value $child -Encoding utf8NoBOM
    $expected = pwsh -NoProfile -File $childPath $worktree $fixture
    if ($LASTEXITCODE) { throw "seal_failed: $expected" }
    [ordered]@{
        deployedCommit = $deployed
        note = 'state.sealed.json: state.json with the hashes of stages fresh at collection recomputed by the deployed commit''s driver. Regenerate with harness/customer/Seal-FixtureState.ps1.'
        expected = ($expected | Select-Object -Last 1 | ConvertFrom-Json -AsHashtable)
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $fixture 'seal.json') -Encoding utf8NoBOM
    Write-Host "Sealed with $deployed into $fixture (state.sealed.json, seal.json)"
} finally {
    git -C $repo worktree remove --force $worktree 2>&1 | Out-Null
}
