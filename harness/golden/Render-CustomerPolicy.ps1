#Requires -Version 7.2
<#
.SYNOPSIS
    Renders the gateway policy the current code would deploy for the customer fixture (BUILD-PLAN P4).

.DESCRIPTION
    Builds the gateway configuration exactly as Stage 5 (Invoke-Stage5, infra/staged/Staged.Application.ps1) does,
    from tests/fixtures/customer/staged.config.json and the stage outputs in its state.json, then runs
    infra/gateway/render.ts into -OutDir. No Azure call: the two Stage 5 inputs that read Azure (the recorded stage
    outputs and the API Management identity) come from the fixture state. Used by tests/harness-golden-policy.test.ts.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$OutDir,
    [string]$FixtureDir
)
$ErrorActionPreference = 'Stop'
$harnessRepo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$fixture = if ($FixtureDir) { [IO.Path]::GetFullPath($FixtureDir) } else { Join-Path $harnessRepo 'tests/fixtures/customer' }
$outPath = [IO.Path]::GetFullPath($OutDir)
$script:FixtureStages = (Get-Content -LiteralPath (Join-Path $fixture 'state.json') -Raw | ConvertFrom-Json -AsHashtable -Depth 100).stages

# Dot-sourcing runs the driver's param block in this scope; everything it needs from here was copied above.
. (Join-Path $harnessRepo 'infra/staged/Invoke-StagedDeployment.ps1') -DotSourceOnly
$ErrorActionPreference = 'Stop'
$script:StateDir = Join-Path $outPath 'state'
New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null

# The recorded outputs stand in for Azure: freshness is the customer replay's job (Test-HarnessCustomerReplay.ps1).
function Get-StgStage { param($Cfg, [int]$Number) return $script:FixtureStages["$Number"].outputs }
function Get-StgApimIdentity {
    param($Cfg)
    $o = $script:FixtureStages['1'].outputs
    return @{ id = $o.apimId; principalId = $o.apimPrincipalId; gatewayUrl = $o.apimGatewayUrl; name = $o.apimName; location = $Cfg.location }
}

$Cfg = Read-StgConfig (Join-Path $fixture 'staged.config.json')
$entra = Get-StgStage $Cfg 4
$ctx = New-StgQsContext $Cfg
# BEGIN Stage 5 gateway config (each line must appear verbatim in Invoke-Stage5)
    $config = New-QsGatewayConfig -P $ctx.P -Checks $ctx.State.completed['1'].outputs
    if ($entra.azureCliClientAllowed) { $config.entra.delegatedClientAppIds = @($config.entra.delegatedClientAppIds) + @($script:AzureCliClientId) }
    $config.entra.surfaceClients = @($Cfg.gateway.surfaceClients | Where-Object { $_ } | ForEach-Object { [ordered]@{ clientAppId = ([string]$_.clientAppId).ToLowerInvariant(); surface = [string]$_.surface } })
# END Stage 5 gateway config
$configPath = Join-Path $outPath 'gateway-config.json'
$config | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
Push-Location $harnessRepo
try { node infra/gateway/render.ts --config $configPath --out (Join-Path $outPath 'gateway') | Out-Null } finally { Pop-Location }
if ($LASTEXITCODE) { throw 'render_failed: infra/gateway/render.ts refused the fixture gateway configuration.' }
