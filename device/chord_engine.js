autowatch = 1;

// =====================================================
// LOGGER FICHIER — tee de post() vers un fichier lisible hors Max.
// Permet de relire la console Max depuis l'extérieur (outil dev).
// Le fichier est remis à zéro à chaque (re)chargement du script.
// Chemin: device/max_console.log (à côté de ce .js).
// =====================================================
// DEBUG = 1 : active le tee fichier (outil dev — écrit device/max_console.log).
// DEBUG = 0 (release) : post() reste la console Max native — AUCUNE écriture disque,
// donc le chemin absolu DBG_LOG n'est jamais utilisé (portable sur toute machine).
var DEBUG = 0;
var DBG_LOG = "C:/Users/LEETJ/Desktop/CHORD SELECTOR/device/max_console.log";
var _origPost = post;
if (DEBUG) {
	(function _dbgInit(){
		try {
			var f = new File(DBG_LOG, "write");   // crée/tronque
			if (f.isopen) {
				f.writestring("=== chord_engine.js (re)chargé ===\n");
				f.close();
			}
		} catch(e) { _origPost("dbg init err: " + e + "\n"); }
	})();
	post = function(){
		var s = Array.prototype.slice.call(arguments).join(" ");
		_origPost(s);                              // console Max normale
		try {
			var f = new File(DBG_LOG, "readwrite");  // append
			if (f.isopen) { f.position = f.eof; f.writestring(s); f.close(); }
		} catch(e) {}
	};
}

post("CHORD ENGINE v5 LOADED\n");
// outlet 0   = velocity (partagé, tire TOUJOURS en premier)
// outlets 1..6 = pitch voix 1..6
// outlet 7   = feedback UI → "active <fn> <degree>" → jsui chord_ui
outlets = 8;
inlets  = 2;  // inlet 0 = messages accord/config, inlet 1 = velocity

// =====================================================
// POLYFILLS ES5 — le moteur JS de Max n'a PAS Set/Map (ES6).
// Le code vl2 (porté du bench Node) les utilise → on les fournit ici.
// Clés internes préfixées par type pour éviter toute collision avec
// les membres hérités d'Object.prototype (toString, constructor…).
// =====================================================
if (typeof Set === 'undefined') {
	Set = function(arr){
		this._k = {}; this._a = []; this.size = 0;
		if (arr) for (var i = 0; i < arr.length; i++) this.add(arr[i]);
	};
	Set.prototype.add = function(v){
		var k = (typeof v) + ':' + v;
		if (!this._k[k]) { this._k[k] = true; this._a.push(v); this.size++; }
		return this;
	};
	Set.prototype.has = function(v){ return !!this._k[(typeof v) + ':' + v]; };
}
if (typeof Map === 'undefined') {
	Map = function(){ this._k = {}; this._order = []; this.size = 0; };
	Map.prototype.has = function(k){ return !!this._k[(typeof k) + ':' + k]; };
	Map.prototype.get = function(k){ var e = this._k[(typeof k) + ':' + k]; return e ? e.v : undefined; };
	Map.prototype.set = function(k, v){
		var mk = (typeof k) + ':' + k;
		if (!this._k[mk]) { this._order.push(k); this.size++; }
		this._k[mk] = { v: v };
		return this;
	};
	Map.prototype['delete'] = function(k){
		var mk = (typeof k) + ':' + k;
		if (this._k[mk]) {
			delete this._k[mk];
			for (var i = 0; i < this._order.length; i++) if (this._order[i] === k) { this._order.splice(i, 1); break; }
			this.size--; return true;
		}
		return false;
	};
	Map.prototype.clear = function(){ this._k = {}; this._order = []; this.size = 0; };
	Map.prototype.keys = function(){
		var a = this._order.slice(), i = 0;
		return { next: function(){ return i < a.length ? { value: a[i++], done: false } : { value: undefined, done: true }; } };
	};
}

var lastFn           = "triad";
var lastDegree       = 0;

// =====================================================
// GAMMES
// =====================================================

var SCALES = {
	"major":      [0,2,4,5,7,9,11],
	"minor":      [0,2,3,5,7,8,10],
	"dorian":     [0,2,3,5,7,9,10],
	"phrygian":   [0,1,3,5,7,8,10],
	"lydian":     [0,2,4,6,7,9,11],
	"mixolydian": [0,2,4,5,7,9,10],
	"harmminor":  [0,2,3,5,7,8,11],
	"melminor":   [0,2,3,5,7,9,11],
	"locrian":    [0,1,3,5,6,8,10],
	"pentamaj":   [0,2,4,5,7,9,11],   // intervals = full major scale; SCALE_VALID_DEGREES mask hides IV+VII columns → pentatonic layout, major-scale voicings
	"pentamin":   [0,2,3,5,7,8,10],   // intervals = full natural minor scale; mask hides II+VI columns → pentatonic layout, minor-scale voicings
	"lydiandom":  [0,2,4,6,7,9,10]    // Lydian Dominant — 4e mode mél. min. ; I7(#11) caractéristique
};

// Degrés actifs (0-6) pour les gammes pentatoniques.
// Les degrés absents sont ignorés dans broadcastGrid → colonnes vides.
var SCALE_VALID_DEGREES = {
	"pentamaj": {0:1, 1:1, 2:1, 4:1, 5:1},   // I  II  III  V   VI
	"pentamin": {0:1, 2:1, 3:1, 4:1, 6:1}    // I  bIII IV  V  bVII
};

var NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
var NOTE_TO_PC = {
	"C":0,"C#":1,"D":2,"D#":3,"E":4,"F":5,
	"F#":6,"G":7,"G#":8,"A":9,"A#":10,"B":11
};

var root                = 0;
var scale               = SCALES["major"];
var scaleName           = "major";
var currentOctave       = 0;
var currentVelocity     = 100;
var currentVoicing      = "classic";
var voiceLeadingEnabled = false;
var activeNotes         = [];
var vlMode              = "anchored";  // "anchored" | "flow"
var lastColorSemis      = 0;          // dernier accord emprunté (pour vl2)
var lastColorType       = "maj";
var _strumMs            = 0;          // ms/note SIGNÉ : 0 = off, >0 = montant (grave→aigu), <0 = descendant (aigu→grave). Slider -60..60
var strumRamp           = 0;          // -100..100 : rampe de vélocité sur le strum. <0 = 1ère note forte puis fade, >0 = crescendo
var STRUM_CURVE_P       = [1.0, 0.55, 1.8];  // exposant : Linear · Accel · Decel
var strumCurve          = 0;          // Linear par défaut
var humanizeAmt         = 0;          // 0-100 : 0 = off ; variation vélocité ±25% + timing ±15ms
var _emitTasks          = [];         // Tasks de notes différées (strum/humanize) en cours

function loadbang() {
	try {
		var fp = this.patcher.filepath;
		var url;
		if (fp && fp.length > 0) {
			fp = fp.replace(/\\/g, '/');
			var dir = fp.substring(0, fp.lastIndexOf('/') + 1).replace(/ /g, '%20');
			// macOS paths start with '/' (→ file:// + /Users/…); Windows paths start
			// with 'C:/' (→ file:/// + C:/…). Prepending 'file:///' blindly produced
			// FOUR slashes on Mac (file:////Users/…) → ERR_FILE_NOT_FOUND. Add the
			// leading slash only when the path doesn't already have one.
			url = 'file://' + (dir.charAt(0) === '/' ? '' : '/') + dir + 'ui/tuple_ui.html';
		} else {
			// pas de fallback machine-spécifique : le device s'auto-localise via
			// patcher.filepath (toujours présent). Si vide, on n'envoie pas d'URL cassée.
			post('tuple: patcher.filepath vide — impossible de localiser ui/tuple_ui.html\n');
			return;
		}
		post('tuple: url=' + url + '\n');
		var sw = this.patcher.getnamed('tuple_strip_jweb');
		post('tuple: strip_jweb=' + (sw ? 'found' : 'null') + '\n');
		if (sw) sw.message('url', url);
		var fvp = this.patcher.getnamed('tuple_fullview_patcher');
		if (fvp) {
			var sub = fvp.subpatcher();
			if (sub) {
				var fw = sub.getnamed('tuple_full_jweb');
				if (fw) fw.message('url', url + '?full');
			}
		}
	} catch(e) { post('tuple: loadbang error: ' + e + '\n'); }
}

// =====================================================
// INLET 1 — velocity
// =====================================================

function msg_int(v) {
	if (inlet === 1) {
		currentVelocity = parseInt(v);
	}
}

// Adaptateur d'entrée jweb. Un [jweb] qui fait window.max.outlet('nine', 5)
// n'émet PAS un message-sélecteur "nine 5" mais une LISTE [nine, 5]. Max appelle
// donc list() au lieu de nine(). On redispatch ici le 1er élément (sélecteur) vers
// la vraie fonction du moteur. Aucune logique harmonique ici — pur routage.
// (Les messages à 1 seul argument — requestgrid, requeststate, synclive — arrivent
//  bien comme messages-sélecteurs natifs et n'ont pas besoin de cet adaptateur.)
function list() {
	var a = Array.prototype.slice.call(arguments);
	var sel = String(a[0]);
	var rest = a.slice(1);
	var D = {
		triad: triad, seven: seven, nine: nine, add9: add9, sus2: sus2, sus4: sus4,
		six: six, sixnine: sixnine, sevensus4: sevensus4, mmaj7: mmaj7,
		sevenflat9: sevenflat9, sevensharp9: sevensharp9, m7s5: m7s5,
		colorchord: colorchord, octave: octave, rootidx: rootidx, scaleidx: scaleidx,
		voicingidx: voicingidx, voiceleading: voiceleading, vlmode: vlmode,
		voicing: voicing, synclive: synclive, requestgrid: requestgrid,
		requeststate: requeststate, midinote: midinote, key: key,
		keynote: keynote, keynoteup: keynoteup, pushmode: pushmode,
		colorscheme: colorscheme, strumms: strumms, strumramp: strumramp,
		strumcurve: strumcurve, humanizeamt: humanizeamt,
		openurl: openurl
	};
	if (D[sel]) { D[sel].apply(null, rest); }
	else { post("list: selecteur jweb inconnu '" + sel + "' (" + rest.join(" ") + ")\n"); }
}

