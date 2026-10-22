# Chord types

## Diatonic grid (`GRID_TYPES` in `device/tuple_chord_engine.js`)

Order = display priority. The **main** window keeps the first `MAX_GRID_ROWS`
(= 8) valid types of a column and cuts the rest — never any vertical overflow.
⚠️ This document long named this constant `MAX_PER_COL`: it does not exist
(0 occurrences, verified 2026-08-17).

There is no second window any more. Until 2026-10-22 an **EXTENDED** window replaced
the grid under EXT with the enriched shapes absent from the main one (mostly M13 / m11 /
13). It was removed (session 86): EXT now acts on the Borrowed column only, the
diatonic grid is the same with EXT on or off, and a degree's extensions are offered by
the **Ext** page of the Borrowed column (`_extTable`).

| fn | buildNotes steps | possible labels | validity (intervals from the degree's root) |
|---|---|---|---|
| `triad` | [0,2,4] | maj / m / dim / aug | always |
| `seven` | [0,2,4,6] | M7 / m7 / 7 / dim7 / ø7 | P5+m7/M7, or dim5+dim7/ø7 |
| `nine` | [0,2,4,6,8] | M9 / m9 / 9 | major 9th (iv[8]=2) |
| `six` | [0,2,4,5] | 6 / m6 | P5 (iv[4]=7) + major 6th (iv[5]=9) |
| `add9` | [0,2,4,8] | add9 / madd9 | P5 + major 9th |
| `sus4` | [0,3,4] | sus4 | P4 (iv[3]=5) + P5 |
| `sus2` | [0,1,4] | sus2 | M2 (iv[1]=2) + P5 |
| `sevensus4` | [0,3,4,6] | 7sus4 | P4 + P5 + m7 (iv[6]=10) |
| `sixnine` | [0,2,4,5,8] | 6/9 / m6/9 | valid 6 + major 9th |
| `mmaj7` | [0,2,4,6] | mMaj7 | m3 (iv[2]=3) + P5 + M7 (iv[6]=11) |
| `sevenflat9` | [0,2,4,6,8] | 7b9 | dominant (M3) + m7 + b9 (iv[8]=1) |
| `sevensharp9` | [0,2,4,6,8] | 7#9 | dominant (M3) + m7 + #9 (iv[8]=3) |

> The **buildNotes steps** are degree offsets within the scale:
> 0=root, 1=2nd, 2=3rd, 3=4th, 4=5th, 5=6th, 6=7th, 7=octave, 8=9th.
> The engine derives the actual quality from the scale (auto-detection).

## BORROWED column (borrowed chords / modal interchange)

Defined in `BORROWED_MAJOR` / `BORROWED_MINOR`. `{roman, semis, type, suf}` —
`semis` = offset in semitones from the tonic. Played via `colorchord`.

**Major**: bIII, iv, bVI, bVII, V/V, V/ii, V/vi
**Minor**: V, vii°, IV, bII, V/V, V/iv, V/VI

## Voicings (`SPACING_NAMES`)

**Six voicings.** Since 2026-09-14 the palette holds six entries, and since 2026-10-21 it is
the only table: the 29-row index table, the deprecated 29-entry `Voicing` Live parameter and
the report that mapped removed styles onto living ones were removed that day (backward
compatibility of old sets' sound is not a goal). The order of `SPACING_NAMES` in
`device/tuple_chord_engine.js` IS the order of the `Voice Spacing` enum, and the UI labels
(`VOICINGS` in `device/ui/tuple_ui.html`) follow it row for row: a one-row offset shifts every
voicing after it. The menu's display order is a separate list (`VOIC_FAM`).

| # | engine name | UI label | idea |
|---|---|---|---|
| 0 | `classic` | **Closed** | close position — since 2026-09-14, the REAL one: no chord note fits between two adjacent voices |
| 1 | `open` | **Open** | 2nd voice raised an octave |
| 2 | `drop2` | **Section** | 2nd voice from the top dropped an octave |
| 3 | `drop3` | **Chord Melody** | 3rd voice from the top dropped an octave |
| 4 | `piano` | **Two Hands** | low root + the rest grouped above (the only two-handed voicing) |
| 5 | `root` | **Default** | the NEUTRAL mode: every note at its default position, in order (root, 3rd, 5th, 7th, then the extensions), with no styling; voice leading does not move it. Added 2026-08-05, absent from this table until 2026-09-15 |

> **Voicing rule**: the bass is always played by a separate instrument,
> the device outputs only the chord. Every voicing must remain a coherent chord
> in a single register, playable with one hand — `piano` (#4) is the only
> accepted exception.

## Scales (`SCALES`)

**30 scales, indices 0–29**, all selectable in the SCALE menu (the label list in
`device/ui/tuple_ui.html` is index-aligned with `SCALE_NAMES_ARR`). The index travels
between engine, UI (`scaleidx`) and the key observer, so **new scales are appended,
never inserted**.

| # | key | # | key |
|---|---|---|---|
| 0 | `major` | 6 | `harmminor` |
| 1 | `minor` | 7 | `melminor` |
| 2 | `dorian` | 8 | `locrian` |
| 3 | `phrygian` | 9 | `pentamaj` |
| 4 | `lydian` | 10 | `pentamin` |
| 5 | `mixolydian` | 11 | `lydiandom` |

**Indices 12–29, added 2026-10-21 — the complete modal families**, all heptatonic:

| family | keys (in index order) |
|---|---|
| melodic minor (modes 2, 3, 5, 6, 7) | `dorianb2` · `lydianaug` · `mixob6` · `locrians2` · `altered` |
| harmonic minor (modes 2–7) | `locrians6` · `ionians5` · `dorians4` · `phrygdom` · `lydians2` · `ultralocrian` |
| harmonic major (modes 1–7) | `harmmajor` · `dorianb5` · `phrygianb4` · `lydianb3` · `mixob2` · `lydianaugs2` · `locrianbb7` |

They bring the major-seventh-sharp-five (`M7#5`), which 21 of the 30 scales contain
on one degree. The dominant `7#5` is **not** a grid cell: no stacking of thirds in
any of these 30 scales produces it (it needs a whole-tone scale) — measured, not
assumed. These scales have no Borrowed table; their borrowed column stays empty.

SYNC maps Live's scale by name first (`LIVE_SCALE_MAP`), then by **intervals**
(`Song.scale_intervals`, Live 12) — Live's scale names are not documented anywhere,
so a mode Tuple knows is recognised whatever Live calls it.

⚠️ **This section announced "7 scales, indices 0–6" until 2026-08-17** — five were
missing (`melminor`, `locrian`, `pentamaj`, `pentamin`, `lydiandom`) and the index
bound was wrong. `CONTEXT.md` carried the same error, corrected the same day.

### The two pentatonics are not five-note scales

`pentamaj` and `pentamin` carry the intervals of the **complete** parent scale
(major and natural minor), plus a **degree mask** — `SCALE_VALID_DEGREES`
in `device/tuple_chord_engine.js`:

| scale | shown degrees | hidden |
|---|---|---|
| `pentamaj` | I · II · III · V · VI | IV and VII |
| `pentamin` | I · ♭III · IV · V · ♭VII | II and ♭VI |

**Measured** consequence, 2026-08-17: these two scales broadcast **5 degree
columns**, the other ten broadcast 7. The chords keep the parent scale's
voicings — the mask amputates the grid, it does not change the harmony.
