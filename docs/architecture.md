# Architecture

## Principle: a single source of truth

`device/tuple_chord_engine.js` is the **only** place that holds the harmonic
logic (scales, intervals, validity, chord construction, voicings, voice
leading). Every other file is a "dumb" client that consumes what the engine
produces.

```
                 ┌──────────────────────────────┐
                 │  device/tuple_chord_engine.js │  ← SOURCE OF TRUTH
                 │  scales / validity /          │
                 │  grid / voicings /            │
                 │  voice leading / notes        │
                 └───────────┬───────────────────┘
        grid (outlet 7)      │    played notes → 6 noteout → track
        ┌────────────────────┼─────────────────────┐
        ▼                    ▼                      ▼
   device/ui/            push/ (parked,       (recording
   tuple_ui.html         repo root) —          on 2nd track)
   (renders +            LEDs + pads
    sends clicks)        to come
        ▲
        │ keyboard input
   device/tuple_midi_map.js ◀── notein → pack i i
```

## Grid flow (the core)

1. A KEY/SCALE change (or loading) calls `broadcastGrid()`.
2. For each degree (0–6), the engine computes the valid **contiguous** chords
   (max 8 per column) + the BORROWED column.
3. It broadcasts a sequence of messages via **outlet 7**:
   - `gridclear`
   - `gridcell <col> <fn> <label>` × N
   - `gridbor <i> <label> <semis> <type> <roman>` × N
   - `griddone`
4. `device/ui/tuple_ui.html` (inline UI logic, no separate JS file) receives them
   through `bindInlet` and re-renders. ⚠️ **Grid state lives in the ENGINE, not in the UI**:
   `gCols` / `gBor` / `flatGrid` (`device/tuple_chord_engine.js`). This line named
   `gridCols` / `gridBor` until 2026-09-15 — two symbols that exist nowhere in the code
   (0 occurrences).
5. The engine also builds `flatGrid` (col-major) for the keyboard/Push mapping.

## Playing a chord

- **Mouse (UI)**: click → `outlet(0, fn, col)` (diatonic) or
  `outlet(0, "colorchord", semis, type)` (borrowed) → engine → `sendChord`.
- **MIDI keyboard**: `notein` → `device/tuple_midi_map.js` → `"midinote pitch vel"` → engine
  → `flatGrid[pitch-48]` → the same cell as the UI.
- **Push 2**: pad → `padIndex(col, row)` → `pitch = 48 + padIndex(…)` → `midinote` →
  the same `flatGrid` as the keyboard (`device/tuple_push2_spike.js`). ⚠️ This line said
  "Push (future)" and `playcell(col, row)` until 2026-09-15: Push 2 has shipped since
  v1.3, and `playcell` never existed (0 occurrences).

Everything ends up on the **6 `noteout`** objects → the track → **recordable**.

## Message protocol (engine ↔ UI)

