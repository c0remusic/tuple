#!/usr/bin/env python3
"""Build site/tuple.zip — the downloadable Tuple device bundle.

Run from the repo root:  python build_zip.py
Then deploy site/tuple.zip via the tuple-site worktree (see CLAUDE.md).

Keep the device files validated in Max BEFORE rebuilding + deploying.
"""
import hashlib
import json
import os
import re
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT     = os.path.join(ROOT, "site", "tuple.zip")
OUT_MAC = os.path.join(ROOT, "site", "tuple-mac.zip")

# (name inside the zip, source path relative to repo root)
FILES = [
    ("Tuple/tuple.amxd",                          "device/tuple.amxd"),
    ("Tuple/tuple_chord_engine.js",                "device/tuple_chord_engine.js"),
    ("Tuple/tuple_init_menus.js",                  "device/tuple_init_menus.js"),
    ("Tuple/tuple_live_key_observer.js",           "device/tuple_live_key_observer.js"),
    ("Tuple/tuple_midi_map.js",                    "device/tuple_midi_map.js"),
    ("Tuple/tuple_push2_spike.js",                 "device/tuple_push2_spike.js"),   # Push 2 (tuple_ prefix kills search-path collisions with old copies)
    ("Tuple/tuple_dl.js",                          "device/tuple_dl.js"),            # Auto-updater download helper (node.script)
    ("Tuple/ui/tuple_ui.html",                     "device/ui/tuple_ui.html"),
    ("Tuple/ui/fonts/SpaceGrotesk-Variable.woff2", "device/ui/fonts/SpaceGrotesk-Variable.woff2"),
    ("Tuple/ui/fonts/Syne-Variable.woff2",         "device/ui/fonts/Syne-Variable.woff2"),
    ("Tuple/ui/fonts/JetBrainsMono-Variable.woff2","device/ui/fonts/JetBrainsMono-Variable.woff2"),
    ("Tuple/Tuple Manual.pdf",                     "manual/Tuple-Manual.pdf"),
]

CMD_SRC = os.path.join(ROOT, "installer", "Install Tuple.command")