// =====================================================
// CLAVIER ORDINATEUR — via [key] dans le patch Max
// =====================================================
// Quand le jweb a le focus OS, Max peut encore intercepter les frappes
// via [key] (son propre loop d'événements). [key] envoie keynote/keynoteup
// à cet inlet → même chemin que notein → midinote.
//
// Layout piano standard (correspond au "Computer MIDI Keyboard" d'Ableton,
// base C3 = MIDI 48 = MIDI_BASE) :
//   rangée basse  : z s x d c v g b h n j m   → C3..B3 (48..59)
//   rangée haute  : q 2 w 3 e r 5 t 6 y 7 u i → C4..C5 (60..72)
var KEY_TO_MIDI = {
    122:48, 115:49, 120:50, 100:51,  99:52, 118:53, 103:54,
     98:55, 104:56, 110:57, 106:58, 109:59,
    113:60,  50:61, 119:62,  51:63, 101:64, 114:65,  53:66,
    116:67,  54:68, 121:69,  55:70, 117:71, 105:72
};
var KEY_VEL = 100;

function keynote(ascii) {
    ascii = parseInt(ascii);
    var pitch = KEY_TO_MIDI[ascii];
    if (pitch === undefined) return;
    if (pitch === activeMidiNote) return;  // dedup : déjà joué via notein
    midinote(pitch, KEY_VEL);
}

function keynoteup(ascii) {
    ascii = parseInt(ascii);
    var pitch = KEY_TO_MIDI[ascii];
    if (pitch !== undefined) { midinote(pitch, 0); }
}

// Absorbeurs d'événements émis par l'objet [jweb] sur son outlet lors du chargement
// de page (onloadstart, url <url>, title <titre>, onloadend...). Ils n'ont aucun sens
// pour le moteur : on les avale pour ne pas polluer la console Max.
function onbeforeload() {}
function onloadstart()  {}
function onloadend()    {}
function url()          {}
function title()        {}

// Liens externes : le [jweb] n'a pas d'onglets — un <a href> ferait naviguer le
// device EN PLACE (UI perdue, device inutilisable). L'UI intercepte le clic et nous
// envoie l'URL ici ; on l'ouvre dans le navigateur système via "; max launchbrowser".
function openurl(u) {
	try {
		max.message('launchbrowser', String(u));
		post('tuple: launchbrowser ' + u + '\n');
	} catch (e) {
		post('tuple: openurl error: ' + e + '\n');
	}
}

// =====================================================
// CONFIG
// =====================================================

function key(k) {
	k = String(k);
	if (NOTE_TO_PC[k] !== undefined) {
		root = NOTE_TO_PC[k];
		pushUIState();
	}
}

// Relaie uniquement l'état de config (octave, voicing, vl, vlmode) SANS rebuild de grille.
// À appeler quand seuls ces paramètres changent — la grille ne dépend pas d'eux.
function pushConfigState() {
	outlet(7, "octave", currentOctave);
	var vi = VOICING_NAMES.indexOf(currentVoicing);
	if (vi >= 0) outlet(7, "voicing", vi);
	outlet(7, "vl", voiceLeadingEnabled ? 1 : 0);
	outlet(7, "vlmode", vlMode);
	outlet(7, "strumms",    _strumMs);
	outlet(7, "strumramp",  strumRamp);
	outlet(7, "strumcurve", strumCurve);
	outlet(7, "humanize",   humanizeAmt);
}

// Relaie l'état complet (tonalité + config) ET rebuilde la grille.
// À appeler uniquement quand root ou scale change — pas pour octave/voicing/vl/vlmode.
//  - au jsui via outlet 7 (déjà câblé) → readout + grille
//  - à midi_map / push2 via messnamed → r root_idx / r scale_idx
//    (aucun câblage requis : touche les receive par leur nom)
function pushUIState() {
	outlet(7, "root", root);
	var si = SCALE_NAMES_ARR.indexOf(scaleName);
	if (si >= 0) outlet(7, "scale", si);

	pushConfigState();

	try {
		messnamed("root_idx", root);
		if (si >= 0) messnamed("scale_idx", si);
	} catch(e) {
		// chord_engine chargé hors patch (sans les receive) → on ignore
	}

	broadcastGrid();   // la grille dépend de root/scale → on rediffuse
}

// SYNC : relit la tonalité du set Live (bouton SYNC du jsui)
var LIVE_SCALE_MAP = {
	"major":0, "minor":1, "natural minor":1, "dorian":2, "phrygian":3,
	"lydian":4, "mixolydian":5, "harmonic minor":6, "harmminor":6,
	"melodic minor":7, "melminor":7, "locrian":8,
	"major pentatonic":9, "pentatonic major":9, "pentamaj":9,
	"minor pentatonic":10, "pentatonic minor":10, "pentamin":10,
	"lydian dominant":11, "lydiandom":11
};
function synclive() {
	try {
		var api = new LiveAPI(function(){}, "live_set");
		if (!api.id || api.id == 0) { post("SYNC : Live pas prêt\n"); return; }

		var rn = api.get("root_note");
		var sn = api.get("scale_name");
		if (rn instanceof Array) rn = rn[0];
		if (sn instanceof Array) sn = sn[0];
		rn = parseInt(rn);
		sn = String(sn).toLowerCase().trim();

		if (rn >= 0 && rn <= 11) root = rn;
		if (LIVE_SCALE_MAP[sn] !== undefined) setscale(SCALE_NAMES_ARR[LIVE_SCALE_MAP[sn]]);

		pushUIState();
		post("SYNC → " + NOTE_NAMES[root] + " " + scaleName + "\n");
	} catch(e) {
		post("SYNC erreur : " + e + "\n");
	}
}

// Reçoit un index int (0-11) depuis live.menu
function rootidx(v) {
	root = parseInt(v);
	_vl2_reset();
	pushUIState();
}

// Reçoit un index int (0-6) depuis live.menu
var SCALE_NAMES_ARR = ["major","minor","dorian","phrygian","lydian","mixolydian","harmminor","melminor","locrian","pentamaj","pentamin","lydiandom"];
function scaleidx(v) {
	setscale(SCALE_NAMES_ARR[parseInt(v)]);
	pushUIState();
}

function setscale(s) {
	s = String(s).toLowerCase();
	if (SCALES[s]) {
		scale = SCALES[s];
		scaleName = s;
		_vl2_reset();
	}
}

function major()      { setscale("major"); }
function minor()      { setscale("minor"); }
function dorian()     { setscale("dorian"); }
function phrygian()   { setscale("phrygian"); }
function lydian()     { setscale("lydian"); }
function mixolydian() { setscale("mixolydian"); }
function harmminor()  { setscale("harmminor"); }
function melminor()   { setscale("melminor"); }
function locrian()    { setscale("locrian"); }
function pentamaj()   { setscale("pentamaj"); }
function pentamin()   { setscale("pentamin"); }
function lydiandom()  { setscale("lydiandom"); }

function octave(v) {
	currentOctave = parseInt(v);
	_vl2_reset();        // le registre change : on repart à zéro (sinon la mémoire VL de
	                     // l'ancienne octave biaise le 1er accord du nouveau registre)
	pushConfigState();   // pas de rebuild grille : l'octave n'affecte pas les cellules
}

function voicing(v) {
	currentVoicing = String(v);
	pushConfigState();   // pas de rebuild grille : le voicing n'affecte pas les cellules
}

// Reçoit un index int (0-12) depuis live.menu
var VOICING_NAMES = ["classic","piano","open","spread","house","prog","rootlessa","rootlessb","drop2","drop3","jazz","nuhouse","trap","trance","funk"];
function voicingidx(v) {
	currentVoicing = VOICING_NAMES[parseInt(v)] || "classic";
	_vl2_reset();
	pushConfigState();   // pas de rebuild grille
}

function voiceleading(v) {
	// Accepte "on"/"off" (toggle jsui) ET 1/0 (toggle jweb)
	var s = String(v).toLowerCase();
	voiceLeadingEnabled = (s === "on" || s === "1" || s === "true");
	_vl2_reset();
	pushConfigState();   // pas de rebuild grille
}

function resetvoiceleading() {
	_vl2_reset();
}

// Reçoit "vlmode anchored" ou "vlmode relative"
function vlmode(m) {
	vlMode = String(m);
	_vl2_reset();
	pushConfigState();   // pas de rebuild grille
}

// =====================================================
// HELPERS
// =====================================================

function noteName(midi) {
	return NOTE_NAMES[((midi % 12) + 12) % 12];
}

// =====================================================
// VALIDATION D'INTERVALLES
// =====================================================

function getIntervals(d) {
	var iv = {};
	for (var step = 0; step <= 8; step++) {
		var absIdx      = d + step;
		var octShift    = Math.floor(absIdx / 7);
		var noteInScale = absIdx % 7;
		var semi        = scale[noteInScale] - scale[d % 7] + octShift * 12;
		iv[step]        = ((semi % 12) + 12) % 12;
	}
	return iv;
}