### UI → engine (jweb outlet 0 → engine inlet 0)
| Message | Effect |
|---|---|
| `triad 2`, `seven 0`, `six 4`, `mmaj7 5`… | plays the chord (fn + degree) |
| `colorchord <semis> <type>` | plays a borrowed chord |
| `rootidx N` / `scaleidx N` | changes tonic / scale |
| `voicingidx N` | changes the voicing |
| `octave N` | changes the register |
| `voiceleading on/off` | enables voice leading |
| `vlmode anchored/flow` | voice leading mode (`relative` and `piano` no longer exist) |
| `extended on/off` | shows every chord (cap lifted) |
| `settension <idx> <color> <0\|1>` | sets / removes a COLOR (`b9` `9` `#9` `11` `#11` `b13` `13`, tuple-dev#73; or `9` / `11` / `13` as a number = the family's diatonic, #68 compat) on a progression card; silently refused when the offer does not propose it (built, or refused by AVOID NOTES) |
| `avoidnotes 1/0` | tension-avoidance filter (global) — touches no card |
| `transportplay` / `transportstop` | starts / stops Live's playback (`live_set.start_playing` / `stop_playing`), from the facade's PLAY · STOP (2026-09-11) |
| `pages N` / `page N` | the PAGES (tuple-dev#74): `pages` adds empty pages at the end or removes them (1 to 4, never a page that carries a card); `page` is the displayed page (0-based), which the engine owns because capture, the cursor and Push depend on it. A page IS a loop; starts stay absolute; `loopbars` is refused while there is more than one page |
| `synclive` | imports Live's key |
| `requestgrid` | requests a grid rebroadcast |
| `requeststate` | resyncs root/scale (after an autowatch reload) |
| `release` | note off |

⚠️ **Two input paths, not one — and `LIST_DISPATCH` is only the second.** A
**single-atom** message (`writeclip`, `requestgrid`…) is routed by Max to the
**global function of the same name**; it never enters `list()`, and the engine has no
`anything()` that could intercept it. `LIST_DISPATCH` serves the messages that carry
**arguments** (`setinv 0 1`, `voicingidx 3`). Practical consequence: an argument-less
handler does not have to appear in the table — looking it up there to check that it is
"wired" wrongly concludes that it is not. Some appear there anyway (`capture`,
`clearprog`): that is a harmless redundancy, not a counter-example.

⚠️ **This page cited `sendclip` as an example until 2026-09-16, and the function no
longer had a single emitter.** The patch names it only in a stale comment ("CC relais
capturetoggle/sendclip" on a `[pack i i]` that goes to `tuple_midi_map.js`), and that file
sends `writeclip`, not `sendclip` — its header says so explicitly. Deleted on
2026-09-16 together with `_writeClipNotes`, which only it called: neither exists in
the engine any more (0 occurrences). An example chosen for an architecture page
outlives the disappearance of its subject: this one described a real routing through a
dead command.

### Engine → UI (engine outlet 7 → jweb inlet 0)
| Message | Effect |
|---|---|
| `gridclear` / `gridcell …` / `gridbor …` / `griddone` | grid broadcast |
| `root N` / `scale N` | key display sync |
| `active <fn> <deg>` | highlight of the played cell |
| `notes <n1 n2 …>` / `clearnotes` | keyboard monitor |
| `prog …` | the progression, tuples of `PROG_STRIDE` (9) atoms: name, roman, deg, inv, bassPc, vlMode, bars, tensions (the COLORS set on the card, `b9.#9.13` or `-`, tuple-dev#73), **start** (start position in bars, tuple-dev#72 — cards have a free slot on the 8-bar ruler, rests are the gaps; `progression[]` stays sorted by time) ("9.13" or "-") — every addition goes AT THE END |
| `progtens …` | the tension offer, **seven atoms per card** (tuple-dev#73), aligned with `prog`, in the fixed order ♭9 · 9 · ♯9 · 11 · ♯11 · ♭13 · 13: `state[:reason]`, followed by `~` when the color is out of the scale (`off`, `on~`, `avoid:3rd`, `built`, `muted`, `none`) |
| `avoidnotes 0/1` | filter state (also in `pushUIState`, for a jweb reload) |
| `playing 0/1` | whether Live is playing — an observer on `live_set.is_playing`, set up at loadbang; the PLAY LED follows |
| `cc <value> <number>` | the expression CCs (2026-09-11): every setting on the EXPRESSION plate also goes out as a MIDI controller — 20 Strum · 21 Strum Ramp · 22 Strum Curve · 23 Humanize (bipolar: zero at 64). The patch routes it `[route cc] → [unpack i i] → [ctlout]` (value first: the number lands on the cold inlet before the value). Emitted on CHANGE only, never by `pushUIState` |
| `playhead <bar>` | the playhead, in ABSOLUTE bars across the song (modulo pages × loop) — the UI derives the page and the x position from it; the view follows the page, unless frozen by ‹ › until the next PLAY |
| `loopbars N` / `pages N` / `page N` | the loop, the page count, the displayed page — also in `pushUIState`; `pages` is also emitted when a capture opens a page |

### Propagation to midi_map / push (no wiring)
The engine broadcasts `root_idx` / `scale_idx` via `messnamed()` → received by the
patch's `r root_idx` / `r scale_idx` objects.

## Voice leading — one control, three positions

UI-side source of truth: `VL3 = ['OFF','ANCHOR','FOLLOW']` in
`device/ui/tuple_ui.html`, and `VLMODE_MSG = ['anchored','flow']` for the wire
values. ⚠️ **This document long named a `VLMODES` table: it does not exist** (0
occurrences in the UI, verified 2026-08-17), and a test pins its absence.

The three positions are carried by **two** messages, not one — this is what lets a
set saved before the 2026-08-05 merge reload its state:

| Displayed position | `voiceleading` | `vlmode` |
|---|---|---|
| **OFF** | `0` | unchanged (remembered) |
| **ANCHOR** | `1` | `anchored` |
| **FOLLOW** | `1` | `flow` |

- **ANCHOR**: recenters the chord (voicing shape preserved) on a fixed register.
  Deterministic → stable loops.
- **FOLLOW**: follows the previous chord (minimal movement, common tones kept).
  **Progressive** center pull to avoid drift without abrupt jumps.

> Label history of the 3rd position: `FLOW`, then `AUTO` (2026-08-05), then
> `FOLLOW` (2026-08-11) — "auto" named four different mechanisms at once.
> The **wire value stays `flow`**: it is what makes existing sets reload,
> do not "fix" the label/value mismatch. Even earlier, the axis carried
> three modes `ANCHOR` / `RELAT` / `PIANO`; `PIANO` became a **voicing** (see
> `chord-types.md`).

### The selection cost: `_vl2_movCost()`, weighted by `_vl2_W`

⚠️ **This document long described a `vlDistance()` function with five
coefficients. It does not exist either** (0 occurrences in the engine, verified
2026-08-17), and the values it quoted corresponded to nothing measurable.

The real selection is `_vl2_select()` (register center, minimal movement, common
tones); the cost is `_vl2_movCost()`, whose weights live in the engine's `_vl2_W`
table — with a second table, `_vl2_W_jazz`, applied to the styles listed in
`_vl2_JAZZ_VC` (rootless, drops, house, jazz, quartal, organ…).

The weights are **in the code**, not here: copying them out produced the drift this
section just corrected. What is worth knowing about their shape:

- note-to-note movement is paid per semitone, with a surcharge beyond a leap;
- common tones are **rewarded** (negative cost), both at the exact note and at the
  pitch class;
- penalized: parallel fifths and octaves, spacing gaps, changes in note count,
  voice crossing;
- `_vl2_W_jazz` stands out mostly through a **much greater tolerance for
  parallels** and cheaper leaps — that is what lets the genre grips breathe.

## Window resizing

⚠️ **This section described a `setwidth` on outlet 1 until 2026-09-15.** Both halves
were wrong, and the second dangerously so: `setwidth` appears nowhere in `device/`,
and **the engine's outlet 1 carries voice 1's pitch** (`outlets = 8`; 1..6 = the six
voices, 7 = the broadcast to the jweb). A message sent there would enter the MIDI
path.

The real mechanism is in two pieces, and neither goes through the engine:

1. **The window** becomes resizable through `[thispatcher]`, which receives
   `window flags grow, window exec` — once, at `loadbang`, via `deferlow`, with the
   window still hidden. Triggered hot from a window callback, this message is
   re-entrant and **has crashed Ableton**.
2. **The content** does not reflow: it ZOOMS. `_v3Zoom()` sets
   `zoom = min(width/1200, height/700)` on the root and gives `html` / `body` back
   the size `window ÷ zoom` — jweb (Chromium 122) does not recompute the viewport on
   its own. Outside Max the zoom is disabled: it skewed the overflow contract.

1200×700 stays the reference geometry, the one the spec sheet and the contracts measure.

## Recording (capturing the generated chords)

Live does not record the output of a MIDI effect. To capture the chords:
- Track A: the device (where you play).
- Track B: MIDI From = track A → its **post-device** output (the tap point carries
  the device's name; this document still said `"Chord_selector"`, the project's old
  name), Monitor = In, armed, an instrument on it.
- → track B records the real chord notes, editable.

## Verification — the three layers, and what none of them sees

The `.amxd` only runs inside Ableton + Max. Impossible to launch it in CI or
headless. Verification is therefore **stratified**, and each layer has a blind spot
that the next one covers. Operational detail (commands, troubleshooting):
`.claude/skills/run-tuple/SKILL.md`.

| Layer | What it executes | What it does NOT see |
|---|---|---|
| `device/tests/*.test.mjs` | the **real** shipped `.js`, in a `vm` with the Max globals stubbed | the `.amxd`; the low-priority thread; the hardware |
| `site/vl2/*.test.js` | the ES-module **mirror** used by the demo | any device↔mirror divergence not tested on both sides |
| `amxd_contract.mjs` | the static engine ↔ patch contract | everything dynamic |
| Ableton + Max (human) | everything | nothing — but only runs with a human |

### The headless harness (`device/tests/max-harness.mjs`)

Loads a device `.js` into a `vm` context with stubs for `outlet`, `post`,
`Task`, `LiveAPI`, `File`, `messnamed`, plus:

- a **virtual clock** — the strum/humanize `Task`s become deterministic;
- a **`noteout` model** rebuilt from the `outlet()` calls, honoring the real
  wiring (outlet 0 = cold velocity, outlets 1..6 = hot pitches).

Hence the central invariant: **every note-on eventually receives its note-off**.
A non-empty `env.notes.hanging` = a note stuck in Live.

`TUPLE_DEVICE_DIR=<dir>` replays the suite against a **published version**
(`git show v1.4.1:device/tuple_chord_engine.js`). A test that does not fail on the
version the user is actually running proves nothing about their bug.

⚠️ **Realm trap**: an `Array` built outside the `vm` context fails
`instanceof Array` **inside it**. The device code tests `nm instanceof Array` on
LiveAPI returns — the stubs must therefore build their arrays with the context's
`Array`, otherwise the test goes green for the wrong reason.

### Why `amxd_contract.mjs` exists

On 2026-08-05, **178 green tests and a green `verify.sh` coexisted with a broken
device**: the engine had gained a 29th voicing while the patch's Live parameter
`Voicing` kept its 28 entries. A style unreachable from Live, and the picker state
overwritten on every load by `parameter_initial`. No test suite could see it —
they do not read the `.amxd`.

The same blind spot had let `get("active")` through for months: the Device LOM
exposes **`is_active`**, not `active`. The wrong property reads `0`, hence
"device off", permanently.

The checker verifies four static invariants: the UInt32LE size at byte 28
(wrong → Max throws EOF on load), the on-disk existence of every instantiated
`[js …]`, the alignment of the Live parameter enumerations with the engine's
tables, and the existence of a handler for every `[prepend X]` **actually wired**
to the engine — by following the patchlines, not by assuming.

### Two rules learned the hard way

- **State conditions fail OPEN.** A read that does not resolve (missing property,
  Live not ready, unresolved object) must let through, never refuse. Two Push-mode
  regressions in one day both came from the opposite: an uncertain read was allowed
  to say no.
- **A test budget is counted in operations, not in milliseconds.** An assertion in
  ms went red under load, green right after. A test that depends on machine load
  says nothing about the code.

### What stays strictly manual

Real MIDI output, Push pads, LiveAPI clip writing, low-priority-thread jitter,
and **any judgment by ear**. A change that modifies the produced notes (register,
the shape of a voicing) must go through Ableton before release, whatever the state
of the green.
