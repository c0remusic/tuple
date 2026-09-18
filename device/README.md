# Tuple Device

Max for Live harmonic composition tool — the device itself. Tuple gives instant
access to every valid chord for a key/scale, in a grid, always one click away.
It outputs the **chord only** (not a sequencer).

## Files

| File | Purpose |
|------|---------|
| `tuple.amxd` | Compiled Max for Live device (binary: 32-byte header + JSON) |
| `tuple_chord_engine.js` | **Source of truth** — all harmonic logic, state, voice leading, UI broadcast |
| `ui/tuple_ui.html` | **Active UI** — loaded by `jweb` (the engine sends the URL at loadbang) |
| `tuple_live_key_observer.js` | Ableton Live integration (SYNC imports Live's key/scale) |
| `tuple_midi_map.js` | MIDI note output routing |
| `tuple_push2_spike.js` | Push 2 integration (`[js]` object in the `.amxd`) — grid grab, colored pads, play, velocity |
| `tuple_dl.js` | Auto-updater download helper (`node.script` — full Node, not ES5) |

> Every device `.js` is `tuple_`-prefixed (2026-06-16) so stale copies under old
> names can't shadow them through Max's search path. This table listed the
> pre-rename names (`chord_engine.js`, `init_menus.js`…) until 2026-08-18 —
> describing files that no longer exist. `init_menus.js` is gone entirely
> (removed with the dead `umenu`s).

> **UI filename must stay unique** (NOT `index.html`): Max indexes the whole
> project tree, so `site/index.html` collided with the old `ui/index.html` and the
> jweb loaded the website. Renamed to `tuple_ui.html` to kill the collision.

## Architecture

### Single source of truth

**`tuple_chord_engine.js`** holds all state (key, scale, octave, voicing, voice leading
mode, expression) and computes the chord grid. It broadcasts the grid and state on
its outlets; the UI is a pure consumer that renders and sends messages back —
never mutating state directly.

**`ui/tuple_ui.html`** is the jweb UI. It talks to Max via
`window.max.outlet(sym, …)` (out) and `window.max.bindInlet(sym, cb)` (in). It
never holds harmonic logic.

### Two-window workflow

- **Compact strip** — the M4L device face: controls + monitor (no grid; M4L height
  is limited). Both columns share equal edge insets and align across columns.
- **Full window** — opened via **OPEN DEVICE** (one click away): the full chord
  grid + controls + monitor + the DEVICE/WINDOW groups. Bridged by `send/receive`
  (`tuple_ui` / `tuple_cmd`) and the `[p tuple_fullview]` subpatcher.

The full window is **non-resizable** and opens/closes with a short content fade.

### Message flow

```
User clicks a chord cell (jweb)
    ↓ window.max.outlet('fn', col)  /  ('colorchord', semis)
tuple_chord_engine.js  →  updates state, computes notes + voicings
    ↓ MIDI out (notes)
    ↓ outlet 7: broadcast grid + 'active' + 'notes' back to the jweb (both windows)
ui/tuple_ui.html  →  bindInlet handlers re-render
```

## Development

- **Engine / MIDI:** edit `tuple_chord_engine.js` / `tuple_midi_map.js` — Max auto-reloads
  (autowatch). The engine tees `post()` into `device/max_console.log` (gitignored)
  so console output is readable from outside Max.
- **UI:** edit `ui/tuple_ui.html` directly (jweb loads from there). jweb does **not**
  hot-reload — **reopen the device** to reload the UI.
- **ES5 only** in `tuple_chord_engine.js` / `tuple_push2_spike.js` (Max's JS engine is ES5 — no
  `Set`/`Map`/arrow fns/`let`/`const`/template strings; the engine ships ES5 polyfills).
- **Editing the `.amxd`:** it's a 32-byte header + JSON. After editing the JSON,
  rewrite the UInt32LE size at byte offset 28 (`buf.writeUInt32LE(buf.length-32, 28)`)
  or Max throws `EOF`. Edit via Node, not PowerShell here-strings.
- **Window control** (full window) goes through `[thispatcher]`: send
  `window flags nogrow, window exec` to lock resizing. Trigger window-flag commands
  from **`loadbang`** (window still hidden) via **`deferlow`** — running `window exec`
  from the `active` callback is re-entrant and crashes Live; running it on a visible
  window also causes a flicker.

## Testing (in Ableton Live)

1. Drop `tuple.amxd` onto a **MIDI track**, before an instrument.
2. Click chords → MIDI notes out.
3. Change **VOICING** / toggle **VOICE LEADING** (modes **ANCHOR / FLOW**) → affects output.
4. **SYNC** → imports Live's key/scale.
5. **OPEN DEVICE** → full grid window (non-resizable, fades in).

## Distribution

Shipped as `site/tuple.zip` (device + engine + `ui/tuple_ui.html` + manual PDF).
Keep all files in the same folder; the UI self-locates its jweb URL at load.
