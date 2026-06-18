# Tuple

A Max for Live harmonic composition tool for Ableton Live.

**Tuple** gives you instant access to every valid chord for your key and scale — organized in a grid, always one click away. It's not a sequencer. It's a tool for exploring, performing and recording chords in real time.

→ **[tuple.live](https://tuple.live)**

---

## Install

**Windows** — Download `Tuple-Installer-vX.Y.Z.exe` from [Releases](https://github.com/c0remusic/tuple/releases/latest) and run it. The installer pre-fills your Ableton User Library path — confirm or change it. First run: click **More info → Run anyway** (SmartScreen, unsigned).

**macOS** — Download `tuple.zip`, unzip it, then double-click **`Install Tuple.command`**. First run: right-click → **Open** (Gatekeeper). The script copies Tuple to your Max MIDI Effect folder and removes quarantine automatically.

**Manual (both OS)** — Unzip `tuple.zip`. Move the `Tuple/` folder to `Ableton/User Library/Presets/Max MIDI Effect/`. Restart Ableton.

After install, Tuple appears in Ableton's browser under **Max MIDI Effect**.

---

## Quick Start

### Development Setup

The **device** is hand-edited — no build step, no dependencies.

```bash
# Device (Max for Live):
#   edit device/tuple_chord_engine.js   (harmonic logic, autowatch reloads)
#   edit device/ui/tuple_ui.html  (jweb UI — reopen the device to reload)
```

> The website lives in its own repo (`tuple-site`, deployed to Vercel → tuple.live).

---

## Project Structure

```
device/          → Max for Live device (source of truth)
  tuple_chord_engine.js   → harmonic logic
  ui/tuple_ui.html  → active jweb UI (strip + full window)
  tuple_push2_spike.js    → Push 2 integration (device-only)
manual/          → user manual (HTML + PDF, ships with the device)
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
- **Smart Chords** — as you play, the grid lights up where to go next, by harmonic
  function or by voice leading (brighter = stronger)
- **Voice leading** — 2 modes (**ANCHOR / FLOW**) for smooth transitions
- **15 voicings** — Classic, Piano, Open, Spread, House, Prog, Rootless A/B,
  Drop 2/3, Jazz, Nu-House, Trap, Trance, Funk
- **Expression** — Strum, Velocity Ramp, Humanize
- **Borrowed chords** — modal interchange & secondary dominants always visible
- **Progression → Clip** — capture chords as you play, then drop the whole
  progression into a MIDI clip (one chord per bar)
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
