// live_key_observer.js
// Lit root_note et scale_name de live_set
//
// inlet 0  → bang = refresh manuel
// outlet 0 → root_idx  (int 0-11)
// outlet 1 → scale_idx (int 0-6)

autowatch = 1;
inlets  = 1;
outlets = 2;

var NOTE_NAMES_DBG = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

var SCALE_MAP = {
	"major":          0,
	"minor":          1,
	"natural minor":  1,
	"dorian":         2,
	"phrygian":       3,
	"lydian":         4,
	"mixolydian":     5,
	"harmonic minor": 6,
	"harmminor":      6
};

// .get() peut renvoyer une valeur seule OU un tableau [valeur].
// On normalise toujours en valeur scalaire.
function unwrap(v) {
	if (v === null || v === undefined) return v;
	if (v instanceof Array) return v.length ? v[0] : null;
	return v;
}

function apiCallback() { /* requis pour résoudre le path */ }

var retries   = 0;
var MAX_RETRY = 30;
var retryTask = new Task(tryRead, this);

function isResolved(api) {
	return api && api.id !== undefined && api.id !== null && api.id != 0;
}

function retryOrGiveUp(why) {
	retries++;
	if (retries < MAX_RETRY) {
		retryTask.schedule(200);  // réessaie dans 200ms
	} else {
		post("Abandon après " + MAX_RETRY + " essais (" + why + ")\n");
	}
}

function tryRead() {
	var api = new LiveAPI(apiCallback, "live_set");

	if (!isResolved(api)) { retryOrGiveUp("API non résolue"); return; }

	var rawRoot  = unwrap(api.get("root_note"));
	var rawScale = unwrap(api.get("scale_name"));

	var root  = parseInt(rawRoot);
	var sname = String(rawScale).toLowerCase().trim();

	// Valeurs saines ? root entier 0-11 ET scale_name = chaîne connue.
	// Sinon l'API n'est pas vraiment prête → on réessaie.
	var rootOK  = (root >= 0 && root <= 11 && String(rawRoot).indexOf("e-") < 0);
	var scaleOK = (SCALE_MAP[sname] !== undefined);

	if (!rootOK || !scaleOK) {
		retryOrGiveUp("valeurs invalides root=" + rawRoot + " scale=" + rawScale);
		return;
	}

	post("Live key → " + NOTE_NAMES_DBG[root] + " " + sname + "\n");
	outlet(0, root);
	outlet(1, SCALE_MAP[sname]);
}

function bang() {
	retries = 0;
	retryTask.cancel();
	tryRead();
}

post("LIVE KEY OBSERVER LOADED\n");
