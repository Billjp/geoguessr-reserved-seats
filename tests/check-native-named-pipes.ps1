# Windows/PowerShell 7 diagnostic only: status + shutdown, no GeoGuessr requests.
[CmdletBinding()]
param(
    [ValidateRange(1000, 30000)][int]$TimeoutMs = 15000,
    [switch]$StdoutNull
)

$ErrorActionPreference = 'Stop'
$script:Diagnostic = 'UNEXPECTED_FAILURE'
$inputPipe = $null
$outputPipe = $null
$child = $null
$clock = [System.Diagnostics.Stopwatch]::StartNew()

function Fail-Diagnostic([string]$Code) {
    $script:Diagnostic = $Code
    throw 'Native named-pipe diagnostic failed.'
}

function Remaining-Milliseconds {
    $remaining = $TimeoutMs - [int]$clock.ElapsedMilliseconds
    if ($remaining -le 0) { Fail-Diagnostic 'DEADLINE_EXCEEDED' }
    return $remaining
}

function Wait-Task($Task, [string]$Code) {
    try { $done = $Task.Wait((Remaining-Milliseconds)) }
    catch { Fail-Diagnostic $Code }
    if (-not $done) { Fail-Diagnostic $Code }
}

function Send-Frame($Pipe, [string]$RequestId, [string]$Action) {
    $payload = [Text.Encoding]::UTF8.GetBytes((@{ requestId = $RequestId; action = $Action } | ConvertTo-Json -Compress))
    $frame = [byte[]]::new(4 + $payload.Length)
    [BitConverter]::GetBytes([uint32]$payload.Length).CopyTo($frame, 0)
    $payload.CopyTo($frame, 4)
    Wait-Task ($Pipe.WriteAsync($frame, 0, $frame.Length)) 'PIPE_WRITE_FAILED'
    Wait-Task ($Pipe.FlushAsync()) 'PIPE_FLUSH_FAILED'
}

function Read-Exact($Pipe, [int]$Length) {
    $buffer = [byte[]]::new($Length)
    $offset = 0
    while ($offset -lt $Length) {
        $read = $Pipe.ReadAsync($buffer, $offset, $Length - $offset)
        Wait-Task $read 'PIPE_READ_FAILED'
        $count = $read.Result
        if ($count -le 0) { Fail-Diagnostic 'PIPE_EOF_BEFORE_REPLY' }
        $offset += $count
    }
    return ,$buffer
}

function Read-Reply($Pipe) {
    $header = Read-Exact $Pipe 4
    $length = [BitConverter]::ToUInt32($header, 0)
    if ($length -lt 1 -or $length -gt 131072) { Fail-Diagnostic 'FRAME_LENGTH_REJECTED' }
    $payload = Read-Exact $Pipe ([int]$length)
    try {
        $encoding = [Text.UTF8Encoding]::new($false, $true)
        return ($encoding.GetString($payload) | ConvertFrom-Json)
    } catch { Fail-Diagnostic 'FRAME_JSON_REJECTED' }
}

