# Runs Jay-C on a connected Android device or emulator (`tauri android dev`), after reloading PATH
# and the Android variables from the registry (terminals opened before installing the SDK lack them).
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($k in 'JAVA_HOME', 'ANDROID_HOME', 'NDK_HOME') {
  $value = [Environment]::GetEnvironmentVariable($k, 'User')
  if ($value) { Set-Item "env:$k" $value }
}
$env:Path = "$env:ANDROID_HOME\platform-tools;$env:Path"
Set-Location (Join-Path (Split-Path $PSScriptRoot -Parent) 'frontend')
npx tauri android dev @args
