# Contributing to Tuple

Thanks for your interest. Tuple welcomes bug reports, documentation fixes and focused
code changes — and this page tells you what is genuinely different about working on a
Max for Live device, so your first attempt runs.

## How this repository works

This repository is a **generated export** of a private working repo: `main` is
force-pushed at each release and never edited by hand. Your pull request will not be
merged here in the usual way — a maintainer replays it in the working repo, credits
you in the commit, and it lands in the next release. Issues and PRs are read and
answered; the code you see always matches the released device.

## What Tuple is made of

There is **no build step**. The device is hand-edited source, loaded live by Max:

| File | Role | Reload |
|---|---|---|
| `device/tuple_chord_engine.js` | All harmonic logic and state | Automatic on save (`autowatch`) |
| `device/ui/tuple_ui.html` | The whole UI (jweb) | Reopen the device in Max |
| `device/tuple_push2_spike.js` | Push 2 pads | Automatic on save |
| `device/tuple_midi_map.js` | MIDI input routing | Automatic on save |
| `device/tuple.amxd` | The Max patch (binary) | See warning below |

## The three rules that break newcomers

1. **The `[js]` engine is ES5 only.** Max's JS engine predates ES6: no arrow
   functions, no `let`/`const`, no template strings, no spread, no `class`.
   Use `var`, `function () {}` and string concatenation. (`Set`/`Map` exist as
   narrow polyfills inside the engine — check the top of the file before using a
   method.) The UI (`tuple_ui.html`) runs in jweb, a Chromium 122 — modern JS is
   fine there, but nothing newer than Chromium 122.

2. **Do not hand-edit `device/tuple.amxd`.** It is a 32-byte binary header + JSON +
   a trailing null, and the header stores the JSON size at byte offset 28 — get it
   wrong and Max throws EOF. Edit the patch from inside Max (open, unlock, save)
   whenever possible. Enum parameters are read by POSITION in saved sets: never
   insert or remove entries, only append.

3. **Live parameter enums never shrink or shift.** A saved Ableton set stores the
   index, not the name. Reordering an enumeration silently remaps every existing
   set that automates it.

## Trying your change

1. Put the `device/` folder somewhere in Ableton's User Library (or add it as a
   Place), open Live 11+, drop `tuple.amxd` on a MIDI track before an instrument.
2. Engine edits reload on save. UI edits need the device reopened — a true reload
   is delete the device and re-drag the `.amxd`.
3. Click the grid: MIDI comes out. Change VOICING and VOICE LEADING and listen.

The automated test harness lives in the private working repo and runs on every PR
replay — you do not need it to contribute, but expect a maintainer to run your
change through it before it ships.

## Scope and style

- Keep changes small and focused; one concern per PR.
- Match the style of the file you are in — the engine is deliberately plain ES5.
- For anything larger than a fix, **open an issue first**: some behaviours that
  look like bugs are arbitrated decisions (voicing labels, enum layouts, what the
  Push screen shows), and the issue saves you building something that cannot land.

## Communication

Questions, ideas, feedback: open an issue, or join the Discord linked from
[tuple.live](https://tuple.live).
