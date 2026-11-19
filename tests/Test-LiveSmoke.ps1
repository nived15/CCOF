#Requires -Version 7.0
<#
.SYNOPSIS
    Offline tests for scripts/Test-LiveSmoke.ps1 (BUILD-PLAN L0). The script loads without
    scripts/Get-E2ETestToken.ps1, -NoToken never asks for a token, a missing token script is reported as the token
    checks' reason, and the configuration reader accepts only a filled copy of harness/live/live-config.example.json.
    No Azure call: every probe is a fake, and the script itself is run only in ways that refuse before Azure.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$passed = 0
function Assert-Contract([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:passed++ }
function Assert-Throws([scriptblock]$Block, [string]$Pattern, [string]$Message) {
    try { & $Block; throw "no error: $Message" } catch { if ($_.Exception.Message -like 'no error:*' -or $_.Exception.Message -notmatch $Pattern) { throw "$Message (got: $($_.Exception.Message))" } }
    $script:passed++
}

$smoke = Join-Path $root 'scripts/Test-LiveSmoke.ps1'
$example = Join-Path $root 'harness/live/live-config.example.json'
Assert-Contract (-not (Test-Path (Join-Path $root 'scripts/Get-E2ETestToken.ps1'))) 'this suite proves the script works without scripts/Get-E2ETestToken.ps1'
. $smoke -DotSourceOnly
Assert-Contract ([bool](Get-Command Invoke-LiveSmoke -ErrorAction SilentlyContinue)) 'the script loads without the token script'

# The example mirrors the header's key list and the reader's keys.
function Get-Leaves($Node, [string]$Prefix = '') {
    foreach ($p in $Node.PSObject.Properties) {
        if ($p.Name -eq '_readme') { continue }
        $key = if ($Prefix) { "$Prefix.$($p.Name)" } else { $p.Name }
        if ($p.Value -is [pscustomobject]) { Get-Leaves $p.Value $key } else { $key }
    }
}
$exampleKeys = @(Get-Leaves (Get-Content $example -Raw | ConvertFrom-Json) | Sort-Object)
$readerKeys = @($script:LiveTestConfigKeys.Keys | Sort-Object)
Assert-Contract (($exampleKeys -join ',') -ceq ($readerKeys -join ',')) "example keys differ from the reader: $($exampleKeys -join ',') vs $($readerKeys -join ',')"
$header = (Get-Content $smoke -Raw) -split 'Config keys' | Select-Object -Index 1
foreach ($key in $readerKeys) {
    $leaf = ($key -split '\.')[-1]
    Assert-Contract ($header -match "\b$([regex]::Escape($leaf))\b") "the script header does not list $key"
}

# Reader: placeholders are refused; a filled copy passes; token settings only when a token is requested.
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('ccof-live-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    Assert-Throws { Read-LiveTestConfig -Path $example } 'tenantId.*resourceGroup.*cosmos\.containers' 'the unfilled example is refused, naming each placeholder'
    Assert-Throws { Read-LiveTestConfig -Path (Join-Path $scratch 'absent.json') } 'live-config\.example\.json' 'a missing file names the example to copy'
    $filled = Get-Content $example -Raw | ConvertFrom-Json
    $filled.tenantId = '11111111-1111-4111-8111-111111111111'; $filled.subscriptionId = '22222222-2222-4222-8222-222222222222'
    $filled.resourceGroup = 'rg-lab'
    $filled.gateway.apimName = 'apim-lab'; $filled.gateway.apiId = 'claude-messages'; $filled.gateway.baseUrl = 'https://apim-lab.azure-api.net'
    $filled.gateway.apiPath = '/anthropic'; $filled.gateway.audience = 'api://ccof-lab'; $filled.gateway.probeModel = 'claude-haiku-4-5'
    $filled.resolver.functionAppName = 'func-resolver'; $filled.resolver.url = 'https://func-resolver.azurewebsites.net/api/resolve'
    $filled.cosmos.accountName = 'cosmos-lab'; $filled.cosmos.databaseName = 'ccof'; $filled.cosmos.containers = @('entitlement', 'budgetState')
    $filled.network.vnetName = 'vnet-lab'; $filled.network.foundryPrivateEndpointName = 'pe-foundry'; $filled.network.jumpboxNamePrefix = 'ccof-jumpbox'
    $path = Join-Path $scratch 'live-config.json'
    $filled | ConvertTo-Json -Depth 8 | Set-Content $path
    $config = Read-LiveTestConfig -Path $path -Overrides @{ 'network.dnsCheckVmName' = 'vm-dns' }
    Assert-Contract ($config.network.dnsCheckVmName -eq 'vm-dns' -and $config.gateway.probeMaxTokens -eq 16) 'a filled copy (token placeholders left) reads with -NoToken, and overrides apply'
    Assert-Throws { Read-LiveTestConfig -Path $path -RequireTokenSettings } 'testClient\.appDisplayName' 'a token run needs the test identity filled in'
    $filled.testClient.appDisplayName = 'ccof-test-client'; $filled | ConvertTo-Json -Depth 8 | Set-Content $path
    Assert-Contract ($null -ne (Read-LiveTestConfig -Path $path -RequireTokenSettings)) 'a fully filled copy reads for a token run'
    foreach ($bad in @(@('gateway.probeMaxTokens', 17, 'probeMaxTokens'), @('cosmos.containers', @(), 'containers'), @('gateway.baseUrl', 'http://x', 'baseUrl'), @('tenantId', 'not-a-guid', 'tenantId'))) {
        $copy = Get-Content $path -Raw | ConvertFrom-Json
        Set-LiveTestConfigValue $copy $bad[0] $bad[1]
        $p = Join-Path $scratch "bad-$($bad[2]).json"; $copy | ConvertTo-Json -Depth 8 | Set-Content $p
        Assert-Throws { Read-LiveTestConfig -Path $p } ([regex]::Escape($bad[2])) "$($bad[0]) = $($bad[1]) is refused"
    }

    # -NoToken never calls the token probe; a missing token script is the token checks' reason.
    $script:tokenCalls = 0
    $probes = @{
        Az = { param($Arguments) [pscustomobject]@{ ExitCode = 1; Json = $null; Error = 'fake az: offline test' } }
        Http = { param($Method, $Uri, $Headers, $Body, $Token) [pscustomobject]@{ StatusCode = 401; Content = ''; Headers = @{} } }
        RunInVm = { throw 'no VM in an offline test' }
        GetToken = { $script:tokenCalls++; throw 'scripts/Get-E2ETestToken.ps1 is not in this repository; run with -NoToken' }
        Sleep = { param($Seconds) }
    }
    $run = Invoke-LiveSmoke -Config $config -Probes $probes -NoToken
    $byId = @{}; $run.Results | ForEach-Object { $byId[$_.Id] = $_ }
    Assert-Contract ($script:tokenCalls -eq 0) '-NoToken never requests a token'
    Assert-Contract ($byId['identity.test-token'].Status -eq 'SKIP' -and $byId['gateway.with-token'].Status -eq 'SKIP') 'with -NoToken the token checks are skipped'
    Assert-Contract ($byId['identity.test-token'].Detail -match '-NoToken') 'the skip says why'
    Assert-Contract ($byId['gateway.no-token'].Status -eq 'PASS') 'the anonymous gateway check still runs'
    $run = Invoke-LiveSmoke -Config $config -Probes $probes -Only identity.test-token, gateway.with-token
    $byId = @{}; $run.Results | ForEach-Object { $byId[$_.Id] = $_ }
    Assert-Contract ($script:tokenCalls -eq 1) 'without -NoToken the token is requested once'
    Assert-Contract ($byId['identity.test-token'].Status -eq 'FAIL' -and $byId['identity.test-token'].Detail -match 'Get-E2ETestToken\.ps1 is not in this repository') 'a missing token script fails the token check with that reason'
    Assert-Contract ($run.ExitCode -eq 1) 'and the run exits 1'

    # The script refuses before any Azure call: without the opt-in, and with a missing configuration.
    $env:CCOF_LIVE_SMOKE = $null
    $out = pwsh -NoProfile -File $smoke -NoToken 2>&1 | Out-String
    Assert-Contract ($LASTEXITCODE -eq 2 -and $out -match 'Set CCOF_LIVE_SMOKE=1') 'without CCOF_LIVE_SMOKE=1 the script refuses (exit 2)'
    $env:CCOF_LIVE_SMOKE = '1'
    $out = pwsh -NoProfile -File $smoke -NoToken -ConfigPath (Join-Path $scratch 'absent.json') 2>&1 | Out-String
    Assert-Contract ($LASTEXITCODE -eq 2 -and $out -match 'live-config\.example\.json') 'a missing configuration is refused (exit 2) before any Azure call'
}
finally {
    $env:CCOF_LIVE_SMOKE = $null
    Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
}
"Test-LiveSmoke: $passed passed"