function isValid(d, type) {
	var iv = getIntervals(d);
	switch(type) {
		case "triad":     return true;
		case "sus2":      return iv[1] === 2  && iv[4] === 7;
		case "sus4":      return iv[3] === 5  && iv[4] === 7;
		case "seven":     return (iv[4] === 7 && (iv[6] === 10 || iv[6] === 11))   // maj7/min7/dom7
		                      || (iv[4] === 6 && (iv[6] === 9  || iv[6] === 10));  // dim7/ø7
		case "maj7":      return iv[4] === 7  && iv[6] === 11;
		case "dom7":      return iv[4] === 7  && iv[6] === 10;
		case "min7":      return iv[2] === 3  && iv[4] === 7  && iv[6] === 10;
		case "dim7":      return iv[2] === 3  && iv[4] === 6  && iv[6] === 9;
		case "hdim7":     return iv[2] === 3  && iv[4] === 6  && iv[6] === 10;
		case "nine":      return iv[4] === 7  && iv[6] === 10 && iv[8] === 2;
		case "maj9":      return iv[4] === 7  && iv[6] === 11 && iv[8] === 2;
		case "min9":      return iv[2] === 3  && iv[4] === 7  && iv[6] === 10 && iv[8] === 2;
		case "add9":      return iv[4] === 7  && iv[8] === 2;
		default: return false;
	}
}

// =====================================================
// GRILLE — SOURCE DE VÉRITÉ
// Le moteur calcule la grille et la diffuse à l'UI / Push (outlet 7).
// =====================================================

// Types affichés dans la grille, ordre = priorité (courants d'abord, alterés/jazz après).
// Tous les types valides au degré sont affichés — pas de cap.
var GRID_TYPES = ["triad","seven","nine","mmaj7","sus4","sus2","add9","six","sevensus4","sixnine","sevenflat9","sevensharp9","m7s5"];

// Accords empruntés par mode (déplacés ici : source de vérité)
var BORROWED_MAJOR = [
	{ roman:"bIII", semis:3,  type:"maj",  suf:""     },
	{ roman:"iv",   semis:5,  type:"min",  suf:"m"    },
	{ roman:"bVI",  semis:8,  type:"maj",  suf:""     },
	{ roman:"bVII", semis:10, type:"maj",  suf:""     },
	{ roman:"V/V",  semis:2,  type:"dom7", suf:"7"    },
	{ roman:"V/ii", semis:9,  type:"dom7", suf:"7"    },
	{ roman:"V/vi", semis:4,  type:"dom7", suf:"7"    }
];
var BORROWED_MINOR = [
	{ roman:"V",    semis:7,  type:"maj",  suf:""     },
	{ roman:"vii°", semis:11, type:"dim7", suf:"dim7" },
	{ roman:"IV",   semis:5,  type:"maj",  suf:""     },
	{ roman:"bII",  semis:1,  type:"maj",  suf:""     },
	{ roman:"V/V",  semis:2,  type:"dom7", suf:"7"    },
	{ roman:"V/iv", semis:0,  type:"dom7", suf:"7"    },
	{ roman:"V/VI", semis:3,  type:"dom7", suf:"7"    }
];
// Emprunts melodic minor : V7 (dominante naturelle) + bVII dominant (Lydian dominant)
var BORROWED_MELMINOR = [
	{ roman:"V7",    semis:7,  type:"dom7", suf:"7"    },
	{ roman:"bVII7", semis:10, type:"dom7", suf:"7"    },
	{ roman:"bII",   semis:1,  type:"maj",  suf:""     },
	{ roman:"IV",    semis:5,  type:"maj",  suf:""     }
];
var BORROWED_LYDIANDOM = [
	{ roman:"iv",   semis:5,  type:"min",  suf:"m"    },
	{ roman:"bII7", semis:1,  type:"dom7", suf:"7"    }
];
var BORROWED_DORIAN = [
	{ roman:"V7",   semis:7,  type:"dom7", suf:"7"    },
	{ roman:"bVI",  semis:8,  type:"maj",  suf:""     },
	{ roman:"bII",  semis:1,  type:"maj",  suf:""     }
];
var BORROWED_PHRYGIAN = [
	{ roman:"I",    semis:0,  type:"maj",  suf:""     },
	{ roman:"V7",   semis:7,  type:"dom7", suf:"7"    },
	{ roman:"IV",   semis:5,  type:"maj",  suf:""     }
];
var BORROWED_LYDIAN = [
	{ roman:"IV",   semis:5,  type:"maj",  suf:""     },
	{ roman:"bVII", semis:10, type:"maj",  suf:""     },
	{ roman:"v",    semis:7,  type:"min",  suf:"m"    }
];
var BORROWED_MIXOLYDIAN = [
	{ roman:"vii°7",semis:11, type:"dim7", suf:"dim7" }, // leading-tone dim7 borrowed from parallel major (not Mixolydian's own bVII)
	{ roman:"bVI",  semis:8,  type:"maj",  suf:""     },
	{ roman:"bIII", semis:3,  type:"maj",  suf:""     }
];
var BORROWED_HARMMINOR = [
	{ roman:"IV",   semis:5,  type:"maj",  suf:""     },
	{ roman:"bVII", semis:10, type:"maj",  suf:""     },
	{ roman:"bII",  semis:1,  type:"maj",  suf:""     }
];
var BORROWED_LOCRIAN = [
	{ roman:"I",    semis:0,  type:"maj",  suf:""     },
	{ roman:"V7",   semis:7,  type:"dom7", suf:"7"    },
	{ roman:"IV",   semis:5,  type:"maj",  suf:""     }
];
function borrowedFor() {
	if (scaleName === "major")      return BORROWED_MAJOR;
	if (scaleName === "minor")      return BORROWED_MINOR;
	if (scaleName === "melminor")   return BORROWED_MELMINOR;
	if (scaleName === "lydiandom")  return BORROWED_LYDIANDOM;
	if (scaleName === "dorian")     return BORROWED_DORIAN;
	if (scaleName === "phrygian")   return BORROWED_PHRYGIAN;
	if (scaleName === "lydian")     return BORROWED_LYDIAN;
	if (scaleName === "mixolydian") return BORROWED_MIXOLYDIAN;
	if (scaleName === "harmminor")  return BORROWED_HARMMINOR;
	if (scaleName === "locrian")    return BORROWED_LOCRIAN;
	return [];
}

// Validité d'une ligne de type à un degré (n'importe quelle qualité)
function gridTypeValid(d, fn) {
	var iv = getIntervals(d);
	switch(fn) {
		case "triad":       return true;
		case "six":         return iv[4]===7 && iv[5]===9;                 // 6 / m6 (6e majeure)
		case "sixnine":     return iv[4]===7 && iv[5]===9 && iv[8]===2;    // 6/9
		case "seven":       return isValid(d,"seven");
		case "maj7":        return iv[4]===7 && iv[6]===11;                // maj7 (explicite)
		case "mmaj7":       return iv[2]===3 && iv[4]===7 && iv[6]===11;   // mineur-majeur 7
		case "sevensus4":   return iv[3]===5 && iv[4]===7 && iv[6]===10;  // 7sus4
		case "nine":        return isValid(d,"maj9") || isValid(d,"min9") || isValid(d,"nine");
		case "sevenflat9":  return iv[2]!==3 && iv[4]===7 && iv[6]===10 && iv[8]===1;  // 7b9 (dominante)
		case "sevensharp9": return iv[2]!==3 && iv[4]===7 && iv[6]===10 && iv[8]===3;  // 7#9 (dominante)
		case "m7s5":        return iv[2]===3 && iv[4]===8 && iv[6]===10;   // m7#5 (alteré)
		case "add9":        return isValid(d,"add9");
		case "sus2":        return isValid(d,"sus2");
		case "sus4":        return isValid(d,"sus4");
		default: return false;
	}
}

// Nom d'accord affiché pour une case (degré + type)
function gridLabel(d, fn) {
	var iv = getIntervals(d);
	var rn = NOTE_NAMES[(root + scale[d]) % 12];
	if (fn === "triad") {
		if (iv[2]===3 && iv[4]===6) return rn + "dim";
		if (iv[2]===4 && iv[4]===8) return rn + "aug";
		if (iv[2]===3) return rn + "m";
		return rn;
	}
	if (fn === "sus2") return rn + "sus2";
	if (fn === "sus4") return rn + "sus4";
	if (fn === "add9") return (iv[2]===3 ? rn + "madd9" : rn + "add9");
	if (fn === "six")         return (iv[2]===3 ? rn + "m6"   : rn + "6");
	if (fn === "sixnine")     return (iv[2]===3 ? rn + "m6/9" : rn + "6/9");
	if (fn === "mmaj7")       return rn + "mMaj7";
	if (fn === "sevensus4")   return rn + "7sus4";
	if (fn === "sevenflat9")  return rn + "7b9";
	if (fn === "sevensharp9") return rn + "7#9";
	if (fn === "seven") {
		if (isValid(d,"maj7"))  return rn + "M7";
		if (isValid(d,"min7"))  return rn + "m7";
		if (isValid(d,"dom7"))  return rn + "7";
		if (isValid(d,"dim7"))  return rn + "dim7";
		if (isValid(d,"hdim7")) return rn + "ø7";
	}
	if (fn === "nine") {
		if (isValid(d,"maj9")) return rn + "M9";
		if (isValid(d,"min9")) return rn + "m9";
		if (isValid(d,"nine")) return rn + "9";
	}
	return rn;
}

// Grille "à plat" (col-major) pour le mapping MIDI clavier
var flatGrid = [];
// Grille 2D : gCols[colonne] = [ {fn} ... ] ; gBor = [ {semis,type} ... ]
// Pour jouer une case par (colonne, rangée) — utilisé par le Push.
var gCols = [[],[],[],[],[],[],[]];
var gBor  = [];

// Qualité du triade diatonique par degré : 0=majeur 1=mineur 2=diminué 3=augmenté.
function chordQuality(d) {
	function semi(step) { return scale[step % 7] + 12 * Math.floor(step / 7); }
	var root = semi(d), third = semi(d + 2) - root, fifth = semi(d + 4) - root;
	if (third === 3 && fifth === 6) return 2;
	if (third === 4 && fifth === 8) return 3;
	if (third === 3) return 1;
	return 0;
}

