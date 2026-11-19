#Requires -Version 7.2
<#
.SYNOPSIS
    Collects a read-only snapshot of a deployed CCOF installation for the harness customer fixture (BUILD-PLAN P3).

.DESCRIPTION
    Read-only. Every Azure call goes through Invoke-FixtureAz, which allows only show, list and GET commands.
    Writes only to a new folder under .env.customer-fixture/ (gitignored through .env.*). It collects:
      - the deployed commit SHA you pass in (manifest.json)
      - copies of staged.config.json and .staged-state/state.json
      - freshness.json: for each recorded stage, whether its config hash and dependency hashes still match, computed
        with the staged driver itself; pseudonymizing changes the hashes, so the P4 replay re-seals from this file
      - the gateway API policy, operation policies, policy fragments, operations, revisions and backends (GET only)
      - each Function App's function list and app-setting NAMES; values are filtered out inside az (--query) and
        never reach this script
      - optionally (-IncludeCosmos) a few documents per container, read with GET; skipped when Cosmos is not reachable
    Next: node harness/pseudonymize-fixture.mjs --from <output folder>, then read every file it writes.

.EXAMPLE
    pwsh -File harness/customer/Collect-CustomerFixture.ps1 -DeployedCommit 92a9e54 -ConfigPath ..\deploy\staged.config.json
#>
[CmdletBinding()]
param(
    [string]$DeployedCommit,
    [string]$ConfigPath,
    [string]$StateDirectory,
    [string]$OutputDirectory,
    [switch]$IncludeCosmos,
    [ValidateRange(1, 10)] [int]$CosmosSampleCount = 3,
    [switch]$DotSourceOnly
)
$ErrorActionPreference = 'Stop'
$script:FixtureRepo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$script:FixtureRoot = Join-Path $script:FixtureRepo '.env.customer-fixture'

# Read-only allow-list: the first words of every az command this collector may run.
$script:AllowedAz = @(
    'version', 'account show', 'account get-access-token', 'resource list', 'cosmosdb list',
    'functionapp function list', 'functionapp config appsettings list', 'rest --method get'
)

function Test-FixtureAzAllowed {
    param([string[]]$Arguments)
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        $a = $Arguments[$i]
        if (($a -in @('--method', '-m')) -and ($i + 1 -ge $Arguments.Count -or $Arguments[$i + 1] -cne 'get')) { return $false }
        if ($a -match '^(--method|-m)=' -and $a -notmatch '^(--method|-m)=get$') { return $false }
    }
    $line = ($Arguments -join ' ').Trim()
    foreach ($prefix in $script:AllowedAz) { if ($line -ceq $prefix -or $line.StartsWith("$prefix ", [StringComparison]::Ordinal)) { return $true } }
    return $false
}

function Invoke-FixtureAz {
    param([string[]]$Arguments, [switch]$AllowFailure)
    if (-not (Test-FixtureAzAllowed $Arguments)) { throw "read_only_refused: az $($Arguments -join ' ')" }
    $out = & az @Arguments 2>$null
    if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) { throw "az_failed: az $($Arguments[0..[Math]::Min(2, $Arguments.Count - 1)] -join ' ') (exit $LASTEXITCODE)" }
    return ($out -join "`n")
}

