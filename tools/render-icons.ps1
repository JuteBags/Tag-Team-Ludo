# Renders the launcher icons and splash screens into android/app/src/main/res
# from assets/icon-background.svg and assets/icon-foreground.svg, using headless Edge.
# Run after changing the icon SVGs:  powershell -File tools/render-icons.ps1
$root = Split-Path $PSScriptRoot -Parent
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$page = ([Uri](Join-Path $root 'assets\render.html')).AbsoluteUri
$res = Join-Path $root 'android\app\src\main\res'

function Render($variant, $w, $h, $out) {
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  # Headless Edge has a minimum window width, so small images are drawn large and scaled down.
  $k = [Math]::Max(1, [Math]::Ceiling(800 / [Math]::Min($w, $h)))
  & $edge --headless=new --disable-gpu --hide-scrollbars "--force-device-scale-factor=$(1 / $k)" --default-background-color=00000000 `
    "--window-size=$($w * $k),$($h * $k)" --virtual-time-budget=2000 "--screenshot=$out" "$page#$variant" 2>$null | Out-Null
}

# Launcher icons: legacy 48dp, adaptive layers 108dp.
$densities = @{ mdpi = 1; hdpi = 1.5; xhdpi = 2; xxhdpi = 3; xxxhdpi = 4 }
foreach ($d in $densities.Keys) {
  $legacy = [int](48 * $densities[$d]); $layer = [int](108 * $densities[$d])
  Render 'legacy' $legacy $legacy "$res\mipmap-$d\ic_launcher.png"
  Render 'round' $legacy $legacy "$res\mipmap-$d\ic_launcher_round.png"
  Render 'foreground' $layer $layer "$res\mipmap-$d\ic_launcher_foreground.png"
  Render 'background' $layer $layer "$res\mipmap-$d\ic_launcher_background.png"
}

# Splash images: keep each existing file's size.
Add-Type -AssemblyName System.Drawing
Get-ChildItem $res -Recurse -Filter splash.png | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName); $w = $img.Width; $h = $img.Height; $img.Dispose()
  Render 'splash' $w $h $_.FullName
}

# Store / website icon.
Render 'icon' 512 512 (Join-Path $root 'assets\icon-512.png')
Write-Host 'Icons and splash screens rendered.'
