# Regenerates docs/screenshot.png from tools/screenshot/demo.html using headless Chrome.
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$chrome = foreach ($dir in $env:ProgramW6432, $env:ProgramFiles) {
  "$dir\Google\Chrome\Application\chrome.exe"
  "$dir\BraveSoftware\Brave-Browser\Application\brave.exe"
}
$chrome = $chrome | Where-Object { Test-Path $_ } | Select-Object -First 1
New-Item -ItemType Directory -Force (Join-Path $root 'docs') | Out-Null
$out = Join-Path $root 'docs\screenshot.png'
$page = 'file:///' + ((Join-Path $root 'tools\screenshot\demo.html') -replace '\\', '/')
& $chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 `
  --window-size=924,640 --virtual-time-budget=1000 --screenshot="$out" $page 2>$null
Write-Output $out
