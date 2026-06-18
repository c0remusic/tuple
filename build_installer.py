#!/usr/bin/env python3
"""Build site/Tuple-Installer-vX.Y.Z.exe (Windows only).

Prerequisites: Inno Setup 6 — https://jrsoftware.org/isdl.php
Run from repo root: python build_installer.py
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ISS  = os.path.join(ROOT, "installer", "tuple.iss")

ISCC_CANDIDATES = [
    r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    r"C:\Program Files\Inno Setup 6\ISCC.exe",
]

def find_iscc():
    for p in ISCC_CANDIDATES:
        if os.path.isfile(p):
            return p
    return None

def main():
    iscc = find_iscc()
    if not iscc:
        print("ERROR: Inno Setup 6 not found.")
        print("Install from: https://jrsoftware.org/isdl.php")
        sys.exit(1)

    ver = open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip()
    print("Building Tuple-Installer-v%s.exe ..." % ver)

    result = subprocess.run([iscc, ISS], capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stdout[-3000:] if result.stdout else "")
        print(result.stderr[-1000:] if result.stderr else "")
        sys.exit(result.returncode)

    out = os.path.join(ROOT, "site", "Tuple-Installer-v%s.exe" % ver)
    if os.path.isfile(out):
        size_kb = os.path.getsize(out) // 1024
        print("built %s (%d KB)" % (os.path.basename(out), size_kb))
    else:
        print("Inno reported success but output not found at: " + out)
        sys.exit(1)

if __name__ == "__main__":
    main()
