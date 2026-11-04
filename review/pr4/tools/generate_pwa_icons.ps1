param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\web\icons")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

function Write-PwaIcon {
    param([int]$Size)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::FromArgb(47, 109, 246))

        # The motif stays inside the central maskable safe zone.
        $ringDiameter = $Size * 0.42
        $ringX = ($Size - $ringDiameter) / 2
        $ringY = ($Size - $ringDiameter) / 2
        $ringWidth = [Math]::Max(3, $Size * 0.055)
        $ringPen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, $ringWidth)
        try {
            $graphics.DrawEllipse($ringPen, $ringX, $ringY, $ringDiameter, $ringDiameter)
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

        $path = Join-Path $OutputDirectory "icon-$Size.png"
        $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

180, 192, 512 | ForEach-Object { Write-PwaIcon -Size $_ }
