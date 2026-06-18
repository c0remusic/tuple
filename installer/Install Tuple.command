#!/bin/bash
# Tuple – macOS Installer
# 1ère fois : clic droit → Ouvrir (Gatekeeper).
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$DIR/Tuple"

if [ ! -d "$PAYLOAD" ]; then
  osascript -e 'display dialog "Erreur : le dossier Tuple est introuvable à côté de ce script.\n\nAssure-toi que Install Tuple.command et le dossier Tuple sont au même endroit." buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi

# Tier 1 detection: default User Library path + Presets/ signature
DEFAULT_LIB="$HOME/Music/Ableton/User Library"
MIDI_FX="$DEFAULT_LIB/Presets/Max MIDI Effect"

if [ -d "$DEFAULT_LIB/Presets" ]; then
  DEST=$(osascript -e "POSIX path of (choose folder with prompt \"Sélectionne le dossier Max MIDI Effect où installer Tuple :\" default location POSIX file \"$MIDI_FX\")" 2>/dev/null) || exit 0
else
  DEST=$(osascript -e "POSIX path of (choose folder with prompt \"Navigue jusqu'à User Library › Presets › Max MIDI Effect, puis clique Choisir :\")" 2>/dev/null) || exit 0
fi

DEST="${DEST%/}"
cp -R "$PAYLOAD" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/Tuple" 2>/dev/null || true
osascript -e "display dialog \"Tuple installé ✓\nDossier : $DEST/Tuple\n\nRedémarre Ableton — le device apparaît dans Max MIDI Effect.\" buttons {\"OK\"} default button \"OK\""