// Diffuse toute la grille à l'UI ET au Push (outlet 7) + reconstruit flatGrid/gCols/gBor
function broadcastGrid() {
	flatGrid = [];
	gCols = [[],[],[],[],[],[],[]];
	gBor  = [];
	outlet(7, "gridclear");
	var degMask = SCALE_VALID_DEGREES[scaleName];
	for (var d = 0; d < 7; d++) {
		if (degMask && !degMask[d]) continue;
		for (var t = 0; t < GRID_TYPES.length; t++) {
			var fn = GRID_TYPES[t];
			if (gridTypeValid(d, fn)) {
				outlet(7, "gridcell", d, fn, gridLabel(d, fn));
				flatGrid.push({ kind:"d", fn:fn, degree:d });
				gCols[d].push({ fn:fn });
			}
		}
	}
	var bl = borrowedFor();
	for (var i = 0; i < bl.length; i++) {
		var c = bl[i];
		var lbl = NOTE_NAMES[(root + c.semis) % 12] + c.suf;
		outlet(7, "gridbor", i, lbl, c.semis, c.type, c.roman);
		flatGrid.push({ kind:"b", semis:c.semis, type:c.type });
		gBor.push({ semis:c.semis, type:c.type });
	}
	var quals = [];
	for (var qd = 0; qd < 7; qd++) quals.push(chordQuality(qd));
	outlet(7, "qualities", quals[0], quals[1], quals[2], quals[3], quals[4], quals[5], quals[6]);
	outlet(7, "griddone");
}

// L'UI demande la grille (au chargement) — aussi appelé par Push (doInit -> requestgrid)
function requestgrid() {
	broadcastGrid();
}

// Synchronise l'état (key, scale) vers l'UI au reload
function requeststate() {
	pushUIState();
}

// Joue une case par (colonne, rangée) — entrée Push.
function playcell(col, row) {
	col = parseInt(col); row = parseInt(row);
	if (col === 7) {
		if (row >= 0 && row < gBor.length) colorchord(gBor[row].semis, gBor[row].type);
		return;
	}
	if (col >= 0 && col < 7 && row >= 0 && row < gCols[col].length) {
		playFlatCell({ kind:"d", fn:gCols[col][row].fn, degree:col });
	}
}

// Vélocité reçue avant un playcell (pad pressé)
function padvel(v) { currentVelocity = parseInt(v); }

function strumms(v) {
	_strumMs = Math.max(-250, Math.min(250, parseInt(v) || 0));  // signé : <0 descendant, >0 montant. >~60ms = arpège
	outlet(7, "strumms", _strumMs);
}
function strumramp(v) {
	strumRamp = Math.max(-100, Math.min(100, parseInt(v) || 0));
	outlet(7, "strumramp", strumRamp);
}
function strumcurve(v) {
	var i = parseInt(v);
	if (i >= 0 && i < STRUM_CURVE_P.length) strumCurve = i;
	outlet(7, "strumcurve", strumCurve);
}
function humanizeamt(v) {
	humanizeAmt = Math.max(0, Math.min(100, parseInt(v)));
	outlet(7, "humanize", humanizeAmt);
}

// Relais du toggle Push mode (UI jweb → module Push, via la sortie 7 déjà câblée).
function pushmode(v) { outlet(7, "pushmode", parseInt(v)); }

// Relais du schéma de couleur (cycler UI → module Push).
function colorscheme(v) { outlet(7, "colorscheme", parseInt(v)); }

// =====================================================
// ENTRÉE CLAVIER MIDI → case de la grille (Phase 2)
// Reçoit "midinote <pitch> <vel>" depuis midi_map (relais).
// Mappe la note sur la grille du moteur → cohérent avec l'UI.
// =====================================================
var MIDI_BASE      = 48;   // Do2 = première case
var activeMidiNote = -1;

function playFlatCell(cell) {
	if (cell.kind === "b") { colorchord(cell.semis, cell.type); return; }
	switch(cell.fn) {
		case "triad":       triad(cell.degree); break;
		case "six":         six(cell.degree); break;
		case "sixnine":     sixnine(cell.degree); break;
		case "seven":       seven(cell.degree); break;
		case "mmaj7":       mmaj7(cell.degree); break;
		case "sevensus4":   sevensus4(cell.degree); break;
		case "nine":        nine(cell.degree);  break;
		case "sevenflat9":  sevenflat9(cell.degree); break;
		case "sevensharp9": sevensharp9(cell.degree); break;
		case "add9":        add9(cell.degree);  break;
		case "sus2":        sus2(cell.degree);  break;
		case "sus4":        sus4(cell.degree);  break;
	}
}

function midinote(pitch, vel) {
	pitch = parseInt(pitch);
	vel   = parseInt(vel);

	if (vel === 0) {                       // note-off
		if (pitch === activeMidiNote) { activeMidiNote = -1; sendNoteOff(); }
		return;
	}

	var idx = pitch - MIDI_BASE;
	if (idx < 0 || idx >= flatGrid.length) return;

	currentVelocity = vel;
	activeMidiNote  = pitch;
	playFlatCell(flatGrid[idx]);
}

// =====================================================
// CONSTRUCTION DES NOTES
// =====================================================

function buildNotes(d, sidx) {
	var notes = [];
	for (var i = 0; i < sidx.length; i++) {
		var step        = sidx[i];
		var absIdx      = d + step;
		var octShift    = Math.floor(absIdx / 7);
		var noteInScale = absIdx % 7;
		var midi        = root + scale[noteInScale] + (4 + currentOctave + octShift) * 12;
		if (midi >= 0 && midi <= 127) notes.push(midi);
	}
	return notes;
}

// =====================================================
// VOICINGS
// =====================================================

function vsort(a) { return a.slice().sort(function(x,y){ return x-y; }); }

// PIANO : main gauche = fondamentale grave, main droite = reste de
// l'accord groupé au-dessus (avec un écart). Son pianistique classique.
function pianoVoicing(notes) {
	if (notes.length < 3) return notes;
	var s = vsort(notes);
	var bass = s[0] - 12;            // fondamentale une octave plus bas
	return [bass].concat(s.slice(1));
}

// OPEN : position ouverte — on monte la 2e voix d'une octave.
// Écartement modéré, plus aéré que le close.
function openVoicing(notes) {
	if (notes.length < 2) return notes;
	var s = vsort(notes);
	s[1] += 12;
	return vsort(s);
}

// SPREAD : écartement large — une voix sur deux montée d'une octave,
// voix imbriquées. Le plus ouvert.
function spreadVoicing(notes) {
	if (notes.length < 3) return notes;
	var s = vsort(notes);
	var r = [];
	for (var i = 0; i < s.length; i++) r.push(i % 2 === 1 ? s[i] + 12 : s[i]);
	return vsort(r);
}

// HOUSE : stab — accord complet + doublure de la fondamentale à
// l'octave au-dessus. Punchy, caractéristique du house piano.
function houseVoicing(notes) {
	if (notes.length < 3) return notes;
	var s = vsort(notes);
	return s.concat([s[0] + 12]);
}

// PROG HOUSE : la nappe prog techno/house ~1998-2005 (Sasha, Digweed,
// Cattáneo, Way Out West...). Fondamentale grave bien détachée, quinte
// au milieu pour l'ancrage, puis 3ce + extensions (7e/9e) projetées
// dans l'aigu pour ce côté large et émotionnel. Triades doublées à la
// quinte pour le shimmer.
function progHouseVoicing(notes) {
	if (notes.length < 3) return notes;
	var s = vsort(notes);
	var r = [];

	r.push(s[0]);                    // fondamentale (en registre — basse = instrument séparé)
	if (s.length >= 3) r.push(s[2]); // quinte au milieu (ancrage)
	r.push(s[1] + 12);               // 3ce projetée dans l'aigu

	for (var i = 3; i < s.length; i++) r.push(s[i] + 12);  // 7e, 9e... en haut

	if (s.length === 3) r.push(s[2] + 12);  // triade : quinte doublée (shimmer)

	r = vsort(r);
	if (r.length > 6) r = r.slice(0, 6);    // max 6 voix (6 noteout)
	return r;
}

// Rootless A : on retire la fondamentale, structure sup. telle quelle
// ex: Cm9 [C,Eb,G,Bb,D] → [Eb,G,Bb,D]  (3-5-7-9)
function rootlessAVoicing(notes) {
	if (notes.length < 3) return notes;
	return notes.slice(1);
}

// Rootless B : on retire la fondamentale puis on bascule la moitié
// basse une octave au-dessus
// ex: Cm9 [C,Eb,G,Bb,D] → [Bb,D,Eb+12,G+12]  (7-9-3-5)
function rootlessBVoicing(notes) {
	if (notes.length < 3) return notes;
	var u = notes.slice(1);                 // structure sans fondamentale
	var n = u.length;
	var botCount = Math.ceil(n / 2);
	var bottom = u.slice(0, botCount);
	var top    = u.slice(botCount);
	var r = top.slice();
	for (var i = 0; i < bottom.length; i++) r.push(bottom[i] + 12);
	return r;
}

// Drop 2 : depuis une position serrée, on descend la 2e voix
// depuis le haut d'une octave. Son ouvert et riche (jazz/nappes).
function drop2Voicing(notes) {
	if (notes.length < 3) return notes;
	var r = notes.slice().sort(function(a,b){ return a-b; });
	r[r.length - 2] -= 12;                       // 2e voix depuis le haut
	r.sort(function(a,b){ return a-b; });
	return r;
}

