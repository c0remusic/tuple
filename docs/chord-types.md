# Chord types

## Diatonic grid (`GRID_TYPES` in `device/tuple_chord_engine.js`)

Order = display priority. The **main** window keeps the first `MAX_GRID_ROWS`
(= 8) valid types of a column and cuts the rest — never any vertical overflow.
⚠️ This document long named this constant `MAX_PER_COL`: it does not exist
(0 occurrences, verified 2026-08-17).

The **EXTENDED** window does not extend that truncation: it shows exactly the
chords **absent** from the main one — the labels of the 8 main cells are excluded,
then the enriched shapes deduplicated among themselves. Hence its population: mostly
M13 / m11 / 13, chords that exist nowhere else (`validGridCells()`).

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

## Voicings (`VOICING_NAMES`)

**Six playable voicings, 29 index rows.** Since 2026-09-14 the living palette
holds six entries — `root` (labelled **Default**), `classic`, `open`, `drop2`, `drop3`,
`piano` — and they are what `SPACING_NAMES` and the picker expose. The other 23 rows
of the table below no longer have an implementation: they remain because the index the
UI sends (`voicingidx N`) is a POSITION that saved sets store, and shrinking the table
would silently remap them. The deprecated dial reports those indices onto a living
style via `VOICING_MIGRATION`.

The engine name (`VOICING_NAMES` in `device/tuple_chord_engine.js`) and the UI label
(`VOICINGS` in `device/ui/tuple_ui.html`) must stay in the same order. A one-row
offset shifts every voicing after it.

⚠️ The header said "28 voicings"; there had been 29 in the table since `root` was
added on 2026-08-05, and neither number said how many can actually be PLAYED.

| # | engine name | UI label | idea |
|---|---|---|---|
| 0 | `classic` | **Closed** | close position — since 2026-09-14, the REAL one: no chord note fits between two adjacent voices |
| 1 | `piano` | **Two Hands** | low root + the rest grouped above (the only two-handed voicing) |
| 2 | `open` | **Open** | 2nd voice raised an octave |
| 3 | `spread` | Spread | every other voice raised (wide) |
| 4 | `house` | House | chord + octave root doubling (stab) |
| 5 | `prog` | Prog | wide prog-techno pad (low bass / 3rd + high extensions) |
| 6 | `rootlessa` | Rootless A | no root, structure as is (3-5-7-9) |
| 7 | `rootlessb` | Rootless B | no root, lower half raised (7-9-3-5) |
| 8 | `rootless` | Rootless | — |
| 9 | `drop2` | **Section** | 2nd voice from the top dropped an octave |
| 10 | `drop3` | **Chord Melody** | 3rd voice from the top dropped an octave |
| 11 | `jazz` | Jazz | — |
| 12 | `nuhouse` | New Jazz | — |
| 13 | `trance` | Trance | — |
| 14 | `funk` | Funk | — |
| 15 | `quartal` | Quartal | — |
| 16 | `upper` | Upper | — |
| 17 | `organ` | Organ | — |
| 18 | `frenchtouch` | French Touch | — |
| 19 | `broken` | Broken | — |
| 20 | `deeptech` | Deep Tech | — |
| 21 | `detroit` | Detroit | — |
| 22 | `soul` | Soul | — |
| 23 | `jamiroquai` | Clav | — |
| 24 | `rave` | Rave | — |
| 25 | `sus` | Sus | — |
| 26 | `wide` | Wide | — |
| 27 | `power` | Power | — |
| 28 | `root` | **Default** | the NEUTRAL mode: every note at its default position, in order (root, 3rd, 5th, 7th, then the extensions), with no styling; voice leading does not move it. Added 2026-08-05, absent from this table until 2026-09-15 |

The `—` entries are voicings that shipped but are not documented here — to be
described as we go, not to be removed from the table (their position carries the
index).

> ⚠️ Two entries have an engine name that does not match their UI label:
> `nuhouse` displayed as "New Jazz" (#12) and `jamiroquai` displayed as "Clav" (#23).
> The second is deliberate (a band name kept out of the UI). The first is worth
> checking — "nuhouse" suggests "New House", not "New Jazz".

> **Voicing rule**: the bass is always played by a separate instrument,
> the device outputs only the chord. Every voicing must remain a coherent chord
> in a single register, playable with one hand — `piano` (#1) is the only
> accepted exception.

## Scales (`SCALES`)

**12 scales, indices 0–11**, all selectable in the SCALE menu (the label list in
`device/ui/tuple_ui.html` is index-aligned with `SCALES`):

| # | key | # | key |
|---|---|---|---|
| 0 | `major` | 6 | `harmminor` |
| 1 | `minor` | 7 | `melminor` |
| 2 | `dorian` | 8 | `locrian` |
| 3 | `phrygian` | 9 | `pentamaj` |
| 4 | `lydian` | 10 | `pentamin` |
| 5 | `mixolydian` | 11 | `lydiandom` |

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
