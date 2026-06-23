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
var DBG_LOG = "C:/Users/LEETJ/Desktop/Tuple/device/max_console.log";
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
// Intervalles des accords empruntés (par type) — SOURCE UNIQUE : colorchord + _vl2_buildColorSpec.
var COLOR_IV = { min:[0,3,7], dim7:[0,3,6,9], maj7:[0,4,7,11], dom7:[0,4,7,10], maj:[0,4,7] };

var root                = 0;
var scale               = SCALES["major"];
var scaleName           = "major";
var currentOctave       = 0;
var currentVelocity     = 100;
var currentVoicing      = "classic";
var voiceLeadingEnabled = false;
var activeNotes         = [];
var lastChordNotes      = [];         // dernier accord JOUÉ (non vidé par sendNoteOff) — pour le glisser → ajout
var vlMode              = "anchored";  // "anchored" | "flow"
var lastColorSemis      = 0;          // dernier accord emprunté (pour vl2)
var lastColorType       = "maj";
var _strumMs            = 0;          // ms/note SIGNÉ : 0 = off, >0 = montant (grave→aigu), <0 = descendant (aigu→grave). Slider -60..60
var strumRamp           = 0;          // -100..100 : rampe de vélocité sur le strum. <0 = 1ère note forte puis fade, >0 = crescendo
var STRUM_CURVE_P       = [1.0, 0.55, 1.8];  // exposant : Linear · Accel · Decel
var strumCurve          = 0;          // Linear par défaut
var humanizeAmt         = 0;          // 0-100 : 0 = off ; variation vélocité ±55 + timing ±60ms
var _emitTasks          = [];         // Tasks de notes différées (strum/humanize) en cours

var TUPLE_VERSION = "1.3.1";

var _patcher = null;