// Drop 3 : on descend la 3e voix depuis le haut d'une octave.
// Plus espacé encore. Nécessite au moins 4 notes.
function drop3Voicing(notes) {
	if (notes.length < 4) return notes;
	var r = notes.slice().sort(function(a,b){ return a-b; });
	r[r.length - 3] -= 12;                       // 3e voix depuis le haut
	r.sort(function(a,b){ return a-b; });
	return r;
}

function applyVoicing(notes) {
	switch(currentVoicing) {
		case "piano":     return pianoVoicing(notes);
		case "open":      return openVoicing(notes);
		case "spread":    return spreadVoicing(notes);
		case "house":     return houseVoicing(notes);
		case "prog":      return progHouseVoicing(notes);
		case "rootlessa": return rootlessAVoicing(notes);
		case "rootlessb": return rootlessBVoicing(notes);
		case "drop2":     return drop2Voicing(notes);
		case "drop3":     return drop3Voicing(notes);
		default:          return notes;
	}
}

// =====================================================
// OUTPUT — 6 outlets directs, chacun envoie [pitch, velocity]
// Le patch câble chaque outlet → unpack i i → noteout
// =====================================================
// VL2 ENGINE — inliné depuis device/vl2/src/ (import/export retirés)
// Actif automatiquement quand voiceLeadingEnabled.
// Mapping modes v1→v2 : "anchored"→"anchor" · "relative"/"piano"→"flow"
// =====================================================

// --- rules ---
var _vl2_LOW_LIMITS = [{iv:2,min:50},{iv:4,min:48},{iv:6,min:41}];
function _vl2_lowIntervalViolations(notes, shift) {
	var sh = shift || 0;
	var r = notes.slice().sort(function(a,b){return a-b;}), v = [];
	for (var i = 0; i < r.length-1; i++) {
		var iv = r[i+1]-r[i];
		for (var j = 0; j < _vl2_LOW_LIMITS.length; j++) {
			var L = _vl2_LOW_LIMITS[j];
			if (iv <= L.iv && r[i] < L.min + sh) { v.push(iv+'st@'+r[i]); break; }
		}
	}
	return v;
}
function _vl2_dominantThirdPc(spec) {
	if (!spec.isDominant) return null;
	for (var i = 0; i < spec.pcs.length; i++) if (spec.pcs[i].role==='third') return spec.pcs[i].pc;
	return null;
}

// --- identity ---
function _vl2_checkIdentity(voicing, notes, spec) {
	var v = [], m = function(n){return((n%12)+12)%12;};
	var ns = notes.slice().sort(function(a,b){return a-b;});
	var pcs = new Set(ns.map(m));
	var has = function(role){ var e=null; for(var i=0;i<spec.pcs.length;i++) if(spec.pcs[i].role===role){e=spec.pcs[i];break;} return e&&pcs.has(e.pc); };
	if (spec.hasSeventh) {
		if (!has('seventh')) v.push('guide:7e absente');
		var hasThird = false; for(var i=0;i<spec.pcs.length;i++) if(spec.pcs[i].role==='third'){hasThird=true;break;}
		if (hasThird && !has('third')) v.push('guide:3ce absente');
	}
	if (voicing==='rootlessa'||voicing==='rootlessb'||voicing==='jazz'||voicing==='nuhouse'||voicing==='house') { if (pcs.has(spec.rootPc)) v.push('rootless:fondamentale présente'); }
	else if (voicing==='trap') { if(m(ns[0])!==spec.rootPc)v.push('trap:basse ≠ fondamentale'); }
	else if (voicing==='drop2'||voicing==='drop3') {
		if (ns.length < 4) { v.push('dropN:<4 voix'); }
		else {
			var lifted = [ns[0]+12].concat(ns.slice(1)).sort(function(a,b){return a-b;});
			var maxGap=0; for(var i=0;i<lifted.length-1;i++) maxGap=Math.max(maxGap,lifted[i+1]-lifted[i]);
			if (maxGap>12) { v.push('dropN:base non-close'); }
			else {
				var fromTop=lifted.length-1-lifted.indexOf(ns[0]+12);
				if (voicing==='drop2'&&fromTop!==1) v.push('drop2:voix abaissée ≠ 2e du haut');
				if (voicing==='drop3'&&fromTop!==2) v.push('drop3:voix abaissée ≠ 3e du haut');
			}
		}
	}
	else if (voicing==='piano') {
		if (m(ns[0])!==spec.rootPc) v.push('piano:basse ≠ fondamentale');
		var rh=ns.slice(1);
		if (rh.length && Math.max.apply(null,rh)-Math.min.apply(null,rh)>12) v.push('piano:MD > 1 octave');
	}
	return v;
}

// --- chordspec builder (depuis l'état courant root/scale du moteur) ---
var _vl2_STEPS = {
	triad:[0,2,4], seven:[0,2,4,6], nine:[0,2,4,6,8], add9:[0,2,4,8],
	sus2:[0,1,4], sus4:[0,3,4], six:[0,2,4,5], sixnine:[0,2,4,5,8],
	sevensus4:[0,3,4,6], mmaj7:[0,2,4,6], sevenflat9:[0,2,4,6,8],
	sevensharp9:[0,2,4,6,8], m7s5:[0,2,4,6]
};
var _vl2_STEP_ROLE = {0:'root',1:'sus',2:'third',3:'sus',4:'fifth',5:'sixth',6:'seventh',8:'ninth'};

function _vl2_buildSpec(fn, d) {
	var m=function(n){return((n%12)+12)%12;}, steps=_vl2_STEPS[fn]; if(!steps) return null;
	var rootPc=m(root+scale[d%7]), pcs=[];
	for (var i=0;i<steps.length;i++) { var s=steps[i]; pcs.push({pc:m(root+scale[(d+s)%7]),role:_vl2_STEP_ROLE[s]}); }
	if (fn==='m7s5'&&pcs.length>2) pcs[2].pc=m(pcs[2].pc+1); // quinte augmentée
	var iv=function(p){return m(p.pc-rootPc);};
	var hasSev=false,isThird4=false,isSev10=false;
	for(var i=0;i<pcs.length;i++){
		if(pcs[i].role==='seventh') hasSev=true;
		if(pcs[i].role==='third'&&iv(pcs[i])===4) isThird4=true;
		if(pcs[i].role==='seventh'&&iv(pcs[i])===10) isSev10=true;
	}
	return {pcs:pcs, rootPc:rootPc, fn:fn, degree:d, hasSeventh:hasSev, isDominant:isThird4&&isSev10};
}

function _vl2_buildColorSpec(semis, type) {
	var m=function(n){return((n%12)+12)%12;};
	var IV={min:[0,3,7],dim7:[0,3,6,9],maj7:[0,4,7,11],dom7:[0,4,7,10],maj:[0,4,7]};
	var ROLES=['root','third','fifth','seventh'];
	var ivs=IV[type]||IV.maj, rootPc=m(root+semis), pcs=[];
	for(var i=0;i<ivs.length;i++) pcs.push({pc:m(rootPc+ivs[i]),role:ROLES[i]});
	return {pcs:pcs, rootPc:rootPc, fn:'color', degree:semis, hasSeventh:ivs.length>3, isDominant:type==='dom7'};
}

function _vl2_specKey(s) {
	var r=s.fn+':'+s.degree+':'; for(var i=0;i<s.pcs.length;i++) r+=(i?'.':'')+s.pcs[i].pc; return r;
}

