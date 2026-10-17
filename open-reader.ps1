# PDF 划词翻译 —— 自带阅读器启动器
#
# 作用：打开扩展自带的 PDF 阅读器页面 chrome-extension://<扩展ID>/src/viewer.html
#
# 扩展 ID 的由来：未打包扩展的 ID = SHA-256(扩展目录的 UTF-16LE 路径) 的前 16 字节，
# 再把每个十六进制位映射成 a-p。这里直接按当前脚本所在目录算出来，
# 所以扩展目录被移动/重新解压到别处也能用（前提是浏览器里加载的是同一个目录）。
#
# 可选：把 PDF 文件拖到本脚本（或桌面快捷方式）上，会带上 ?file= 参数直接打开该文件。
#       （file:// 读取需要在扩展详情页打开「允许访问文件网址」，否则请把文件拖进阅读器窗口）

#Requires -Version 7.0
param(
  [switch]$PrintUrl,
  [ValidateSet('Chrome', 'Edge')]
  [string]$Browser = 'Chrome',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Files
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$here = (Resolve-Path -LiteralPath $here).Path.TrimEnd('\')

function Get-ExtensionId([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [System.Text.Encoding]::Unicode.GetBytes($path)   # UTF-16LE
  $hash = $sha.ComputeHash($bytes)
  $hex = -join ($hash[0..15] | ForEach-Object { '{0:x2}' -f $_ })
  return (-join ($hex.ToCharArray() | ForEach-Object { [char]([Convert]::ToInt32($_, 16) + 97) }))
}

$id = Get-ExtensionId $here
$url = "chrome-extension://$id/src/viewer.html"

# 拖进来的 PDF → 带上 ?file=
$dropped = $null
if ($Files -and $Files.Count -gt 0) {
  foreach ($candidate in $Files) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $dropped = $candidate; break }
  }
}
if ($dropped) {
  $full = (Resolve-Path -LiteralPath $dropped).Path -replace '\\', '/'
  $url += '?file=' + [uri]::EscapeDataString("file:///$full")
}

# 默认使用 Chrome，不跟随系统默认浏览器；Edge 用户可显式传入 -Browser Edge。
$relativeExe = if ($Browser -eq 'Edge') { 'Microsoft\Edge\Application\msedge.exe' } else { 'Google\Chrome\Application\chrome.exe' }
$browserExe = $null
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
  if (-not $base) { continue }
  $candidate = Join-Path $base $relativeExe
  if (Test-Path -LiteralPath $candidate -PathType Leaf) { $browserExe = $candidate; break }
}

if ($PrintUrl) {
  Write-Output "ID   : $id"
  Write-Output "URL  : $url"
  Write-Output "浏览器: $(if ($browserExe) { $browserExe } else { "(未找到 $Browser)" })"
  exit 0
}

if (-not $browserExe) { throw "未找到 $Browser，请先安装该浏览器，或通过 -Browser 指定已安装的浏览器。" }
Start-Process -FilePath $browserExe -ArgumentList $url

# 检测扩展是否已经加载过：只做一次宽松的文本匹配（不做 JSON 解析，避免大文件卡顿/报错）
$installed = $false
$relativeData = if ($Browser -eq 'Edge') { 'Microsoft\Edge\User Data' } else { 'Google\Chrome\User Data' }
$roots = @((Join-Path $env:LOCALAPPDATA $relativeData))
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  foreach ($prof in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
    if ($prof.Name -ne 'Default' -and $prof.Name -notlike 'Profile *') { continue }
    foreach ($name in @('Preferences', 'Secure Preferences')) {
      $pref = Join-Path $prof.FullName $name
      if (-not (Test-Path -LiteralPath $pref)) { continue }
      try {
        $text = [System.IO.File]::ReadAllText($pref)
        if ($text.IndexOf($id, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
          $installed = $true
          break
        }
      } catch { }
    }
    if ($installed) { break }
  }
  if ($installed) { break }
}

if (-not $installed) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $msg = "看起来扩展还没有在 $Browser 里加载，所以刚打开的页面可能是错误页。`n`n请在扩展管理页点「加载已解压的扩展程序」，选择这个文件夹：`n$here`n`n加载完成后，再双击一次桌面快捷方式即可。"
    [System.Windows.Forms.MessageBox]::Show($msg, 'PDF 划词翻译', 'OK', 'Information') | Out-Null
    $extPage = 'chrome://extensions/'
    if ($Browser -eq 'Edge') { $extPage = 'edge://extensions/' }
    Start-Process -FilePath $browserExe -ArgumentList $extPage
  } catch { }
}
