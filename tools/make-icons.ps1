# Generates the toolbar icons in src/icons.
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\src\icons'
New-Item -ItemType Directory -Force $out | Out-Null
foreach ($size in 16, 32, 48, 128) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 79, 140, 255))
  $g.FillEllipse($bg, 0, 0, $size - 1, $size - 1)
  $font = New-Object System.Drawing.Font 'Segoe UI', ($size * 0.55), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF 0, ($size * 0.03), $size, $size
  $g.DrawString([string][char]0x266A, $font, [System.Drawing.Brushes]::White, $rect, $fmt)
  $bmp.Save((Join-Path $out "$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
