#Requires -Version 7.2
# Offline checks for harness/customer/Collect-CustomerFixture.ps1 (BUILD-PLAN P3): only read-only az commands pass
# its allow-list, it writes only under .env.customer-fixture/, and stage freshness comes from the staged driver.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$passed = 0
function Assert-That([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAIL: $Message" }; $script:passed++ }

. (Join-Path $root 'harness/customer/Collect-CustomerFixture.ps1') -DotSourceOnly

foreach ($ok in @(
    @('account', 'show'), @('rest', '--method', 'get', '--url', 'https://management.azure.com/x'),
    @('functionapp', 'config', 'appsettings', 'list', '-g', 'rg', '-n', 'app', '--query', '[].name'),
    @('resource', 'list', '-g', 'rg'), @('version', '-o', 'json'))) {
    Assert-That (Test-FixtureAzAllowed $ok) "allowed: az $($ok -join ' ')"
}
foreach ($bad in @(
    @('rest', '--method', 'put', '--url', 'x'), @('rest', '--method', 'post', '--url', 'x'), @('rest', '--url', 'x', '--method', 'delete'),
    @('rest', '--method', 'get', '--url', 'x', '--method', 'patch'), @('functionapp', 'config', 'appsettings', 'set', '-n', 'a'),
    @('functionapp', 'config', 'appsettings', 'delete'), @('role', 'assignment', 'create'), @('apim', 'api', 'update'),
    @('cosmosdb', 'keys', 'list'), @('resource', 'delete'), @('account', 'set', '-s', 'x'))) {
    Assert-That (-not (Test-FixtureAzAllowed $bad)) "refused: az $($bad -join ' ')"
}
$refused = $null; try { Invoke-FixtureAz @('rest', '--method', 'put', '--url', 'x') } catch { $refused = $_.Exception.Message }
Assert-That ($refused -like 'read_only_refused:*') 'Invoke-FixtureAz refuses before calling az'

$outside = $null; try { Resolve-FixtureOutput (Join-Path $root 'tests/fixtures') } catch { $outside = $_.Exception.Message }
Assert-That ($outside -like 'output_outside_fixture_root:*') 'an output folder outside .env.customer-fixture is refused'
$sibling = $null; try { Resolve-FixtureOutput (Join-Path $root '.env.customer-fixture-other/x') } catch { $sibling = $_.Exception.Message }
Assert-That ($sibling -like 'output_outside_fixture_root:*') 'a sibling folder with the same prefix is refused'
$default = Resolve-FixtureOutput $null
Assert-That ($default.StartsWith((Join-Path $root '.env.customer-fixture'))) 'the default output is under .env.customer-fixture'

$collector = Get-Content -Raw (Join-Path $root 'harness/customer/Collect-CustomerFixture.ps1')
Assert-That ($collector -notmatch "(?i)'--method',\s*'(put|patch|post|delete)'") 'the collector names no write method'
Assert-That ($collector -match "appsettings', 'list'\)[^\r\n]*'\[\]\.name'") 'app settings are listed by name only, inside az'

# Freshness from the staged driver: a stage recorded with this config's hash is fresh; one changed since is not.
. (Join-Path $root 'infra/staged/Invoke-StagedDeployment.ps1') -DotSourceOnly
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -Raw (Join-Path $root 'infra/staged/staged.config.example.json') | ConvertFrom-Json -AsHashtable -Depth 100
$s1 = @{ outputs = @{ apimName = 'a' } }
$s1.configHash = Get-StgStageInput $cfg 1
$s2 = @{ configHash = 'stale'; outputs = @{}; dependencyHashes = @{ '1' = (Get-StgOutputHash $s1.outputs) } }
$rows = Get-FixtureFreshness $cfg @{ stages = @{ '1' = $s1; '2' = $s2 } }
Assert-That ($rows[0].stage -eq 1 -and $rows[0].configFresh) 'a stage recorded with the current config hash is fresh'
Assert-That ($rows[1].stage -eq 2 -and -not $rows[1].configFresh -and $rows[1].dependenciesFresh['1']) 'a changed config is stale while its dependency still matches'

Write-Host "Harness collector: $passed checks passed. No Azure calls."