def sha256_file(path):
    """SHA256 hex digest of a file, streamed (safe for large binaries)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def write_sha256_sidecar(path):
    """Writes <path>.sha256 next to the file (plain hex digest, no filename —
    matches the format tuple_dl.js expects). Used for release integrity checks
    (see docs/decisions.md § auto-updater checksum verification)."""
    digest = sha256_file(path)
    sidecar = path + ".sha256"
    with open(sidecar, "w", encoding="utf-8") as f:
        f.write(digest)
    print("  sha256 " + digest + "  -> " + sidecar)
    return digest


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
    # critical=True targets drive the in-device auto-updater (engine + UI version
    # strings) — a silently-missed anchor there can ship a release with a stale
    # version and desync the updater (see docs/decisions.md, release-amxd-requires-
    # reinstall). Site/installer targets stay WARN-only: cosmetic, not update-critical.
    targets = [
        ("device/tuple_chord_engine.js",  r'(var TUPLE_VERSION = ")[^"]*(";)', True),
        ("device/ui/tuple_ui.html",   r'(var LOCAL_VERSION = ")[^"]*(";)', True),
        ("device/ui/tuple_ui.html", r'(<div class="ib-label">Version</div><div class="ib-val">)[^<]*(</div>)', False),
        ("site/index.html",         r'(&middot; v)[0-9][0-9.]*(</span>)', False),
        ("site/index.html",         r'("softwareVersion": ")[^"]*(",)', False),
        ("site/manual/index.html",  r'(<div>Version<b>v)[0-9][0-9.]*(</b></div>)', False),
        ("installer/tuple.iss",     r'(#define AppVersion ")[^"]*(")', False)
    ]
    for rel, pat, critical in targets:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            if critical:
                raise SystemExit("FATAL: critical version target missing: " + rel)
            print("  SKIP: %s (not in device repo)" % rel)
            continue
        s = open(p, encoding="utf-8").read()
        ns, n = re.subn(pat, r'\g<1>' + ver + r'\g<2>', s, count=1)
        if n == 0:
            if critical:
                raise SystemExit("FATAL: version anchor not found in " + rel + " — auto-updater would ship a stale version")
            print("  WARN: version anchor not found in " + rel)
        elif ns != s:
            with open(p, "w", encoding="utf-8", newline="") as f:
                f.write(ns)
            print("  synced %s -> %s" % (rel, ver))
    return ver


VERSION = sync_version()
print("VERSION (single source) = " + VERSION)

# version.json — uploaded as a separate release asset next to tuple.zip. The device
# UI fetches it (checkForUpdates) to decide in-place update vs installer.
# requires_reinstall defaults to False; flip it to True for a release whose .amxd
# changed structurally (Windows can't replace the locked .amxd in place).
REQUIRES_REINSTALL = os.environ.get("TUPLE_REQUIRES_REINSTALL", "0") == "1"
VERSION_JSON = os.path.join(ROOT, "site", "version.json")
os.makedirs(os.path.dirname(VERSION_JSON), exist_ok=True)  # site/ is local-only (device-only repo) -> absent on CI checkout
with open(VERSION_JSON, "w", encoding="utf-8") as f:
    json.dump({"version": VERSION, "requires_reinstall": REQUIRES_REINSTALL}, f)
print("generated " + VERSION_JSON + "  (requires_reinstall=%s)" % REQUIRES_REINSTALL)

# Distribution = UNFROZEN .amxd + loose .js + ui/ folder (kept together). The device
# self-locates the UI via chord_engine.js's loadbang, which builds a cross-platform
# file:// URL (Windows C:/… -> file:///C:/… ; macOS /Users/… -> file:///Users/…).

os.makedirs(os.path.dirname(OUT), exist_ok=True)
VERSION_JSON_CONTENT = json.dumps({"version": VERSION, "requires_reinstall": REQUIRES_REINSTALL})

# tuple.zip — plain device files only (auto-updater included, no installer scripts)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for arc, src in FILES:
        z.write(os.path.join(ROOT, src), arc)
    z.writestr("Tuple/version.json", VERSION_JSON_CONTENT)

print("built " + OUT)
with zipfile.ZipFile(OUT) as z:
    for info in z.infolist():
        print("  %8d  %s" % (info.file_size, info.filename))
write_sha256_sidecar(OUT)

# tuple-mac.zip — macOS installer: Install Tuple.command + Tuple/ folder
with zipfile.ZipFile(OUT_MAC, "w", zipfile.ZIP_DEFLATED) as z:
    for arc, src in FILES:
        z.write(os.path.join(ROOT, src), arc)
    z.writestr("Tuple/version.json", VERSION_JSON_CONTENT)
    zi = zipfile.ZipInfo("Install Tuple.command")
    # create_system MUST be 3 (Unix) or macOS ignores the mode bits and the .command
    # extracts WITHOUT the exec bit -> "could not be executed: access privileges".
    # On Windows, zipfile defaults create_system to 0 (FAT) -> the 0o755 is silently dropped.
    zi.create_system = 3                        # Unix host
    zi.external_attr = (0o100755) << 16         # S_IFREG | rwxr-xr-x
    zi.compress_type = zipfile.ZIP_DEFLATED
    with open(CMD_SRC, "rb") as f:
        z.writestr(zi, f.read())

print("built " + OUT_MAC)
with zipfile.ZipFile(OUT_MAC) as z:
    for info in z.infolist():
        print("  %8d  %s" % (info.file_size, info.filename))
    # Hard guard: the .command must extract as executable on macOS, whatever OS built the
    # zip. Fail loudly here (on the build machine — often Windows) rather than shipping a
    # broken installer that only fails on the user's Mac.
    _cmd = next(i for i in z.infolist() if i.filename == "Install Tuple.command")
    if _cmd.create_system != 3 or not ((_cmd.external_attr >> 16) & 0o111):
        raise SystemExit(
            "FATAL: 'Install Tuple.command' is not executable in tuple-mac.zip "
            "(create_system=%d, mode=%s). macOS would refuse to run it."
            % (_cmd.create_system, oct((_cmd.external_attr >> 16) & 0o7777))
        )
    # CRLF guard: a Windows-style \r in the shebang line makes macOS bash fail with
    # "bad interpreter: /bin/bash^M". .gitattributes (eol=lf) normally prevents it, but
    # guard the actual bytes too — if .gitattributes ever changes, fail here, not on a Mac.
    _cmd_bytes = z.read("Install Tuple.command")
    if b"\r" in _cmd_bytes:
        raise SystemExit(
            "FATAL: 'Install Tuple.command' contains CR (CRLF) bytes — macOS bash would "
            "fail with 'bad interpreter: /bin/bash^M'. Re-checkout with LF (see .gitattributes)."
        )
    print("  guard OK: Install Tuple.command is Unix-executable (create_system=3, +x) and LF-only")
write_sha256_sidecar(OUT_MAC)