try {
    if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { Fail-Diagnostic 'WINDOWS_POWERSHELL7_REQUIRED' }
    $packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $launcher = [IO.Path]::GetFullPath((Join-Path $packageRoot 'native-messaging\launch-native-host.cmd'))
    $manifestPath = Join-Path $packageRoot 'native-messaging\com.geoguessr.reserved_seats.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.name -ne 'com.geoguessr.reserved_seats' -or $manifest.type -ne 'stdio' -or
        [IO.Path]::GetFullPath($manifest.path) -ne $launcher -or
        -not (Test-Path -LiteralPath $launcher -PathType Leaf) -or
        $launcher -match '["%\r\n&|<>^]' -or
        -not ($manifest.allowed_origins -is [Array]) -or $manifest.allowed_origins.Count -lt 1 -or
        $manifest.allowed_origins.Count -gt 8 -or
        $manifest.allowed_origins[0] -cnotmatch '^chrome-extension://[a-p]{32}/$') {
        Fail-Diagnostic 'LOCAL_MANIFEST_REJECTED'
    }
    $origin = $manifest.allowed_origins[0]
    $suffix = [Guid]::NewGuid().ToString('N')
    $inName = "geoguessr-native-test-$suffix-in"
    $outName = "geoguessr-native-test-$suffix-out"
    $options = [IO.Pipes.PipeOptions]::Asynchronous -bor [IO.Pipes.PipeOptions]::CurrentUserOnly
    # Chromium creates the input handle as a server writer and output as a reader.
    $inputPipe = [IO.Pipes.NamedPipeServerStream]::new($inName, [IO.Pipes.PipeDirection]::Out, 1,
        [IO.Pipes.PipeTransmissionMode]::Byte, $options, 4096, 4096)
    $inputConnected = $inputPipe.WaitForConnectionAsync()
    if (-not $StdoutNull) {
        $outputPipe = [IO.Pipes.NamedPipeServerStream]::new($outName, [IO.Pipes.PipeDirection]::In, 1,
            [IO.Pipes.PipeTransmissionMode]::Byte, $options, 4096, 4096)
        $outputConnected = $outputPipe.WaitForConnectionAsync()
    }

    $inputPath = "\\.\pipe\$inName"
    $outputPath = if ($StdoutNull) { 'nul' } else { "\\.\pipe\$outName" }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'cmd.exe'
    # Only the validated local launcher, fixed action arguments, and generated
    # pipe names enter CMD. No cookies, browser state, or tokens are read.
    $startInfo.Arguments = '/d /s /c ""{0}" {1} --parent-window=0" < {2} > {3} 2>nul' -f $launcher, $origin, $inputPath, $outputPath
    $startInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($launcher)
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $child = [Diagnostics.Process]::Start($startInfo)
    if ($null -eq $child) { Fail-Diagnostic 'CHILD_START_FAILED' }
    Wait-Task $inputConnected 'INPUT_CONNECT_FAILED'
    if (-not $StdoutNull) { Wait-Task $outputConnected 'OUTPUT_CONNECT_FAILED' }

    Send-Frame $inputPipe 'named_status' 'status'
    if (-not $StdoutNull) {
        $status = Read-Reply $outputPipe
        if ($status.requestId -ne 'named_status' -or $status.ok -ne $true -or
            $status.result.ready -ne $true -or @($status.result.seats).Count -ne 0) { Fail-Diagnostic 'STATUS_REJECTED' }
    }
    Send-Frame $inputPipe 'named_shutdown' 'shutdown'
    if (-not $StdoutNull) {
        $shutdown = Read-Reply $outputPipe
        if ($shutdown.requestId -ne 'named_shutdown' -or $shutdown.ok -ne $true -or
            $shutdown.result.stopped -ne $true) { Fail-Diagnostic 'SHUTDOWN_REJECTED' }
    }
    if (-not $child.WaitForExit((Remaining-Milliseconds))) { Fail-Diagnostic 'CHILD_EXIT_TIMEOUT' }
    if ($child.ExitCode -ne 0) { Fail-Diagnostic 'CHILD_EXIT_NONZERO' }
    $script:Diagnostic = if ($StdoutNull) { 'STDOUT_NUL_EXIT_OK' } else { 'NAMED_PIPES_STATUS_SHUTDOWN_OK' }
    Write-Output "PASS $script:Diagnostic"
    $result = 0
} catch {
    Write-Output "FAIL $script:Diagnostic"
    $result = 1
} finally {
    if ($null -ne $inputPipe) { try { $inputPipe.Dispose() } catch {} }
    if ($null -ne $outputPipe) { try { $outputPipe.Dispose() } catch {} }
    if ($null -ne $child) {
        try { if (-not $child.HasExited) { $child.Kill($true); $null = $child.WaitForExit(2000) } } catch {}
        $child.Dispose()
    }
    $clock.Stop()
}
exit $result
