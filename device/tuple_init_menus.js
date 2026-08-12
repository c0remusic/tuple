// init_menus.js
// Peuple les umenu KEY, SCALE, VOICING au chargement du patch
//
// outlet 0 → umenu KEY
// outlet 1 → umenu SCALE
// outlet 2 → umenu VOICING

autowatch = 1;
inlets  = 1;
outlets = 3;

var KEYS    = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
var SCALES  = ["major","minor","dorian","phrygian","lydian","mixolydian","harmminor"];
var VOICING = ["classic","piano","open","spread","house","prog","rootless A","rootless B","drop 2","drop 3"];

function bang() {
	outlet(0, "clear");
	for (var i = 0; i < KEYS.length; i++) outlet(0, "append", KEYS[i]);

	outlet(1, "clear");
	for (var i = 0; i < SCALES.length; i++) outlet(1, "append", SCALES[i]);

	outlet(2, "clear");
	for (var i = 0; i < VOICING.length; i++) outlet(2, "append", VOICING[i]);

	post("MENUS INITIALIZED\n");
}
