#!/bin/bash
# Tuple – macOS Installer
# First time: right-click → Open (Gatekeeper).
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$DIR/Tuple"

if [ ! -d "$PAYLOAD" ]; then
  osascript -e 'display dialog "Error: the “Tuple” folder was not found next to this installer.\n\nKeep “Install Tuple.command” and the “Tuple” folder together, then run again." buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi

# On macOS the User Library defaults here. We always append Presets/Max MIDI Effect
# OURSELVES (and create it) so Tuple can never land in the wrong place — the user only
# ever has to confirm or point us at their User Library, not the deep subfolder.
DEFAULT_LIB="$HOME/Music/Ableton/User Library"

if [ -d "$DEFAULT_LIB" ]; then
  CHOICE=$(osascript -e "display dialog \"Install Tuple here?\n\n$DEFAULT_LIB/Presets/Max MIDI Effect\" buttons {\"Choose another…\", \"Install here\"} default button \"Install here\"" -e 'button returned of result' 2>/dev/null) || exit 0
  if [ "$CHOICE" = "Install here" ]; then
    LIB="$DEFAULT_LIB"
  else
    LIB=$(osascript -e 'POSIX path of (choose folder with prompt "Locate your Ableton “User Library” folder:")' 2>/dev/null) || exit 0
  fi
else
  LIB=$(osascript -e 'POSIX path of (choose folder with prompt "Locate your Ableton “User Library” folder:")' 2>/dev/null) || exit 0
fi

LIB="${LIB%/}"

# Accept whatever level the user pointed at: User Library, Presets, or Max MIDI Effect.
case "$(basename "$LIB")" in
  "Max MIDI Effect") DEST="$LIB" ;;
  "Presets")         DEST="$LIB/Max MIDI Effect" ;;
  *)                 DEST="$LIB/Presets/Max MIDI Effect" ;;
esac

# Create the Max MIDI Effect folder if Ableton hasn't made it yet.
mkdir -p "$DEST"
rm -rf "$DEST/Tuple"
cp -R "$PAYLOAD" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/Tuple" 2>/dev/null || true

# Verify it actually landed — never report success on a copy that didn't happen.
if [ ! -f "$DEST/Tuple/tuple.amxd" ]; then
  osascript -e "display dialog \"Install failed — could not write to:\n$DEST\n\nRun the installer again and pick your Ableton “User Library” folder.\" buttons {\"OK\"} default button \"OK\" with icon stop"
  exit 1
fi

# Record the path so the in-device auto-updater knows where to copy future updates.
echo "$DEST" > "$HOME/.tuple-install-path"

osascript -e "display dialog \"Tuple installed ✓\n\nLocation:\n$DEST/Tuple\n\nRestart Ableton — Tuple appears under Max MIDI Effect.\" buttons {\"OK\"} default button \"OK\""