// Construit l'URL file:// de l'UI depuis patcher.filepath, multi-plateforme.
// macOS renvoie un chemin "Max-style" : "<Volume>:/chemin" (séparateur '/'). Conversion en POSIX :
//   - volume de DÉMARRAGE (chemin → /Users, /Applications…) : on retire le volume (le boot EST "/").
//   - autre volume (disque EXTERNE) : "<Vol>:/…" → "/Volumes/<Vol>/…" (point de montage macOS).
//   - déjà POSIX (commence par '/') : inchangé.
// Windows "C:/…" (lettre de lecteur) : laissé tel quel. Puis POSIX → file:///… ; Windows → file:///C:/…
function _uiUrl() {
	if (!_patcher) return "";
	var fp = _patcher.filepath;
	if (!fp || !fp.length) return "";
	fp = fp.replace(/\\/g, '/');
	if (!/^[A-Za-z]:\//.test(fp) && fp.charAt(0) !== '/') {
		var vol  = fp.substring(0, fp.indexOf(':'));
		var rest = fp.replace(/^[^/:]*:\//, '/');
		fp = /^\/(Users|Applications|Library|System|private|opt|usr|Volumes)\//.test(rest) ? rest : ('/Volumes/' + vol + rest);
	}
	var dir = fp.substring(0, fp.lastIndexOf('/') + 1).replace(/ /g, '%20');
	return 'file://' + (dir.charAt(0) === '/' ? '' : '/') + dir + 'ui/tuple_ui.html';
}

// Envoie l'URL au jweb de la GRANDE fenêtre (sous-patcher tuple_fullview).
function _sendFullUrl() {
	if (!_patcher) return;
	var url = _uiUrl(); if (!url) return;
	var fvp = _patcher.getnamed('tuple_fullview_patcher'); if (!fvp) return;
	var sub = fvp.subpatcher(); if (!sub) return;
	var fw = sub.getnamed('tuple_full_jweb'); if (fw) fw.message('url', url + '?full&v=' + TUPLE_VERSION + '&t=' + (new Date()).getTime());
}

function loadbang() {
	try {
		_patcher = this.patcher;
		post('Tuple v' + TUPLE_VERSION + ' — loadbang\n');
		post('tuple: raw filepath=' + this.patcher.filepath + '\n');   // DIAGNOSTIC
		var url = _uiUrl();
		if (!url) { post('tuple: patcher.filepath vide — impossible de localiser ui/tuple_ui.html\n'); return; }
		post('tuple: url=' + url + '\n');
		var sw = this.patcher.getnamed('tuple_strip_jweb');
		post('tuple: strip_jweb=' + (sw ? 'found' : 'null') + '\n');
		if (sw) sw.message('url', url + '?v=' + TUPLE_VERSION + '&t=' + (new Date()).getTime());
		_sendFullUrl();
	} catch(e) { post('tuple: loadbang error: ' + e + '\n'); }
}

// OPEN DEVICE → l'UI envoie 'openwindow full'. On RE-ENVOIE l'URL au jweb de la grande fenêtre :
// le loadbang peut tourner avant que ce jweb (dans le sous-patcher) soit prêt, donc sur macOS il
// gardait le chemin dev codé en dur → grande fenêtre blanche. Le re-send à l'ouverture le corrige.
function openwindow(which) {
	if (String(which) === 'full') { _sendFullUrl(); }
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
// Table de dispatch jweb → moteur. Construite UNE SEULE FOIS (les cibles sont des function
// declarations, hoisted) au lieu de réallouer ~45 clés à CHAQUE message reçu (chemin chaud).
var LIST_DISPATCH = {
	triad: triad, seven: seven, nine: nine, add9: add9, sus2: sus2, sus4: sus4,
	six: six, sixnine: sixnine, sevensus4: sevensus4, mmaj7: mmaj7,
	sevenflat9: sevenflat9, sevensharp9: sevensharp9, m7s5: m7s5,
	colorchord: colorchord, octave: octave, rootidx: rootidx, scaleidx: scaleidx,
	voicingidx: voicingidx, voiceleading: voiceleading, vlmode: vlmode,
	voicing: voicing, synclive: synclive, requestgrid: requestgrid,
	requeststate: requeststate, midinote: midinote, key: key,
	keynote: keynote, keynoteup: keynoteup, pushmode: pushmode, smart: smart, smartmode: smartmode,
	colorscheme: colorscheme, strumms: strumms, strumramp: strumramp,
	strumcurve: strumcurve, humanizeamt: humanizeamt,
	openurl: openurl, openwindow: openwindow, installupdate: installupdate,
	capture: capture, sendclip: sendclip, clearprog: clearprog, removelast: removelast,
	removeat: removeat, setcursor: setcursor, playprog: playprog, moveprog: moveprog,
	captureone: captureone, autosync: setautosync, progress: handleprogress,
	useflats: useflats, preview: preview, previewcolor: previewcolor, previewprog: previewprog, extended: extended,
	chordify: chordify,
	progmode: progmode, progmodecycle: progmodecycle, selprog: selprog, selopt: selopt
};
function list() {
	var a = Array.prototype.slice.call(arguments);
	var sel = String(a[0]);
	if (LIST_DISPATCH[sel]) { LIST_DISPATCH[sel].apply(null, a.slice(1)); }
	else { post("list: selecteur jweb inconnu '" + sel + "' (" + a.slice(1).join(" ") + ")\n"); }
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
// (KEY_TO_MIDI / KEY_VEL retirés : morts depuis que keynote()/keynoteup() sont des no-op.
//  Le clavier ORDINATEUR est géré par l'UI jweb — KB_MAP dans tuple_ui.html — qui envoie 'midinote'.)

// [key] (clavier ORDINATEUR interne au device) DÉSACTIVÉ : il faisait DOUBLON avec le « Computer
// MIDI Keyboard » d'Ableton (→ notein). Quand les deux sont actifs (surtout à des octaves
// différentes), UNE touche déclenchait DEUX accords (et polluait la capture). On joue désormais
// uniquement via l'entrée MIDI (notein / Computer MIDI Keyboard d'Ableton).
function keynote(ascii)   { }
function keynoteup(ascii) { }

// Absorbeurs d'événements émis par l'objet [jweb] sur son outlet lors du chargement
// de page (onloadstart, url <url>, title <titre>, onloadend...). Ils n'ont aucun sens
// pour le moteur : on les avale pour ne pas polluer la console Max.
function onbeforeload() {}
function onloadstart()  {}
function onloadend()    {
	// jweb finished loading — safe to init the LiveAPI auto-sync observers now.
	if (typeof Task !== 'undefined') { var t = new Task(function(){ _initAutoSync(); }, this); t.schedule(300); }
	else { _initAutoSync(); }
}
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
// ── Auto-updater install (node.script tuple_dl) ──────────────────────────────
// The node.script boots its Node process lazily — the FIRST 'dl' message hits
// "Node script not ready can't handle message dl". So: kick the script, then
// RETRY 'dl' up to 6× (1.5 s apart) until Node answers. tuple_dl's _busy lock
// ignores the duplicate 'dl' once a download is running (→ a single download).
// handleprogress('done') clears _dlUrl, which makes the next _doDl tick stop the
// retry loop. THIS retry/kick is what made the in-app install actually work.
var _dlUrl = null, _dlPlatform = null, _dlAmxdPath = null, _dlAttempts = 0;
function installupdate(url, platform) {
	var ndl = _patcher ? _patcher.getnamed('tuple_dl') : null;
	if (!ndl) {
		post('tuple: installupdate — tuple_dl not found, fallback to browser\n');
		openurl(String(url));
		return;
	}
	if (_dlUrl) { post('tuple: installupdate — already pending, ignoring\n'); return; }
	post('tuple: installupdate → starting node.script (platform=' + platform + ')\n');
	_dlUrl = String(url); _dlPlatform = String(platform);
	_dlAmxdPath = _patcher ? String(_patcher.filepath) : '';
	_dlAttempts = 0;
	ndl.message('script', 'start');   // kick the Node.js process (no-op if already running)
	var t = new Task(_doDl); t.schedule(1500);
}
function _doDl() {
	if (!_dlUrl) return;              // cleared by handleprogress('done') → stops the retry
	_dlAttempts++;
	var ndl = _patcher ? _patcher.getnamed('tuple_dl') : null;
	if (!ndl) { post('tuple: _doDl — tuple_dl gone\n'); _dlUrl = null; _dlPlatform = null; _dlAmxdPath = null; _dlAttempts = 0; return; }
	post('tuple: _doDl attempt ' + _dlAttempts + '\n');
	ndl.message('dl', _dlUrl, _dlPlatform, _dlAmxdPath);
	if (_dlAttempts < 6) { var t = new Task(_doDl); t.schedule(1500); }
	else { post('tuple: _doDl — gave up after 6 attempts\n'); _dlUrl = null; _dlPlatform = null; _dlAmxdPath = null; _dlAttempts = 0; }
}
// tuple_dl reports back via its outlet → obj-CE (this js) → handleprogress.
// The message arrives as the SELECTOR 'progress <state>' (node.script outlet,
// NOT a jweb list), so Max calls progress() directly — define it explicitly.
// (The LIST_DISPATCH entry only covers the jweb-list path, which never fires here.)
function progress(state) { handleprogress(state); }
function useflats(v) { outlet(7, 'useflats', parseInt(v) !== 0 ? 1 : 0); }

function handleprogress(state) {
	if (String(state) === 'done') {
		_dlUrl = null; _dlPlatform = null; _dlAmxdPath = null; _dlAttempts = 0;
		outlet(7, 'updatedone');
		post('tuple: update installed — reload the device to apply\n');
	} else if (String(state) === 'error') {
		_dlUrl = null; _dlPlatform = null; _dlAmxdPath = null; _dlAttempts = 0;
		outlet(7, 'updateerror');
		post('tuple: update download failed\n');
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
	if (smartOn && smartMode === "voiceleading") _sg_broadcast();   // seul le voice-leading dépend du voicing/octave/VL ; en function les suggestions sont inchangées → pas de recalcul
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
	outlet(7, "autosync", _autoSync ? 1 : 0);   // keep the SYNC button + KEY/SCALE lock in sync after a jweb reload

	pushConfigState();

	try {
		messnamed("root_idx", root);
		if (si >= 0) messnamed("scale_idx", si);
	} catch(e) {
		// chord_engine chargé hors patch (sans les receive) → on ignore
	}

	_sg_reset();          // key/scale a changé → on efface la mémoire smart live AVANT de rediffuser
	broadcastSurface();   // grille (dépend de root/scale) + heat-map smart repartie de zéro
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
		outlet(7, "sync", 1);   // flash the SYNC button in the jweb
		post("SYNC → " + NOTE_NAMES[root] + " " + scaleName + "\n");
	} catch(e) {
		post("SYNC erreur : " + e + "\n");
	}
}

// ── Auto-sync : observe Live's root_note + scale_name, re-sync on every change ──
// Same pattern as Tupline: the observers are ALWAYS attached; the callback checks
// the _autoSync flag before acting. The SYNC button toggles _autoSync via 'autosync'
// and locks KEY/SCALE in the UI while ON.
var _liveSyncApiRoot  = null;
var _liveSyncApiScale = null;
var _autoSync = false;
function _taskDefer(fn) {
	if (typeof Task !== 'undefined') { var t = new Task(fn, this); t.schedule(1); }
	else { fn(); }
}
function setautosync(v) {
	_autoSync = parseInt(v) !== 0;
	post('tuple: auto-sync ' + (_autoSync ? 'ON' : 'OFF') + '\n');
	if (_autoSync) _taskDefer(synclive);   // immediate sync on enable
}
function _initAutoSync() {
	if (typeof LiveAPI === 'undefined') return;
	try {
		_liveSyncApiRoot  = new LiveAPI(function(){ if (_autoSync) _taskDefer(synclive); }, 'live_set');
		_liveSyncApiRoot.property  = 'root_note';
		_liveSyncApiScale = new LiveAPI(function(){ if (_autoSync) _taskDefer(synclive); }, 'live_set');
		_liveSyncApiScale.property = 'scale_name';
		post('tuple: auto-sync observers ready\n');
	} catch(e) { post('tuple: auto-sync init error: ' + e + '\n'); }
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
var VOICING_NAMES = ["classic","piano","open","spread","house","prog","rootlessa","rootlessb","rootless","drop2","drop3","jazz","nuhouse","trance","funk","quartal","upper","organ","frenchtouch","broken","deeptech","detroit","soul","jamiroquai","rave","sus","wide","power"];
function voicingidx(v) {
	currentVoicing = VOICING_NAMES[parseInt(v)] || "classic";
	_vl2_reset();
	pushConfigState();   // pas de rebuild grille
}

function voiceleading(v) {
	// Accepte "on"/"off" (toggle jsui) ET 1/0 (toggle jweb)
	var s = String(v).toLowerCase();
	sendNoteOff(); activeMidiNote = -1;   // libère toute note tenue → le toggle ne peut pas laisser de note coincée (no-op si rien ne sonne)
	voiceLeadingEnabled = (s === "on" || s === "1" || s === "true");
	_vl2_reset();
	pushConfigState();   // pas de rebuild grille
}

function resetvoiceleading() {
	_vl2_reset();
}

// Reçoit "vlmode anchored" ou "vlmode relative"
function vlmode(m) {
	sendNoteOff(); activeMidiNote = -1;   // idem : pas de note orpheline au changement de mode
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

function isValid(d, type, iv) {
	iv = iv || getIntervals(d);
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
// Ordre = PRIORITÉ d'affichage. La fenêtre principale prend les MAX_GRID_ROWS premiers types valides
// par colonne ; la fenêtre EXT reçoit le complément (cf. validGridCells). sixnine (6/9) placé juste
// après six (plus courant que 7sus4/altérés → reste dans la principale quand une colonne déborde).
var GRID_TYPES = ["triad","seven","nine","mmaj7","sus4","sus2","add9","six","sixnine","sevensus4","sevenflat9","sevensharp9","m7s5"];
var MAX_GRID_ROWS = 8;   // fenêtre principale : 8 rangées max (jamais de débordement vertical)

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
// Emprunts melodic minor : bVII7 (Lydian dominant) + bII (Napolitain). V7 et IV RETIRÉS (audit Loi 1 E :
// ils sont DIATONIQUES au mélodique mineur → déjà offerts par la grille, pas des emprunts).
var BORROWED_MELMINOR = [
	{ roman:"bVII7", semis:10, type:"dom7", suf:"7"    },
	{ roman:"bII",   semis:1,  type:"maj",  suf:""     }
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
function gridTypeValid(d, fn, iv) {
	iv = iv || getIntervals(d);
	switch(fn) {
		case "triad":       return true;
		case "six":         return iv[4]===7 && iv[5]===9;                 // 6 / m6 (6e majeure)
		case "sixnine":     return iv[4]===7 && iv[5]===9 && iv[8]===2;    // 6/9
		case "seven":       return isValid(d,"seven",iv);
		case "maj7":        return iv[4]===7 && iv[6]===11;                // maj7 (explicite)
		case "mmaj7":       return iv[2]===3 && iv[4]===7 && iv[6]===11;   // mineur-majeur 7
		case "sevensus4":   return iv[3]===5 && iv[4]===7 && iv[6]===10;  // 7sus4
		case "nine":        return isValid(d,"maj9",iv) || isValid(d,"min9",iv) || isValid(d,"nine",iv);
		case "sevenflat9":  return iv[2]!==3 && iv[4]===7 && iv[6]===10 && iv[8]===1;  // 7b9 (dominante)
		case "sevensharp9": return iv[2]!==3 && iv[4]===7 && iv[6]===10 && iv[8]===3;  // 7#9 (dominante)
		case "m7s5":        return iv[2]===3 && iv[4]===8 && iv[6]===10;   // m7#5 (alteré)
		case "add9":        return isValid(d,"add9",iv);
		case "sus2":        return isValid(d,"sus2",iv);
		case "sus4":        return isValid(d,"sus4",iv);
		default: return false;
	}
}

// Nom d'accord affiché pour une case (degré + type)
function gridLabel(d, fn, iv, ext) {
	iv = iv || getIntervals(d);
	var rn = NOTE_NAMES[(root + scale[d]) % 12];
	var x = (ext === undefined || ext === null) ? extendedOn : ext;   // x = nom étendu (CM7 -> CM13…)
	if (fn === "triad") {
		if (iv[2]===3 && iv[4]===6) return rn + "dim";
		if (iv[2]===4 && iv[4]===8) return rn + "aug";
		if (iv[2]===3) return rn + (x ? "madd9" : "m");
		return rn + (x ? "6/9" : "");
	}
	if (fn === "sus2") return rn + "sus2";
	if (fn === "sus4") return rn + "sus4";
	if (fn === "add9") return (iv[2]===3 ? rn + "madd9" : rn + (x ? "6/9" : "add9"));
	if (fn === "six")         return (iv[2]===3 ? rn + (x ? "m6/9" : "m6")   : rn + (x ? "6/9" : "6"));
	if (fn === "sixnine")     return (iv[2]===3 ? rn + "m6/9" : rn + "6/9");
	if (fn === "mmaj7")       return rn + (x ? "mMaj9" : "mMaj7");
	if (fn === "sevensus4")   return rn + "7sus4";
	if (fn === "sevenflat9")  return rn + (x ? "13b9" : "7b9");
	if (fn === "sevensharp9") return rn + (x ? "13#9" : "7#9");
	if (fn === "seven") {
		if (isValid(d,"maj7",iv))  return rn + (x ? "M13" : "M7");
		if (isValid(d,"min7",iv))  return rn + (x ? "m11" : "m7");
		if (isValid(d,"dom7",iv))  return rn + (x ? "13" : "7");
		if (isValid(d,"dim7",iv))  return rn + (x ? "dim9" : "dim7");
		if (isValid(d,"hdim7",iv)) return rn + (x ? "ø11" : "ø7");
	}
	if (fn === "nine") {
		if (isValid(d,"maj9",iv)) return rn + (x ? "M13" : "M9");
		if (isValid(d,"min9",iv)) return rn + (x ? "m11" : "m9");
		if (isValid(d,"nine",iv)) return rn + (x ? "13" : "9");
	}
	if (fn === "m7s5") return rn + (x ? "m9#5" : "m7#5");   // m7♯5 (quinte augmentée)
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
	var rt = semi(d), third = semi(d + 2) - rt, fifth = semi(d + 4) - rt;
	if (third === 3 && fifth === 6) return 2;
	if (third === 4 && fifth === 8) return 3;
	if (third === 3) return 1;
	return 0;
}

// =====================================================================
// SMART CHORDS — scoring (miroir ES5 de site/vl2/suggest.js) + état.
// Indépendant du voicing/VL : ne lit que degré + type + pitch classes.
// Réutilise _vl2_buildSpec / _vl2_buildColorSpec (hoisted, définis plus bas).
// =====================================================================
var smartOn = false;
var smartMode = "function";   // "function" = meilleur score harmonique ; "voiceleading" = plus fluide (voicing). Reçu de l'UI.
var SG_PER_FN = 3;            // par FONCTION de transition (les 5) : nb MAX d'accords colorés (plusieurs par degré possibles)
var _sg_hist = [];            // mémoire live : [{kind, degree, pcs}], récents en fin
var SG_HIST_MAX = 8;

var SG_MAJOR = [
	[0.2,0.6,0.4,0.7,0.7,0.6,0.3],[0.3,0.0,0.3,0.4,0.9,0.3,0.6],
	[0.3,0.4,0.0,0.6,0.3,0.8,0.2],[0.6,0.5,0.3,0.0,0.9,0.4,0.5],
	[0.95,0.2,0.3,0.3,0.0,0.6,0.2],[0.3,0.7,0.4,0.7,0.6,0.0,0.2],
	[0.9,0.2,0.5,0.2,0.3,0.4,0.0]
];
var SG_MINOR = [
	[0.2,0.5,0.4,0.7,0.7,0.6,0.4],[0.3,0.0,0.3,0.4,0.9,0.3,0.5],
	[0.3,0.4,0.0,0.5,0.4,0.7,0.5],[0.6,0.4,0.3,0.0,0.9,0.4,0.4],
	[0.95,0.2,0.3,0.3,0.0,0.6,0.2],[0.3,0.6,0.5,0.6,0.5,0.0,0.4],
	[0.4,0.2,0.8,0.3,0.3,0.4,0.0]
];
function _sg_clamp(v){ return v < 0 ? 0 : (v > 1 ? 1 : v); }
function _sg_level(s){ if (s >= 0.75) return 3; if (s >= 0.55) return 2; if (s >= 0.40) return 1; return 0; }
// Rang de fluidité -> palier de luminosité (3 = plus fluide, 1 = moins). Miroir : site/vl2/fluidity.js levelByRank.
function _sg_fluidLevel(rankIndex, total){
	if (total <= 1) return 3;
	var frac = rankIndex / (total - 1);
	return frac < 0.34 ? 3 : frac < 0.67 ? 2 : 1;
}
function _sg_isMinor(){ return chordQuality(0) === 1; }

// SUBSTITUTS (mode Push « Substituts ») — accords pouvant REMPLACER une étape, même emplacement
// harmonique : frères de FONCTION (I↔iii↔vi, ii↔IV, V↔vii°) + variantes de QUALITÉ (même degré,
// autre type). Port ES5 de site/vl2/substitutes.js (testé). Les relatifs maj/min viennent gratis (vi/iii).
var _FUNC_MAJOR = [0,1,0,1,2,0,2], _FUNC_MINOR = [0,1,0,1,2,1,1];   // 0=Tonique 1=Sous-dom 2=Dom — mineur : ♭VI=S (pas T du majeur), ♭VII=S (PAS dominante : sous-tonique sans sensible). T={i,♭III} S={ii°,iv,♭VI,♭VII} D={V}
function gridTypesFor(d) {
	var iv = getIntervals(d), out = [], t;
	for (t = 0; t < GRID_TYPES.length; t++) if (gridTypeValid(d, GRID_TYPES[t], iv)) out.push(GRID_TYPES[t]);
	return out;
}
function substitutesFor(step) {        // step = { deg, fn }
	var out = [];
	if (step.deg == null || step.deg < 0) return out;   // emprunts : raffinement futur
	var F = _sg_isMinor() ? _FUNC_MINOR : _FUNC_MAJOR, myFunc = F[step.deg], d, i;
	for (d = 0; d < 7; d++) if (d !== step.deg && F[d] === myFunc) out.push({ kind:"func", deg:d, fn:step.fn });
	var types = gridTypesFor(step.deg);
	for (i = 0; i < types.length; i++) if (types[i] !== step.fn) out.push({ kind:"qual", deg:step.deg, fn:types[i] });
	return out;
}
function _sg_base(lastDeg, tgt, isMin){
	if (lastDeg == null || lastDeg < 0 || tgt < 0) return 0;
	return (isMin ? SG_MINOR : SG_MAJOR)[lastDeg][tgt];
}
function _sg_quality(cell){
	if (cell.kind !== "d") return 0;
	var deg = cell.degree, dlt = 0;
	var isDom = (deg === 4 || deg === 6), isTon = (deg === 0), isPre = (deg === 1 || deg === 3);
	if (isDom){ if (cell.isDominant) dlt += 0.12; else if (cell.hasSeventh) dlt += 0.05; }
	else if (isTon){ if (cell.isDominant) dlt -= 0.10; else if (cell.fn === "triad" || cell.fn === "mmaj7" || cell.fn === "six") dlt += 0.08; }
	else if (isPre){ if (cell.hasSeventh) dlt += 0.06; }
	if (cell.fn === "sevenflat9" || cell.fn === "sevensharp9" || cell.fn === "m7s5"
		|| cell.fn === "sus2" || cell.fn === "sus4" || cell.fn === "sevensus4") dlt -= 0.05;
	return dlt;
}
function _sg_context(cell, isMin){
	if (cell.kind !== "d") return 0;
	var tgt = cell.degree, dlt = 0, n = _sg_hist.length;
	var last = n >= 1 ? _sg_hist[n-1] : null, prev = n >= 2 ? _sg_hist[n-2] : null;
	var lastDeg = (last && last.kind === "d") ? last.degree : -1;
	var prevDeg = (prev && prev.kind === "d") ? prev.degree : -1;
	if (prevDeg >= 0) dlt += 0.3 * (isMin ? SG_MINOR : SG_MAJOR)[prevDeg][tgt];
	if (lastDeg === 4 && (prevDeg === 1 || prevDeg === 3) && tgt === 0) dlt += 0.2;
	if (tgt === 0 && n >= 4){
		var hit = false, i;
		for (i = n-4; i < n; i++) if (_sg_hist[i] && _sg_hist[i].kind === "d" && _sg_hist[i].degree === 0) hit = true;
		if (!hit) dlt += 0.1;
	}
	return dlt;
}
function _sg_common(lastPcs, cellPcs){
	if (!lastPcs || !cellPcs || !lastPcs.length || !cellPcs.length) return 0;
	var shared = 0, i, j;
	for (i = 0; i < cellPcs.length; i++) for (j = 0; j < lastPcs.length; j++) if (cellPcs[i] === lastPcs[j]) { shared++; break; }
	var b = 0.05 * shared; return b > 0.12 ? 0.12 : b;
}
var _SG_MODAL_MAJ = {5:0,10:0,8:4,3:3}, _SG_MODAL_MIN = {1:4,7:0,11:0,5:0};
function _sg_borrowedResolveDeg(pcs, tonicPc, isMin, degByRoot){
	if (!pcs || !pcs.length) return -1;
	var R = pcs[0];
	if (pcs.indexOf((R+4)%12) >= 0 && pcs.indexOf((R+10)%12) >= 0){ var d=degByRoot[(R+5)%12]; return (d!=null)?d:-1; }
	if (tonicPc < 0) return -1;
	var semis=(R-tonicPc+12)%12, tgt=(isMin?_SG_MODAL_MIN:_SG_MODAL_MAJ)[semis];
	return (tgt!=null)?tgt:-1;
}
function _sg_borrowedScore(cell, lastDeg, isMin, degByRoot, tonicPc){
	var tgtDeg = _sg_borrowedResolveDeg(cell.pcs, tonicPc, isMin, degByRoot);
	if (tgtDeg >= 0) return 0.30 + 0.55 * _sg_base(lastDeg, tgtDeg, isMin);
	return 0.30;
}
// Catégorie de transition (miroir de transitionType) — couleur côté UI device.
function _sg_transType(lastDeg, targetDeg, isBor){
	if (isBor) return "color";
	if (lastDeg === 4 && targetDeg === 5) return "deceptive";
	if (targetDeg === 4 || targetDeg === 6) return "dominant";
	if (targetDeg === 1 || targetDeg === 3) return "predominant";
	return "resolution";
}
function _sg_pcs(spec){ var a = [], i; for (i = 0; i < spec.pcs.length; i++) a.push(spec.pcs[i].pc); return a; }
function _sg_diatonicCell(d, fn){
	var sp = _vl2_specFor(fn, d); if (!sp) return null;   // même pipeline que play → smart ne peut plus diverger (EXT inclus)
	return { kind:"d", degree:d, fn:fn, pcs:_sg_pcs(sp), isDominant:sp.isDominant, hasSeventh:sp.hasSeventh, sp:sp };
}
function _sg_borrowedCell(index, semis, type){
	var sp = _vl2_specFor('color', 0, semis, type);   // même pipeline (enrich no-op sur emprunts, pas de scalePcs)
	return { kind:"b", index:index, pcs:_sg_pcs(sp), sp:sp };   // emprunts : isDominant/hasSeventh/isSecDom non lus (le score d'emprunt n'utilise que pcs/sp)
}
// Registre + centre de sélection — SOURCE UNIQUE (utilisés par _vl2_play ET _sg_fluid) :
// regBase = plancher d'octave (multiple de 12) ; center = tonique pour classic, C-ancré sinon.
function _vl2_regBase(){ return 48 + Math.max(-12, Math.min(24, currentOctave * 12)); }
function _vl2_center(vc){ var rb = _vl2_regBase(); return (vc === "classic") ? (rb + root) : (vc === "piano") ? (rb + 6) : (60 + currentOctave * 12); }   // piano : centre plus bas (basse grave) -> pas de dérive FLOW vers le haut
// SOURCE UNIQUE du centre de sélection — utilisée par _vl2_play ET _sg_fluid (sinon la heat-map VL
// et le playback divergent → sauts d'octave). cands = sortie de _vl2_realize ; cands[0] = forme canonique.
// ABSOLUTE : centre = poche d'origine du grip (moyenne de la canonique), sinon _vl2_center (classic/piano/C4).
// FIX SAUT FALLBACK : quand un voicing retombe sur classic (trap sur triade…), centrer au registre MAISON
// du voicing (pas la tonique) → la triade fallback se pose au même étage que ses grips de 7e. Miroir engine.js.
// (N.B. classic refuse de voicer trop grave via la règle low-interval → marche pour les planchers ~48, partiel pour trap.)
var _vl2_FB_HOME = { jazz:54, house:54, nuhouse:54, quartal:54, sus:54, rootlessa:54, rootlessb:54, rootless:54, upper:54, drop2:54, drop3:54 };
function _vl2_selCtr(cands){
	var realized = cands[0].voicing, fb = cands[0].fallback;
	if (fb && _vl2_FB_HOME[fb] != null) return _vl2_FB_HOME[fb] + (_vl2_regBase() - 48);
	if (_vl2_ABSOLUTE.has(realized)){ var ns = cands[0].notes, s = 0, i; for (i = 0; i < ns.length; i++) s += ns[i]; return s / ns.length; }
	return _vl2_center(realized);
}
// Fluidité de voice-leading : coût de mouvement vers la réalisation que l'appareil JOUERAIT
// (celle dont la moyenne est la plus proche du centre de registre), avec le voicing + l'octave
// courants. Plus bas = plus fluide. Pur (ne mute pas _vl2_st). Sensible au voicing (≠ ancien
// minimum sur ±2 octaves, qui rendait tous les voicings identiques). Miroir : site/vl2/fluidity.js.
function _sg_fluid(sp){
	var ref = (typeof lastChordNotes !== "undefined" && lastChordNotes && lastChordNotes.length) ? lastChordNotes : activeNotes;
	if (!sp || !ref || !ref.length) return 0;
	var regBase = _vl2_regBase();
	var cands = _vl2_realize(sp, currentVoicing, { regBase:regBase, rootPos:!voiceLeadingEnabled });
	if (!cands || !cands.length) return 9999;
	var center = _vl2_selCtr(cands);   // SOURCE UNIQUE — même centre que _vl2_play (poche pour les ABSOLUTE)
	var w = _vl2_pickW(currentVoicing), i, j, sum, m, dev, pick = null, bestDev = 1e9;
	for (i = 0; i < cands.length; i++){
		var ns = cands[i].notes; sum = 0; for (j = 0; j < ns.length; j++) sum += ns[j]; m = sum / ns.length;
		dev = Math.abs(m - center);
		if (dev < bestDev){ bestDev = dev; pick = ns; }
	}
	return _vl2_movCost(ref, pick, w);
}
function _sg_remember(){
	var sp = _vl2_specFor(lastFn, lastDegree, lastColorSemis, lastColorType);   // même pipeline que play
	if (!sp) return;
	var entry = { kind:(lastFn === "color") ? "b" : "d", degree:(lastFn === "color") ? -1 : lastDegree, pcs:_sg_pcs(sp) };
	// Pas de doublon CONSÉCUTIF : rejouer le même accord ne doit pas polluer le contexte (l'avant-dernier).
	var lastE = _sg_hist[_sg_hist.length-1];
	if (lastE && lastE.kind === entry.kind && lastE.degree === entry.degree && lastE.pcs.join(",") === entry.pcs.join(",")) return;
	_sg_hist.push(entry);
	if (_sg_hist.length > SG_HIST_MAX) _sg_hist.shift();
}
function _sg_reset(){ _sg_hist = []; }

// Coeur de suggestion : classe + ordonne les cases candidates APRÈS la source (= queue de _sg_hist).
// Extrait de _sg_broadcast pour être réutilisé par _suiteOptions (mode Suite du Push). skip* = l'accord
// à NE PAS re-suggérer (la source elle-même). Retourne le tableau `emit` (cases retenues, triées +
// nivelées) SANS rien émettre — ne lit que _sg_hist + l'état de gamme, jamais l'accord live.
function _sg_rank(skipFn, skipDeg, skipSemis, skipType){
	var isMin = _sg_isMinor();
	var last = _sg_hist[_sg_hist.length-1], lastPcs = (last && last.pcs) ? last.pcs : [];
	var lastDeg = (last && last.kind === "d") ? last.degree : -1;
	var d, t, fn, s, lvl;
	var degMask = SCALE_VALID_DEGREES[scaleName];
	var degByRoot = {};
	for (d = 0; d < 7; d++){ if (degMask && !degMask[d]) continue; var rp=(root+scale[d]+1200)%12; if (degByRoot[rp]==null) degByRoot[rp]=d; }
	// emprunt comme source : dernier accord = emprunt → suggère fortement sa résolution (dom7 OU modal)
	var tonicPc = ((root % 12) + 12) % 12;
	var lastResolveDeg = (last && last.kind === "b") ? _sg_borrowedResolveDeg(last.pcs, tonicPc, isMin, degByRoot) : -1;
	var vl = (smartMode === "voiceleading");
	var byFn = {}, fnOrder = [];   // par FONCTION de transition (cat) : liste des cases compatibles (sélection harmonique)
	var cells = validGridCells(), ci;   // MÊME forme de grille que broadcastGrid (source unique)
	for (ci = 0; ci < cells.length; ci++){
		d = cells[ci].d; fn = cells[ci].fn;
		if (skipFn !== "color" && d === skipDeg && fn === skipFn) continue;   // ne pas re-suggérer la source
		var cell = _sg_diatonicCell(d, fn); if (!cell) continue;
		var dcat;
		if (lastResolveDeg >= 0){
			s = (d === lastResolveDeg ? 0.92 : 0.12) + _sg_quality(cell);
			dcat = (d === lastResolveDeg) ? "resolution" : _sg_transType(lastResolveDeg, d, false);
		} else {
			s = _sg_base(lastDeg, d, isMin) + _sg_quality(cell) + _sg_context(cell, isMin);
			dcat = _sg_transType(lastDeg, d, false);
		}
		s = _sg_clamp(s + _sg_common(lastPcs, cell.pcs));
		lvl = _sg_level(s);
		if (lvl <= 0) continue;
		if (!byFn[dcat]) { byFn[dcat] = []; fnOrder.push(dcat); }
		byFn[dcat].push({ kind:"d", d:d, fn:fn, lvl:lvl, cat:dcat, s:s, sp:cell.sp });
	}
	var bl = borrowedFor();
	for (t = 0; t < bl.length; t++){
		if (skipFn === "color" && bl[t].semis === skipSemis && bl[t].type === skipType) continue;   // ne pas re-suggérer l'emprunt source
		var bc = _sg_borrowedCell(t, bl[t].semis, bl[t].type);
		s = _sg_clamp(_sg_borrowedScore(bc, lastDeg, isMin, degByRoot, tonicPc) + _sg_common(lastPcs, bc.pcs));
		lvl = _sg_level(s);
		if (lvl <= 0) continue;
		if (!byFn["color"]) { byFn["color"] = []; fnOrder.push("color"); }
		byFn["color"].push({ kind:"b", index:t, semis:bl[t].semis, type:bl[t].type, lvl:lvl, cat:"color", s:s, sp:bc.sp });   // semis/type : réalisation de l'option (Push)
	}
	// Sélection : top SG_PER_FN par fonction, TOUJOURS par score harmonique (les deux modes)
	// → plusieurs accords par fonction, toutes les fonctions présentes, borné (pas de rangées).
	var fi, fa, j, n2, emit = [];
	for (fi = 0; fi < fnOrder.length; fi++){
		fa = byFn[fnOrder[fi]];
		fa.sort(function(a,b){ return b.s - a.s; });
		n2 = (fa.length < SG_PER_FN) ? fa.length : SG_PER_FN;
		for (j = 0; j < n2; j++) emit.push(fa[j]);
	}
	// Voice-leading : la LUMINOSITÉ (lvl) = rang de fluidité parmi les cases retenues. Fluidité calculée
	// SEULEMENT ici (sur les cases émises → peu d'appels). Function : lvl reste le palier harmonique.
	if (vl){
		var k, by = emit.slice();
		for (k = 0; k < by.length; k++) by[k]._f = _sg_fluid(by[k].sp);
		by.sort(function(a,b){ return a._f - b._f; });
		for (k = 0; k < by.length; k++) by[k].lvl = _sg_fluidLevel(k, by.length);
	}
	return emit;
}

// Recalcule + diffuse la heat-map (outlet 7). Émis seulement si SMART on ; sinon neutralise.
function _sg_broadcast(){
	outlet(7, "smartclear");
	if (!smartOn || !_sg_hist.length) { outlet(7, "smartdone"); return; }
	var emit = _sg_rank(lastFn, lastDegree, lastColorSemis, lastColorType), j, x;   // skip = l'accord qu'on vient de jouer
	for (j = 0; j < emit.length; j++){
		x = emit[j];
		if (x.kind === "d") outlet(7, "smartcell", x.d, x.fn, x.lvl, x.cat, x.s, 0);
		else outlet(7, "smartbor", x.index, x.lvl, x.cat, x.s, 0);
	}
	outlet(7, "smartdone");
}

// Mode SUITE (Push) : meilleurs accords À JOUER APRÈS l'étape `idx` de la progression. Réutilise le
// scorer smart (_sg_rank) en remplaçant TEMPORAIREMENT l'historique par progression[0..idx] (puis le
// restaure) — l'état live (_sg_hist / lastFn…) n'est pas touché. Retourne [{deg,fn,kind:"suite",…}].
function _suiteOptions(idx){
	if (idx < 0 || idx >= progression.length) return [];
	var saved = _sg_hist, built = [], i, p, sp;
	for (i = 0; i <= idx; i++){
		p = progression[i];
		sp = _vl2_specFor(p.fn, p.deg, p.colorSemis, p.colorType);   // même pipeline que _sg_remember
		if (!sp) continue;
		built.push({ kind:(p.fn === "color") ? "b" : "d", degree:(p.fn === "color") ? -1 : p.deg, pcs:_sg_pcs(sp) });
	}
	_sg_hist = built;
	var src = progression[idx];
	var emit = _sg_rank(src.fn, src.deg, src.colorSemis, src.colorType);   // skip = l'étape elle-même
	_sg_hist = saved;
	var out = [], j, x;
	for (j = 0; j < emit.length; j++){
		x = emit[j];
		if (x.kind === "d") out.push({ deg:x.d, fn:x.fn, kind:"suite", lvl:x.lvl });
		else out.push({ deg:-1, fn:"color", kind:"suite", lvl:x.lvl, colorSemis:x.semis, colorType:x.type });
	}
	return out;
}

// Toggle UI : "smart 1/0".
function smart(v){
	smartOn = (parseInt(v) === 1);
	if (!smartOn) _sg_hist = [];
	outlet(7, "smart", smartOn ? 1 : 0);   // activation = ardoise vierge : cases d'accord en blanc, couleur seulement après avoir choisi un accord
	_sg_broadcast();
}
// Mode de sélection des suggestions (reçu de l'UI) : "function" (meilleur score) ou "voiceleading" (plus fluide).
function smartmode(v){
	smartMode = (String(v) === "voiceleading") ? "voiceleading" : "function";
	if (smartOn) _sg_broadcast();
}

// Énumère les cellules diatoniques VALIDES (degré × type), dans l'ordre d'affichage. SOURCE UNIQUE
// de la « forme » de la grille — consommée par broadcastGrid ET _sg_broadcast (fini la double boucle).
function validGridCells() {
	var out = [], degMask = SCALE_VALID_DEGREES[scaleName], d, t, fn, iv;
	for (d = 0; d < 7; d++) {
		if (degMask && !degMask[d]) continue;
		iv = getIntervals(d);   // calculé UNE fois par degré (partagé par gridTypeValid + gridLabel)
		// Types valides de la colonne, dans l'ordre de PRIORITÉ (GRID_TYPES).
		var valid = [];
		for (t = 0; t < GRID_TYPES.length; t++) { fn = GRID_TYPES[t]; if (gridTypeValid(d, fn, iv)) valid.push(fn); }
		if (!extendedOn) {
			// Fenêtre PRINCIPALE : le max d'accords sans dépasser MAX_GRID_ROWS.
			for (t = 0; t < valid.length && t < MAX_GRID_ROWS; t++) out.push({ d:d, fn:valid[t], iv:iv });
		} else {
			// Fenêtre EXT : UNIQUEMENT les accords absents de la principale. On exclut les labels des
			// MAX_GRID_ROWS cases principales (labels NORMAUX), puis on dédoublonne les formes enrichies
			// entre elles. Résultat : surtout les M13/m11/13 (extensions qui n'existent pas ailleurs).
			var mainLbls = {}, lim = (valid.length < MAX_GRID_ROWS) ? valid.length : MAX_GRID_ROWS, lb;
			for (t = 0; t < lim; t++) mainLbls[gridLabel(d, valid[t], iv, false)] = 1;
			var seen = {};
			for (t = 0; t < valid.length; t++) {
				lb = gridLabel(d, valid[t], iv, true);   // label ENRICHI (la case jouera l'accord enrichi)
				if (mainLbls[lb] || seen[lb]) continue;
				seen[lb] = 1;
				out.push({ d:d, fn:valid[t], iv:iv });
			}
		}
	}
	return out;
}

// Diffuse toute la grille à l'UI ET au Push (outlet 7) + reconstruit flatGrid/gCols/gBor
function broadcastGrid() {
	flatGrid = [];
	gCols = [[],[],[],[],[],[],[]];
	gBor  = [];
	outlet(7, "gridclear");
	var cells = validGridCells(), ci, c2;
	for (ci = 0; ci < cells.length; ci++) {
		c2 = cells[ci];
		outlet(7, "gridcell", c2.d, c2.fn, gridLabel(c2.d, c2.fn, c2.iv));
		flatGrid.push({ kind:"d", fn:c2.fn, degree:c2.d });
		gCols[c2.d].push({ fn:c2.fn });
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

// La « surface » cohérente : grille + heat-map smart, diffusées ENSEMBLE. broadcastGrid reconstruit
// colFns/colLen côté Push → les anciennes suggestions (smartPads) deviennent périmées ; en mode SMART
// (spotlight Push) un accord valide NON suggéré est peint en BLANC → si on rediffuse la grille sans
// rejouer le smart, tous les pads passent en blanc (bug du grab Push). Regrouper les deux ici garantit
// qu'AUCUN site ne peut oublier la moitié smart. NE PAS y mettre _sg_reset : effacer la mémoire smart
// (uniquement sur changement key/scale) reste explicite chez l'appelant (pushUIState).
function broadcastSurface() {
	broadcastGrid();
	if (smartOn) _sg_broadcast();
}

// L'UI demande la grille (au chargement) — aussi appelé par Push (doInit -> requestgrid)
function requestgrid() {
	broadcastSurface();   // grille + heat-map (cf. broadcastSurface : sinon les pads non suggérés passent en blanc au grab)
}

// Synchronise l'état (key, scale) vers l'UI au reload
function requeststate() {
	pushUIState();
	broadcastProg();   // repeuple la liste de progression après un reload du jweb
}


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
		case "m7s5":        m7s5(cell.degree);  break;
	}
}

function midinote(pitch, vel) {
	pitch = parseInt(pitch);
	vel   = parseInt(vel);

	if (vel === 0) {                       // note-off
		if (pitch === activeMidiNote) { activeMidiNote = -1; sendNoteOff(); }
		return;
	}

	// Dédoublonnage SYMÉTRIQUE : la même touche peut arriver par DEUX chemins
	// (notein du Computer MIDI Keyboard d'Ableton + l'objet [key] du patch). Si cette
	// note sonne déjà, on ignore le 2e déclenchement — sinon double-attaque et l'état
	// de voice leading avance 2× → accords suivants erratiques. (keynote() dédoublonnait
	// déjà dans un seul sens ; ici c'est complet.)
	if (pitch === activeMidiNote) return;

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

// FILET DE SECOURS uniquement (appelé par sendChord SEULEMENT si _vl2_play ne sort aucun candidat).
// ⚠️ Ces voicings v1 DIVERGENT de _vl2_T (algos différents) et ne couvrent que 9 des 15 (trap/
// nuhouse/jazz/trance/funk → close position par défaut). Secours rare, PAS le chemin réel : la
// vérité du voicing est _vl2_T / _vl2_play. Ne pas y ajouter de logique de jeu.
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
	if (spec.hasSeventh) {   // guide tones sur les 7e. EXCEPTION house : 6/9 en EXT (lâche la 7e, GARDE la 3ce).
		if (voicing !== 'house' && voicing !== 'sus' && voicing !== 'power' && !has('seventh')) v.push('guide:7e absente');
		var hasThird = false; for(var i=0;i<spec.pcs.length;i++) if(spec.pcs[i].role==='third'){hasThird=true;break;}
		if (voicing !== 'sus' && voicing !== 'power' && hasThird && !has('third')) v.push('guide:3ce absente');
	}
	if (voicing==='rootlessa'){if(pcs.has(spec.rootPc))v.push('rootless:fondamentale présente');var t3=null;for(var ii=0;ii<spec.pcs.length;ii++)if(spec.pcs[ii].role==='third'){t3=spec.pcs[ii];break;}if(t3&&m(ns[0])!==t3.pc)v.push('rootlessa:3ce absente du bas');}
	else if (voicing==='rootlessb'){if(pcs.has(spec.rootPc))v.push('rootless:fondamentale présente');var t7=null;for(var ji=0;ji<spec.pcs.length;ji++)if(spec.pcs[ji].role==='seventh'){t7=spec.pcs[ji];break;}if(t7&&m(ns[0])!==t7.pc)v.push('rootlessb:7e absente du bas');}
	else if (voicing==='jazz'||voicing==='nuhouse'||voicing==='house'||voicing==='quartal'||voicing==='upper'||voicing==='rootless'||voicing==='organ'||voicing==='broken'||voicing==='deeptech') { if (pcs.has(spec.rootPc)) v.push('rootless:fondamentale présente'); }
	else if (voicing==='sus') { var t=null,ti; for(ti=0;ti<spec.pcs.length;ti++)if(spec.pcs[ti].role==='third'){t=spec.pcs[ti];break;} if(t&&pcs.has(t.pc))v.push('sus:3ce présente'); }
	else if (voicing==='power') { var fp=m(spec.rootPc+7),pi; for(pi=0;pi<ns.length;pi++)if(m(ns[pi])!==spec.rootPc&&m(ns[pi])!==fp){v.push('power:note hors root/5te');break;} }
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
		if (rh.length && Math.max.apply(null,rh)-Math.min.apply(null,rh) > 12 + Math.max(0,rh.length-3)*3) v.push('piano:MD trop large');   // marge pour les accords étendus -> pas de saut d'octave EXT/normal
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
	var scalePcs=[]; for(var j=0;j<scale.length;j++) scalePcs.push(m(root+scale[j]));   // gamme (quartal/upper)
	return {pcs:pcs, rootPc:rootPc, fn:fn, degree:d, scalePcs:scalePcs, hasSeventh:hasSev, isDominant:isThird4&&isSev10};
}

function _vl2_buildColorSpec(semis, type) {
	var m=function(n){return((n%12)+12)%12;};
	var ROLES=['root','third','fifth','seventh'];
	var ivs=COLOR_IV[type]||COLOR_IV.maj, rootPc=m(root+semis), pcs=[];
	for(var i=0;i<ivs.length;i++) pcs.push({pc:m(rootPc+ivs[i]),role:ROLES[i]});
	return {pcs:pcs, rootPc:rootPc, fn:'color', degree:semis, hasSeventh:ivs.length>3, isDominant:type==='dom7'};
}

var extendedOn = false;   // toggle EXTENDED : enrichit chaque accord avec ses tensions (couche B)
// Extended (couche B) — miroir ES5 de chordspec.enrichSpec. Ajoute les tensions idiomatiques par qualité
// (3ce M -> +9+13 ; 3ce m + 7e -> +9+11 ; jamais la 11 juste sur 3ce M ; saute les tensions déjà là).
// Réutilise scalePcs. Sans scalePcs (emprunts) ou sans 3ce (sus) : inchangé.
function _vl2_enrichSpec(spec){
	if(!spec||!spec.scalePcs)return spec;
	var hasRole=function(r){for(var j=0;j<spec.pcs.length;j++)if(spec.pcs[j].role===r)return true;return false;};
	var third=null,i;for(i=0;i<spec.pcs.length;i++)if(spec.pcs[i].role==='third'){third=spec.pcs[i];break;}
	if(!third){   // sus / sans 3ce
		var sus=null;for(i=0;i<spec.pcs.length;i++)if(spec.pcs[i].role==='sus'){sus=spec.pcs[i];break;}
		if(sus&&spec.hasSeventh&&!hasRole('ninth'))   // 7sus4 -> 9sus4 (la 9 est diatonique)
			return {pcs:spec.pcs.slice().concat([{pc:spec.scalePcs[(spec.degree+1)%7],role:'ninth'}]),rootPc:spec.rootPc,fn:spec.fn,degree:spec.degree,scalePcs:spec.scalePcs,hasSeventh:spec.hasSeventh,isDominant:spec.isDominant};
		return spec;   // sus sans 7e : laissé tel quel
	}
	var minor=_vl2_m(third.pc-spec.rootPc)===3;
	var add=[];
	if(!hasRole('ninth')) add.push({pc:spec.scalePcs[(spec.degree+1)%7],role:'ninth'});
	if(minor&&spec.hasSeventh&&!hasRole('eleventh')) add.push({pc:spec.scalePcs[(spec.degree+3)%7],role:'eleventh'});
	if(!minor&&!hasRole('thirteenth')&&!hasRole('sixth')) add.push({pc:spec.scalePcs[(spec.degree+5)%7],role:'thirteenth'});
	if(!add.length)return spec;
	return {pcs:spec.pcs.slice().concat(add),rootPc:spec.rootPc,fn:spec.fn,degree:spec.degree,scalePcs:spec.scalePcs,hasSeventh:spec.hasSeventh,isDominant:spec.isDominant};
}
// PIPELINE DE SPEC UNIQUE — construit le spec d'une case (diatonique OU emprunt) et applique les transforms
// de niveau spec (EXT enrich aujourd'hui ; futurs : polychord…). Utilisé par play, preview ET smart → ils
// ne peuvent plus diverger (la classe de bug « le smart n'a pas eu l'EXT » disparaît à la racine).
function _vl2_specFor(fn,d,colorSemis,colorType){
	var spec=(fn==='color')?_vl2_buildColorSpec(colorSemis,colorType):_vl2_buildSpec(fn,d);
	if(!spec)return null;
	if(extendedOn)spec=_vl2_enrichSpec(spec);
	return spec;
}
// Toggle UI : "extended 1/0". Orthogonal au voicing.
function extended(v){
	sendNoteOff(); activeMidiNote = -1;    // libère toute note tenue (comme voiceleading/vlmode) → le toggle ne laisse pas de note coincée
	extendedOn=(parseInt(v)===1);
	_vl2_reset();                          // changer de mode = nouvelle réalisation
	outlet(7,'extended',extendedOn?1:0);   // reflète l'état au bouton EXT
	broadcastSurface();                    // re-diffuse la grille (noms étendus CM7->CM13) + la heat-map smart (la grille change en EXT)
}

function _vl2_specKey(s) {
	var r=s.fn+':'+s.degree+':'; for(var i=0;i<s.pcs.length;i++) r+=(i?'.':'')+s.pcs[i].pc; return r;
}

// --- realizer ---
var _vl2_ROLE_ORDER=['root','sus','third','fifth','sixth','seventh','ninth','eleventh','thirteenth'];
function _vl2_vs(a){return a.slice().sort(function(x,y){return x-y;});}
function _vl2_m(n){return((n%12)+12)%12;}
function _vl2_rotOf(arr){
	var out=[],r=_vl2_vs(arr);
	for(var i=0;i<arr.length;i++){out.push(r.slice());r=_vl2_vs(r.slice(1).concat([r[0]+12]));}
	return out;
}
// rootless A/B : MÊME réalisation (retire la fonda par pitch-class, robuste aux rotations de _vl2_realize).
// _vl2_checkIdentity distingue Type A (3ce en bas) de Type B (7e en bas). NON-ABSOLUTE → registre normalisé
// par le Selector (fini l'écart de l'ancien stackFromFloor : Am7 3rd=C→48 vs G7 3rd=B→59).
function _vl2_rootlessClose(c,spec){
	if(!spec||c.length<4)return[_vl2_vs(c)];
	var rp=_vl2_m(spec.rootPc);
	var wr=_vl2_vs(c.filter(function(n){return _vl2_m(n)!==rp;}));
	return wr.length>=3?[wr]:[_vl2_vs(c)];
}
function _vl2_closeFrom(spec,rootMidi){
	var ord=spec.pcs.slice().sort(function(a,b){return _vl2_ROLE_ORDER.indexOf(a.role)-_vl2_ROLE_ORDER.indexOf(b.role);});
	var out=[rootMidi],last=rootMidi;
	for(var i=1;i<ord.length;i++){var n=last+1;n+=_vl2_m(ord[i].pc-_vl2_m(n));out.push(n);last=n;}
	return out;
}
var _vl2_STRUCT=new Set(['piano','rootlessa','rootlessb','rootless','drop2','drop3','house','prog','jazz','nuhouse','trance','funk','quartal','upper','organ','frenchtouch','broken','deeptech','detroit','soul','jamiroquai','rave','sus','wide','power']);
var _vl2_ABSOLUTE=new Set(['house','prog','jazz','nuhouse','trance','funk','quartal','upper','organ','frenchtouch','broken','deeptech','detroit','soul','jamiroquai','rave','sus','wide','power']);
// Replie une extension qui flotte tout en haut (EXT : la 13e empilée une octave au-dessus → span 2 octaves,
// injouable d'une main). Voir realizer.js compactFloatingTop. FOLD = voicings SERRÉS uniquement (les
// open/spread/funk/prog/trance/nuhouse/drop/piano/upper gardent leur déplacement d'octave voulu).
var _vl2_FLOAT_GAP=5;
function _vl2_compactFloatingTop(notes){
	var r=_vl2_vs(notes),g;
	for(g=0;g<8&&r.length>=2;g++){
		var n=r.length;
		if(r[n-1]-r[n-2]<=_vl2_FLOAT_GAP)break;
		var folded=r[n-1]-12;
		if(folded<=r[0]||r.indexOf(folded)!==-1)break;
		r=_vl2_vs(r.slice(0,n-1).concat([folded]));
	}
	return r;
}
var _vl2_FOLD=new Set(['classic','rootlessa','rootlessb']);
// Symétrique pour le BAS : remonte une fonda grave ISOLÉE d'une octave si elle "boome" loin sous le reste
// (#28 : Am11 spread/open). Ne touche QUE le bas isolé (gap>FLOAT_GAP) → l'étalement voulu est préservé.
function _vl2_compactFloatingBottom(notes){
	var r=_vl2_vs(notes),g;
	for(g=0;g<8&&r.length>=2;g++){
		if(r[1]-r[0]<=_vl2_FLOAT_GAP)break;
		var lifted=r[0]+12;
		if(lifted>=r[r.length-1]||r.indexOf(lifted)!==-1)break;
		r=_vl2_vs(r.slice(1).concat([lifted]));
	}
	return r;
}
var _vl2_BOTTOM_FOLD=new Set(['spread','open']);
// Empile une liste de pitch-classes en position serrée ascendante depuis un plancher MIDI.
function _vl2_stackFromFloor(pcs,floor){
	var out=[],cur=floor-1,i,n;
	for(i=0;i<pcs.length;i++){n=cur+1+_vl2_m(pcs[i]-_vl2_m(cur+1));out.push(n);cur=n;}
	return _vl2_vs(out);
}
// Anti-boue : écarte toute seconde mineure (demi-ton) en remontant la voix haute d'une octave.
// Pour les clusters graves (deeptech) où un demi-ton bas = boueux. Garde toutes les notes (Loi 1).
function _vl2_deMud(notes){
	var r=_vl2_vs(notes),i,g,changed;
	for(g=0;g<6;g++){ changed=false;
		for(i=0;i<r.length-1;i++){ if(r[i+1]-r[i]===1){ r[i+1]+=12; changed=true; break; } }
		r=_vl2_vs(r); if(!changed)break;
	}
	return r;
}
var _vl2_T={
	classic:function(c){return[c];},
	open:function(c){return c.length<2?[c]:[_vl2_vs(c.map(function(n,i){return i===1?n+12:n;}))];},
	spread:function(c){return c.length<3?[c]:[_vl2_vs(c.map(function(n,i){return i%2===1?n+12:n;}))];},
	// house : STAB deep-house = sus2 + 6/9, rootless, brillant (PAS de 3ce ni 7e) → 2de + 5te + 6te depuis la
	// gamme. Registre C3, toutes rotations, 1 main. Besoin de scalePcs (sinon fallback en amont).
	// house : stab deep-house ROOTLESS, ancré C3. EN MODE EXTENDED (9e + 13e) → 6/9 = 3-5-6-9 (lâche la 7e),
	// distinct + correct. En NORMAL → cluster rootless (QUE les notes de l'accord, ≈ rootless assumé).
	house:function(c,oct,spec){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var hm=function(n){return((n%12)+12)%12;};
		var roleP=function(r){if(!spec)return null;var e=null,j;for(j=0;j<spec.pcs.length;j++)if(spec.pcs[j].role===r){e=spec.pcs[j];break;}return e?e.pc:null;};
		var thirteenth=roleP('thirteenth'),ninth=roleP('ninth');
		if(thirteenth!=null&&ninth!=null){   // EXTENDED → 6/9 (3-5-6-9, sans la 7e)
			var i6=[roleP('third'),roleP('fifth'),thirteenth,ninth],seq=[],q;
			for(q=0;q<i6.length;q++)if(i6[q]!=null)seq.push(i6[q]);
			return _vl2_rotOf(_vl2_stackFromFloor(seq,48+oct));
		}
		var pcs=c.slice(1).map(hm);
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
		var rt=48+oct+rootPc,cl=[rt],cur=rt,i,n;
		for(i=0;i<upperPc.length;i++){n=cur+1+pm(upperPc[i]-pm(cur+1));cl.push(n);cur=n;}
		cl.push(rt+12);
		return[_vl2_vs(cl).slice(0,6)];   // pad root-doublé = registre FIXE (cohérence > mouvement) — pas de fenêtre octave (dérive)
	},
	piano:function(c){
		if(c.length<3)return[c];
		var pm=function(n){return((n%12)+12)%12;},rootPc=pm(c[0]);
		return _vl2_rotOf(c.slice(1)).map(function(rh){
			var lo=Math.min.apply(null,rh),d=pm(rootPc-pm(lo-12));if(d>6)d-=12;
			return[lo-12+d].concat(rh);  // basse ~1 octave sous la MD
		});
	},
	// rootless A/B : NON-ABSOLUTE (sorti du set ABSOLUTE) — le Realizer génère toutes les formes
	// rootless A/B (Bill Evans) : réalisation commune _vl2_rootlessClose ; _vl2_checkIdentity choisit
	// la rotation (Type A = 3ce en bas, Type B = 7e en bas). Voir _vl2_rootlessClose ci-dessus.
	rootlessa:function(c,oct,spec){return _vl2_rootlessClose(c,spec);},
	rootlessb:function(c,oct,spec){return _vl2_rootlessClose(c,spec);},
	rootless:function(c,oct,spec){return _vl2_rootlessClose(c,spec);},   // A↔B fusionnés : le Selector choisit la rotation (Type A/B) qui voice-lead le mieux (geste Bill Evans)
	// quartal : So What rootless [11,7,3,5]. 11e = 4e degré gamme au-dessus de la fonda, montée
	// en #11 sur accord majeur (lydien). 1 main, rootless, ABSOLUTE. Besoin de scalePcs (sinon fallback).
	quartal:function(c,oct,spec){
		if(!spec||!spec.scalePcs||c.length<3)return[_vl2_vs(c)];
		var roleP=function(r){var e=null,i;for(i=0;i<spec.pcs.length;i++)if(spec.pcs[i].role===r){e=spec.pcs[i];break;}return e?e.pc:null;};
		var third=roleP('third'),fifth=roleP('fifth'),seventh=roleP('seventh');
		if(third==null||seventh==null)return[_vl2_vs(c)];
		var eleven=spec.scalePcs[(spec.degree+3)%7];
		if(_vl2_m(third-spec.rootPc)===4)eleven=_vl2_m(eleven+1);   // #11 lydien sur accord majeur
		var seq=[eleven,seventh,third];if(fifth!=null)seq.push(fifth);
		return _vl2_rotOf(_vl2_stackFromFloor(seq,48+(oct||0)));   // rotations → VL chaud (canonique = pile So-What, 1re)
	},
	// upper : upper-structure DEUX MAINS (exception comme piano). MG = shell guide-tones (3+7, rootless),
	// MD = triade majeure d'upper-structure. Auto : US bII (altered) sur b9/#9, sinon US II (lydien dom).
	// Dominantes uniquement (fallback en amont). Pas de scalePcs (triade chromatique depuis la fonda).
	upper:function(c,oct,spec){
		if(!spec||!spec.isDominant)return[_vl2_vs(c)];
		var roleP=function(r){var e=null,i;for(i=0;i<spec.pcs.length;i++)if(spec.pcs[i].role===r){e=spec.pcs[i];break;}return e?e.pc:null;};
		var third=roleP('third'),seventh=roleP('seventh');
		if(third==null||seventh==null)return[_vl2_vs(c)];
		var ninth=null,ni;for(ni=0;ni<spec.pcs.length;ni++)if(spec.pcs[ni].role==='ninth'){ninth=spec.pcs[ni];break;}
		var iv9=ninth?_vl2_m(ninth.pc-spec.rootPc):-1;
		var usRoot=_vl2_m(spec.rootPc+((iv9===1||iv9===3)?1:2));   // US bII (altered) ou US II (lydien)
		var shell=_vl2_stackFromFloor([third,seventh],48+(oct||0));                         // main gauche ~C3
		var triad=_vl2_stackFromFloor([usRoot,_vl2_m(usRoot+4),_vl2_m(usRoot+7)],60+(oct||0)); // main droite ~C4
		// shell MG fixe + inversions de la triade MD → VL chaud (canonique = triade position fonda, 1re)
		return _vl2_rotOf(triad).map(function(t){return _vl2_vs(shell.concat(t));});
	},
	drop2:function(c){var r=_vl2_vs(c);r[r.length-2]-=12;return[_vl2_vs(r)];},
	drop3:function(c){var r=_vl2_vs(c);r[r.length-3]-=12;return[_vl2_vs(r)];},
	// nuhouse : rootless OUVERT aéré (2e voix +octave), 1 main, ancré C3, suit OCT.
	nuhouse:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var pm=function(n){return((n%12)+12)%12;},pcs=c.slice(1).map(pm),floor=48+oct;
		var cl=pcs.map(function(pc){return floor+pm(pc);}).sort(function(a,b){return a-b;})
			.filter(function(n,i,a){return i===0||n!==a[i-1];});
		if(cl.length>=2)cl[1]+=12;
		return _vl2_rotOf(_vl2_vs(cl));   // rotations → VL chaud (canonique = cluster aéré, 1re)
	},
	jazz:function(c,oct,spec){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var pm=function(n){return((n%12)+12)%12;};
		var pcs=c.slice(1).map(pm),floor=48+oct;
		if(pcs.length>=3)pcs=pcs.filter(function(p,k){return k!==1;});   // 7e+ : SHELL (lâche la 5te) → 3-7(-9) ; QUE les notes de l'accord, ≠ rootless
		// FIX REGISTRE : pc-placement (méthode house) borné [floor,floor+11] au lieu d'empiler en montant (qui dérivait selon les pc)
		var cl=pcs.map(function(pc){return floor+pm(pc-floor);}).sort(function(a,b){return a-b;}).filter(function(n,i,a){return i===0||n!==a[i-1];});
		return _vl2_rotOf(_vl2_vs(cl));
	},
	// trance : anthem 1 main — fonda + 3ce (+7e) + fonda doublée à l'octave au sommet ;
	// lâche la 5te sur les 7e (son power). Root-inclus, centré, suit OCT.
	trance:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var pm=function(n){return((n%12)+12)%12;},rootPc=pm(c[0]),upperPc=c.slice(1).map(pm);
		if(upperPc.length>=3)upperPc=upperPc.filter(function(_,i){return i!==1;});
		var rt=48+oct+rootPc,cl=[rt],cur=rt,i,n;
		for(i=0;i<upperPc.length;i++){n=cur+1+pm(upperPc[i]-pm(cur+1));cl.push(n);cur=n;}
		cl.push(rt+12);
		return[_vl2_vs(cl).slice(0,6)];   // anthem root-doublé = registre FIXE (cohérence > mouvement)
	},
	// funk : grip "10e" root-inclus — fonda en bas + 3ce (c[1], ordre des rôles) montée
	// d'une octave = la dixième caractéristique. c[1] est TOUJOURS la 3ce, donc la 10e
	// reste lisible même sur 9e+ (où l'ancien tri remontait le 9th par erreur). Les voix
	// trop proches de la fonda (9th) montent d'une octave pour éviter la boue. 1 main.
	funk:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];oct=oct||0;
		var pm=function(n){return((n%12)+12)%12;},floor=48+oct;
		var hasSev=c.length>=4;   // sparse Rhodes : lâche la 5te s'il y a une 7e
		var rt=floor+pm(c[0]),third=floor+pm(c[1])+12;
		var rest=[];
		for(var i=2;i<c.length;i++){if(i===2&&hasSev)continue;var n=floor+pm(c[i]);if(n-rt<3)n+=12;rest.push(n);}
		var notes=_vl2_vs([rt].concat(rest).concat([third]))
			.filter(function(n,i,a){return i===0||n!==a[i-1];});
		return[notes];   // grip "10e" root-inclus = registre FIXE (cohérence > mouvement)
	},
	// ─── NOUVEAUX VOICINGS (miroir vl2, 1res versions à affiner à l'oreille) ───
	// FIX REGISTRE (audit Loi 1 D) : placement par pitch-class dans une octave fixe (méthode house),
	// AU LIEU d'empiler en montant depuis le plancher (qui faisait flotter le registre selon les pc).
	// Registre borné à [floor,floor+11] → cohérent entre degrés/tonalités. Identité (cluster brillant) intacte.
	organ:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];
		var pm=function(n){return((n%12)+12)%12;},pcs=c.slice(1).map(pm),floor=60+(oct||0);
		var cl=pcs.map(function(pc){return floor+pm(pc);}).sort(function(a,b){return a-b;}).filter(function(n,i,a){return i===0||n!==a[i-1];});
		return _vl2_rotOf(_vl2_vs(cl).slice(0,5));
	},
	// frenchtouch — Daft Punk "Something About Us" : Rhodes chaud, FONDA INCLUSE + reste de
	// l'accord empilé serré au-dessus, registre médium fixe (C3). La 9e (présente dans c en
	// EXTENDED seulement) se pose au sommet = la couleur Rhodes ; en NORMAL = 7e propre root-
	// inclusive (Loi 1 stricte). Distinct de rootless (garde la fonda), de prog/rave (pas de
	// doublage de fonda), de jamiroquai (ancré C3, pas C#3+). ABSOLUTE, 1 forme.
	frenchtouch:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];
		var pm=function(n){return((n%12)+12)%12;},floor=48+(oct||0);
		var root=floor+pm(c[0]),cur=root,up=[],i,n;
		for(i=1;i<c.length;i++){n=cur+1+pm(pm(c[i])-pm(cur+1));up.push(n);cur=n;}
		return[_vl2_vs([root].concat(up)).slice(0,6)];
	},
	broken:function(c,oct){   // FIX REGISTRE : placement par pitch-class (méthode house), registre borné [48,59]
		if(c.length<3)return[_vl2_vs(c)];
		var pm=function(n){return((n%12)+12)%12;},pcs=c.slice(1).map(pm),floor=48+(oct||0);
		var cl=pcs.map(function(pc){return floor+pm(pc);}).sort(function(a,b){return a-b;}).filter(function(n,i,a){return i===0||n!==a[i-1];});
		return _vl2_rotOf(_vl2_vs(cl).slice(0,6));
	},
	// deeptech — dub techno : m7 rootless, dark mais PROPRE. pc-placement borné [44,55] (remonté de 40
	// → moins boueux) + anti-boue (écarte les secondes mineures des 9e/étendus). floor 44 ≠ mult-12 → pm(pc-floor).
	deeptech:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];
		var pm=function(n){return((n%12)+12)%12;},pcs=c.slice(1).map(pm),floor=44+(oct||0);
		var cl=pcs.map(function(pc){return floor+pm(pc-floor);}).sort(function(a,b){return a-b;}).filter(function(n,i,a){return i===0||n!==a[i-1];});
		return _vl2_rotOf(_vl2_deMud(_vl2_vs(cl).slice(0,4)));
	},
	detroit:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];
		var pm=function(n){return((n%12)+12)%12;},keep=c.length>=4?[c[0],c[1],c[3]]:[c[0],c[1],c[2]],floor=48+(oct||0),cl=[],cur=floor-1,i,m;
		for(i=0;i<keep.length;i++){m=cur+1+pm(pm(keep[i])-pm(cur+1));cl.push(m);cur=m;}
		return[_vl2_vs(cl)];
	},
	// soul — D'Angelo (neo-soul / gospel) : cluster DENSE root-inclus qui GARDE les frottements
	// de 2de (pas d'anti-boue), avec la 9e posée juste au-dessus de la fonda = le frottement
	// gospel signature. 9e ajoutée par DESIGN (tension du mode, comme sus/quartal/power) → en
	// NORMAL aussi. En EXTENDED, les tensions de c (9/11/13) s'empilent serré = la boue voulue.
	// ABSOLUTE, 1 forme. Distinct de funk (grip 10e ouvert) et de jamiroquai (close depuis C#3).
	soul:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];
		var pm=function(n){return((n%12)+12)%12;},floor=48+(oct||0);
		var root=floor+pm(c[0]),isMaj=pm(c[1]-c[0])===4,up=[],cur=isMaj?(root+2):root,i,n;
		for(i=1;i<c.length;i++){n=cur+1+pm(pm(c[i])-pm(cur+1));up.push(n);cur=n;}
		// 9e gospel en frottement BAS (root+2) sur accord MAJEUR (cluster propre, tons entiers) ; PAS sur mineur
		// (le root+2 y tomberait en ♭9 grave sous la 3ce mineure → boue, audit Loi 1 B). Pas de remontée de registre.
		var base=isMaj?[root,root+2]:[root];
		return[_vl2_vs(base.concat(up)).filter(function(x,j,a){return j===0||x!==a[j-1];}).slice(0,6)];
	},
	jamiroquai:function(c,oct){
		if(c.length<3)return[_vl2_vs(c)];
		var pm=function(n){return((n%12)+12)%12;},floor=53+(oct||0),out=[],cur=floor-1,i,m;
		for(i=0;i<c.length;i++){m=cur+1+pm(pm(c[i])-pm(cur+1));out.push(m);cur=m;}
		return[_vl2_vs(out).slice(0,6)];
	},
	rave:function(c,oct){
		if(c.length<2)return[_vl2_vs(c)];
		var pm=function(n){return((n%12)+12)%12;},floor=60+(oct||0),root=floor+pm(c[0]),out=[root],cur=root,u=c.slice(1),i,m;
		for(i=0;i<u.length;i++){m=cur+1+pm(pm(u[i])-pm(cur+1));out.push(m);cur=m;}
		out.push(root+12);
		return[_vl2_vs(out).slice(0,6)];
	},
	sus:function(c,oct,spec){
		if(!spec||!spec.scalePcs)return[_vl2_vs(c)];
		var pm=function(n){return((n%12)+12)%12;};
		var role=function(r){var e=null,k;for(k=0;k<spec.pcs.length;k++)if(spec.pcs[k].role===r){e=spec.pcs[k];break;}return e?e.pc:null;};
		var two=spec.scalePcs[(spec.degree+1)%7],fifth=role('fifth'),seventh=role('seventh');
		var seq=[spec.rootPc,two];if(fifth!=null)seq.push(fifth);if(seventh!=null)seq.push(seventh);
		var floor=48+(oct||0),out=[],cur=floor-1,i,n;
		for(i=0;i<seq.length;i++){n=cur+1+pm(seq[i]-pm(cur+1));out.push(n);cur=n;}
		return[_vl2_vs(out)];
	},
	wide:function(c,oct){
		var pm=function(n){return((n%12)+12)%12;},floor=42+(oct||0),base=[],cur=floor-1,i,m;
		for(i=0;i<c.length;i++){m=cur+1+pm(pm(c[i])-pm(cur+1));base.push(m);cur=m;}
		return[_vl2_vs(base.map(function(n,j){return j%2===1?n+24:n;})).slice(0,6)];
	},
	power:function(c,oct){
		var pm=function(n){return((n%12)+12)%12;},root=48+(oct||0)+pm(c[0]);
		return[[root,root+7,root+12]];
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
	if((vc==='rootlessa'||vc==='rootlessb')&&!spec.hasSeventh){fallback=vc;vc='classic';}   // rootlessa/b : triade rootless = 2 notes trop maigres (besoin de ≥3 via rootlessClose) → fallback classic. jazz/house/nuhouse font LEUR triade rootless (cohérent avec leur 7e, fini le saut fonda-présente↔rootless).
	if(vc==='quartal'&&(!spec.hasSeventh||!spec.scalePcs)){fallback=vc;vc='classic';}   // quartal a besoin de la 7e + la gamme
	if(vc==='sus'&&!spec.scalePcs){fallback=vc;vc='classic';}   // sus a besoin de la gamme (le 2)
	if(vc==='upper'&&!spec.isDominant){fallback=vc;vc='classic';}   // upper n'a de sens que sur les dominantes
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
		return[{notes:cn,voicing:vc,fallback:fallback,canonical:true}];
	}
	var rotUp=function(arr){var r=_vl2_vs(arr);r.push(r.shift()+12);return _vl2_vs(r);};
	var seen=new Set(),out=[],canonTagged=false;
	for(var oct=-2;oct<=2;oct++){
		var base=48+oct*12,rootMidi=base+_vl2_m(spec.rootPc-_vl2_m(base));
		var inv=_vl2_closeFrom(spec,rootMidi);
		var nInv=_vl2_ABSOLUTE.has(vc)?1:spec.pcs.length;
		for(var k=0;k<nInv;k++){
			var TF=_vl2_T[vc]||_vl2_T.classic;
			var shapes=TF(inv,octShift,spec);
			for(var si=0;si<shapes.length;si++){
				var notes=(want!=null&&!_vl2_STRUCT.has(vc))?_vl2_stabilize(shapes[si],spec,want):_vl2_vs(shapes[si]).slice(0,6);
				if(_vl2_FOLD.has(vc))notes=_vl2_compactFloatingTop(notes);   // replie l'extension flottante (EXT, voicings serrés) → jouable 1 main
				if(_vl2_BOTTOM_FOLD.has(vc)&&spec.pcs.length>=5)notes=_vl2_compactFloatingBottom(notes);   // remonte la fonda grave isolée — accords riches 9e+/EXT (#28 Am11)
				if(Math.min.apply(null,notes)<24||Math.max.apply(null,notes)>108)continue;
				if(_vl2_checkIdentity(vc,notes,spec).length)continue;
				if(!_vl2_ABSOLUTE.has(vc)&&_vl2_lowIntervalViolations(notes,octShift).length)continue;
				var key=notes.join(',');if(seen.has(key))continue;seen.add(key);
				// forme maison : ABSOLUTE (registre fixe, shape indépendante de l'octave de boucle) → le 1er candidat émis EST la canonique ; sinon 1re inversion à base===regBase.
				var canon=_vl2_ABSOLUTE.has(vc)?!canonTagged:(base===regBase&&k===0&&!canonTagged);if(canon)canonTagged=true;
				out.push({notes:notes,voicing:vc,fallback:fallback,canonical:canon});
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
var _vl2_JAZZ_VC={rootlessa:1,rootlessb:1,rootless:1,drop2:1,drop3:1,house:1,jazz:1,nuhouse:1,quartal:1,upper:1,organ:1,frenchtouch:1,broken:1,deeptech:1,sus:1,wide:1};
function _vl2_pickW(vc){return _vl2_JAZZ_VC[vc]?_vl2_W_jazz:_vl2_W;}
function _vl2_movCost(prev,cand,w){
	if(!w)w=_vl2_W;
	var a=_vl2_vs(prev),b=_vl2_vs(cand),n=Math.min(a.length,b.length);
	var tot=Math.abs(a.length-b.length)*w.countDiff;
	var bObj={},_bi,commons=0;
	for(_bi=0;_bi<b.length;_bi++) bObj[b[_bi]]=true;
	for(var i=0;i<a.length;i++) if(bObj[a[i]]){tot+=w.common;commons++;}
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
	var apcs={},bpcs={},_pc;
	for(_pc=0;_pc<a.length;_pc++) apcs[_vl2_m(a[_pc])]=true;
	for(_pc=0;_pc<b.length;_pc++) bpcs[_vl2_m(b[_pc])]=true;
	if(ps.isDominant){
		var tri3=null,tri7=null;
		for(var i=0;i<ps.pcs.length;i++){if(ps.pcs[i].role==='third')tri3=ps.pcs[i];if(ps.pcs[i].role==='seventh')tri7=ps.pcs[i];}
		if(tri3&&apcs[tri3.pc]&&bpcs[_vl2_m(tri3.pc+1)])bonus+=w.tendency;
		if(tri7&&apcs[tri7.pc]&&bpcs[_vl2_m(tri7.pc-1)])bonus+=w.tendency;
		if(_vl2_m(ps.rootPc-sp.rootPc)===7){
			var thi=null;for(var i=0;i<sp.pcs.length;i++) if(sp.pcs[i].role==='third'){thi=sp.pcs[i];break;}
			if(tri7&&thi&&apcs[tri7.pc]&&bpcs[thi.pc]&&!bpcs[tri7.pc])bonus+=w.tendency;
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
		// ABSOLUTE (registre fixe) : à froid on VERROUILLE la forme canonique signature (sinon la proximité-centre choisirait une rotation/octave secondaire et casserait l'identité). Les candidats ne servent qu'au VL chaud.
		if(first){cost=(c.canonical?(opts.absolute?-1000:0):3)+Math.abs(mean(c.notes)-center);}
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
	var spec=_vl2_specFor(fn,d,colorSemis,colorType);   // pipeline de spec unique (build + EXT)
	if(!spec)return null;
	var vc=currentVoicing,mode='anchor';
	if(voiceLeadingEnabled){
		mode=(vlMode==='anchored')?'anchor':'flow';
	} else {
		_vl2_reset();   // VL OFF : pas de mémoire de mouvement -> chaque accord au plus proche du centre
	}
	// regBase : plancher de l'octave (multiple de 12, invariant).
	// selCtr  : tonique pour classic (ancrage harmonique), C-ancré pour les autres voicings.
	var regBase=_vl2_regBase();
	var cands=_vl2_realize(spec,vc,{regBase:regBase,rootPos:!voiceLeadingEnabled});
	if(!cands.length)return null;
	var selCtr=_vl2_selCtr(cands);   // SOURCE UNIQUE (poche pour ABSOLUTE) — même centre que _sg_fluid → heat-map VL alignée au playback
	var key=_vl2_specKey(spec)+'|'+vc+'|'+selCtr;
	var notes=_vl2_select(cands,{mode:mode,center:selCtr,key:key,voicing:vc,spec:spec,prevSpec:_vl2_prevSpec,absolute:_vl2_ABSOLUTE.has(cands[0].voicing)});
	_vl2_prevSpec=spec;
	return notes;
}

// Aperçu (hover) : calcule le voicing d'une cellule SANS jouer ni polluer la mémoire VL.
// État VL JETABLE (snapshot + restore) -> le prochain accord réel n'est pas affecté.
// Toujours en démarrage à froid -> montre la forme CANONIQUE de la cellule (stable).
function _vl2_previewNotes(fn,d,colorSemis,colorType){
	var spec=_vl2_specFor(fn,d,colorSemis,colorType);   // même pipeline que le play
	if(!spec)return null;
	var vc=currentVoicing,regBase=_vl2_regBase();
	var cands=_vl2_realize(spec,vc,{regBase:regBase,rootPos:!voiceLeadingEnabled});
	if(!cands.length)return null;
	// MÊME centre + MÊME flag absolu que le play (était _vl2_center → C4 pour les ABSOLUTE, d'où le saut
	// de registre entre survol et jeu). _vl2_selCtr = poche du grip + registre maison du fallback.
	var selCtr=_vl2_selCtr(cands);
	var key=_vl2_specKey(spec)+'|'+vc+'|'+selCtr+'|prev';
	var sv=_vl2_st.voices,sr=_vl2_st.recall;                           // snapshot (select ne touche pas _vl2_prevSpec)
	_vl2_st.voices=null;_vl2_st.recall=new Map();                      // état froid jetable
	var notes=_vl2_select(cands,{mode:'flow',center:selCtr,key:key,voicing:vc,spec:spec,prevSpec:null,absolute:_vl2_ABSOLUTE.has(cands[0].voicing)});
	_vl2_st.voices=sv;_vl2_st.recall=sr;                               // restore (pas de pollution VL)
	return notes;
}
function preview(fn,d){
	var notes=_vl2_previewNotes(String(fn),parseInt(d),0,'');
	if(notes&&notes.length)outlet(7,['previewnotes'].concat(notes));
}
function previewcolor(semis,type){
	var notes=_vl2_previewNotes('color',0,parseInt(semis),String(type));
	if(notes&&notes.length)outlet(7,['previewnotes'].concat(notes));
}

// =====================================================

// Distribution triangulaire centrée sur 0, plage [-1,1] (somme de 2 uniformes).
// Plus musical qu'une uniforme : les petites variations dominent, les extrêmes rares.
function _bell() { return Math.random() + Math.random() - 1; }

function humanizeVel(v) {
	v = Math.max(1, Math.min(127, Math.round(v)));   // clamp toujours (la rampe peut dépasser 127)
	if (!humanizeAmt) return v;
	var spread = humanizeAmt * 0.55;           // 100% → ±55
	var off = Math.round(_bell() * spread);
	return Math.max(1, Math.min(127, v + off));
}

// Décalage de timing en ms (humanize). 100% → ±60ms environ.
function humanizeTime() {
	if (!humanizeAmt) return 0;
	return _bell() * (humanizeAmt / 100 * 60);
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
	// ⚠️ La VÉRITÉ = lastFn/lastDegree (posés par chaque fonction d'accord) ; l'argument `notes`
	// n'est qu'un FILET DE SECOURS (applyVoicing) si vl2 ne sort aucun candidat.
	var v2 = _vl2_play(lastFn, lastDegree, lastColorSemis, lastColorType);
	notes = (v2 && v2.length) ? v2 : applyVoicing(notes);
	if (_chordifyMode) { _chordifyResult = notes.slice(); return; }   // CHORDIFY : capture le voicing (VL avancé), zéro son/UI/état
	sendNoteOff();
	activeNotes = notes.slice();
	lastChordNotes = notes.slice();            // survit au note-off → utilisé par le glisser → ajout
	_emitNotes(notes);
	if (captureMode) captureChord(name);       // progression -> clip (capture si ON)
	outlet(7, "active", lastFn, lastDegree);   // highlight grille
	if (smartOn) { _sg_remember(); _sg_broadcast(); }   // smart chords : recompute heat-map
	outlet(7, ["notes"].concat(activeNotes));  // → clavier moniteur
}

// =====================================================
// PROGRESSION -> CLIP (device-only) — capture les accords joués puis les écrit
// dans un clip Live. Voir docs/decisions.md (2026-06-16) + issue #1.
// captureMode est OFF par défaut -> AUCUN impact sur le jeu normal.
// =====================================================
var captureMode = false;       // toggle UI : ON = on empile chaque accord joué
var progression = [];          // [{ name:"Cmaj7", notes:[48,52,55,59] }]
var CLIP_BEATS_PER_BAR = 4;    // fallback si la signature de Live est illisible (sendclip lit la vraie) ; 1 accord = 1 mesure
var insertCursor = -1;         // index d'insertion (clic sur une carte) ; -1 = ajout à la fin
var PROG_MAX     = 8;          // limite d'accords (pas de scroll) ; au-delà on n'ajoute plus

// Libellé de degré (chiffre romain) de l'accord courant, pour la carte de progression.
// Diatonique : casse selon la qualité du triade du degré (I, ii, iii, IV, V, vi, vii°).
// Emprunt (lastFn === "color") : chiffre romain de l'accord emprunté (carte violette côté UI).
function currentRoman() {
	if (lastFn === "color") {
		var bl = borrowedFor();
		for (var i = 0; i < bl.length; i++) {
			if (bl[i].semis === lastColorSemis && bl[i].type === lastColorType) return bl[i].roman || "·";
		}
		return "·";
	}
	var ROMAN = ["I","II","III","IV","V","VI","VII"];
	var base = ROMAN[lastDegree] || "·";
	var q = chordQuality(lastDegree);
	if (q === 1) return base.toLowerCase();             // mineur
	if (q === 2) return base.toLowerCase() + "°";  // diminué (°)
	if (q === 3) return base + "+";                     // augmenté
	return base;                                         // majeur
}

// Construit une entrée de progression depuis l'accord COURANT (lastFn/lastDegree/last*).
// `notesArr` = notes à stocker : activeNotes (jeu live) ou lastChordNotes (glisser → ajout).
function _progEntry(name, notesArr) {
	return {
		name: String(name),
		roman: currentRoman(),
		deg: (lastFn === "color" ? -1 : lastDegree),   // -1 = emprunt (violet) ; 0..6 = degré
		fn: lastFn,                                     // re-dérivation (substituts/voicings/suite Push)
		colorSemis: lastColorSemis, colorType: lastColorType,
		notes: notesArr.slice()
	};
}

// Appelé depuis sendChord() quand captureMode est ON : empile l'accord joué (clic, clavier MIDI
// ou pad Push). 1 déclenchement = 1 carte.
function captureChord(name) {
	var entry = _progEntry(name, activeNotes);
	if (_progCommit) {                                 // édition depuis le Push (rangées 1-7, CAPTURE on)
		var c = _progCommit; _progCommit = null;
		if (c.mode === "replace" && c.idx >= 0 && c.idx < progression.length) {
			progression.splice(c.idx, 1, entry);       // Subs/Voicings : remplace l'étape (taille inchangée, ignore PROG_MAX)
		} else if (progression.length < PROG_MAX) {
			var at = c.idx + 1; if (at < 0) at = 0; if (at > progression.length) at = progression.length;
			progression.splice(at, 0, entry);          // Suite : insère APRÈS l'étape (respecte PROG_MAX)
		} else { outlet(7, "progfull"); return; }
		broadcastProg();
		return;
	}
	if (progression.length >= PROG_MAX) { outlet(7, "progfull"); return; }   // limite atteinte (8)
	if (insertCursor >= 0 && insertCursor <= progression.length) {
		progression.splice(insertCursor, 0, entry);   // insère à la position du curseur, qui RESTE fixe :
		                                               // l'accord suivant s'insère au MÊME point (devant le précédent)
	} else {
		progression.push(entry);                       // sinon : ajout à la fin
	}
	broadcastProg();
}

function capture(v) {                      // toggle « Capture » depuis l'UI
	captureMode = (parseInt(v) === 1);
	outlet(7, "capture", captureMode ? 1 : 0);
}
function clearprog()  { progression = []; insertCursor = -1; broadcastProg(); }
function removelast() { if (progression.length) progression.pop(); broadcastProg(); }
function removeat(i)  {
	i = parseInt(i);
	if (i >= 0 && i < progression.length) {
		progression.splice(i, 1);
		if (insertCursor > i) insertCursor--;                       // le curseur suit le décalage
		if (insertCursor > progression.length) insertCursor = progression.length;
		broadcastProg();
	}
}
// Curseur d'insertion posé par l'UI (clic sur une carte). -1 = ajout à la fin.
function setcursor(i) { insertCursor = parseInt(i); }
// Réordonne : déplace l'accord d'index `from` vers la position `to` (glisser-déposer).
function moveprog(from, to) {
	from = parseInt(from); to = parseInt(to);
	if (from < 0 || from >= progression.length) return;
	var item = progression.splice(from, 1)[0];
	var t = (to > from) ? to - 1 : to;           // après retrait, les positions > from se décalent
	if (t < 0) t = 0;
	if (t > progression.length) t = progression.length;
	progression.splice(t, 0, item);
	broadcastProg();
}
// Ajoute l'accord COURANT (dernier joué/glissé) à la position `pos` — hors mode capture
// (utilisé par le glisser d'une case de la grille vers la progression).
function captureone(name, pos) {
	if (progression.length >= PROG_MAX) { outlet(7, "progfull"); return; }
	pos = parseInt(pos);
	var entry = _progEntry(name, lastChordNotes);   // ← dernier accord joué (activeNotes a pu être vidé par le release)
	if (pos >= 0 && pos <= progression.length) progression.splice(pos, 0, entry);
	else progression.push(entry);
	broadcastProg();
}
// Écoute (audition) d'UN accord de la progression : rejoue ses notes puis note-off auto (~0.8 s).
// Pas de séquence — un seul accord, conforme au principe « pas un séquenceur ».
function playprog(i) {
	i = parseInt(i);
	if (i < 0 || i >= progression.length) return;
	var p = progression[i];
	var notes = p.notes;
	if (!notes || !notes.length) return;
	sendNoteOff();
	activeNotes = notes.slice();
	lastChordNotes = notes.slice();             // survit au note-off
	// Reconstruit le contexte de l'accord (depuis l'entrée) → le smart + la grille à l'écran SUIVENT
	// l'accord de progression joué (sinon SMART on + lecture progression ne rafraîchissait pas l'UI).
	lastFn = p.fn || "triad";
	lastColorSemis = p.colorSemis; lastColorType = p.colorType;
	if (p.deg != null && p.deg >= 0) lastDegree = p.deg;
	_emitNotes(notes);                          // MÊME chemin d'émission que le jeu de la grille (fiable)
	// Monitor : nom + degré de la carte. APRÈS sendNoteOff (qui émet 'clearnotes' → l'UI vide
	// activeChordName) et AVANT 'notes' (qui rend le Monitor) — sinon le texte resterait vide.
	outlet(7, "monitor", p.name, (p.deg == null ? -1 : p.deg));
	outlet(7, ["notes"].concat(activeNotes));   // clavier moniteur
	outlet(7, "active", lastFn, lastDegree);    // surbrillance de la grille à l'écran
	if (smartOn) { _sg_remember(); _sg_broadcast(); }   // la heat-map suit l'accord de progression joué
	// pas de note-off auto : la note tient jusqu'au relâchement (message 'release', comme la grille)
}

// APERÇU au survol d'une carte de progression (UI) : émet ses notes stockées via 'previewnotes' (même
// pipeline que l'aperçu de la grille) — SANS jouer ni toucher l'état (activeNotes/smart/last*). Le nom
// est géré côté UI (_previewLabel). Mineur : ne recalcule pas le voicing, montre les notes capturées.
function previewprog(idx) {
	idx = parseInt(idx);
	if (idx < 0 || idx >= progression.length) return;
	var p = progression[idx];
	if (p.notes && p.notes.length) outlet(7, ["previewnotes"].concat(p.notes));
}

// Diffuse la progression à l'UI par TRIPLETS : "prog <nom> <romain> <deg> …" (vide = "prog" seul).
// deg : -1 = emprunt (carte violette) ; 0..6 = degré (couleur de la grille).
function broadcastProg() {
	var flat = [];
	for (var i = 0; i < progression.length; i++) {
		var p = progression[i];
		flat.push(p.name);
		flat.push(p.roman || "·");
		flat.push(p.deg);
	}
	outlet(7, ["prog"].concat(flat));
	outlet(7, "cursor", insertCursor);
	if (progPushOn) broadcastProgPush();   // le Push reflète la progression à chaque changement
}

// =====================================================
// PROGRESSION → PUSH (device-only) — layout « progression » sur le Push 2 : rangée du BAS = les étapes
// capturées ; au-dessus de CHAQUE accord (dans sa colonne) = ses options (6 max) selon le mode actif
// (Substituts / Suite / Voicings), séparées par une rangée vide. Spec :
// docs/superpowers/specs/2026-06-22-push-progression-3modes-design.md.
// =====================================================
var PROG_MODE_SUBS = 0, PROG_MODE_SUITE = 1, PROG_MODE_VOIC = 2;
var progMode   = PROG_MODE_SUBS;   // mode actif des options (rangées 1-7)
var progSel    = -1;               // étape sélectionnée ; -1 = dernière étape de la progression
var progPushOn = false;            // le layout Push « progression » est-il actif ? (toggle UI 'progmode')
function _progSelIdx(){ return (progSel >= 0 && progSel < progression.length) ? progSel : progression.length - 1; }

// Options empilées au-dessus de l'accord `idx` selon le mode actif, **6 MAX** (la rangée du bas = étapes
// + 1 rangée vide séparatrice réservent 2 des 8 rangées). Retourne [{deg, fn, kind, …}] — voic: +voicing ;
// emprunt: +colorSemis/colorType.
var PROG_OPT_MAX = 6;
function _progOptions(idx){
	if (idx < 0 || idx >= progression.length) return [];
	var step = progression[idx], out, v;
	if (progMode === PROG_MODE_VOIC){
		out = [];                                       // voicings de CET accord (6 premiers ; curation fine = futur)
		for (v = 0; v < VOICING_NAMES.length && out.length < PROG_OPT_MAX; v++)
			out.push({ deg:step.deg, fn:step.fn, kind:"voic", voicing:VOICING_NAMES[v], colorSemis:step.colorSemis, colorType:step.colorType });
		return out;
	}
	out = (progMode === PROG_MODE_SUITE) ? _suiteOptions(idx) : substitutesFor({ deg:step.deg, fn:step.fn });
	return (out.length > PROG_OPT_MAX) ? out.slice(0, PROG_OPT_MAX) : out;
}

// Diffuse la progression + les options PAR COLONNE vers le Push (outlet 7). Layout : rangée du bas =
// étapes ; au-dessus de CHAQUE accord (sa colonne) = ses propres options (6 max) selon le mode. progopt
// est POSITIONNÉ : col (= l'étape) + optrow (1..6). progclear → progstep* → progopt* → progsel → progdone.
function broadcastProgPush(){
	outlet(7, "progclear");
	var i, j, opts;
	for (i = 0; i < progression.length; i++){
		outlet(7, "progstep", i, progression[i].deg);              // rangée du bas (deg : -1 emprunt ; 0..6 degré)
		opts = _progOptions(i);                                     // options de CET accord
		for (j = 0; j < opts.length; j++)
			outlet(7, "progopt", i, j + 1, (opts[j].deg == null ? -1 : opts[j].deg), opts[j].kind);   // col=i, optrow=j+1
	}
	outlet(7, "progsel", _progSelIdx(), progMode);
	outlet(7, "progdone");
}

// --- Handlers du layout Push « progression » (toggle / cycle de mode / sélection d'étape / option) ---
var _progCommit = null;   // {mode:"replace"|"insert", idx} : posé par selopt, consommé par captureChord

// Réalise les notes d'une option SANS effet de bord (preview VL jetable) — pour l'audition (CAPTURE off).
function _realizeOption(idx, opt){
	var step = progression[idx], fn, d, cs, ct;
	if (opt.kind === "voic"){ fn = step.fn; d = step.deg; cs = step.colorSemis; ct = step.colorType; }   // re-voice de l'étape
	else if (opt.fn === "color"){ fn = "color"; d = 0; cs = opt.colorSemis; ct = opt.colorType; }        // emprunt (suite)
	else { fn = opt.fn; d = opt.deg; cs = 0; ct = ""; }                                                   // diatonique
	if (fn === "color") d = 0;
	var notes, savedVc;
	if (opt.kind === "voic" && opt.voicing){ savedVc = currentVoicing; currentVoicing = opt.voicing; notes = _vl2_previewNotes(fn, d, cs, ct); currentVoicing = savedVc; }
	else notes = _vl2_previewNotes(fn, d, cs, ct);
	return notes || [];
}
// Émet un accord d'audition (même chemin que playprog : note-off + _emitNotes + Monitor + clavier).
function _auditionNotes(notes, name, deg){
	if (!notes || !notes.length) return;
	sendNoteOff();
	activeNotes = notes.slice();
	_emitNotes(notes);
	if (name != null) outlet(7, "monitor", String(name), (deg == null ? -1 : deg));   // nom + degré (APRÈS clearnotes de sendNoteOff, AVANT 'notes' — sinon le Monitor reste vide)
	outlet(7, ["notes"].concat(activeNotes));
}
// Nom d'affichage d'une option pour le Monitor : libellé diatonique (gridLabel) ou nom d'emprunt.
function _optName(opt){
	if (opt.fn === "color"){
		var bl = borrowedFor(), i;
		for (i = 0; i < bl.length; i++) if (bl[i].semis === opt.colorSemis && bl[i].type === opt.colorType) return NOTE_NAMES[(((root + bl[i].semis) % 12) + 12) % 12] + bl[i].suf;
		return "·";
	}
	return gridLabel(opt.deg, opt.fn);
}
// Cellule de grille (forme playFlatCell) pour une option / une étape : emprunt -> "b", sinon "d".
function _cellFor(o){ return (o.fn === "color") ? { kind:"b", semis:o.colorSemis, type:o.colorType } : { kind:"d", fn:o.fn, degree:o.deg }; }

function progmode(v){ progPushOn = (parseInt(v) === 1); outlet(7, "progmode", progPushOn ? 1 : 0); if (progPushOn) broadcastProgPush(); }
function progmodecycle(){ progMode = (progMode + 1) % 3; outlet(7, "progmodeui", progMode); if (progPushOn) broadcastProgPush(); }
// Sélection d'une étape (rangée 0 du Push) : la sélectionne + l'écoute (réutilise playprog).
function selprog(col){
	var i = parseInt(col);
	if (i < 0 || i >= progression.length) return;
	progSel = i;
	playprog(i);
	if (progPushOn) broadcastProgPush();
}
// Appui d'une option au-dessus d'un accord. `col` = la colonne = l'accord concerné ; `row` = 1..6.
// CAPTURE off -> écoute ; CAPTURE on -> édite : Subs/Voicings remplacent l'accord de la colonne, Suite
// insère après — en rejouant l'option par le VRAI chemin (son/nom/état) via _progCommit.
function selopt(col, row){
	var idx = parseInt(col), r = parseInt(row);
	if (idx < 0 || idx >= progression.length) return;
	var opts = _progOptions(idx);
	if (r - 1 < 0 || r - 1 >= opts.length) return;
	var opt = opts[r - 1];
	if (!captureMode){ _auditionNotes(_realizeOption(idx, opt), _optName(opt), (opt.deg == null ? -1 : opt.deg)); return; }   // écoute + nom dans le Monitor
	var step = progression[idx], cell, savedVc = null;
	if (opt.kind === "voic"){
		cell = _cellFor({ fn:step.fn, deg:step.deg, colorSemis:step.colorSemis, colorType:step.colorType });
		if (opt.voicing){ savedVc = currentVoicing; currentVoicing = opt.voicing; }   // re-voice temporaire (n'altère pas le voicing live)
		_progCommit = { mode:"replace", idx:idx };
	} else if (progMode === PROG_MODE_SUITE){
		cell = _cellFor(opt);
		_progCommit = { mode:"insert", idx:idx };
	} else {                                                                          // SUBS
		cell = _cellFor(opt);
		_progCommit = { mode:"replace", idx:idx };
	}
	playFlatCell(cell);                 // -> sendChord -> captureChord consomme _progCommit (splice)
	if (savedVc !== null) currentVoicing = savedVc;
	_progCommit = null;                 // filet : déjà consommé en temps normal
}

// Écrit la progression dans le clip de l'emplacement SÉLECTIONNÉ (1 accord = 1 mesure).
// NON destructif : si le slot contient déjà un clip -> "clipbusy" (on n'écrase pas).
// Notes "block" propres (pas de strum/humanize : ce sont des effets de jeu).
function sendclip() {
	if (!progression.length) { outlet(7, "clipempty"); post("sendclip: progression vide\n"); return; }
	try {
		// 1 accord = 1 mesure, à la signature rythmique RÉELLE de Live (était 4/4 EN DUR -> faux en 3/4, 6/8…).
		// Le temps de clip Live se compte en noires : 1 mesure = num * 4/den noires (4/4->4, 3/4->3, 6/8->3).
		var song = new LiveAPI(function(){}, "live_set");
		var num = song.get("signature_numerator");   num = parseInt((num instanceof Array) ? num[0] : num);
		var den = song.get("signature_denominator"); den = parseInt((den instanceof Array) ? den[0] : den);
		var barLen = (num > 0 && den > 0) ? (num * 4 / den) : CLIP_BEATS_PER_BAR;
		var total  = progression.length * barLen;
		var notes = [], i, k;
		for (i = 0; i < progression.length; i++) {
			var start = i * barLen, ns = progression[i].notes;
			for (k = 0; k < ns.length; k++) notes.push({ pitch: ns[k], start: start, dur: barLen, vel: 100 });
		}
		var r = _writeClipNotes(notes, total, false);   // progression = clip neuf (jamais overdub) ; 1 accord = 1 mesure
		if (r === "noslot") { outlet(7, "clipnoslot"); post("sendclip: aucun slot selectionne\n"); return; }
		if (r === "busy")   { outlet(7, "clipbusy");   post("sendclip: slot occupe -> choisir un slot vide\n"); return; }
		outlet(7, "clipdone", progression.length);
		post("sendclip: " + progression.length + " accords -> clip (" + total + " temps)\n");
	} catch (e) { outlet(7, "cliperr"); post("sendclip ERR " + e + "\n"); }
}

// =====================================================
// PROGRESSION -> CLIP : écriture des notes via LiveAPI (utilisé par sendclip).
// =====================================================

// Écrit notes=[{pitch,start,dur,vel}] dans le clip du slot SÉLECTIONNÉ (API moderne add_new_notes).
// overdub=false : refuse un slot occupé (busy) ; overdub=true : empile. Renvoie "ok"|"noslot"|"busy"|"empty".
function _writeClipNotes(notes, totalBeats, overdub) {
	if (!notes || !notes.length) return "empty";
	var slot = new LiveAPI(function(){}, "live_set view highlighted_clip_slot");
	if (!slot || !slot.id || parseInt(slot.id) === 0) return "noslot";
	var has = slot.get("has_clip"); has = (has instanceof Array) ? has[0] : has;
	var hasClip = (parseInt(has) === 1);
	if (hasClip && !overdub) return "busy";
	if (!hasClip) slot.call("create_clip", totalBeats);   // overdub sur slot vide -> on crée quand même
	var clip = new LiveAPI(function(){}, "live_set view highlighted_clip_slot clip");
	if (!clip || !clip.id || parseInt(clip.id) === 0) return "noslot";
	var arr = [], i;
	for (i = 0; i < notes.length; i++) {
		arr.push({ pitch: notes[i].pitch, start_time: notes[i].start, duration: notes[i].dur, velocity: (notes[i].vel > 0 ? notes[i].vel : 100) });
	}
	clip.call("add_new_notes", { notes: arr });   // API moderne (Live 11+) ; remplace set_notes/note/done déprécié (= 0 note)
	return "ok";
}

// =====================================================
// CHORDIFY — transforme un clip de notes-DÉCLENCHEURS (enregistré NATIVEMENT par Live en jouant
// Tuple au clavier/Push) en ACCORDS Tuple : chaque déclencheur -> son voicing, MÊME temps/durée/vélo.
// Le dur (enregistrement, timing, repos, vélo) = natif Live ; Tuple = pur transform du clip.
// =====================================================
var _chordifyMode = false;     // quand true, sendChord CAPTURE le voicing au lieu d'émettre
var _chordifyResult = null;

// Lit les notes d'un clip -> [{pitch,start,dur,vel}]. get_notes_extended renvoie une CHAÎNE JSON
// { "notes": [ { pitch, start_time, duration, velocity, ... } ] } (Live 11/12).
function _readClipNotes(clip) {
	var raw = clip.call("get_notes_extended", 0, 128, 0, 1000000);
	var data;
	try { data = JSON.parse(raw); }
	catch (e) { post("[CHORDIFY] JSON parse ERR: " + e + " raw[0..80]=" + String(raw).substring(0, 80) + "\n"); return []; }
	var ns = (data && data.notes) ? data.notes : [];
	var out = [], i;
	for (i = 0; i < ns.length; i++) {
		out.push({ pitch: parseInt(ns[i].pitch), start: parseFloat(ns[i].start_time), dur: parseFloat(ns[i].duration), vel: parseInt(ns[i].velocity) });
	}
	return out;
}

// Transforme le clip sélectionné : chaque déclencheur -> son accord Tuple, au même temps/durée/vélo.
function chordify() {
	try {
		var clip = new LiveAPI(function(){}, "live_set view detail_clip");
		if (!clip || !clip.id || parseInt(clip.id) === 0) clip = new LiveAPI(function(){}, "live_set view highlighted_clip_slot clip");
		if (!clip || !clip.id || parseInt(clip.id) === 0) { outlet(7, "clipnoslot"); post("chordify: aucun clip selectionne\n"); return; }
		var trigs = _readClipNotes(clip);
		if (!trigs.length) { outlet(7, "clipempty"); post("chordify: clip vide\n"); return; }
		trigs.sort(function(a, b){ return a.start - b.start; });
		var _sv = _vl2_st.voices, _sr = _vl2_st.recall;     // snapshot VL
		_vl2_st.voices = null; _vl2_st.recall = new Map();  // repart à zéro -> rejoue la séquence proprement (VL)
		var out = [], i, k;
		_chordifyMode = true;
		for (i = 0; i < trigs.length; i++) {
			var idx = trigs[i].pitch - MIDI_BASE;
			if (idx < 0 || idx >= flatGrid.length) continue;   // pas une note de la grille Tuple -> on saute
			_chordifyResult = null;
			playFlatCell(flatGrid[idx]);                       // -> sendChord (mode chordify) -> _chordifyResult = voicing
			var ch = _chordifyResult;
			if (ch && ch.length) for (k = 0; k < ch.length; k++) {
				out.push({ pitch: ch[k], start_time: trigs[i].start, duration: trigs[i].dur, velocity: (trigs[i].vel > 0 ? trigs[i].vel : 100) });
			}
		}
		_chordifyMode = false;
		_vl2_st.voices = _sv; _vl2_st.recall = _sr;         // restore VL (le jeu live n'est pas perturbé)
		clip.call("remove_notes_extended", 0, 128, 0, 1000000);
		clip.call("add_new_notes", { notes: out });
		outlet(7, "chordifydone", out.length);
		post("chordify: " + trigs.length + " declencheurs -> " + out.length + " notes\n");
	} catch (e) { outlet(7, "cliperr"); post("chordify ERR " + e + "\n"); }
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
	var q = iv[6]===11 ? "M7"
	      : (iv[2]===3 && iv[4]===6 && iv[6]===10) ? "ø7"
	      : (iv[2]===3 && iv[4]===6 && iv[6]===9)  ? "dim7"
	      : (iv[2]===3) ? "m7" : "7";   // M7 (pas "maj7") → identique à la grille (gridLabel)
	sendChord(noteName(notes[0]) + q, notes);
}

function nine(d) {
	d = parseInt(d); lastFn = "nine"; lastDegree = d;
	if (!isValid(d,"nine") && !isValid(d,"maj9") && !isValid(d,"min9")) {
		post("nine " + d + " : invalid\n"); return;
	}
	var notes = buildNotes(d, [0,2,4,6,8]);
	var iv = getIntervals(d);
	var q = iv[6]===11 ? "M9" : (iv[2]===3) ? "m9" : "9";   // M9 (pas "maj9") → identique à la grille
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

	var ivs = COLOR_IV[type] || COLOR_IV.maj;

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

// Auto-updater:
//  - DETECTION is browser-side in the jweb (checkForUpdates() → GitHub API).
//  - INSTALL goes through tuple_dl (node.script): installupdate() below sends
//    'dl <url> <platform> <amxdPath>' to it. tuple_dl downloads + extracts
//    in-place (or launches the installer on Win+requires_reinstall), and
//    reports back to the jweb via its OWN outlet wired in tuple.amxd
//    (obj-UPD-dl → strip jweb + s tuple_ui): updprogress/updone/upderr.
//  This is NOT the old _wire_updater relay (removed in 1c1416b) — just one
//  node.script + two patchlines. See docs/decisions.md.

// Diffusion initiale de la grille (différée le temps que l'UI charge) — passe par la surface unique
var gridInitTask = new Task(broadcastSurface, this);
gridInitTask.schedule(700);

// Auto-sync observers — init at global scope too so autowatch reloads recreate them.
var _autoSyncInitTask = new Task(_initAutoSync, this);
_autoSyncInitTask.schedule(800);

// =====================================================
// SELF-CHECK — confirme que les globals critiques sont initialisés.
// Visible dans device/max_console.log après (re)chargement.
// =====================================================
(function _selfCheck(){
	try {
		var okSt = (typeof _vl2_st !== 'undefined' && _vl2_st && _vl2_st.recall);
		// VOICING_NAMES doit avoir 28 entrées (classic..power, trap supprimé). Si on en ajoute/retire sans
		// mettre à jour l'UI (VOICINGS dans tuple_ui.html + VOICEKEYS dans demo.html + le live.menu du .amxd), le mapping par index diverge.
		var vcOk = VOICING_NAMES.length === 28;
		post("tuple selfcheck: Set=" + (typeof Set !== 'undefined') +
		     " Map=" + (typeof Map !== 'undefined') +
		     " _vl2_st=" + (okSt ? "ok" : "KO") +
		     " STRUCT=" + (typeof _vl2_STRUCT !== 'undefined') +
		     " VOICING_NAMES=" + VOICING_NAMES.length + (vcOk ? "" : " ⚠️ DESYNC UI") + "\n");
	} catch(e) { post("tuple selfcheck ERROR: " + e + "\n"); }
})();

