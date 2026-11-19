#Requires -Version 7.0
<#
.SYNOPSIS
    Reads and checks the live smoke configuration for scripts/Test-LiveSmoke.ps1 (BUILD-PLAN L0).

.DESCRIPTION
    Read-LiveTestConfig returns the configuration from -Path, or throws one message naming every problem. Placeholders
    ("<...>") are refused, so only a filled copy runs. The test identity's settings (cloud.*, testClient.*) are needed
    only when a token is requested (-RequireTokenSettings). Overrides set a dotted key, for example
    @{ 'network.dnsCheckVmName' = 'vm1' }. The example is harness/live/live-config.example.json; keep filled copies in
    gitignored .env.live-lab/ or .env.live-customer/.
#>

$script:LiveTestConfigKeys = [ordered]@{
    'tenantId' = 'guid'; 'subscriptionId' = 'guid'; 'resourceGroup' = 'text'
    'cloud.authorityHost' = 'https+token'; 'cloud.graphBaseUrl' = 'https+token'
    'gateway.apimName' = 'text'; 'gateway.apiId' = 'text'; 'gateway.baseUrl' = 'https'; 'gateway.apiPath' = 'path'
    'gateway.operationPath' = 'path'; 'gateway.audience' = 'text'; 'gateway.probeModel' = 'text'
    'gateway.probeMaxTokens' = 'int:1:16'; 'gateway.anthropicVersion' = 'text'
    'testClient.appDisplayName' = 'text+token'; 'testClient.secretLifetimeHours' = 'int:1:24+token'; 'testClient.secretDisplayNamePrefix' = 'text+token'
    'resolver.functionAppName' = 'text'; 'resolver.functionName' = 'text'; 'resolver.url' = 'https'
    'cosmos.accountName' = 'text'; 'cosmos.databaseName' = 'text'; 'cosmos.containers' = 'list'
    'network.vnetName' = 'text'; 'network.foundryPrivateEndpointName' = 'text'; 'network.jumpboxNamePrefix' = 'text'
    'network.dnsCheckVmName' = 'optional'
}

function Get-LiveTestConfigValue($Config, [string]$Key) {
    $node = $Config
    foreach ($part in $Key -split '\.') {
        if ($null -eq $node -or -not ($node.PSObject.Properties.Name -contains $part)) { return $null }
        $node = $node.$part
    }
    , $node
}

function Set-LiveTestConfigValue($Config, [string]$Key, $Value) {
    $parts = $Key -split '\.'
    $node = $Config
    foreach ($part in @($parts | Select-Object -SkipLast 1)) {
        if (-not ($node.PSObject.Properties.Name -contains $part)) { $node | Add-Member -NotePropertyName $part -NotePropertyValue ([pscustomobject]@{}) }
        $node = $node.$part
    }
    $node | Add-Member -NotePropertyName $parts[-1] -NotePropertyValue $Value -Force
}

function Test-LiveTestConfigValue($Value, [string]$Rule) {
    $kind = $Rule -replace '\+token$', ''
    $placeholder = '<[^>]*>'
    if ($kind -eq 'optional') { return $null -eq $Value -or ($Value -is [string] -and $Value -notmatch $placeholder) }
    if ($kind -eq 'list') {
        return $Value -is [array] -and $Value.Count -gt 0 -and @($Value | Where-Object { $_ -isnot [string] -or -not $_.Trim() -or $_ -match $placeholder }).Count -eq 0
    }
    if ($kind -like 'int:*') {
        $null, $min, $max = $kind -split ':'
        return ($Value -is [int] -or $Value -is [long]) -and $Value -ge [int]$min -and $Value -le [int]$max
    }
    if ($Value -isnot [string] -or $Value -match $placeholder) { return $false }
    switch ($kind) {
        'guid' { return $Value -match '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$' }
        'https' { return $Value -match '^https://[^\s/]+(/\S*)?$' }
        'path' { return $Value -eq '' -or $Value -match '^/\S*$' }
        default { return [bool]$Value.Trim() }
    }
}

function Read-LiveTestConfig {
    param([Parameter(Mandatory)] [string]$Path, [hashtable]$Overrides = @{}, [switch]$RequireTokenSettings)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "live smoke configuration not found: $Path. Copy harness/live/live-config.example.json to .env.live-lab/ (or .env.live-customer/), fill it and pass -ConfigPath"
    }
    try { $config = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 16 } catch { throw "live smoke configuration is not valid JSON: $Path" }
    foreach ($key in $Overrides.Keys) { Set-LiveTestConfigValue $config $key $Overrides[$key] }
    $problems = foreach ($key in $script:LiveTestConfigKeys.Keys) {
        $rule = $script:LiveTestConfigKeys[$key]
        if ($rule.EndsWith('+token') -and -not $RequireTokenSettings) { continue }
        if (-not (Test-LiveTestConfigValue (Get-LiveTestConfigValue $config $key) $rule)) { "$key ($($rule -replace '\+token$', ''))" }
    }
    if ($problems) { throw "live smoke configuration $Path has missing or invalid values: $(@($problems) -join ', ')" }
    $config
}
