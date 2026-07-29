# Architecture

## Principe : une seule source de vérité

`device/tuple_chord_engine.js` est le **seul** endroit qui contient la logique
harmonique (gammes, intervalles, validité, construction des accords, voicings,
voice leading). Tous les autres fichiers sont des clients « bêtes » qui
consomment ce que le moteur produit.

```
                 ┌──────────────────────────────┐
                 │  device/tuple_chord_engine.js │  ← SOURCE DE VÉRITÉ
                 │  gammes / validité /          │
                 │  grille / voicings /          │
                 │  voice leading / notes        │
                 └───────────┬───────────────────┘
        grille (outlet 7)    │    notes jouées → 6 noteout → piste
        ┌────────────────────┼─────────────────────┐
        ▼                    ▼                      ▼
   device/ui/            push/ (parké,        (enregistrement
   tuple_ui.html         racine repo) —        sur 2e piste)
   (affiche +            LEDs + pads
    envoie clics)        futurs
        ▲
        │ entrée clavier
   device/tuple_midi_map.js ◀── notein → pack i i
```

## Flux de la grille (le cœur)

1. Un changement de KEY/SCALE (ou le chargement) appelle `broadcastGrid()`.
2. Le moteur calcule, pour chaque degré (0–6), les accords valides **contigus**
   (max 8 par colonne) + la colonne BORROWED.
3. Il diffuse via **outlet 7** une séquence de messages :
   - `gridclear`
   - `gridcell <col> <fn> <label>` × N
   - `gridbor <i> <label> <semis> <type> <roman>` × N
   - `griddone`
4. `device/ui/tuple_ui.html` (logique UI inline, pas de fichier JS séparé) reçoit, stocke (`gridCols` / `gridBor`) et redessine.
5. Le moteur construit aussi `flatGrid` (col-major) pour le mapping clavier/Push.

## Jouer un accord

- **Souris (UI)** : clic → `outlet(0, fn, col)` (diatonique) ou
  `outlet(0, "colorchord", semis, type)` (borrowed) → moteur → `sendChord`.
- **Clavier MIDI** : `notein` → `device/tuple_midi_map.js` → `"midinote pitch vel"` → moteur
  → `flatGrid[pitch-48]` → même case que l'UI.
- **Push (futur)** : pad → `playcell(col, row)` → moteur. Même chemin.

Tout finit sur les **6 `noteout`** → la piste → **enregistrable**.

## Protocole de messages (moteur ↔ UI)

### UI → moteur (outlet 0 du jsui → inlet 0 du moteur)
| Message | Effet |
|---|---|
| `triad 2`, `seven 0`, `six 4`, `mmaj7 5`… | joue l'accord (fn + degré) |
| `colorchord <semis> <type>` | joue un accord emprunté |
| `rootidx N` / `scaleidx N` | change tonique / gamme |
| `voicingidx N` | change le voicing |
| `octave N` | change le registre |
| `voiceleading on/off` | active le voice leading |
| `vlmode anchored/relative/piano` | mode de voice leading |
| `extended on/off` | affiche tous les accords (cap levé) |
| `synclive` | importe la tonalité de Live |
| `requestgrid` | demande une rediffusion de grille |
| `requeststate` | resync root/scale (après reload autowatch) |
| `release` | note off |

### Moteur → UI (outlet 7 du moteur → inlet 0 du jsui)
| Message | Effet |
|---|---|
| `gridclear` / `gridcell …` / `gridbor …` / `griddone` | diffusion grille |
| `root N` / `scale N` | sync affichage tonalité |
| `active <fn> <deg>` | highlight de la case jouée |
| `notes <n1 n2 …>` / `clearnotes` | moniteur clavier |

### Propagation vers midi_map / push (sans câblage)
Le moteur diffuse `root_idx` / `scale_idx` via `messnamed()` → reçus par les
objets `r root_idx` / `r scale_idx` du patch.

## Voice leading (2 modes)

Source de vérité : `VLMODES = ['ANCHOR','FLOW']` dans `device/ui/tuple_ui.html`
(messages internes : `anchored` / `flow`).

- **ANCHOR** : recentre l'accord (forme du voicing préservée) sur un registre
  fixe. Déterministe → boucles stables.
- **FLOW** : suit l'accord précédent (mouvement minimal, notes communes gardées).
  Centre pull **progressif** (0%–100% entre accords 8–20) pour éviter la dérive
  sans sauts abruptes.

> Historique : ce document a longtemps décrit trois modes (`ANCHOR` / `RELAT` /
> `PIANO`). `RELAT` a été renommé `FLOW`, et `PIANO` est devenu un **voicing**
> (voir `chord-types.md`), pas un mode de voice leading.

### Calcul `vlDistance()` (distance voicing)
Distance entre deux voicings, récompensant fluidité + cohérence musicale :
- Somme des écarts note-à-note (après tri).
- **Pénalité sauts** : +0.5× (ecart − 4) pour sauts > tierce.
- **Bonus common tones** : −6 par note commune (même pitch class, octave libre).
- **Pénalité registre** : +0.3× (écart zone 48–72) pour notes trop graves/aiguës.
- **Pénalité parallèles** : +8 pour chaque paire de quintes/octaves parallèles
  détectées sur l'ordre des voix (pas sur notes triées).

## Redimensionnement du device (collapse)

Le jsui envoie `setwidth <px>` sur **outlet 1** → `[deferlow]` → `live.thisdevice`.
Le `deferlow` est **obligatoire** (sinon Live ignore un setwidth déclenché par code).

## Enregistrement (capturer les accords générés)

Live n'enregistre pas la sortie d'un MIDI effect. Pour capturer les accords :
- Piste A : le device (où on joue).
- Piste B : MIDI From = piste A → **"Chord_selector"** (sortie post-device),
  Monitor = In, armée, instrument dessus.
- → la piste B enregistre les vraies notes d'accord, éditables.
