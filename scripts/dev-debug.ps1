# Starts `npm run dev` with WebView2 remote debugging on port 9222, so scripts/cdp-eval.mjs can
# drive the real app. Also reloads PATH and the Android variables from the registry, for terminals
# opened before the tools were installed.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($k in 'JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME') {
  $value = [Environment]::GetEnvironmentVariable($k, 'User')
  if ($value) { Set-Item "env:$k" $value }
}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
Set-Location (Split-Path $PSScriptRoot -Parent)
npm run dev
