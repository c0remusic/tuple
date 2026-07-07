<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo.png">
    <img alt="Tuple" src="docs/images/logo-light.png" width="300">
  </picture>
</p>

# Tuple — Free Open-Source Max for Live Chord Device for Ableton Live

[![version](https://img.shields.io/github/v/release/c0remusic/tuple)](https://github.com/c0remusic/tuple/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/c0remusic/tuple)](https://github.com/c0remusic/tuple/stargazers)
[![issues](https://img.shields.io/github/issues/c0remusic/tuple)](https://github.com/c0remusic/tuple/issues)

**Tuple** is a free, open-source Max for Live chord device for Ableton Live. It puts every in-key and borrowed chord on a single color-coded grid, always visible, so producers can explore, perform and capture chord progressions without menus or theory friction.

Tuple is not a standalone app and not a VST plugin. It runs inside Ableton Live as a Max for Live MIDI device, sends MIDI notes to the instrument after it, and follows your key and scale workflow.

→ **[tuple.live](https://tuple.live)** &nbsp;·&nbsp; [Manual](https://tuple.live/manual/) &nbsp;·&nbsp; [Interactive demo](https://tuple.live/demo.html) &nbsp;·&nbsp; [Releases](https://github.com/c0remusic/tuple/releases/latest)

---

## Why Tuple?

Most chord tools hide the musical space behind menus, pages or generated suggestion lists. Tuple keeps harmony visible and playable:

- every chord for your key stays on one grid
- borrowed chords are always one click away
- color-coded degrees make harmonic function readable at a glance
- Smart Chords suggest where to go next without forcing a progression
- Push 2 and MIDI mapping keep the workflow hands-on
- Progression → Clip captures what you play directly into Ableton Live

Core idea: **every chord in your key, always visible.**

---

## Install

**Windows** — Download `Tuple-Installer.exe` from [Releases](https://github.com/c0remusic/tuple/releases/latest) and run it. The installer pre-fills your Ableton User Library path — confirm or change it. First run: click **More info → Run anyway** (SmartScreen, unsigned).

**macOS** — Download `tuple-mac.zip`, unzip it, then double-click **`Install Tuple.command`**. First run: right-click → **Open** (Gatekeeper). The script copies Tuple to your Max MIDI Effect folder and removes quarantine automatically.

**Manual (both OS)** — Unzip `tuple.zip`. Move the `Tuple/` folder to `Ableton/User Library/Presets/Max MIDI Effect/`. Restart Ableton.

After install, Tuple appears in Ableton's browser under **Max MIDI Effect**.

---

## Quick Start

1. Drop Tuple on a MIDI track in Ableton Live.
2. Put an instrument after it.
3. Choose or sync your key and scale.
4. Play chords from the grid, Push 2 or mapped MIDI controls.
5. Capture a progression into a MIDI clip when it works.

---

## Development Setup

The **device** is hand-edited — no build step, no dependencies.

```bash
# Device (Max for Live):
#   edit device/tuple_chord_engine.js   (harmonic logic, autowatch reloads)
#   edit device/ui/tuple_ui.html        (jweb UI — reopen the device to reload)
```

> The website lives in its own repo (`tuple-site`, deployed to Vercel → tuple.live).

---

## Project Structure

```
device/                    → Max for Live device (source of truth)
  tuple_chord_engine.js     → harmonic logic
  ui/tuple_ui.html          → active jweb UI (strip + full window)
  tuple_push2_spike.js      → Push 2 integration (device-only)
manual/                    → user manual (HTML + PDF, ships with the device)
```

**Git:** this repo tracks the **device** only (`device/`, `manual/`, `README`, `LICENSE`).
The website has its own repo (`tuple-site`, deployed to Vercel → tuple.live). Local-only
folders — `site/`, `docs/`, `brand/`, `discord/`, `font/`, `CLAUDE.md` — are gitignored.

---

## Key Files

| File | Purpose |
|------|---------|
| `device/tuple_chord_engine.js` | Harmonic logic (source of truth) |
| `device/ui/tuple_ui.html` | Active jweb UI (rendering & interaction) |
| `device/tuple_push2_spike.js` | Push 2 integration |
| `device/README.md` | Device architecture & dev notes |

---

## Features

- **Instant chord access** — grid of all valid chords for your key/scale
- **Smart Chords** — as you play, the grid lights up where to go next, by harmonic function or by voice leading (brighter = stronger)
- **Voice leading** — 2 modes (**ANCHOR / FLOW**) for smooth transitions
- **28 voicings** — a wide set of playable voicing styles for different production contexts
- **Expression** — Strum, Velocity Ramp, Humanize
- **Borrowed chords** — modal interchange & secondary dominants always visible
- **Progression → Clip** — capture chords as you play, then drop the whole progression into a MIDI clip (one chord per bar)
- **Two-window workflow** — compact strip + full grid window (one click away)
- **Push 2 integration** — grab the pad grid (colored by degree), play, velocity
- **Ableton Live integration** — SYNC button imports key/scale from Live

---

## Support

Tuple is free. If it's useful to you, consider a donation:

☕ [paypal.me/c0remusic](https://www.paypal.com/paypalme/c0remusic)

---

## License

MIT
