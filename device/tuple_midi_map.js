// midi_map.js — relais clavier MIDI (Phase 2)
// Ne contient PLUS de logique harmonique : c'est le moteur qui mappe
// la note sur sa grille (source de vérité).
//
// inlet 0  → "pack i i" depuis notein  (pitch velocity)
// outlet 0 → "midinote <pitch> <velocity>" → chord_engine inlet 0
//
// (inlets/outlets supplémentaires conservés pour ne pas casser le câblage)

autowatch = 1;
inlets  = 3;
outlets = 3;

function list(pitch, velocity) {
	outlet(0, "midinote", parseInt(pitch), parseInt(velocity));
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
