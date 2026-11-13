# Builds the signed AutoDeck APK on this PC, with Android Studio's Java and the SDK installed on E:.
# Run: npm run android:apk      (about 1-7 minutes; the first run downloads Gradle's files)
# Output: C:\Users\HP\Downloads\AutoDeck Android\AutoDeck-<version>.apk
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sign = "C:\Users\HP\Documents\AutoDeck-Android-Signing"   # the signing key; keep it safe, every APK must use it
$out = "C:\Users\HP\Downloads\AutoDeck Android"

$ver = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version
$a, $b, $c = $ver.Split('.') | ForEach-Object { [int]$_ }
$pw = ((Get-Content "$sign\README-keep-safe.txt" | Where-Object { $_ -like 'password:*' }) -replace '^password:\s*', '').Trim()

$env:JAVA_HOME = 'E:\Android\jdk-21'                          # Java 21: Gradle here can't read Android Studio's Java 25
$env:ANDROID_HOME = $env:ANDROID_SDK_ROOT = 'E:\Android\Sdk'
$env:ANDROID_USER_HOME = 'E:\Android\.android'
$env:GRADLE_USER_HOME = 'E:\Android\gradle-home'            # keeps Gradle's big caches off the C: drive
$env:ANDROID_VERSION_NAME = $ver
$env:ANDROID_VERSION_CODE = [string]($a * 10000 + $b * 100 + $c)   # same rule as the GitHub workflow
$env:KEYSTORE_FILE = "$sign\autodeck-release.keystore"
$env:KEYSTORE_PASSWORD = $pw; $env:KEY_ALIAS = 'autodeck'; $env:KEY_PASSWORD = $pw

Set-Location $root
npm run build
npx cap sync android
Set-Location "$root\android"
.\gradlew.bat assembleRelease --no-daemon
if ($LASTEXITCODE -ne 0) { throw "Gradle failed" }

New-Item -ItemType Directory -Force $out | Out-Null
$apk = "$out\AutoDeck-$ver.apk"
Copy-Item "$root\android\app\build\outputs\apk\release\app-release.apk" $apk -Force
Write-Host "APK ready: $apk"

