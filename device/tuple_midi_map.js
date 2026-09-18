// midi_map.js — relais clavier MIDI (Phase 2)
// Ne contient PLUS de logique harmonique : c'est le moteur qui mappe
// la note sur sa grille (source de vérité).
//
// inlet 0  → "pack i i" depuis notein  (pitch velocity)
// outlet 0 → "midinote <pitch> <velocity>" → chord_engine inlet 0
// inlet 3  → "pack i i" depuis ctlin (value controller) — relais CC pour piloter
//            CAPTURE et WRITE CLIP sans passer par l'UI jweb (aucun autre chemin
//            externe n'existe : LiveAPI ne voit pas l'intérieur du patch M4L).
//            CC 118 (valeur > 0) → capturetoggle · CC 119 (valeur > 0) → writeclip.
//            ⚠️ `writeclip`, PAS `sendclip` : `sendclip` écrit un clip et oublie tout, tandis
//            que `writeclip` établit le LIEN persistant que le live-sync réécrit ensuite. Les
//            deux réussissent visiblement (un clip apparaît), donc l'erreur ne se voit qu'à la
//            mutation suivante, quand rien ne se met à jour — mesuré le 2026-08-18.
//            Numéros choisis hors de toute plage standard (0-127 usuels de contrôleurs
//            physiques restent < 118), passthrough CC64 (sustain) inchangé ailleurs.
//
// (inlets/outlets supplémentaires conservés pour ne pas casser le câblage)

autowatch = 1;
inlets  = 4;
outlets = 3;

var CC_CAPTURE_TOGGLE = 118;
var CC_SEND_CLIP      = 119;

function list(a, b) {
	if (inlet === 3) {
		var value = parseInt(a), controller = parseInt(b);
		if (value <= 0) return;                       // ignore release (value 0)
		if (controller === CC_CAPTURE_TOGGLE) outlet(0, "capturetoggle");
		else if (controller === CC_SEND_CLIP) outlet(0, "writeclip");
		return;
	}
	outlet(0, "midinote", parseInt(a), parseInt(b));
}

// inlets 1/2 (scale/root) ignorés : le moteur n'en a plus besoin ici
function msg_int(v) { }

// Handlers vides : si l'outlet 7 du moteur (broadcast grille) est encore
// relié à midi_map, on ignore ces messages sans polluer la console.
function root()      { }
function scale()     { }
function active()    { }
function notes()     { }
function clearnotes(){ }
function gridclear() { }
function gridcell()  { }
function gridbor()   { }
function griddone()  { }
function qualities() { }

post("MIDI MAP (relais) LOADED\n");