function Resolve-FixtureOutput {
    param([string]$Requested)
    $root = [IO.Path]::GetFullPath($script:FixtureRoot)
    $path = if ($Requested) { [IO.Path]::GetFullPath($Requested) } else { Join-Path $root ([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')) }
    $sep = [IO.Path]::DirectorySeparatorChar
    if (-not $path.StartsWith($root + $sep, [StringComparison]::OrdinalIgnoreCase)) { throw "output_outside_fixture_root: $path is not under $root" }
    if ((Test-Path -LiteralPath $path) -and @(Get-ChildItem -LiteralPath $path -Force).Count) { throw "output_not_empty: $path" }
    return $path
}

function Get-FixtureFreshness {
    param($Cfg, $State)
    $rows = foreach ($key in @($State.stages.Keys | Sort-Object { [int]$_ })) {
        $n = [int]$key; $record = $State.stages[$key]
        $deps = [ordered]@{}
        foreach ($d in Get-StgStageDependencies $n) {
            $dep = $State.stages["$d"]
            $deps["$d"] = [bool]($dep -and $record.dependencyHashes -and $record.dependencyHashes["$d"] -ceq (Get-StgOutputHash $dep.outputs))
        }
        [ordered]@{ stage = $n; configFresh = [bool]($record.configHash -ceq (Get-StgStageInput $Cfg $n)); dependenciesFresh = $deps }
    }
    return @($rows)
}

function Save-FixtureJson { param($Value, [string]$Path) New-Item -ItemType Directory -Force -Path (Split-Path $Path -Parent) | Out-Null; ConvertTo-Json -InputObject $Value -Depth 100 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM }

# A policy GET returns XML, which az rest cannot print, so it is written straight to the file.
function Save-FixturePolicy {
    param([string]$Url, [string]$Path)
    $null = Invoke-FixtureAz @('rest', '--method', 'get', '--url', $Url, '--output-file', $Path) -AllowFailure
    if (-not (Test-Path -LiteralPath $Path) -or (Get-Item -LiteralPath $Path).Length -eq 0) { Remove-Item -LiteralPath $Path -ErrorAction SilentlyContinue; return $false }
    $text = [IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF)
    if ($text.TrimStart().StartsWith('{')) { Remove-Item -LiteralPath $Path; return $false }
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
    return $true
}

function Get-FixtureGateway {
    param($Cfg, $State, [string]$Out)
    $apimName = $State.stages['1'].outputs.apimName
    $apim = if ($apimName) { @{ name = $apimName; subscriptionId = $Cfg.subscriptionId; resourceGroup = $Cfg.resourceGroup } }
            elseif ($Cfg.apim.existing) { $Cfg.apim.existing } else { throw 'apim_missing: no Stage 1 apimName and no apim.existing' }
    $base = "https://management.azure.com/subscriptions/$($apim.subscriptionId)/resourceGroups/$($apim.resourceGroup)/providers/Microsoft.ApiManagement/service/$($apim.name)"
    $api = $Cfg.apim.apiId; $v = 'api-version=2024-05-01'; $dir = Join-Path $Out 'gateway'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    if (-not (Save-FixturePolicy "$base/apis/$api/policies/policy?$v" (Join-Path $dir 'api-policy.xml'))) { throw "policy_missing: API $api has no policy" }
    $null = Save-FixturePolicy "$base/policies/policy?$v" (Join-Path $dir 'global-policy.xml')
    $ops = @(Invoke-FixtureAz @('rest', '--method', 'get', '--url', "$base/apis/$api/operations?$v", '--query', 'value[].{name:name, method:properties.method, urlTemplate:properties.urlTemplate}', '-o', 'json') | ConvertFrom-Json)
    Save-FixtureJson $ops (Join-Path $dir 'operations.json')
    foreach ($op in $ops) { $null = Save-FixturePolicy "$base/apis/$api/operations/$($op.name)/policies/policy?$v" (Join-Path $dir "op-$($op.name).xml") }
    $revisions = @(Invoke-FixtureAz @('rest', '--method', 'get', '--url', "$base/apis/$api/revisions?$v", '--query', 'value[].{apiRevision:apiRevision, isCurrent:isCurrent, isOnline:isOnline}', '-o', 'json') | ConvertFrom-Json)
    Save-FixtureJson $revisions (Join-Path $dir 'revisions.json')
    $fragments = @(Invoke-FixtureAz @('rest', '--method', 'get', '--url', "$base/policyFragments?$v", '--query', 'value[].{name:name, value:properties.value}', '-o', 'json') | ConvertFrom-Json)
    foreach ($f in $fragments) { [IO.File]::WriteAllText((Join-Path $dir "fragment-$($f.name).xml"), $f.value, [Text.UTF8Encoding]::new($false)) }
    $backends = @(Invoke-FixtureAz @('rest', '--method', 'get', '--url', "$base/backends?$v", '--query', 'value[].{name:name, url:properties.url, protocol:properties.protocol}', '-o', 'json') | ConvertFrom-Json)
    Save-FixtureJson $backends (Join-Path $dir 'backends.json')
}

function Get-FixtureFunctions {
    param($Cfg, [string]$Out)
    $apps = @(Invoke-FixtureAz @('resource', 'list', '-g', $Cfg.resourceGroup, '--subscription', $Cfg.subscriptionId, '--resource-type', 'Microsoft.Web/sites', '--query', '[].name', '-o', 'json') | ConvertFrom-Json)
    foreach ($app in $apps) {
        $common = @('-g', $Cfg.resourceGroup, '-n', $app, '--subscription', $Cfg.subscriptionId)
        $functions = @(Invoke-FixtureAz (@('functionapp', 'function', 'list') + $common + @('--query', '[].{name:name, disabled:isDisabled, trigger:config.bindings[0].type}', '-o', 'json')) | ConvertFrom-Json)
        $names = @(Invoke-FixtureAz (@('functionapp', 'config', 'appsettings', 'list') + $common + @('--query', '[].name', '-o', 'json')) | ConvertFrom-Json)
        Save-FixtureJson ([ordered]@{
            app = $app
            functions = @($functions | ForEach-Object { [ordered]@{ name = ($_.name -split '/')[-1]; disabled = [bool]$_.disabled; trigger = $_.trigger } } | Sort-Object { $_.name })
            appSettingNames = @($names | Sort-Object)
        }) (Join-Path $Out "functions/$app.json")
    }
}

function Get-FixtureCosmos {
    param($Cfg, [string]$Out, [int]$Count)
    $accounts = @(Invoke-FixtureAz @('cosmosdb', 'list', '-g', $Cfg.resourceGroup, '--subscription', $Cfg.subscriptionId, '--query', '[].documentEndpoint', '-o', 'json') | ConvertFrom-Json)
    if (-not $accounts.Count) { return 'no Cosmos account in the resource group' }
    $endpoint = "$($accounts[0])".TrimEnd('/')
    $token = Invoke-FixtureAz @('account', 'get-access-token', '--resource', 'https://cosmos.azure.com', '--query', 'accessToken', '-o', 'tsv')
    try {
        foreach ($container in 'entitlement', 'budgetState', 'projects') {
            $headers = @{ Authorization = [uri]::EscapeDataString("type=aad&ver=1.0&sig=$token"); 'x-ms-date' = [DateTime]::UtcNow.ToString('r'); 'x-ms-version' = '2018-12-31'; 'x-ms-max-item-count' = "$Count" }
            $page = Invoke-RestMethod -Method Get -Uri "$endpoint/dbs/$($Cfg.cosmos.databaseName)/colls/$container/docs" -Headers $headers -TimeoutSec 20
            $docs = @($page.Documents | Select-Object -First $Count | ForEach-Object { foreach ($p in '_rid', '_self', '_attachments', '_etag') { $_.PSObject.Properties.Remove($p) }; $_ })
            Save-FixtureJson $docs (Join-Path $Out "cosmos/$container.json")
        }
        return 'collected'
    } catch {
        Remove-Item -LiteralPath (Join-Path $Out 'cosmos') -Recurse -Force -ErrorAction SilentlyContinue
        return "Cosmos not reachable from this machine ($($_.Exception.GetType().Name))"
    } finally { $token = $null }
}

if ($DotSourceOnly) { return }
if ($DeployedCommit -notmatch '^[0-9a-f]{7,40}$') { throw 'Usage: -DeployedCommit <git sha the customer runs> -ConfigPath <staged.config.json> [-StateDirectory <dir>] [-IncludeCosmos]' }
if (-not $ConfigPath -or -not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "config_missing: $ConfigPath" }

$out = Resolve-FixtureOutput $OutputDirectory
. (Join-Path $script:FixtureRepo 'infra/staged/Invoke-StagedDeployment.ps1') -DotSourceOnly
$ErrorActionPreference = 'Stop'
$cfg = Read-StgConfig $ConfigPath
$stateDir = if ($StateDirectory) { [IO.Path]::GetFullPath($StateDirectory) } else { Join-Path (Split-Path $cfg.__path -Parent) '.staged-state' }
$statePath = Join-Path $stateDir 'state.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw "state_missing: $statePath" }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable -Depth 100
if (-not $state.stageLayout -or $state.stageLayout -lt 2) { throw 'state_layout_1: run any stage preview once so the driver migrates the state file, then collect' }
$account = Invoke-FixtureAz @('account', 'show', '--query', '{tenantId:tenantId, subscriptionId:id}', '-o', 'json') | ConvertFrom-Json
if ($account.tenantId -ne $cfg.tenantId) { throw "wrong_tenant: az is signed in to another tenant than the configuration's" }

New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item -LiteralPath $cfg.__path -Destination (Join-Path $out 'staged.config.json')
Copy-Item -LiteralPath $statePath -Destination (Join-Path $out 'state.json')
Save-FixtureJson (Get-FixtureFreshness $cfg $state) (Join-Path $out 'freshness.json')
Get-FixtureGateway $cfg $state $out
Get-FixtureFunctions $cfg $out
$cosmosNote = if ($IncludeCosmos) { Get-FixtureCosmos $cfg $out $CosmosSampleCount } else { 'not requested (-IncludeCosmos)' }
$azVersion = (Invoke-FixtureAz @('version', '-o', 'json') | ConvertFrom-Json).'azure-cli'
Save-FixtureJson ([ordered]@{
    deployedCommit = $DeployedCommit; collectedAt = [DateTime]::UtcNow.ToString('o'); azureCli = $azVersion
    cosmosSamples = [bool](Test-Path -LiteralPath (Join-Path $out 'cosmos')); cosmosNote = $cosmosNote
    files = @(Get-ChildItem -LiteralPath $out -Recurse -File | ForEach-Object { [IO.Path]::GetRelativePath($out, $_.FullName).Replace('\', '/') } | Sort-Object)
}) (Join-Path $out 'manifest.json')
Write-Host "Collected into $out"
Write-Host "Next: node harness/pseudonymize-fixture.mjs --from `"$out`""
