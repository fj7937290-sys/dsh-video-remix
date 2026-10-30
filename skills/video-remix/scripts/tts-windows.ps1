param(
  [string]$TextFile,
  [string]$OutFile,
  [string]$Voice = '',
  [switch]$List
)

# Offline Windows speech via the modern WinRT API.
# The legacy SAPI interface only exposes 2 voices; WinRT exposes the OneCore
# voices too (Huihui / Yaoyao / Kangkang on a zh-CN Windows).

Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]

function Await($task, $type) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $netTask = $asTask.MakeGenericMethod($type).Invoke($null, @($task))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

$all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices

if ($List) {
  foreach ($v in $all) {
    Write-Output ("{0}|{1}|{2}" -f $v.DisplayName, $v.Language, $v.Gender)
  }
  exit 0
}

if (-not $TextFile -or -not $OutFile) {
  Write-Error 'need -TextFile and -OutFile'
  exit 2
}
if (-not (Test-Path -LiteralPath $TextFile)) {
  Write-Error "text file not found: $TextFile"
  exit 2
}

$text = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $TextFile), [System.Text.Encoding]::UTF8)
if (-not $text.Trim()) {
  Write-Error 'text file is empty'
  exit 2
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
if ($Voice) {
  $picked = $all | Where-Object { $_.DisplayName -like "*$Voice*" } | Select-Object -First 1
  if ($picked) { $synth.Voice = $picked }
}

$stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$size = [int]$stream.Size
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$null = Await ($reader.LoadAsync([uint32]$size)) ([uint32])
$buffer = New-Object byte[] $size
$reader.ReadBytes($buffer)

$outDir = Split-Path -Parent $OutFile
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}
[System.IO.File]::WriteAllBytes($OutFile, $buffer)

$reader.Dispose()
$synth.Dispose()
Write-Output ("OK|{0}|{1}" -f $OutFile, $size)
