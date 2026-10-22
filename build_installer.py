#!/usr/bin/env python3
"""Build site/Tuple-Installer-vX.Y.Z.exe (Windows only).

Prerequisites: Inno Setup 6 or 7 — https://jrsoftware.org/isdl.php
Run from repo root: python build_installer.py
"""
import hashlib
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ISS  = os.path.join(ROOT, "installer", "tuple.iss")
PANEL = os.path.join(ROOT, "installer", "wizard_panel.png")

ISCC_CANDIDATES = [
    r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    r"C:\Program Files\Inno Setup 6\ISCC.exe",
    r"C:\Program Files (x86)\Inno Setup 7\ISCC.exe",
    r"C:\Program Files\Inno Setup 7\ISCC.exe",
]

def find_iscc():
    for p in ISCC_CANDIDATES:
        if os.path.isfile(p):
            return p
    return None

def _regen_panel(ver):
    """Regenerate installer/wizard_panel.png with current version via PowerShell System.Drawing."""
    ps = r"""
Add-Type -AssemblyName System.Drawing
$w=164; $h=314
$bmp=New-Object System.Drawing.Bitmap($w,$h)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint=[System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(20,20,20))),0,0,$w,$h)
$sf=New-Object System.Drawing.StringFormat
$sf.Alignment=[System.Drawing.StringAlignment]::Center
$sf.LineAlignment=[System.Drawing.StringAlignment]::Center
$g.DrawString("Tuple",(New-Object System.Drawing.Font("Arial",34,[System.Drawing.FontStyle]::Bold)),(New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,220,130))),(New-Object System.Drawing.RectangleF(0,100,164,52)),$sf)
$g.DrawLine((New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(153,255,220,130),1)),62,165,102,165)
$g.DrawString("Max for Live",(New-Object System.Drawing.Font("Arial",9)),(New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(140,237,233,224))),(New-Object System.Drawing.RectangleF(0,174,164,22)),$sf)
$g.DrawString("v{VER}",(New-Object System.Drawing.Font("Arial",8)),(New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(100,142,204,232))),(New-Object System.Drawing.RectangleF(0,290,164,18)),$sf)
$bmp.Save("{PANEL}",[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
""".replace("{VER}", ver).replace("{PANEL}", PANEL.replace("\\", "\\\\"))
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print("WARN: wizard_panel.png regen failed — using existing file")
        print(result.stderr[-500:] if result.stderr else "")
    else:
        print("  wizard_panel.png regenerated (v%s)" % ver)

def _write_sha256_sidecar(path):
    """Writes <path>.sha256 next to the file - plain hex digest, no filename.

    WHY THIS EXISTS. build_zip.py writes a sidecar for each zip it builds, but
    nothing wrote one for the installer: Tuple-Installer.exe.sha256 was last
    touched on 2026-08-12 and still held the digest of an .exe from that day.
    Measured 2026-09-16, right after a rebuild:

        sidecar  37dfd2d2a68d37a927a0261890b78801593755181c0d6abad7b824b69e9422aa
        real exe 5f05dcd6a4c8cf4b6628f31a2c1a64e85b513ec2f1788af690767e0b9ffc9dcd

    A stale digest is worse than a missing one: anyone verifying the download
    concludes the file was corrupted or tampered with, and the auto-updater checks
    these digests. The sidecar is now written by whoever builds the file, which is
    the only place that can keep it true.
    """
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    digest = h.hexdigest()
    sidecar = path + ".sha256"
    with open(sidecar, "w", encoding="utf-8", newline="\n") as f:
        f.write(digest + "\n")
    print("  sha256 " + digest + "  -> " + sidecar)


def main():
    iscc = find_iscc()
    if not iscc:
        print("ERROR: Inno Setup 6 not found.")
        print("Install from: https://jrsoftware.org/isdl.php")
        sys.exit(1)

    if not os.path.isfile(ISS):
        print("ERROR: installer/tuple.iss not found — run from repo root")
        sys.exit(1)

    with open(os.path.join(ROOT, "VERSION"), encoding="utf-8") as f:
        ver = f.read().strip()

    _regen_panel(ver)
    print("Building Tuple-Installer.exe (v%s) ..." % ver)

    result = subprocess.run([iscc, ISS], capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stdout[-3000:] if result.stdout else "")
        print(result.stderr[-1000:] if result.stderr else "")
        sys.exit(result.returncode)

    out = os.path.join(ROOT, "site", "Tuple-Installer.exe")
    if os.path.isfile(out):
        size_kb = os.path.getsize(out) // 1024
        print("built %s (%d KB)" % (os.path.basename(out), size_kb))
        _write_sha256_sidecar(out)
    else:
        print("Inno reported success but output not found at: " + out)
        sys.exit(1)

if __name__ == "__main__":
    main()
