# One-time current-user Native Messaging registration. It does not install the extension or change browser policies.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$NodePath,
    [switch]$PrepareOnly,
    [ValidateSet('Edge', 'Chrome', 'Both')]
    [string]$Browser = 'Edge'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$nativeHostName = 'com.geoguessr.reserved_seats'
$extensionManifestPath = Join-Path $PSScriptRoot 'extension\manifest.json'
$nativeScriptPath = Join-Path $PSScriptRoot 'native-host.mjs'
$dependencyPath = Join-Path $PSScriptRoot 'node_modules\ws\package.json'

if (-not (Test-Path -LiteralPath $nativeScriptPath -PathType Leaf)) { throw 'native-host.mjs was not found. Extract the complete package first.' }
if (-not (Test-Path -LiteralPath $dependencyPath -PathType Leaf)) { throw 'The bundled ws dependency was not found. Extract the complete package first.' }
$extensionManifest = Get-Content -LiteralPath $extensionManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not ($extensionManifest.PSObject.Properties.Name -contains 'key') -or -not ($extensionManifest.key -is [string])) {
    throw 'The extension manifest must contain its fixed public key.'
}
try { $publicKeyBytes = [Convert]::FromBase64String($extensionManifest.key) }
catch { throw 'The extension public key is invalid.' }
if ($publicKeyBytes.Length -lt 64 -or $publicKeyBytes.Length -gt 4096) { throw 'The extension public key is invalid.' }
$keyHasher = [System.Security.Cryptography.SHA256]::Create()
try { $keyHash = $keyHasher.ComputeHash($publicKeyBytes) }
finally { $keyHasher.Dispose() }
$extensionIdBuilder = New-Object System.Text.StringBuilder
for ($keyIndex = 0; $keyIndex -lt 16; $keyIndex++) {
    [void]$extensionIdBuilder.Append([char](97 + ($keyHash[$keyIndex] -shr 4)))
    [void]$extensionIdBuilder.Append([char](97 + ($keyHash[$keyIndex] -band 15)))
}
$extensionId = $extensionIdBuilder.ToString()

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $usualNodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path -LiteralPath $usualNodePath -PathType Leaf) { $NodePath = $usualNodePath }
    else {
        $nodeCommand = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $nodeCommand) { throw 'Node.js 20.3 or newer was not found. Install Node.js, then run this setup again.' }
        $NodePath = $nodeCommand.Source
    }
}
$resolvedNodePath = (Resolve-Path -LiteralPath $NodePath).ProviderPath
if (-not (Test-Path -LiteralPath $resolvedNodePath -PathType Leaf) -or [IO.Path]::GetFileName($resolvedNodePath) -ine 'node.exe') {
    throw 'NodePath must point to node.exe.'
}
# The ASCII launcher expands its own folder at runtime, so Japanese extraction paths work too.
# Refuse characters that can expand unexpectedly in the one literal executable path in cmd.exe.
if ($resolvedNodePath -cmatch '[%"\r\n\x00-\x1f\x7f-\uffff]') { throw 'The Node.js executable path contains characters unsupported by this launcher. Use the standard Node.js installation path.' }
$runtimeVersionText = (& $resolvedNodePath --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $runtimeVersionText -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { throw 'Could not verify the Node.js runtime.' }
$runtimeMajor = [int]$Matches[1]
$runtimeMinor = [int]$Matches[2]
if ($runtimeMajor -lt 20 -or ($runtimeMajor -eq 20 -and $runtimeMinor -lt 3)) { throw 'Node.js 20.3 or newer is required.' }

$nativeDirectory = Join-Path $PSScriptRoot 'native-messaging'
$launcherPath = Join-Path $nativeDirectory 'launch-native-host.cmd'
$nativeManifestPath = Join-Path $nativeDirectory ($nativeHostName + '.json')
$nativeManifest = [ordered]@{
    name = $nativeHostName
    description = 'GeoGuessr isolated reserved guest seats'
    path = $launcherPath
    type = 'stdio'
    allowed_origins = @('chrome-extension://' + $extensionId + '/')
}
$launcherText = "@echo off`r`nsetlocal DisableDelayedExpansion`r`n`"$resolvedNodePath`" `"%~dp0..\native-host.mjs`" %*`r`n"

if ($PSCmdlet.ShouldProcess($nativeDirectory, 'Write the local Native Messaging launcher and manifest')) {
    [void](New-Item -ItemType Directory -Path $nativeDirectory -Force)
    [IO.File]::WriteAllText($launcherPath, $launcherText, [Text.Encoding]::ASCII)
    $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($nativeManifestPath, ($nativeManifest | ConvertTo-Json -Depth 4), $utf8WithoutBom)
}

$registrationTargets = @()
if ($Browser -in @('Edge', 'Both')) {
    $registrationTargets += @{ name = 'Microsoft Edge'; subkey = 'Software\Microsoft\Edge\NativeMessagingHosts\' + $nativeHostName }
}
if ($Browser -in @('Chrome', 'Both')) {
    $registrationTargets += @{ name = 'Google Chrome'; subkey = 'Software\Google\Chrome\NativeMessagingHosts\' + $nativeHostName }
}
foreach ($registrationTarget in $registrationTargets) {
    if (-not $PrepareOnly -and $PSCmdlet.ShouldProcess(('HKCU\' + $registrationTarget.subkey), ('Register this host for the current user in ' + $registrationTarget.name))) {
        $registryKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($registrationTarget.subkey)
        try { $registryKey.SetValue('', $nativeManifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
        finally { $registryKey.Dispose() }
    }
}

Write-Output ('Extension ID: ' + $extensionId)
if ($WhatIfPreference) { Write-Output 'Preview complete. No files or registration were changed.' }
elseif ($PrepareOnly) { Write-Output 'Launcher prepared. Registry registration was skipped.' }
elseif ($Browser -eq 'Edge') { Write-Output 'Edge Native Messaging host registered for this Windows user. Load the extension folder once, then use its seat-count setting.' }
elseif ($Browser -eq 'Chrome') { Write-Output 'Chrome Native Messaging host registered for this Windows user. Load the extension folder once, then use its seat-count setting.' }
else { Write-Output 'Edge and Chrome Native Messaging hosts registered for this Windows user. Load the extension folder once, then use its seat-count setting.' }
Write-Output 'Keep this extracted folder in place. Moving it requires running setup again.'
