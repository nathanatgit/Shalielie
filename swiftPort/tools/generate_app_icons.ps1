param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\Resources\Assets.xcassets\AppIcon.appiconset")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

function Write-StylePortIcon {
    param([int]$Size)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::FromArgb(47, 109, 246))

        $ringDiameter = $Size * 0.42
        $ringWidth = [Math]::Max(2, $Size * 0.055)
        $ringPen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, $ringWidth)
        try {
            $graphics.DrawEllipse(
                $ringPen,
                ($Size - $ringDiameter) / 2,
                ($Size - $ringDiameter) / 2,
                $ringDiameter,
                $ringDiameter
            )
        } finally {
            $ringPen.Dispose()
        }

        $dotDiameter = $Size * 0.15
        $dotBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
        try {
            $graphics.FillEllipse(
                $dotBrush,
                ($Size - $dotDiameter) / 2,
                ($Size - $dotDiameter) / 2,
                $dotDiameter,
                $dotDiameter
            )
        } finally {
            $dotBrush.Dispose()
        }

        $bitmap.Save(
            (Join-Path $OutputDirectory "icon-$Size.png"),
            [System.Drawing.Imaging.ImageFormat]::Png
        )
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

16, 32, 64, 128, 256, 512, 1024 | ForEach-Object { Write-StylePortIcon -Size $_ }
