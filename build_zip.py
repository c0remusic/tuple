#!/usr/bin/env python3
"""Build site/tuple.zip — the downloadable Tuple device bundle.

Run from the repo root:  python build_zip.py
Then deploy site/tuple.zip via the tuple-site worktree (see CLAUDE.md).

Keep the device files validated in Max BEFORE rebuilding + deploying.
"""
import os
import re
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "site", "tuple.zip")

# (name inside the zip, source path relative to repo root)
FILES = [
    ("Tuple/tuple.amxd",                          "device/tuple.amxd"),
    ("Tuple/tuple_chord_engine.js",                "device/tuple_chord_engine.js"),
    ("Tuple/tuple_init_menus.js",                  "device/tuple_init_menus.js"),
    ("Tuple/tuple_live_key_observer.js",           "device/tuple_live_key_observer.js"),
    ("Tuple/tuple_midi_map.js",                    "device/tuple_midi_map.js"),
    ("Tuple/tuple_push2_spike.js",                 "device/tuple_push2_spike.js"),   # Push 2 (tuple_ prefix kills search-path collisions with old copies)
    ("Tuple/ui/tuple_ui.html",                     "device/ui/tuple_ui.html"),
    ("Tuple/ui/fonts/SpaceGrotesk-Variable.woff2", "device/ui/fonts/SpaceGrotesk-Variable.woff2"),
    ("Tuple/ui/fonts/Syne-Variable.woff2",         "device/ui/fonts/Syne-Variable.woff2"),
    ("Tuple/ui/fonts/JetBrainsMono-Variable.woff2","device/ui/fonts/JetBrainsMono-Variable.woff2"),
    ("Tuple/Tuple Manual.pdf",                     "manual/Tuple-Manual.pdf"),
]

CMD_SRC = os.path.join(ROOT, "installer", "Install Tuple.command")

missing = [src for _, src in FILES if not os.path.exists(os.path.join(ROOT, src))]
if not os.path.exists(CMD_SRC):
    missing.append("installer/Install Tuple.command")
if missing:
    raise SystemExit("MISSING source file(s):\n  " + "\n  ".join(missing))


def sync_version():
    """SINGLE SOURCE OF TRUTH = the VERSION file. Propagate it to every spot that shows
    the version, so a release = edit VERSION only, then run this script. No more 5-place
    hand-editing / device<->site drift."""
    ver = open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip()
    targets = [
        ("device/tuple_chord_engine.js",  r'(var TUPLE_VERSION = ")[^"]*(";)'),
        ("device/ui/tuple_ui.html",   r'(var LOCAL_VERSION = ")[^"]*(";)'),
        ("device/ui/tuple_ui.html", r'(<div class="ib-label">Version</div><div class="ib-val">)[^<]*(</div>)'),
        ("site/index.html",         r'(&middot; v)[0-9][0-9.]*(</span>)'),
        ("site/index.html",         r'("softwareVersion": ")[^"]*(",)'),
        ("installer/tuple.iss",     r'(#define AppVersion ")[^"]*(")')
    ]
    for rel, pat in targets:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            print("  SKIP: %s (local-only, not in repo)" % rel)
            continue
        s = open(p, encoding="utf-8").read()
        ns, n = re.subn(pat, r'\g<1>' + ver + r'\g<2>', s, count=1)
        if n == 0:
            print("  WARN: version anchor not found in " + rel)
        elif ns != s:
            with open(p, "w", encoding="utf-8", newline="") as f:
                f.write(ns)
            print("  synced %s -> %s" % (rel, ver))
    return ver


VERSION = sync_version()
print("VERSION (single source) = " + VERSION)

# Distribution = UNFROZEN .amxd + loose .js + ui/ folder (kept together). The device
# self-locates the UI via chord_engine.js's loadbang, which builds a cross-platform
# file:// URL (Windows C:/… -> file:///C:/… ; macOS /Users/… -> file:///Users/…).

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for arc, src in FILES:
        z.write(os.path.join(ROOT, src), arc)
    # .command at ZIP root — executable bit must survive macOS Archive Utility
    zi = zipfile.ZipInfo("Install Tuple.command")
    zi.external_attr = 0o755 << 16
    zi.compress_type = zipfile.ZIP_DEFLATED
    with open(CMD_SRC, "rb") as f:
        z.writestr(zi, f.read())

print("built " + OUT)
with zipfile.ZipFile(OUT) as z:
    for info in z.infolist():
        print("  %8d  %s" % (info.file_size, info.filename))