// --- realizer ---
var _vl2_ROLE_ORDER=['root','sus','third','fifth','sixth','seventh','ninth'];
function _vl2_vs(a){return a.slice().sort(function(x,y){return x-y;});}
function _vl2_m(n){return((n%12)+12)%12;}
function _vl2_rotOf(arr){
	var out=[],r=_vl2_vs(arr);
	for(var i=0;i<arr.length;i++){out.push(r.slice());r=_vl2_vs(r.slice(1).concat([r[0]+12]));}
	return out;
}
function _vl2_closeFrom(spec,rootMidi){
	var ord=spec.pcs.slice().sort(function(a,b){return _vl2_ROLE_ORDER.indexOf(a.role)-_vl2_ROLE_ORDER.indexOf(b.role);});
	var out=[rootMidi],last=rootMidi;
	for(var i=1;i<ord.length;i++){var n=last+1;n+=_vl2_m(ord[i].pc-_vl2_m(n));out.push(n);last=n;}
	return out;
}
var _vl2_STRUCT=new Set(['piano','rootlessa','rootlessb','drop2','drop3','house','prog','jazz','nuhouse','trap','trance','funk']);
var _vl2_ABSOLUTE=new Set(['house','prog','jazz','nuhouse','trap','trance','funk']);
var _vl2_T={
	classic:function(c){return[c];},
	open:function(c){return c.length<2?[c]:[_vl2_vs(c.map(function(n,i){return i===1?n+12:n;}))];},
	spread:function(c){return c.length<3?[c]:[_vl2_vs(c.map(function(n,i){return i%2===1?n+12:n;}))];},
	// house : stab deep-house ROOTLESS (basse jouée à part), cluster serré ancré C3.
	house:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var hm=function(n){return((n%12)+12)%12;},pcs=c.slice(1).map(hm);
		if(c.length>=5)pcs=pcs.filter(function(p,i){return i!==1;});
		var floor=48+oct;
		var cluster=pcs.map(function(pc){return floor+hm(pc);}).sort(function(a,b){return a-b;})
			.filter(function(n,i,a){return i===0||n!==a[i-1];});
		return _vl2_rotOf(_vl2_vs(cluster));
	},
	// prog : pad root-inclus, structure pleine + fonda doublée à l'octave, ~1 octave, suit OCT.
	prog:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var pm=function(n){return((n%12)+12)%12;},rootPc=pm(c[0]),upperPc=c.slice(1).map(pm);
		var root=48+oct+rootPc,cl=[root],cur=root,i,n;
		for(i=0;i<upperPc.length;i++){n=cur+1+pm(upperPc[i]-pm(cur+1));cl.push(n);cur=n;}
		cl.push(root+12);
		return[_vl2_vs(cl).slice(0,6)];
	},
	piano:function(c){
		if(c.length<3)return[c];
		var pm=function(n){return((n%12)+12)%12;},rootPc=pm(c[0]);
		return _vl2_rotOf(c.slice(1)).map(function(rh){
			var lo=Math.min.apply(null,rh),d=pm(rootPc-pm(lo-12));if(d>6)d-=12;
			return[lo-12+d].concat(rh);  // basse ~1 octave sous la MD
		});
	},
	rootlessa:function(c){return c.length<3?[c]:_vl2_rotOf(c.slice(1));},
	rootlessb:function(c){
		if(c.length<3)return[c];
		var u=c.slice(1),k=Math.ceil(u.length/2);
		var sp=_vl2_vs(u.slice(k).concat(u.slice(0,k).map(function(n){return n+12;})));
		return[-1,0,1,2].map(function(o){return _vl2_vs(sp.map(function(n){return n+o*12;}));});
	},
	drop2:function(c){var r=_vl2_vs(c);r[r.length-2]-=12;return[_vl2_vs(r)];},
	drop3:function(c){var r=_vl2_vs(c);r[r.length-3]-=12;return[_vl2_vs(r)];},
	// trap : accord grave serré root-inclus verrouillé C3 (dark) ; la sub-808 jouée à part.
	trap:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var pm=function(n){return((n%12)+12)%12;},rootPc=pm(c[0]),upperPc=c.slice(1).map(pm);
		if(upperPc.length>=4)upperPc=upperPc.filter(function(_,i){return i!==1;});
		var root=48+oct+rootPc,cl=[root],cur=root,i,n;
		for(i=0;i<upperPc.length;i++){n=cur+1+pm(upperPc[i]-pm(cur+1));cl.push(n);cur=n;}
		return[_vl2_vs(cl)];
	},
	// nuhouse : rootless OUVERT aéré (2e voix +octave), 1 main, ancré C3, suit OCT.
	nuhouse:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var pm=function(n){return((n%12)+12)%12;},pcs=c.slice(1).map(pm),floor=48+oct;
		var cl=pcs.map(function(pc){return floor+pm(pc);}).sort(function(a,b){return a-b;})
			.filter(function(n,i,a){return i===0||n!==a[i-1];});
		if(cl.length>=2)cl[1]+=12;
		return[_vl2_vs(cl)];
	},
	jazz:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var pm=function(n){return((n%12)+12)%12;};
		var pcs=c.slice(1).map(pm),floor=48+oct,cluster=[],cur=floor;
		for(var i=0;i<pcs.length;i++){
			var n=cur+pm(pcs[i]-pm(cur));
			if(cluster.length&&n<=cluster[cluster.length-1])n+=12;
			cluster.push(n);cur=n;
		}
		return _vl2_rotOf(_vl2_vs(cluster));
	},
	// trance : anthem 1 main — fonda + 3ce (+7e) + fonda doublée à l'octave au sommet ;
	// lâche la 5te sur les 7e (son power). Root-inclus, centré, suit OCT.
	trance:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var pm=function(n){return((n%12)+12)%12;},rootPc=pm(c[0]),upperPc=c.slice(1).map(pm);
		if(upperPc.length>=3)upperPc=upperPc.filter(function(_,i){return i!==1;});
		var root=48+oct+rootPc,cl=[root],cur=root,i,n;
		for(i=0;i<upperPc.length;i++){n=cur+1+pm(upperPc[i]-pm(cur+1));cl.push(n);cur=n;}
		cl.push(root+12);
		return[_vl2_vs(cl).slice(0,6)];
	},
	// funk : grip "10e" root-inclus — fonda en bas + 3ce (c[1], ordre des rôles) montée
	// d'une octave = la dixième caractéristique. c[1] est TOUJOURS la 3ce, donc la 10e
	// reste lisible même sur 9e+ (où l'ancien tri remontait le 9th par erreur). Les voix
	// trop proches de la fonda (9th) montent d'une octave pour éviter la boue. 1 main.
	funk:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var pm=function(n){return((n%12)+12)%12;},floor=48+oct;
		var root=floor+pm(c[0]),third=floor+pm(c[1])+12;
		var rest=[];
		for(var i=2;i<c.length;i++){var n=floor+pm(c[i]);if(n-root<3)n+=12;rest.push(n);}
		var notes=_vl2_vs([root].concat(rest).concat([third]))
			.filter(function(n,i,a){return i===0||n!==a[i-1];});
		return[notes];
	}
};
function _vl2_stabilize(notes,spec,target){
	var out=notes.slice(),m=_vl2_m;
	var avoid=_vl2_dominantThirdPc(spec);
	var prefer=[];
	['root','fifth','third'].forEach(function(ro){
		for(var i=0;i<spec.pcs.length;i++){if(spec.pcs[i].role===ro&&spec.pcs[i].pc!==avoid){prefer.push(spec.pcs[i]);break;}}
	});
	var pi=0;
	while(out.length<target&&prefer.length){
		var pc=prefer[pi%prefer.length].pc;pi++;
		var top=Math.max.apply(null,out);
		out.push(top+1+m(pc-m(top+1)));
	}
	while(out.length>Math.min(target,6)){
		var fifth=null;for(var i=0;i<spec.pcs.length;i++){if(spec.pcs[i].role==='fifth'){fifth=spec.pcs[i];break;}}
		var idx=-1;if(fifth){for(var i=0;i<out.length;i++){if(m(out[i])===fifth.pc){idx=i;break;}}}
		out.splice(idx>=0?idx:out.length-1,1);
	}
	return _vl2_vs(out);
}
// regBase : plancher de l'octave, TOUJOURS multiple de 12 (48=C3 à oct0, 36=C2 à oct-1…).
// Conséquence : m(regBase)=0, donc tonicPos = regBase + root (addition directe, pas de modulo).
// octShift = regBase - 48 (décalage pour le filtre basse et les shape functions).
function _vl2_realize(spec,voicing,opts){
	var regBase=(opts&&opts.regBase!=null)?opts.regBase:48;
	var octShift=regBase-48;
	var want=(opts&&opts.targetVoices!=null)?opts.targetVoices:null;
	var vc=voicing,fallback=null;
	if((vc==='rootlessa'||vc==='rootlessb'||vc==='jazz'||vc==='nuhouse'||vc==='house')&&!spec.hasSeventh){fallback=vc;vc='classic';}
	if(vc==='drop3'&&spec.pcs.length<4){fallback=vc;vc='drop2';}
	if(vc==='drop2'&&spec.pcs.length<4){fallback=fallback||vc;vc='classic';}
	// classic VL off : tonique de la gamme en bas, tous les degrés strictement au-dessus.
	// tonicPos = regBase + root (root de la tonique dans ce registre).
	// cr      = tonicPos + m(pc - root) -> chaque degré placé au-dessus de la tonique.
	if(vc==='classic'&&opts&&opts.rootPos){
		var tonicPos=regBase+root;
		var cr=tonicPos+_vl2_m(spec.rootPc-root);
		var cn=_vl2_vs(_vl2_closeFrom(spec,cr)).slice(0,6);
		if(Math.min.apply(null,cn)<24||Math.max.apply(null,cn)>108)return[];
		if(_vl2_checkIdentity(vc,cn,spec).length)return[];
		return[{notes:cn,voicing:vc,fallback:fallback}];
	}
	var rotUp=function(arr){var r=_vl2_vs(arr);r.push(r.shift()+12);return _vl2_vs(r);};
	var seen=new Set(),out=[];
	for(var oct=-2;oct<=2;oct++){
		var base=48+oct*12,rootMidi=base+_vl2_m(spec.rootPc-_vl2_m(base));
		var inv=_vl2_closeFrom(spec,rootMidi);
		var nInv=_vl2_ABSOLUTE.has(vc)?1:spec.pcs.length;
		for(var k=0;k<nInv;k++){
			var TF=_vl2_T[vc]||_vl2_T.classic;
			var shapes=TF(inv,octShift);
			for(var si=0;si<shapes.length;si++){
				var notes=(want!=null&&!_vl2_STRUCT.has(vc))?_vl2_stabilize(shapes[si],spec,want):_vl2_vs(shapes[si]).slice(0,6);
				if(Math.min.apply(null,notes)<24||Math.max.apply(null,notes)>108)continue;
				if(_vl2_checkIdentity(vc,notes,spec).length)continue;
				if(!_vl2_ABSOLUTE.has(vc)&&_vl2_lowIntervalViolations(notes,octShift).length)continue;
				var key=notes.join(',');if(seen.has(key))continue;seen.add(key);
				out.push({notes:notes,voicing:vc,fallback:fallback});
			}
			inv=rotUp(inv);
		}
	}
	return out;
}

