# Types d'accords

## Grille diatonique (`GRID_TYPES` dans `device/tuple_chord_engine.js`)

Ordre = priorité d'affichage. Si une colonne dépasse `MAX_PER_COL` (8), on garde
les premiers et on coupe les derniers.

| fn | étapes buildNotes | labels possibles | validité (intervalles depuis la fondamentale du degré) |
|---|---|---|---|
| `triad` | [0,2,4] | maj / m / dim / aug | toujours |
| `seven` | [0,2,4,6] | M7 / m7 / 7 / dim7 / ø7 | 5J+m7/M7, ou 5dim+dim7/ø7 |
| `nine` | [0,2,4,6,8] | M9 / m9 / 9 | 9e majeure (iv[8]=2) |
| `six` | [0,2,4,5] | 6 / m6 | 5J (iv[4]=7) + 6e maj (iv[5]=9) |
| `add9` | [0,2,4,8] | add9 / madd9 | 5J + 9e maj |
| `sus4` | [0,3,4] | sus4 | 4J (iv[3]=5) + 5J |
| `sus2` | [0,1,4] | sus2 | 2M (iv[1]=2) + 5J |
| `sevensus4` | [0,3,4,6] | 7sus4 | 4J + 5J + m7 (iv[6]=10) |
| `sixnine` | [0,2,4,5,8] | 6/9 / m6/9 | 6 valide + 9e maj |
| `mmaj7` | [0,2,4,6] | mMaj7 | 3m (iv[2]=3) + 5J + 7M (iv[6]=11) |
| `sevenflat9` | [0,2,4,6,8] | 7b9 | dominante (3M) + m7 + b9 (iv[8]=1) |
| `sevensharp9` | [0,2,4,6,8] | 7#9 | dominante (3M) + m7 + #9 (iv[8]=3) |

> Les **étapes buildNotes** sont des décalages de degré dans la gamme :
> 0=fond, 1=2de, 2=3ce, 3=4te, 4=5te, 5=6te, 6=7e, 7=octave, 8=9e.
> Le moteur en déduit la qualité réelle selon la gamme (auto-détection).

## Colonne BORROWED (emprunts / modal interchange)

Définie dans `BORROWED_MAJOR` / `BORROWED_MINOR`. `{roman, semis, type, suf}` —
`semis` = décalage en demi-tons depuis la tonique. Jouée via `colorchord`.

**Majeur** : bIII, iv, bVI, bVII, V/V, V/ii, V/vi
**Mineur** : V, vii°, IV, bII, V/V, V/iv, V/VI

## Voicings (`VOICING_NAMES`)

**28 voicings.** L'index envoyé par l'UI (`voicingidx N`) est une position dans
cette table : le nom moteur (`VOICING_NAMES` dans `device/tuple_chord_engine.js`)
et le libellé UI (`VOICINGS` dans `device/ui/tuple_ui.html`) doivent rester dans
le même ordre. Un décalage d'une ligne décale tous les voicings suivants.

| # | nom moteur | libellé UI | idée |
|---|---|---|---|
| 0 | `classic` | Classic | position serrée |
| 1 | `piano` | Piano | fondamentale grave + reste groupé au-dessus (seul voicing deux-mains) |
| 2 | `open` | Open | 2e voix montée d'une octave |
| 3 | `spread` | Spread | une voix sur deux montée (large) |
| 4 | `house` | House | accord + doublure fondamentale octave (stab) |
| 5 | `prog` | Prog | nappe large prog-techno (basse grave / 3ce + ext. aigu) |
| 6 | `rootlessa` | Rootless A | sans fondamentale, structure telle quelle (3-5-7-9) |
| 7 | `rootlessb` | Rootless B | sans fondamentale, moitié basse montée (7-9-3-5) |
| 8 | `rootless` | Rootless | — |
| 9 | `drop2` | Drop 2 | 2e voix depuis le haut descendue d'une octave |
| 10 | `drop3` | Drop 3 | 3e voix depuis le haut descendue d'une octave |
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

Les `—` sont des voicings livrés mais non documentés ici — à décrire au fil de
l'eau, pas à supprimer de la table (leur position porte l'index).

> ⚠️ Deux entrées ont un nom moteur qui ne correspond pas à leur libellé UI :
> `nuhouse` affiché « New Jazz » (#12) et `jamiroquai` affiché « Clav » (#23).
> Le second est délibéré (nom de groupe écarté de l'UI). Le premier est à
> vérifier — « nuhouse » suggère « New House », pas « New Jazz ».

> **Règle de voicing** : la basse est toujours jouée par un instrument séparé,
> le device ne sort que l'accord. Chaque voicing doit rester un accord cohérent
> sur un seul registre, jouable d'une main — `piano` (#1) est la seule exception
> assumée.

## Gammes (`SCALES`)

major, minor, dorian, phrygian, lydian, mixolydian, harmminor (index 0–6).