// --- selector ---
var _vl2_W={
	move:1,leapOver:4,leapFactor:0.7,
	common:-7,commonPc:-2,
	soprano:2.2,bass:1.2,bassFreeLeaps:[5,7,12],
	parallel:10,spacingGap:0.8,countDiff:6,
	contrary:-1.5,spring:0.04,recall:-6,
	window:9,knee:25,
	tendency:-5,chromatic:-3,
	crossing:12
};
var _vl2_W_jazz={
	move:1,leapOver:4,leapFactor:0.5,
	common:-7,commonPc:-2,
	soprano:1.8,bass:1.0,bassFreeLeaps:[],
	parallel:4,spacingGap:0.8,countDiff:6,
	contrary:-1.5,spring:0.04,recall:-6,
	window:9,knee:25,
	tendency:-5,chromatic:-5,
	crossing:12
};
var _vl2_JAZZ_VC={rootlessa:1,rootlessb:1,drop2:1,drop3:1,house:1,jazz:1,nuhouse:1};
function _vl2_pickW(vc){return _vl2_JAZZ_VC[vc]?_vl2_W_jazz:_vl2_W;}
function _vl2_movCost(prev,cand,w){
	if(!w)w=_vl2_W;
	var a=_vl2_vs(prev),b=_vl2_vs(cand),n=Math.min(a.length,b.length);
	var tot=Math.abs(a.length-b.length)*w.countDiff;
	var bSet=new Set(b),commons=0;
	for(var i=0;i<a.length;i++) if(bSet.has(a[i])){tot+=w.common;commons++;}
	for(var i=0;i<n;i++){
		var isTop=i===n-1,isBass=i===0,d=Math.abs(b[i]-a[i]);if(d===0)continue;
		var wv=w.move*(isTop?w.soprano:isBass?w.bass:1);
		tot+=d*wv;
		var freeBass=isBass&&w.bassFreeLeaps.indexOf(d)>=0;
		if(d>w.leapOver&&!freeBass)tot+=(d-w.leapOver)*w.leapFactor*(isTop?w.soprano:1);
		if(_vl2_m(a[i])===_vl2_m(b[i]))tot+=w.commonPc;
	}
	for(var j=0;j<n-1;j++){
		var i1=_vl2_m(a[j+1]-a[j]),i2=_vl2_m(b[j+1]-b[j]);
		if(i1===i2&&(i1===0||i1===7)&&a[j]!==b[j])tot+=w.parallel;
	}
	for(var j=1;j<b.length-1;j++) if(b[j+1]-b[j]>12)tot+=(b[j+1]-b[j]-12)*w.spacingGap;
	if(n>=2){var db=b[0]-a[0],dt=b[n-1]-a[n-1];if(db!==0&&dt!==0&&(db>0)!==(dt>0))tot+=w.contrary;}
	var crosses=0;
	for(var ci=0;ci<n-1;ci++){var dir=Math.abs(b[ci]-a[ci])+Math.abs(b[ci+1]-a[ci+1]);var sw=Math.abs(b[ci+1]-a[ci])+Math.abs(b[ci]-a[ci+1]);if(sw<dir)crosses++;}
	if(crosses)tot+=crosses*w.crossing;
	return tot;
}
function _vl2_harmBonus(prev,cand,opts,w){
	var ps=opts.prevSpec,sp=opts.spec;if(!ps||!sp||!prev||!prev.length)return 0;
	if(!w)w=_vl2_W;
	var a=_vl2_vs(prev),b=_vl2_vs(cand),n=Math.min(a.length,b.length),bonus=0,chrom=0;
	var apcs=new Set(a.map(_vl2_m)),bpcs=new Set(b.map(_vl2_m));
	if(ps.isDominant){
		var tri3=null,tri7=null;
		for(var i=0;i<ps.pcs.length;i++){if(ps.pcs[i].role==='third')tri3=ps.pcs[i];if(ps.pcs[i].role==='seventh')tri7=ps.pcs[i];}
		if(tri3&&apcs.has(tri3.pc)&&bpcs.has(_vl2_m(tri3.pc+1)))bonus+=w.tendency;
		if(tri7&&apcs.has(tri7.pc)&&bpcs.has(_vl2_m(tri7.pc-1)))bonus+=w.tendency;
		if(_vl2_m(ps.rootPc-sp.rootPc)===7){
			var thi=null;for(var i=0;i<sp.pcs.length;i++) if(sp.pcs[i].role==='third'){thi=sp.pcs[i];break;}
			if(tri7&&thi&&apcs.has(tri7.pc)&&bpcs.has(thi.pc)&&!bpcs.has(tri7.pc))bonus+=w.tendency;
		}
	}
	for(var i=0;i<n&&chrom<2;i++) if(Math.abs(b[i]-a[i])===1){bonus+=w.chromatic;chrom++;}
	return bonus;
}
var _vl2_st={voices:null,recall:new Map()};
function _vl2_resetState(){_vl2_st.voices=null;_vl2_st.recall.clear();}
var _vl2_prevSpec=null;
function _vl2_reset(){_vl2_resetState();_vl2_prevSpec=null;}
function _vl2_select(cands,opts){
	var st=_vl2_st,mode=opts.mode,center=opts.center,key=opts.key;
	var w=_vl2_pickW(opts.voicing||'');
	var mean=function(ns){var s=0;for(var i=0;i<ns.length;i++)s+=ns[i];return s/ns.length;};
	var same=function(a,b){if(a.length!==b.length)return false;for(var i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;};
	if(mode==='anchor'&&st.recall.has(key)){var nn=st.recall.get(key).slice();st.voices=nn.slice();return nn;}
	var first=st.voices===null,best=null,bestC=Infinity;
	for(var ci=0;ci<cands.length;ci++){
		var c=cands[ci],cost;
		if(first){cost=Math.abs(mean(c.notes)-center);}
		else{
			cost=_vl2_movCost(st.voices,c.notes,w)+_vl2_harmBonus(st.voices,c.notes,opts,w);
			if(mode==='flow'){
				var dev=Math.abs(mean(c.notes)-center);
				cost+=w.spring*dev*dev;
				// soft knee : au-delà de la fenêtre, freinage QUADRATIQUE (raccord en pente
				// nulle à dev=window -> pas d'à-coup, et plus ferme à mesure qu'on s'éloigne).
				if(dev>w.window){var ov=dev-w.window;cost+=w.knee*ov*ov;}
				var rc=st.recall.get(key);
				if(rc&&same(rc,c.notes))cost+=w.recall;
			}
		}
		if(cost<bestC){bestC=cost;best=c;}
	}
	st.voices=best.notes.slice();
	if(st.recall.size>64)st.recall.delete(st.recall.keys().next().value);
	st.recall.set(key,best.notes.slice());
	return best.notes;
}

// --- façade vl2 ---
// Mapping mode v1 → v2 : "anchored"→"anchor" · "relative"→"flow" · "piano"→ voicing piano + flow
function _vl2_play(fn,d,colorSemis,colorType){
	var spec=(fn==='color')?_vl2_buildColorSpec(colorSemis,colorType):_vl2_buildSpec(fn,d);
	if(!spec)return null;
	var vc=currentVoicing,mode='anchor';
	if(voiceLeadingEnabled){
		mode=(vlMode==='anchored')?'anchor':'flow';
	} else {
		_vl2_reset();   // VL OFF : pas de mémoire de mouvement -> chaque accord au plus proche du centre
	}
	// regBase : plancher de l'octave (multiple de 12, invariant).
	// selCtr  : tonique pour classic (ancrage harmonique), C-ancré pour les autres voicings.
	var regBase=48+Math.max(-12,Math.min(24,currentOctave*12));
	var selCtr=(vc==='classic')?(regBase+root):(60+currentOctave*12);
	var key=_vl2_specKey(spec)+'|'+vc+'|'+selCtr;
	var cands=_vl2_realize(spec,vc,{regBase:regBase,rootPos:!voiceLeadingEnabled});
	if(!cands.length)return null;
	var notes=_vl2_select(cands,{mode:mode,center:selCtr,key:key,voicing:vc,spec:spec,prevSpec:_vl2_prevSpec});
	_vl2_prevSpec=spec;
	return notes;
}

// =====================================================

// Distribution triangulaire centrée sur 0, plage [-1,1] (somme de 2 uniformes).
// Plus musical qu'une uniforme : les petites variations dominent, les extrêmes rares.
function _bell() { return Math.random() + Math.random() - 1; }

function humanizeVel(v) {
	v = Math.max(1, Math.min(127, Math.round(v)));   // clamp toujours (la rampe peut dépasser 127)
	if (!humanizeAmt) return v;
	var spread = humanizeAmt * 0.25;           // 100% → ±25
	var off = Math.round(_bell() * spread);
	return Math.max(1, Math.min(127, v + off));
}

// Micro-décalage de timing en ms (humanize). 100% → ±15ms environ.
function humanizeTime() {
	if (!humanizeAmt) return 0;
	return _bell() * (humanizeAmt / 100 * 15);
}

function _cancelEmit() {
	for (var ci = 0; ci < _emitTasks.length; ci++) {
		try { _emitTasks[ci].cancel(); } catch(e) {}
	}
	_emitTasks = [];
}

// Émet les notes avec strum (espacement courbé) et/ou humanize (vélocité + timing).
// Chemin rapide (tout à 0) si ni strum ni humanize → aucun Task créé.
function _emitNotes(notes) {
	var n = notes.length;
	var mag = Math.abs(_strumMs);
	var strum = mag > 0 && n > 1;
	if (!strum && !humanizeAmt) {
		outlet(0, currentVelocity);
		for (var i = 0; i < n && i < 6; i++) outlet(i + 1, notes[i]);
		return;
	}
	// On classe par hauteur (l'ordre interne du voicing n'est PAS trié).
	// rank[idx] = position de note[idx] dans l'ordre croissant des hauteurs (0 = plus grave).
	var order = [];
	for (var j = 0; j < n; j++) order.push(j);
	order.sort(function(a, b) { return notes[a] - notes[b]; });
	var rank = [];
	for (var rr = 0; rr < n; rr++) rank[order[rr]] = rr;

	var up = _strumMs >= 0;                      // sens : >0 grave→aigu, <0 aigu→grave
	var T = strum ? (n - 1) * mag : 0;           // durée nominale du strum
	var p = STRUM_CURVE_P[strumCurve] || 1.0;
	for (var k = 0; k < n && k < 6; k++) {
		(function(idx, note) {
			// seq = position dans la SÉQUENCE de jeu (0 = 1ère note jouée), selon le sens.
			var seq = strum ? (up ? rank[idx] : (n - 1 - rank[idx])) : 0;
			var base = strum ? T * Math.pow(seq / (n - 1), p) : 0;
			var off = base + humanizeTime();
			if (off < 0) off = 0;
			// Rampe de vélocité le long de la séquence : pos 0..1, facteur 1±0.5·ramp.
			var v = currentVelocity;
			if (strum && strumRamp) {
				var pos = (n > 1) ? seq / (n - 1) : 0;
				v = currentVelocity * (1 + (strumRamp / 100) * (pos * 2 - 1) * 0.5);
			}
			var nv = humanizeVel(Math.round(v));
			if (off < 0.5) { outlet(0, nv); outlet(idx + 1, note); return; }
			var t = new Task(function() { outlet(0, nv); outlet(idx + 1, note); });
			_emitTasks.push(t);
			t.schedule(off);
		})(k, notes[k]);
	}
}

function sendNoteOff() {
	_cancelEmit();
	if (activeNotes.length === 0) return;
	outlet(0, 0);  // velocity=0 arrive en PREMIER dans tous les noteout
	for (var i = 0; i < activeNotes.length && i < 6; i++) {
		outlet(i + 1, activeNotes[i]);  // pitches, déclenchent noteout avec vel=0
	}
	activeNotes = [];
	outlet(7, "clearnotes");  // efface le clavier moniteur
}

function sendChord(name, notes) {
	// Voicing TOUJOURS via vl2 (15 voicings) ; le bouton VL ne pilote que le lissage dynamique.
	// applyVoicing (v1) = simple filet de secours si vl2 ne sort aucun candidat.
	var v2 = _vl2_play(lastFn, lastDegree, lastColorSemis, lastColorType);
	notes = (v2 && v2.length) ? v2 : applyVoicing(notes);
	sendNoteOff();
	activeNotes = notes.slice();
	_emitNotes(notes);
	outlet(7, "active", lastFn, lastDegree);   // highlight grille
	outlet(7, ["notes"].concat(activeNotes));  // → clavier moniteur
}

// =====================================================
// TYPES D'ACCORDS
// =====================================================

function triad(d) {
	d = parseInt(d); lastFn = "triad"; lastDegree = d;
	var notes = buildNotes(d, [0,2,4]);
	var iv = getIntervals(d);
	var q = (iv[2]===3 && iv[4]===6) ? "dim"
	      : (iv[2]===4 && iv[4]===8) ? "aug"
	      : (iv[2]===3) ? "m" : "";
	sendChord(noteName(notes[0]) + q, notes);
}

function seven(d) {
	d = parseInt(d); lastFn = "seven"; lastDegree = d;
	if (!isValid(d, "seven")) { post("seven " + d + " : invalid\n"); return; }
	var notes = buildNotes(d, [0,2,4,6]);
	var iv = getIntervals(d);
	var q = iv[6]===11 ? "maj7"
	      : (iv[2]===3 && iv[4]===6 && iv[6]===10) ? "ø7"
	      : (iv[2]===3 && iv[4]===6 && iv[6]===9)  ? "dim7"
	      : (iv[2]===3) ? "m7" : "7";
	sendChord(noteName(notes[0]) + q, notes);
}

function nine(d) {
	d = parseInt(d); lastFn = "nine"; lastDegree = d;
	if (!isValid(d,"nine") && !isValid(d,"maj9") && !isValid(d,"min9")) {
		post("nine " + d + " : invalid\n"); return;
	}
	var notes = buildNotes(d, [0,2,4,6,8]);
	var iv = getIntervals(d);
	var q = iv[6]===11 ? "maj9" : (iv[2]===3) ? "m9" : "9";
	sendChord(noteName(notes[0]) + q, notes);
}

function add9(d) {
	d = parseInt(d); lastFn = "add9"; lastDegree = d;
	if (!isValid(d, "add9")) { post("add9 " + d + " : invalid\n"); return; }
	var notes = buildNotes(d, [0,2,4,8]);
	var iv = getIntervals(d);
	var q = (iv[2]===3) ? "m" : "";
	sendChord(noteName(notes[0]) + q + "add9", notes);
}

function sus2(d) {
	d = parseInt(d); lastFn = "sus2"; lastDegree = d;
	if (!isValid(d, "sus2")) { post("sus2 " + d + " : invalid\n"); return; }
	var notes = buildNotes(d, [0,1,4]);
	sendChord(noteName(notes[0]) + "sus2", notes);
}

function sus4(d) {
	d = parseInt(d); lastFn = "sus4"; lastDegree = d;
	if (!isValid(d, "sus4")) { post("sus4 " + d + " : invalid\n"); return; }
	var notes = buildNotes(d, [0,3,4]);
	sendChord(noteName(notes[0]) + "sus4", notes);
}

// ----- Nouveaux types -----

function six(d) {
	d = parseInt(d); lastFn = "six"; lastDegree = d;
	if (!gridTypeValid(d, "six")) return;
	var notes = buildNotes(d, [0,2,4,5]);        // root, 3ce, 5te, 6te
	var iv = getIntervals(d);
	sendChord(noteName(notes[0]) + (iv[2]===3 ? "m6" : "6"), notes);
}

function sixnine(d) {
	d = parseInt(d); lastFn = "sixnine"; lastDegree = d;
	if (!gridTypeValid(d, "sixnine")) return;
	var notes = buildNotes(d, [0,2,4,5,8]);      // + 9e
	var iv = getIntervals(d);
	sendChord(noteName(notes[0]) + (iv[2]===3 ? "m6/9" : "6/9"), notes);
}

function sevensus4(d) {
	d = parseInt(d); lastFn = "sevensus4"; lastDegree = d;
	if (!gridTypeValid(d, "sevensus4")) return;
	var notes = buildNotes(d, [0,3,4,6]);        // root, 4te, 5te, 7e
	sendChord(noteName(notes[0]) + "7sus4", notes);
}

function mmaj7(d) {
	d = parseInt(d); lastFn = "mmaj7"; lastDegree = d;
	if (!gridTypeValid(d, "mmaj7")) return;
	var notes = buildNotes(d, [0,2,4,6]);        // root, 3ce min, 5te, 7e maj
	sendChord(noteName(notes[0]) + "mMaj7", notes);
}

function sevenflat9(d) {
	d = parseInt(d); lastFn = "sevenflat9"; lastDegree = d;
	if (!gridTypeValid(d, "sevenflat9")) return;
	var notes = buildNotes(d, [0,2,4,6,8]);      // + b9
	sendChord(noteName(notes[0]) + "7b9", notes);
}

function sevensharp9(d) {
	d = parseInt(d); lastFn = "sevensharp9"; lastDegree = d;
	if (!gridTypeValid(d, "sevensharp9")) return;
	var notes = buildNotes(d, [0,2,4,6,8]);      // + #9
	sendChord(noteName(notes[0]) + "7#9", notes);
}

function m7s5(d) {
	d = parseInt(d); lastFn = "m7s5"; lastDegree = d;
	if (!gridTypeValid(d, "m7s5")) return;
	var notes = buildNotes(d, [0,2,4,6]);
	// Augmenter la quinte (index 2) d'un demi-ton
	if (notes.length > 2) notes[2]++;
	sendChord(noteName(notes[0]) + "m7#5", notes);
}

function release() {
	sendNoteOff();
}

// =====================================================
// ACCORDS EMPRUNTÉS (borrowed / modal interchange)
// Construit un accord à partir d'un décalage en demi-tons depuis
// la tonique + un type explicite. Passe par le pipeline normal
// (voicing, voice leading, sortie, moniteur).
// =====================================================

function colorchord(semis, type) {
	semis = parseInt(semis);
	type  = String(type);

	var ivs;
	switch(type) {
		case "min":   ivs = [0,3,7];    break;
		case "dim7":  ivs = [0,3,6,9];  break;
		case "maj7":  ivs = [0,4,7,11]; break;
		case "dom7":  ivs = [0,4,7,10]; break;
		default:      ivs = [0,4,7];    break;  // maj
	}

	var base  = root + semis + (4 + currentOctave) * 12;
	var notes = [];
	for (var i = 0; i < ivs.length; i++) {
		var m = base + ivs[i];
		if (m >= 0 && m <= 127) notes.push(m);
	}

	lastFn = "color"; lastDegree = semis;
	lastColorSemis = semis; lastColorType = type;
	var suffix = (type === "min") ? "m" : (type === "dim7") ? "dim7"
	           : (type === "maj7") ? "maj7" : (type === "dom7") ? "7" : "";
	sendChord(noteName(notes[0]) + suffix, notes);
}

// Diffusion initiale de la grille (différée le temps que l'UI charge)
var gridInitTask = new Task(broadcastGrid, this);
gridInitTask.schedule(700);

// =====================================================
// SELF-CHECK — confirme que les globals critiques sont initialisés.
// Visible dans device/max_console.log après (re)chargement.
// =====================================================
(function _selfCheck(){
	try {
		var okSt = (typeof _vl2_st !== 'undefined' && _vl2_st && _vl2_st.recall);
		// VOICING_NAMES doit avoir 15 entrées (classic..funk). Si on en ajoute sans
		// mettre à jour l'UI (VOICINGS dans tuple_ui.html), le mapping par index diverge.
		var vcOk = VOICING_NAMES.length === 15;
		post("tuple selfcheck: Set=" + (typeof Set !== 'undefined') +
		     " Map=" + (typeof Map !== 'undefined') +
		     " _vl2_st=" + (okSt ? "ok" : "KO") +
		     " STRUCT=" + (typeof _vl2_STRUCT !== 'undefined') +
		     " VOICING_NAMES=" + VOICING_NAMES.length + (vcOk ? "" : " ⚠️ DESYNC UI") + "\n");
	} catch(e) { post("tuple selfcheck ERROR: " + e + "\n"); }
})();

