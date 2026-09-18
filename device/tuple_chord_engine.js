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
// ⚠️ NE PAS remettre un chemin absolu ici. Jusqu'au 2026-08-13 cette ligne valait en dur
// "C:/Users/LEETJ/Desktop/Tuple/device/max_console.log" — dossier qui n'existe plus (vérifié).
// `new File(...)` sur un dossier absent échoue en silence : DEBUG = 1 écrivait donc dans le
// vide, sans la moindre erreur, sur toute machine sauf une — et le § Troubleshooting de
// CLAUDE.md envoyait lire un fichier qui ne pouvait pas exister. Le chemin se déduit
// maintenant du patch lui-même, à côté du .amxd, donc partout.
var DBG_LOG = "";        // résolu à la première écriture, puis mémorisé
var _dbgThis = this;     // au sommet du fichier, `this` est l'objet [js] ; absent sous le harnais
var _dbgFresh = false;   // le fichier a-t-il déjà été remis à zéro pour ce chargement ?
var _origPost = post;
// `patcher.filepath` est vide tant que le patch n'est pas chargé, donc la résolution est
// PARESSEUSE : les tout premiers post() (avant loadbang) restent console-seule.
function _dbgResolve() {
	if (DBG_LOG) return DBG_LOG;
	try {
		// Deux sources, dans cet ordre. `_patcher` est posé par loadbang() et c'est la
		// voie fiable ; `this` au sommet du fichier N'EST PAS toujours l'objet [js] —
		// mesuré le 2026-08-13, DEBUG = 1 n'écrivait rien avec cette seule source.
		var pat = (typeof _patcher !== 'undefined' && _patcher) ? _patcher
		        : ((_dbgThis && _dbgThis.patcher) ? _dbgThis.patcher : null);
		var fp = pat ? pat.filepath : "";
		if (fp && fp.length) {
			// `new File` veut un chemin Max-style : "C:/…" et "Macintosh HD:/…" passent
			// tels quels, pas de conversion POSIX ici (contrairement à _uiUrl, qui bâtit
			// une URL pour jweb — deux besoins différents, ne pas les fusionner).
			fp = fp.replace(/\\/g, '/');
			DBG_LOG = fp.substring(0, fp.lastIndexOf('/') + 1) + "max_console.log";
		}
	} catch(e) {}
	return DBG_LOG;
}
if (DEBUG) {
	post = function(){
		var s = Array.prototype.slice.call(arguments).join(" ");
		_origPost(s);                              // console Max normale
		try {
			var p = _dbgResolve(); if (!p) return;
			if (!_dbgFresh) {
				var t = new File(p, "write");          // crée/tronque, une fois par chargement
				if (t.isopen) { t.writestring("=== chord_engine.js (re)chargé ===\n"); t.close(); }
				_dbgFresh = true;
			}
			var f = new File(p, "readwrite");        // append
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
//
// ⚠️ Cacher la COLONNE ne suffisait pas. Mesuré le 2026-09-14 en do majeur pentatonique :
// 23 cases sur 37 des colonnes GARDÉES jouaient un fa ou un si — les deux notes que la gamme
// n'a pas. Les accords s'empilent en tierces dans la gamme PARENTE à sept notes (pentamaj a
// les intervalles de la majeure), donc `Dm` ramassait le fa et `G` le si. `_scaleAllowsSpec`
// ci-dessous ferme la porte : une case dont l'accord sort du set est invalide, comme une
// colonne masquée. Il reste 14 cases, réparties sur quatre colonnes — C, Csus2, Cadd9, C6,
// C6/9, Dsus4, Dsus2, D7sus4, Gsus4, Gsus2, Am, Am7, Asus4, A7sus4.
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
// Style CONCRET joué par la grille — toujours un VOICING_NAME, jamais un sentinel.
// Il n'existe PLUS de seconde clé de picker : le choix automatique de style est mort le
// 2026-08-11 (mesuré : « auto » libre ne rendait que 4 styles sur 28, et chaque clé de
// catégorie rendait un seul membre sur 42/42 cases). Un style est désormais toujours
// désigné par l'utilisateur, donc « ce qui joue » et « ce qui est choisi » ne peuvent
// plus diverger — d'où une seule variable au lieu de deux.
var currentVoicing      = "classic";
var voiceLeadingEnabled = false;
var activeNotes         = [];
var lastChordNotes      = [];         // dernier accord JOUÉ (non vidé par sendNoteOff) — pour le glisser → ajout
var vlMode              = "anchored";  // "anchored" | "flow"
var lastColorSemis      = 0;          // dernier accord emprunté (pour vl2)
var lastColorType       = "maj";
var _strumMs            = 0;          // ms/note SIGNÉ : 0 = off, >0 = montant (grave→aigu), <0 = descendant (aigu→grave). Slider -60..60
var strumRamp           = 0;          // -100..100 : rampe de vélocité sur le strum. <0 = 1ère note forte puis fade, >0 = crescendo
// ── LA GÉOMÉTRIE DU STRUM, ÉCRITE UNE FOIS ──────────────────────────────────
//
// Le jeu et le clip partagent la FORME du strum et divergent sur le reste, légitimement :
// le jeu compte en millisecondes et tire `_bell()` à chaque note, le clip compte en TEMPS
// (donc lit le tempo) et tire un hasard REPRODUCTIBLE, sans quoi éditer le 5e accord
// changerait le feel des quatre premiers. Trois choses étaient malgré tout recopiées des
// deux côtés, à mille lignes d'écart, et rien ne les appariait.
//
// ⚠️ LE RANG EST PAR HAUTEUR, PAS PAR ORDRE DE STOCKAGE. L'ordre interne d'un voicing n'est
// pas trié : un `drop2` range la note descendue là où la transformée l'a mise. Jouer dans
// l'ordre de stockage donnerait un strum qui saute.
function _strumRank(notes) {
	var n = notes.length, order = [], rank = [], j;
	for (j = 0; j < n; j++) order.push(j);
	order.sort(function (a, b) { return notes[a] - notes[b]; });
	for (j = 0; j < n; j++) rank[order[j]] = j;
	return rank;
}

// Position dans la SÉQUENCE de jeu : 0 = première note jouée. `up` inverse le sens.
function _strumSeq(rank, idx, n, up) { return up ? rank[idx] : (n - 1 - rank[idx]); }

// La courbe, en FRACTION de la durée nominale : 0 pour la première note, 1 pour la
// dernière, et l'exposant entre les deux. Chaque appelant la multiplie par sa propre
// durée — c'est là que les unités se séparent.
function _strumFrac(seq, n, p) { return Math.pow(n > 1 ? seq / (n - 1) : 0, p); }

// Rampe de vélocité le long de la séquence : facteur 1 ± 0,5 · ramp. Le « 0,5 » borne
// l'écart total à la moitié du réglage, sans quoi ramp = 100 éteindrait la première note.
function _strumRampFactor(seq, n, ramp) {
	var pos = (n > 1) ? seq / (n - 1) : 0;
	return 1 + (ramp / 100) * (pos * 2 - 1) * 0.5;
}

var STRUM_CURVE_P       = [1.0, 0.55, 1.8];  // exposant : Linear · Accel · Decel
var strumCurve          = 0;          // Linear par défaut
var humanizeAmt         = 0;          // 0-100 : 0 = off ; variation vélocité ±55 + timing ±60ms
var _emitTasks          = [];         // Tasks de notes différées (strum/humanize) en cours

var TUPLE_VERSION = "1.5.0";

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
		transportwatch();   // PLAY / STOP de la façade suivent l'état de lecture de Live
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
	voicingidx: voicingidx, spacingidx: spacingidx, voicingkey: voicingkey, voiceleading: voiceleading, vlmode: vlmode,
	voicing: voicing, synclive: synclive, requestgrid: requestgrid,
	requeststate: requeststate, midinote: midinote, key: key,
	keynote: keynote, keynoteup: keynoteup, pushmode: pushmode, smart: smart, smartmode: smartmode,
	colorscheme: colorscheme, strumms: strumms, strumramp: strumramp,
	strumcurve: strumcurve, humanizeamt: humanizeamt, velmin: velmin, velmax: velmax,   // #38
	openurl: openurl, openwindow: openwindow, installupdate: installupdate,
	capture: capture, clearprog: clearprog,
	removeat: removeat, setcursor: setcursor, playprog: playprog, moveprog: moveprog,
	setinv: setinv, resetinv: resetinv, setoct: setoct, settension: settension, avoidnotes: avoidnotes,   // tuple-dev#68
	progvoicing: progvoicing,
	captureone: captureone, autosync: setautosync, progress: handleprogress,
	useflats: useflats, theme: theme, loopbars: loopbars, pages: pages, page: page, preview: preview, previewcolor: previewcolor, previewprog: previewprog, extended: extended,
	progmode: progmode, progmodecycle: progmodecycle, selprog: selprog, selopt: selopt,
	voiceleadall: voiceleadall,
	capturetoggle: capturetoggle,
	borpage: borpage, borpagecycle: borpagecycle,
	// ⚠️ Tout send('x', args…) du jweb DOIT avoir sa clé ici : multi-argument = liste,
	// et une clé absente meurt en silence dans list(). `progbars` et `cliptarget`
	// manquaient — deux contrôles UI livrés morts (audit 2026-08-18). La garde
	// device/tests/ui-fil-contract.test.mjs lit désormais l'UI et vérifie la table.
	progbars: progbars, progstart: progstart, progleft: progleft, cliptarget: cliptarget,
	clipfollow: clipfollow, clipreplace: clipreplace, progmulti: progmulti   // tuple-dev#77
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
	if (typeof Task !== 'undefined') { var t = new Task(function(){ _initAutoSync(); }, this); _deferredTasks.push(t); t.schedule(300); }
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
var _dlUrl = null, _dlPlatform = null, _dlAmxdPath = null, _dlAttempts = 0, _dlShaUrl = null;
function installupdate(url, platform, shaUrl) {
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
	_dlShaUrl = String(shaUrl || '');   // '' = no checksum asset on this release, tuple_dl skips verification
	_dlAttempts = 0;
	ndl.message('script', 'start');   // kick the Node.js process (no-op if already running)
	var t = new Task(_doDl); t.schedule(1500);
}
function _doDl() {
	if (!_dlUrl) return;              // cleared by handleprogress('done') → stops the retry
	_dlAttempts++;
	var ndl = _patcher ? _patcher.getnamed('tuple_dl') : null;
	if (!ndl) { post('tuple: _doDl — tuple_dl gone\n'); _dlUrl = null; _dlPlatform = null; _dlAmxdPath = null; _dlShaUrl = null; _dlAttempts = 0; return; }
	post('tuple: _doDl attempt ' + _dlAttempts + '\n');
	ndl.message('dl', _dlUrl, _dlPlatform, _dlAmxdPath, _dlShaUrl);
	if (_dlAttempts < 6) { var t = new Task(_doDl); t.schedule(1500); }
	else { post('tuple: _doDl — gave up after 6 attempts\n'); _dlUrl = null; _dlPlatform = null; _dlAmxdPath = null; _dlShaUrl = null; _dlAttempts = 0; }
}
// tuple_dl reports back via its outlet → obj-CE (this js) → handleprogress.
// The message arrives as the SELECTOR 'progress <state>' (node.script outlet,
// NOT a jweb list), so Max calls progress() directly — define it explicitly.
// (The LIST_DISPATCH entry only covers the jweb-list path, which never fires here.)
function progress(state) { handleprogress(state); }
function useflats(v) { outlet(7, 'useflats', parseInt(v) !== 0 ? 1 : 0); }
// Thème de la façade (jour | nuit). LE MOTEUR EN EST LA SOURCE DE VÉRITÉ depuis le 2026-09-15.
//
// ⚠️ Il ne faisait que relayer, et deux pages pouvaient rester en désaccord indéfiniment.
// Mesuré dans Live ce jour-là : la fenêtre pleine avait `tuple_theme = 'nuit'` en mémoire et un
// `body` SANS la classe `nuit` — elle stockait nuit et rendait jour — pendant que le strip
// stockait `jour`. Le thème vivait dans le `localStorage` de CHAQUE page, sans personne pour
// trancher, et rien ne le ré-affirmait au chargement : tant que la bascule n'était pas rejouée,
// la divergence tenait. Dans une chaîne de devices sombre, un strip clair se voit.
//
// Désormais `currentTheme` est l'état, et `pushConfigState()` le rediffuse — même raison que
// `avoidnotes` et `loopbars` juste à côté : après un rechargement du jweb, la surface doit
// refléter le moteur. Le `localStorage` de chaque page reste, mais comme un CACHE qui évite le
// flash au boot, plus comme la vérité.
//
// ⚠️ Ce qui n'est PAS réglé ici, et que #46 laisse ouvert : la PERSISTANCE. `currentTheme` vit
// dans le moteur, donc il meurt avec l'instance — il n'est pas sauvegardé avec le set. Le mettre
// dans un paramètre Live est l'autre moitié de la question, et c'est une énumération de plus
// dans le `.amxd`, à ajouter EN FIN.
var currentTheme = "nuit";   // nuit par défaut (2026-09-10, Antoine) — même défaut que themeGet() côté UI
function theme(v) {
	currentTheme = (String(v) === 'nuit') ? 'nuit' : 'jour';
	outlet(7, 'theme', currentTheme);
}
// ── TRANSPORT (2026-09-11) : PLAY / STOP sur la façade lancent et arrêtent la lecture de Live ──
// Deux messages d'un atome (routés vers la fonction du même nom), et un observateur de `is_playing`
// qui renvoie `playing 0|1` à l'UI — c'est Live qui dit s'il joue, jamais le bouton.
var _transportObs = null;
function transportplay() { try { new LiveAPI(function(){}, "live_set").call("start_playing"); } catch (e) { post("transportplay: " + e + "\n"); } }
function transportstop() { try { new LiveAPI(function(){}, "live_set").call("stop_playing"); } catch (e) { post("transportstop: " + e + "\n"); } }
function _transportCb(args) {
	// LiveAPI livre [ "is_playing", 0|1 ] ; un observateur fraîchement posé peut recevoir autre chose d'abord.
	if (!args || String(args[0]) !== "is_playing") return;
	var on = parseInt(args[1]) ? 1 : 0;
	_transportOn = !!on;
	if (!on) _seqStop();                 // l'arrêt éteint la carte en cours (séquenceur interne)
	outlet(7, "playing", on);
}
// La TÊTE DE LECTURE : `current_song_time` (en temps) devient une position en MESURES sur la règle de huit
// (modulo PROG_BARS_TOTAL), envoyée à l'UI quand elle change d'au moins un centième. La longueur de mesure
// vient de la signature de Live, relue à chaque armement et toutes les 64 notifications (elle peut changer).
var _playheadObs = null, _playheadBarLen = 4, _playheadLast = -1, _playheadTick = 0;
function _playheadReadBarLen() {
	try {
		var song = new LiveAPI(function(){}, "live_set");
		var num = song.get("signature_numerator");   num = parseInt((num instanceof Array) ? num[0] : num);
		var den = song.get("signature_denominator"); den = parseInt((den instanceof Array) ? den[0] : den);
		if (num > 0 && den > 0) _playheadBarLen = num * 4 / den;
	} catch (e) {}
}
function _playheadCb(args) {
	if (!args || String(args[0]) !== "current_song_time") return;
	if ((++_playheadTick % 64) === 0) _playheadReadBarLen();
	var beats = parseFloat(args[1]); if (!(beats >= 0)) return;
	var pos = (beats / _playheadBarLen) % _songBars();    // absolu sur le morceau : l'UI en déduit la page (tuple-dev#74)
	pos = Math.round(pos * 100) / 100;
	if (pos === _playheadLast) return;
	_playheadLast = pos;
	outlet(7, "playhead", pos);
	_seqTick(pos);
}

// ── SÉQUENCEUR INTERNE (2026-09-18, Antoine : « les cartes doivent jouer du midi peu
// importe la présence d'un clip ») ──────────────────────────────────────────────────
// Nouveau contrat de lecture, qui REMPLACE « Tuple écrit un clip, il ne le joue pas
// lui-même » (CONTEXT.md mis à jour le même jour) : transport de Live en marche, Tuple
// joue LUI-MÊME la carte sous la tête de lecture — les trous sont des silences, les
// pages bouclent avec la position (déjà modulo _songBars dans _playheadCb). Le clip lié
// reste l'EXPORT de la progression vers Live ; quand ce clip JOUE, son passthrough est
// la seule voix (_linkPlaying) et le séquenceur se tait — jamais deux émissions du même
// accord. Une tête qui bouge transport arrêté (scrub) ne joue rien.
// Émission par _emitNotes : strum, humanize et la plage de vélocité s'appliquent comme
// au jeu, base 100 comme l'écriture de clip (_progToNotes). La carte est identifiée par
// RÉFÉRENCE, pas par index : une édition pendant la lecture (coupe, multi-move) déplace
// les index sous le curseur.
var _transportOn = false, _seqCard = null, _seqHeld = null;
function _seqStop() {
	if (_seqHeld && _seqHeld.length) {
		_cancelEmit();                   // strum/humanize encore en vol
		_emitVel(0);
		for (var i = 0; i < _seqHeld.length && i < 6; i++) outlet(i + 1, _seqHeld[i]);
	}
	_seqHeld = null; _seqCard = null;
}
function _seqTick(pos) {
	if (!_transportOn || _linkPlaying) return;
	var i, card = null;
	for (i = 0; i < progression.length; i++) {
		var st = _entryStart(i), b = _entryBars(progression[i]);
		if (pos >= st - 1e-9 && pos < st + b - 1e-9) { card = progression[i]; break; }
	}
	if (card === _seqCard) return;
	_seqStop();
	_seqCard = card;
	if (!card || !card.notes || !card.notes.length) return;
	var sv = currentVelocity;
	currentVelocity = 100;               // la base du clip : même son écrit, même son joué
	_emitNotes(card.notes);
	currentVelocity = sv;
	_seqHeld = card.notes.slice();
}
function transportwatch() {
	try {
		if (_transportObs) { try { _transportObs.property = ""; } catch (e) {} }
		_transportObs = new LiveAPI(_transportCb, "live_set");
		_transportObs.property = "is_playing";
		_playheadReadBarLen();
		if (_playheadObs) { try { _playheadObs.property = ""; } catch (e) {} }
		_playheadObs = new LiveAPI(_playheadCb, "live_set");
		_playheadObs.property = "current_song_time";
	} catch (e) { post("transportwatch: " + e + "\n"); }
}

function handleprogress(state) {
	if (String(state) === 'done') {
		_dlUrl = null; _dlPlatform = null; _dlAmxdPath = null; _dlShaUrl = null; _dlAttempts = 0;
		outlet(7, 'updatedone');
		post('tuple: update installed — reload the device to apply\n');
	} else if (String(state) === 'error') {
		_dlUrl = null; _dlPlatform = null; _dlAmxdPath = null; _dlShaUrl = null; _dlAttempts = 0;
		outlet(7, 'updateerror');
		post('tuple: update download failed\n');
	}
}

// =====================================================
// CONFIG
// =====================================================

// Règle (2026-07-15) : tout changement de config qui affecte la réalisation d'un accord
// (root/scale/octave/voicing/VL/extended) libère d'abord toute note tenue — sinon une note
// jouée sous l'ancienne config reste sonner alors que son "identité" a changé sous elle.
// EXT et Voice Leading le faisaient déjà ; étendu ici à key/scale/octave/voicing pour la
// même raison (cf. audit bug-hunter du 2026-07-15).
function key(k) {
	k = String(k);
	if (NOTE_TO_PC[k] !== undefined) {
		_releaseHeld();
		root = NOTE_TO_PC[k];
		_tensPrune();          // tuple-dev#68 : une carte ne porte jamais une tension hors gamme
		_progRekeyDefer();     // les cartes suivent la tonalité (session 73), coalescé
		pushUIState();
	}
}

// Relaie uniquement l'état de config (octave, voicing, vl, vlmode) SANS rebuild de grille.
// À appeler quand seuls ces paramètres changent — la grille ne dépend pas d'eux.
function pushConfigState() {
	outlet(7, "octave", currentOctave);
	var vi = VOICING_NAMES.indexOf(currentVoicing);
	if (vi >= 0) outlet(7, "voicing", vi);
	// Retour vers le live.menu "Voice Spacing", en miroir de "voicing" ci-dessus
	// (route -> prepend set -> live.menu ; `set` écrit SANS faire sortir l'objet,
	// donc pas de boucle de retour).
	//
	// Un style hors des cinq — un legacy encore joué, ou le style d'une carte —
	// remet la SENTINELLE. Ce n'est pas un pis-aller : le paramètre "Voicing"
	// déprécié porte, lui, le style exact (ligne ci-dessus). Un set sauvegardé
	// dans cet état se recharge donc en migrant depuis la bonne valeur, au lieu
	// d'afficher un des cinq qui ne correspondrait à rien de ce qui joue.
	outlet(7, "spacing", _spacingIdxFor(currentVoicing));
	outlet(7, "voicingkey", currentVoicing);   // la clé du picker EST le style concret depuis le retrait du choix automatique — le message reste pour ne pas changer le protocole UI
	outlet(7, "vl", voiceLeadingEnabled ? 1 : 0);
	outlet(7, "vlmode", vlMode);
	outlet(7, "strumms",    _strumMs);
	outlet(7, "strumramp",  strumRamp);
	outlet(7, "strumcurve", strumCurve);
	outlet(7, "humanize",   humanizeAmt);
	outlet(7, "velmin",     velMin);
	outlet(7, "velmax",     velMax);   // publie sans `_cc` : un rechargement ne doit pas bouger l'instrument (#38)
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
	outlet(7, "avoidnotes", avoidNotesOn ? 1 : 0);   // tuple-dev#68 : même raison — le bouton AVOID NOTES doit refléter le moteur
	outlet(7, "theme", currentTheme);                // le moteur tranche le thème : une page qui recharge adopte le sien, les deux jweb ne peuvent plus diverger
	outlet(7, "loopbars", PROG_BARS_TOTAL);           // la boucle (2026-09-11) : la règle de l'UI doit la connaître après un rechargement
	outlet(7, "pages", progPages); outlet(7, "page", progPage);   // les pages (tuple-dev#74)

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

		// SYNC peut arriver de manière asynchrone (observateur auto-sync) pendant qu'une note
		// est tenue — même règle que key()/rootidx() : libérer avant de changer root/scale.
		_releaseHeld();
		if (rn >= 0 && rn <= 11) root = rn;
		if (LIVE_SCALE_MAP[sn] !== undefined) setscale(SCALE_NAMES_ARR[LIVE_SCALE_MAP[sn]]);
		else _progRekeyDefer();   // gamme Live inconnue : seule la tonique a bougé, les cartes suivent quand même (session 73)

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
// Garde-fou : onloadend (chargement jweb réel) ET le Task global (survie à un reload autowatch
// du JS seul) planifient TOUS DEUX _initAutoSync — sur un cold load les deux tirent, créant 2 paires
// de LiveAPI observers (double synclive() par changement Live + fuite de la 1re paire). Réinitialisé
// à chaque (re)chargement du script (portée globale), donc reste correct après un autowatch reload.
var _autoSyncInited = false;
// Références retenues (au lieu de laisser `t` sortir de portée) : Max peut annuler une Task one-shot
// dont la référence JS a été collectée avant qu'elle ne se déclenche — gotcha connu de l'engine JS de
// Max, cf. gridInitTask/_autoSyncInitTask déjà retenues en global plus bas. Simple tableau, pas de
// nettoyage : le volume d'appels (sync, smart-broadcast différé) est trop faible pour justifier plus.
var _deferredTasks = [];
function _taskDefer(fn) {
	if (typeof Task !== 'undefined') { var t = new Task(fn, this); _deferredTasks.push(t); t.schedule(1); }
	else { fn(); }
}
function setautosync(v) {
	_autoSync = parseInt(v) !== 0;
	post('tuple: auto-sync ' + (_autoSync ? 'ON' : 'OFF') + '\n');
	if (_autoSync) _taskDefer(synclive);   // immediate sync on enable
}
function _initAutoSync() {
	if (typeof LiveAPI === 'undefined') return;
	if (_autoSyncInited) return;   // déjà armé par l'autre planificateur (onloadend / Task global)
	try {
		_liveSyncApiRoot  = new LiveAPI(function(){ if (_autoSync) _taskDefer(synclive); }, 'live_set');
		_liveSyncApiRoot.property  = 'root_note';
		_liveSyncApiScale = new LiveAPI(function(){ if (_autoSync) _taskDefer(synclive); }, 'live_set');
		_liveSyncApiScale.property = 'scale_name';
		_autoSyncInited = true;
		post('tuple: auto-sync observers ready\n');
	} catch(e) { post('tuple: auto-sync init error: ' + e + '\n'); }
}

// Reçoit un index int (0-11) depuis live.menu
// VALIDATION : root DOIT rester dans 0..11. Un index hors plage (ou NaN) se propage
// jusqu'à buildNotes, où `root + scale[...]` sort de 0..127 : toutes les notes sont
// filtrées, le voicing part vide, et le sélecteur VL ne trouve plus aucun candidat au
// coût fini. Le moteur se retrouve alors coincé — accord après accord — au lieu de
// simplement ignorer une entrée absurde. On filtre à la SOURCE.
function rootidx(v) {
	var i = parseInt(v);
	if (isNaN(i) || i < 0 || i > 11) { post("rootidx: index hors plage 0..11 ignoré (" + v + ")\n"); return; }
	_releaseHeld();
	root = i;
	_vl2_reset();
	_progRekeyDefer();     // idem key() : la progression suit la tonique (session 73), coalescé
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
		_releaseHeld();
		scale = SCALES[s];
		scaleName = s;
		// ⚠️ La page du cycleur Borrowed est revalidée ICI, pas paresseusement. Les pages 2 et 3
		// n'existent qu'en majeur et en mineur : rester sur une page devenue vide viderait la
		// colonne en silence, et rien ne le dirait. La retombée est explicite et immédiate —
		// et ANNONCÉE : sans ré-émission, l'UI et le paramètre Live restaient sur l'ancienne
		// page pendant que le moteur servait la page 1 (audit 2026-08-18). Mêmes deux messages
		// que borpage(), même raison ([sel] d'un côté, libellé UI de l'autre).
		if (borPage > 0) {
			var _bt = borPageTable(borPage);
			if (!_bt || !_bt.length) {
				borPage = 0;
				outlet(7, "borpage", 0);
				outlet(7, "borpages", BOR_PAGES[0], borPagesDispo().length);
			}
		}
		_vl2_reset();
		_tensPrune();          // tuple-dev#68 : idem key()
		_progRekeyDefer();     // idem key() : la progression suit la gamme (session 73), coalescé
	}
}

// Les douze raccourcis de gamme (major(), dorian(), lydiandom()...) sont partis le
// 2026-09-15 : aucun n etait dans LIST_DISPATCH, aucun dans le .amxd, aucun envoye par
// l UI, aucun appele. La gamme se regle par scaleidx (patch) ou setscale (interne).

// L'UI n'expose que -2..+2 (tuple_ui.html, renderOct) — on borne ici aussi : une octave
// hors plage pousse tout l'accord hors 0..127, buildNotes renvoie un tableau vide et le
// moteur se bloque (même chaîne que rootidx). Borner plutôt qu'ignorer : un clic molette
// en butée doit rester en butée, pas être rejeté.
var OCTAVE_MIN = -2, OCTAVE_MAX = 2;
function octave(v) {
	var i = parseInt(v);
	if (isNaN(i)) { post("octave: valeur non numérique ignorée (" + v + ")\n"); return; }
	if (i < OCTAVE_MIN) i = OCTAVE_MIN;
	if (i > OCTAVE_MAX) i = OCTAVE_MAX;
	_releaseHeld();
	currentOctave = i;
	_vl2_reset();        // le registre change : on repart à zéro (sinon la mémoire VL de
	                     // l'ancienne octave biaise le 1er accord du nouveau registre)
	pushConfigState();   // pas de rebuild grille : l'octave n'affecte pas les cellules
}

function voicing(v) {
	// Garde du même métal que voicingkey : un nom inconnu retomberait EN SILENCE sur
	// classic dans _vl2_realize. Aucun émetteur vivant n'envoie `voicing` aujourd'hui
	// (patch → voicingidx, UI → voicingkey) — trou latent fermé à l'audit du 2026-08-18.
	if (!_isVoicingName(String(v))) { post("voicing: nom inconnu '" + v + "'\n"); return; }
	// Délégué à voicingkey : même sémantique (un nom concret choisi explicitement), donc
	// mêmes effets — _releaseHeld, _spacingWins, _vl2_reset, pushConfigState. Jusqu'à
	// l'audit du 2026-08-20 cette entrée changeait currentVoicing SANS reset VL ni mise à
	// jour du menu Voice Spacing : la mémoire de mouvement de l'ancien style biaisait le
	// premier accord du nouveau.
	voicingkey(String(v));
}

// Reçoit un index int depuis live.menu / l'UI jweb.
// ⚠️ COUPLÉ PAR INDEX : le message `voicingidx` transporte une POSITION, pas un nom.
// Les sets Live sauvegardés et les pistes d'automation stockent cet entier. Insérer un
// nom AILLEURS QU'À LA FIN décale tous les suivants -> chaque set rejoue un autre style,
// en silence. On AJOUTE TOUJOURS À LA FIN ; l'ordre d'AFFICHAGE est un tableau distinct
// côté UI (VOIC_FAM/FAM_IDX dans tuple_ui.html), qui existe précisément pour ça.
// "root" (2026-08-05, chantier 1) = position neutre, ajoutée en 29e position.
var VOICING_NAMES = ["classic","piano","open","spread","house","prog","rootlessa","rootlessb","rootless","drop2","drop3","jazz","nuhouse","trance","funk","quartal","upper","organ","frenchtouch","broken","deeptech","detroit","soul","jamiroquai","rave","sus","wide","power","root"];
// Index venant du paramètre Live "Voicing" (live.menu du .amxd). Son énumération porte
// EXACTEMENT les VOICING_NAMES concrets, dans le même ordre — plus rien d'autre depuis le
// retrait du choix automatique (2026-08-11). Elle lit par POSITION : un ajout ailleurs
// qu'en fin remapperait silencieusement chaque set sauvegardé.
//
// Les 7 entrées virtuelles retirées ("Auto" + une par catégorie curée) n'ont JAMAIS été
// chargées par Max — le .amxd n'a pas été ouvert depuis leur ajout du 2026-08-05 — donc
// aucun set au monde ne stocke les index 29..35 et le retrait ne casse aucune sauvegarde.
// Contrat vérifié par .claude/skills/run-tuple/amxd_contract.mjs ; procédure d'édition
// du patch : docs/runbooks/amxd-parametre-voicing.md.
function voicingidx(v) {
	var i = parseInt(v);
	if (isNaN(i) || i < 0) { post("voicingidx: index invalide (" + v + ")\n"); return; }
	if (i >= VOICING_NAMES.length) { post("voicingidx: index hors enumeration (" + i + ")\n"); return; }
	_legacyVoicingIdx = i;                       // mémorisé pour la migration, quel que soit l'ordre d'arrivée
	_legacyVoicingSeen = true;
	if (_spacingPending) { _spacingMigrate(); return; }
	// Un choix de palette tient la barre : le paramètre déprécié est inerte. C'est ce
	// qui rend le chargement d'un set INDÉPENDANT de l'ordre d'émission de Live.
	if (_spacingWins) return;
	// Le legacy APPLIQUE, il ne touche pas à la barre : `classic` tombe dans la palette et
	// c'est la valeur initiale du paramètre déprécié, donc passer par voicingkey levait
	// _spacingWins pour rien — la décision vient du legacy, elle ne doit pas verrouiller le
	// legacy lui-même. L'inertie quand un choix de palette tient la barre est déjà assurée
	// par le return ci-dessus, et une migration en attente a été traitée plus haut. La
	// baisse de drapeau qui suivait cet appel est donc devenue MORTE et a été retirée le
	// 2026-08-20 : on n'atteint cette ligne que si _spacingWins vaut déjà false.
	// Les 24 styles retires n'ont plus d'implementation (palette reduite a cinq, 2026-09-14) :
	// le dial deprecie passe donc par la MEME table de report que le chargement d'un set,
	// `VOICING_MIGRATION`, au lieu d'appliquer un nom que `_vl2_T` ne connait plus. L'enumeration
	// Live garde ses 29 entrees — la retrecir ecreterait les index des sets sauvegardes.
	var mi = VOICING_MIGRATION[i];
	_applyVoicingStyle(SPACING_NAMES[mi === undefined ? 0 : mi]);
}

// =====================================================
// AXE VOICE SPACING — la palette d'espacement à cinq, et la migration des sets
// sauvegardés avant elle.
// =====================================================
// POURQUOI DEUX PARAMÈTRES LIVE PLUTÔT QU'UN RÉTRÉCI. Mesuré le 2026-08-13 sur
// Live 12.2.1 : Live borne un paramètre enum sur la LONGUEUR de son énumération,
// et un set qui stocke l'index 24 revient à 4 dès que la liste tombe à 5 entrées.
// L'écrêtage a lieu AVANT que le moteur voie quoi que ce soit — une table de
// migration lue dans voicingidx() ne recevrait donc jamais un index utile.
// D'où la dépréciation, qui est aussi la norme du monde plugin (VST3, AU, CLAP :
// l'identifiant d'un paramètre est immuable, on ajoute, on ne retire pas) :
//   • "Voicing" reste INCHANGÉ, 29 entrées — et VISIBLE en automation : le .amxd ne pose
//     aucun parameter_visibility (défaut = Automated and Stored), la mesure LOM plus bas
//     (automation_state) le confirme. Cette ligne a affirmé "Stored Only" jusqu'à l'audit
//     du 2026-08-20 — c'était le plan initial, pas l'état livré ;
//   • "Voice Spacing" est un paramètre NEUF, ajouté en fin, avec la palette à cinq.
//
// ⚠️ "Voicing" doit garder son nom À VIE. Mesuré le même jour : Live apparie les
// paramètres PAR NOM. Renommer orpheline la valeur stockée de tous les sets — un
// paramètre renommé est revenu sur son `parameter_initial`, la valeur sauvegardée
// jetée sans un mot. C'est aussi pourquoi le neuf ne peut pas s'appeler "Voicing".
var SPACING_NAMES = ["classic", "open", "drop2", "drop3", "piano", "root"];   // `root` = mode neutre, ajoute EN FIN le 2026-09-14 (un ajout en tete remapperait tous les sets)

// Report ancien `voicingidx` → index dans SPACING_NAMES. Calculé PAR LA MESURE, pas
// au jugé : device/tests/mesure-migration-palette.mjs cherche, pour chacun des 24
// styles retirés, lequel des cinq retenus produit les notes les plus proches sur les
// 91 cellules. Longueur 29 = VOICING_NAMES.length, vérifié par _selfCheck.
//
// ⚠️ Deux reports que la mesure à froid déclarait « alias exacts » n'en sont PAS :
// `root` (index 28) et `frenchtouch` (18) rendent la même forme que `classic` VL
// éteint, mais n'offrent qu'UN candidat au voice leading là où `classic` en offre
// 14 — 86 cellules sur 91 divergent dès que le VL est allumé.
// Voir device/tests/mesure-alias-sous-vl.mjs. Le report reste le meilleur possible ;
// il n'est simplement pas inaudible, et ne doit pas être annoncé comme tel.
// ⚠️ REMESUREE A SIX CIBLES le 2026-09-15, et la table a bouge sur 14 des 29 entrees. La mesure
// precedente comparait les deux cotes sur la MEME revision du moteur — elle repondait donc a
// « quel style ressemblait le plus a quoi, a l'epoque », pas a « vers quoi reporter ». Le script
// charge maintenant l'AVANT (la revision a 29 implementations) et l'APRES (l'arbre de travail)
// dans le meme processus, via `loadDevice(file, {dir})`.
//
// ⚠️ UN SURVIVANT SE MIGRE TOUJOURS SUR LUI-MEME, et la mesure seule dirait le contraire pour
// `classic`. Depuis le resserrement du 2026-09-14, l'ancien `classic` est reproduit NOTE POUR NOTE
// par le nouveau `root` (distance 0.00) pendant que le nouveau `classic` en diverge sur 35 cases
// (0.97). Suivre la mesure enverrait l'index 0 sur 5 — et l'index 0 n'est pas qu'un vieux set :
// c'est le `parameter_initial` du dial deprecie, donc ce qu'un device NEUF emet au chargement.
// Un device sorti de la boite ouvrirait sur `Default` au lieu de `Closed`. La regle prime donc sur
// la mesure ici, et device/tests/spacing-migration.test.mjs l'epingle.
// Les 23 autres cibles sont celles de la mesure a six.
var VOICING_MIGRATION = [0, 4, 1, 1, 2, 5, 5, 5, 5, 2, 3, 0, 1, 5, 1, 5, 5, 1, 5, 2, 2, 5, 5, 5, 1, 5, 1, 1, 5];

// L'index 0 du paramètre Live "Voice Spacing" est une SENTINELLE, jamais un style :
// il vaut « ce set est antérieur à la migration ». Mesuré le 2026-08-13 — un
// paramètre absent du set chargé reçoit son `parameter_initial`, donc un vieux set
// arrive forcément dessus, et un set récent n'y arrive jamais (il stocke ≥ 1).
// La distinction est donc structurelle, pas heuristique.
var SPACING_SENTINEL = 0;
var _legacyVoicingIdx = 0;      // dernier index reçu du paramètre "Voicing" déprécié
var _legacyVoicingSeen = false; // ⚠️ distinct de `_legacyVoicingIdx === 0` : « reçu 0 » et
                                // « rien reçu » sont deux états différents, et les confondre
                                // faisait migrer tout vieux set sur `classic` quand la
                                // sentinelle arrivait la première (prouvé par le test).
var _spacingPending = false;    // la sentinelle est arrivée, la migration attend son index legacy

// L'ARBITRE ENTRE LES DEUX PARAMÈTRES LIVE. Vrai dès qu'un choix DÉLIBÉRÉ dans la
// palette tient la barre — le menu "Voice Spacing" ou le picker du device. Le
// paramètre "Voicing" déprécié est alors inerte.
//
// ⚠️ Pourquoi un arbitre est nécessaire, et pourquoi il ne l'était pas « en théorie ».
// Les deux paramètres écrivent le MÊME état (`currentVoicing`), donc sans arbitre le
// dernier arrivé gagne — et au chargement d'un set, qui arrive en dernier appartient à
// Live. Mesuré le 2026-08-17 : `spacingidx(2)` puis `voicingidx(0)` rendait `classic`
// là où l'ordre inverse rendait `open`. Le set rouvrait sur un autre style que celui
// sauvegardé, en silence, une fois sur deux.
// Ça a longtemps passé pour le prix assumé de la dépréciation, sur la foi d'une phrase
// fausse : « Voicing quitte la liste d'automation ». Lu par le LOM sur Live 12.2.1,
// device de `main` chargé — `is_enabled = true`, `automation_state = 0`, c'est-à-dire
// « Automated and Stored ». Il est automatisable et MIDI-mappable. Le rendre invisible
// le retirerait AUSSI de la sauvegarde, donc de la migration : impossible.
//
// Sur la SENTINELLE, le legacy reprend la main — c'est mot pour mot ce que le libellé
// « (from Voicing) » promet à l'utilisateur.
var _spacingWins = false;

// Applique le report. Séparé de spacingidx() parce que l'ORDRE D'ARRIVÉE des deux
// paramètres au chargement d'un set n'est pas garanti : la sentinelle peut précéder
// ou suivre l'index legacy. Le premier des deux ARME, le second DÉCLENCHE.
function _spacingMigrate() {
	var m = VOICING_MIGRATION[_legacyVoicingIdx];
	if (m === undefined) m = 0;
	// Poste SEULEMENT quand la migration change quelque chose : un device NEUF rejoue les
	// deux parameter_initial (Voicing=0 + sentinelle) et passait ici en annonçant « set
	// anterieur a la migration » — diagnostic faux dans la console que la checklist release
	// lit (audit 2026-08-20). classic -> classic n'apprend rien à personne.
	if (VOICING_NAMES[_legacyVoicingIdx] !== SPACING_NAMES[m])
		post("spacing: set anterieur a la migration — voicingidx " + _legacyVoicingIdx +
			" (" + VOICING_NAMES[_legacyVoicingIdx] + ") -> " + SPACING_NAMES[m] + "\n");
	_applyVoicingStyle(SPACING_NAMES[m]);
	// La migration CONSOMME l'armement. Sans cette baisse, tout `voicingidx` suivant —
	// l'utilisateur bouge le dial « Voicing » en séance — repasserait par la migration au
	// lieu de jouer son style, et VOICING_MIGRATION[i] diffère de VOICING_NAMES[i] sur la
	// plupart des index. Ligne retirée le 2026-08-20 au matin, quand voicingkey la couvrait
	// pour les quatre chemins ; redevenue PORTEUSE le soir même, quand l'extraction de
	// _applyVoicingStyle a sorti la migration de voicingkey.
	_spacingPending = false;
	// Migrer n'est pas choisir. L'utilisateur d'un vieux set n'a jamais ouvert le picker :
	// son seul contrôle connu reste le dial « Voicing », et le rendre inerte au
	// rechargement casserait sa séance. La barre lui revient donc.
	// ⚠️ Depuis l'extraction (2026-08-20), cette ligne dit une INTENTION, plus un
	// contre-ordre : elle ne rattrape plus un drapeau que voicingkey venait de lever, elle
	// REND la barre au legacy quand un choix de palette antérieur la tenait encore.
	_spacingWins = false;
}

// Index à AFFICHER dans le live.menu "Voice Spacing" pour un style donné.
// Décalage de 1 : l'index 0 de l'énumération Live est la sentinelle, donc le style
// `SPACING_NAMES[n]` s'affiche à l'index n + 1. Un style hors des cinq rend la
// sentinelle — voir pushConfigState pour pourquoi ce n'est pas une perte.
function _spacingIdxFor(style) {
	var i = SPACING_NAMES.indexOf(style);   // ES5, et la ligne voisine de pushConfigState fait pareil sur VOICING_NAMES
	return (i >= 0) ? (i + 1) : SPACING_SENTINEL;
}

// Reçoit un index int depuis le live.menu "Voice Spacing".
// 0 = sentinelle ; 1..5 = les cinq styles, donc SPACING_NAMES[i - 1].
function spacingidx(v) {
	var i = parseInt(v);
	if (isNaN(i) || i < 0) { post("spacingidx: index invalide (" + v + ")\n"); return; }
	// Sentinelle : migrer TOUT DE SUITE si l'index legacy est déjà là, sinon ARMER et
	// laisser voicingidx() déclencher. Migrer d'office ici ferait le report sur la
	// valeur d'initialisation (0 = classic) chaque fois que la sentinelle arrive en
	// premier — c'est-à-dire au petit bonheur de l'ordre d'émission de Live.
	if (i === SPACING_SENTINEL) {
		_spacingPending = true;
		if (_legacyVoicingSeen) _spacingMigrate();
		return;
	}
	if (i > SPACING_NAMES.length) { post("spacingidx: index hors enumeration (" + i + ")\n"); return; }
	voicingkey(SPACING_NAMES[i - 1]);
}

// Applique un style : l'EFFET, sans opinion sur l'arbitrage Voicing/Voice Spacing.
// Les drapeaux (_spacingWins, _spacingPending) appartiennent aux ENTRÉES : voicingkey
// (geste délibéré) les pose, voicingidx et _spacingMigrate (legacy, migration) expriment
// les leurs — plus personne ne défait la décision d'un autre (extraction 2026-08-20,
// audit /simplify : le sink décidait pour 4 chemins et 2 devaient défaire juste après).
function _applyVoicingStyle(key) {
	_releaseHeld();
	currentVoicing = key;
	_vl2_reset();
	pushConfigState();
}

// Style du contrôle GLOBAL de voicing. Vaut un VOICING_NAME, et rien d'autre.
// Deux effets, et deux seulement :
//  1. la GRILLE joue ce style — il ne bouge pas d'un accord à l'autre pendant qu'on joue.
//     design.md §2.2 promet « face performance intacte » ; un style qui change sous les
//     doigts est l'inverse d'un instrument.
//  2. il sème les cartes capturées (_progEntry), qui naissent donc sur un style concret.
// Distinct de voicing() (message `voicing`, qui prend un nom brut — même _releaseHeld) :
// ce point d'entrée-ci est celui du picker, il relâche et réinitialise l'état VL.
function voicingkey(k) {
	var key = String(k === undefined || k === null ? "" : k);
	if (!_isVoicingName(key)) {
		post("voicingkey: cle inconnue '" + key + "'\n");   // refus BRUYANT : silencieux = indébogable dans Max
		return;
	}
	_applyVoicingStyle(key);
	// Ce point d'entrée EST le picker du device (message `voicingkey` depuis jweb) : y
	// arriver, c'est un choix délibéré, donc la barre passe à la palette. Depuis
	// l'extraction de _applyVoicingStyle (2026-08-20), SEULS les chemins délibérés passent
	// ici — le picker, voicing() (nom brut) et la branche concrète de spacingidx(). Les
	// deux chemins non délibérés, voicingidx() (legacy) et _spacingMigrate() (migration),
	// appliquent par _applyVoicingStyle et posent leurs propres drapeaux : plus aucun
	// appelant n'a à défaire ce qu'on écrit ci-dessous.
	//
	// ORDRE LIBRE, vérifié le 2026-08-20 : _applyVoicingStyle finit par pushConfigState,
	// qui émet le menu Voice Spacing depuis _spacingIdxFor(currentVoicing) et ne lit
	// AUCUN des deux drapeaux. Les poser après l'application n'antidate donc rien.
	_spacingWins = (_spacingIdxFor(key) !== SPACING_SENTINEL);
	// Un choix délibéré DÉSARME aussi une migration en attente : sinon, sentinelle arrivée
	// sans legacy (recompile autowatch en séance), un voicingidx tardif rejouerait la
	// migration PAR-DESSUS ce choix — mesuré à l'audit du 2026-08-20 (picker open, puis
	// voicingidx 20 → drop3 écrasait open).
	_spacingPending = false;
}

function voiceleading(v) {
	// Accepte "on"/"off" (toggle jsui) ET 1/0 (toggle jweb)
	var s = String(v).toLowerCase();
	_releaseHeld();   // libère toute note tenue → le toggle ne peut pas laisser de note coincée (no-op si rien ne sonne)
	voiceLeadingEnabled = (s === "on" || s === "1" || s === "true");
	_vl2_reset();
	pushConfigState();   // pas de rebuild grille
}


// Reçoit "vlmode anchored" ou "vlmode flow" (v1 disait "relative" — mapping v1→v2 plus bas)
function vlmode(m) {
	_releaseHeld();   // idem : pas de note orpheline au changement de mode
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
// ══ Cycleur de la colonne Borrowed (carte tuple-dev#23) ═══════════════════════════════════
// Page 1 = la table de la gamme, INCHANGÉE dans les onze gammes. Le cycleur est ADDITIF : rien ne
// disparaît d'un set existant. Les pages 2 et 3 n'existent qu'en majeur et en mineur — aucune
// source ne définit ces catégories dans un mode, et la seule qui aborde la question dit de ne pas
// le faire (une dominante secondaire employée pour établir un centre modal ramène l'attention sur
// la tonalité). Extrapoler serait une invention présentée comme de la théorie.
//
// ⚠️ Le `type` se résout dans COLOR_IV (5 entrées : min · dim7 · maj7 · dom7 · maj), PAS dans
// GRID_TYPES, et `COLOR_IV[type] || COLOR_IV.maj` replie en SILENCE. `triad` y tomberait.
var BOR_PAGES = ["Borrowed", "Tritone", "Mediants"];   // ⚠️ UN MOT chacun : mesuré au prototype,
// « Chromatic mediants » passe sur deux lignes dans un en-tête de 38 px et casse l'alignement de
// la rangée. Les sept en-têtes de degré tiennent en « chiffre + un mot ».
var borPage = 0;

// Subs tritoniques : les quatre COMMUNS (Berklee), tous dom7 — la quinte diminuée entre tierce et
// septième EST le mécanisme, donc une triade majeure sur ♭2 n'en est pas un (c'est le napolitain).
var SUBS_MAJOR = [
	{ roman:"subV7",    semis:1, type:"dom7", suf:"7" },
	{ roman:"subV7/II", semis:3, type:"dom7", suf:"7" },
	{ roman:"subV7/IV", semis:6, type:"dom7", suf:"7" },
	{ roman:"subV7/V",  semis:8, type:"dom7", suf:"7" }
];
// ⚠️ En mineur, semis 3 est RETIRÉ : mesuré, `bIII7` est exactement `V/VI` de BORROWED_MINOR
// (même semis, même type). Le servir ici donnerait le même accord sous deux noms dans la colonne.
var SUBS_MINOR = [
	{ roman:"subV7",    semis:1, type:"dom7", suf:"7" },
	{ roman:"subV7/IV", semis:6, type:"dom7", suf:"7" },
	{ roman:"subV7/V",  semis:8, type:"dom7", suf:"7" }
];
// Médiantes chromatiques : quatre triades de MÊME QUALITÉ que la triade de tonique, à un ton
// commun. ⚠️ En majeur, ♭III (+3 maj) et ♭VI (+8 maj) sont DÉJÀ dans BORROWED_MAJOR à l'identique
// — il n'en reste que deux. La page maigre est voulue ; la littérature dit elle-même que ♭VI est
// aussi un emprunt au mineur parallèle.
var MED_MAJOR = [
	{ roman:"III", semis:4, type:"maj", suf:"" },
	{ roman:"VI",  semis:9, type:"maj", suf:"" }
];
var MED_MINOR = [
	{ roman:"iii",  semis:3, type:"min", suf:"m" },
	{ roman:"#iii", semis:4, type:"min", suf:"m" },
	{ roman:"vi",   semis:8, type:"min", suf:"m" },
	{ roman:"#vi",  semis:9, type:"min", suf:"m" }
];

/** La table de la gamme courante, HORS cycleur. C'est la page 1, et la seule voie d'avant. */
function borrowedTableDeGamme() {
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
function borPageTable(p) {
	if (p === 0) return null;                              // page 1 : voie normale
	var maj = (scaleName === "major"), min = (scaleName === "minor");
	if (!maj && !min) return [];                           // hors majeur/mineur : page vide
	if (p === 1) return maj ? SUBS_MAJOR : SUBS_MINOR;
	return maj ? MED_MAJOR : MED_MINOR;
}
/** Les pages NON VIDES pour la gamme courante. Une page vide est sautée, pas affichée. */
function borPagesDispo() {
	var out = [0], p, t;
	for (p = 1; p < BOR_PAGES.length; p++) { t = borPageTable(p); if (t && t.length) out.push(p); }
	return out;
}
// Reçu du paramètre Live "Borrowed Page" ET de l'UI. ⚠️ Le paramètre Live est la SOURCE DE VÉRITÉ :
// il rejoue sa valeur au chargement du set, donc tout état que lui ne sait pas exprimer serait
// écrasé en silence. C'est pourquoi la page est un paramètre et non une variable interne.
function borpage(v) {
	var p = parseInt(v), d = borPagesDispo();
	if (!(p >= 0) || d.indexOf(p) < 0) p = 0;              // page invalide pour cette gamme -> page 1
	// Release SEULEMENT si la page change (la colonne bouge sous les doigts — même règle
	// qu'extended()). Mais émettre TOUJOURS : le paramètre Live rejoue borpage au chargement
	// du set, et une UI fraîche compte sur cet écho pour son en-tête.
	if (p !== borPage) _releaseHeld();
	borPage = p;
	// ⚠️ DEUX messages, et ce n'est pas de la redondance. `borpage` porte UN SEUL entier parce
	// qu'il alimente aussi le retour vers le paramètre Live, via un [sel 0 1 2] — exactement comme
	// `cliptarget`, qui émet un symbole nu pour la même raison. Un `sel` ne matche pas une liste :
	// y joindre le libellé et le compte casserait le retour en silence, et le paramètre relu au
	// chargement du set écraserait alors le choix (le piège rencontré sur `Clip Target`).
	outlet(7, "borpage", borPage);
	outlet(7, "borpages", BOR_PAGES[borPage], d.length);   // libellé + nombre de pages : UI seule
	broadcastSurface();                                     // grille + heat-map : l'index de smartbor
	                                                        // indexe la page VISIBLE (tuple-dev#26)
}
function borpagecycle() {
	var d = borPagesDispo(), i = d.indexOf(borPage);
	borpage(d[(i + 1) % d.length]);
}

function borrowedFor() {
	// ⚠️ Une page devenue invalide (changement de gamme) RETOMBE sur la page 1 plutôt que de rendre
	// une table vide : sans ça, la colonne se viderait en silence et rien ne le dirait.
	if (borPage > 0) { var t = borPageTable(borPage); if (t && t.length) return t; borPage = 0; }
	return borrowedTableDeGamme();
}

// Validité d'une ligne de type à un degré (n'importe quelle qualité)
// Les pitch classes REELLEMENT dans la gamme courante. Pour une pentatonique, seuls les degrés
// du masque comptent — c'est la définition d'une gamme à cinq notes. Pour les autres, les sept.
function scalePcSet() {
	var mask = SCALE_VALID_DEGREES[scaleName], out = {}, d;
	for (d = 0; d < 7; d++) if (!mask || mask[d]) out[((root + scale[d]) % 12 + 12) % 12] = 1;
	return out;
}

// Toutes les notes de l'accord d'une case tiennent-elles dans la gamme ? Ne concerne QUE les
// gammes à masque : ailleurs l'accord est diatonique par construction, et la question coûterait
// un buildSpec par case pour toujours répondre oui. La colonne BORROWED n'y passe pas — un
// emprunt est chromatique par définition, c'est son métier.
function _scaleAllowsSpec(d, fn) {
	if (!SCALE_VALID_DEGREES[scaleName]) return true;
	var spec = _vl2_buildSpec(fn, d);
	if (!spec) return true;
	var ok = scalePcSet(), i;
	for (i = 0; i < spec.pcs.length; i++) if (!ok[((spec.pcs[i].pc % 12) + 12) % 12]) return false;
	return true;
}

function _gridTypeValidIntervals(d, fn, iv) {
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

// Une case est valide si son TYPE l'est au degré (intervalles) ET si son accord tient dans la
// gamme. Les deux questions sont distinctes : la seconde ne mord que sur les pentatoniques.
function gridTypeValid(d, fn, iv) {
	return _gridTypeValidIntervals(d, fn, iv) && _scaleAllowsSpec(d, fn);
}


// Quelles tensions l'accord d'une case PORTE une fois enrichi ? Lu sur le spec réellement
// enrichi — c'est la seule façon pour le label de ne jamais annoncer une note absente.
function _extRoles(d, fn) {
	var spec = _vl2_buildSpec(fn, d);
	if (!spec) return null;
	spec = _vl2_enrichSpec(spec);
	var r = { ninth:false, eleventh:false, thirteenth:false, sixth:false }, i;
	for (i = 0; i < spec.pcs.length; i++) if (r.hasOwnProperty(spec.pcs[i].role)) r[spec.pcs[i].role] = true;
	return r;
}

// Nom d'accord affiché pour une case (degré + type)
function gridLabel(d, fn, iv, ext) {
	iv = iv || getIntervals(d);
	var rn = NOTE_NAMES[(root + scale[d]) % 12];
	var x = (ext === undefined || ext === null) ? extendedOn : ext;   // x = nom étendu (CM7 -> CM13…)
	// Le nom étendu ne revendique QUE les tensions que l'accord PORTERA. Il ne les devine plus
	// (« Amadd9 » sur une ♭9, « G6/9 » sur une ♭13, « CM13 » sur un mineur-majeur) : il enrichit
	// le spec pour de vrai et lit ses rôles. Une seule source, zéro dérive possible.
	var xr  = x ? _extRoles(d, fn) : null;
	var x9  = !!xr && xr.ninth;
	var x11 = !!xr && xr.eleventh;
	var x13 = !!xr && (xr.thirteenth || xr.sixth);
	if (fn === "triad") {
		if (iv[2]===3 && iv[4]===6) return rn + "dim";   // dim / aug : accords de couleur, jamais enrichis
		if (iv[2]===4 && iv[4]===8) return rn + "aug";
		if (iv[2]===3) return rn + (x9 ? "madd9" : "m");
		return rn + (x9 && x13 ? "6/9" : (x13 ? "6" : (x9 ? "add9" : "")));
	}
	if (fn === "sus2") return rn + "sus2";
	if (fn === "sus4") return rn + "sus4";
	if (fn === "add9") return (iv[2]===3 ? rn + "madd9" : rn + (x13 ? "6/9" : "add9"));
	if (fn === "six")         return (iv[2]===3 ? rn + (x9 ? "m6/9" : "m6")   : rn + (x9 ? "6/9" : "6"));
	if (fn === "sixnine")     return (iv[2]===3 ? rn + "m6/9" : rn + "6/9");
	if (fn === "mmaj7")       return rn + (x9 ? "mMaj9" : "mMaj7");
	if (fn === "sevensus4")   return rn + (x9 ? "9sus4" : "7sus4");   // la 9 EST ajoutée ici (cf. enrichSpec)
	if (fn === "sevenflat9")  return rn + (x13 ? "13b9" : "7b9");
	if (fn === "sevensharp9") return rn + (x13 ? "13#9" : "7#9");
	if (fn === "seven") {
		// mineur-majeur AVANT maj7 : `isValid(d,"maj7")` ne regarde pas la tierce, et rendait
		// « CM13 » pour un Cm(Maj7) en mineur harmonique.
		if (iv[2]===3 && iv[4]===7 && iv[6]===11) return rn + (x9 ? "mMaj9" : "mMaj7");
		if (isValid(d,"maj7",iv))  return rn + (x9 && x13 ? "M13" : (x9 ? "M9" : "M7"));
		if (isValid(d,"min7",iv))  return rn + (x9 && x11 ? "m11"  : (x9 ? "m9" : "m7"));
		if (isValid(d,"dom7",iv))  return rn + (x9 && x13 ? "13"   : (x9 ? "9"  : "7"));
		if (isValid(d,"dim7",iv))  return rn + (x9 ? "dim9" : "dim7");
		if (isValid(d,"hdim7",iv)) return rn + (x9 && x11 ? "ø11" : (x9 ? "ø9" : "ø7"));
	}
	if (fn === "nine") {
		if (iv[2]===3 && iv[4]===7 && iv[6]===11) return rn + "mMaj9";   // mineur-majeur avant maj9 (meme piege)
		if (isValid(d,"maj9",iv)) return rn + (x13 ? "M13" : "M9");
		if (isValid(d,"min9",iv)) return rn + (x11 ? "m11" : "m9");
		if (isValid(d,"nine",iv)) return rn + (x13 ? "13"  : "9");
	}
	if (fn === "m7s5") return rn + (x9 ? "m9#5" : "m7#5");   // m7♯5 (quinte augmentée)
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
// Borne asymétrique VOULUE (tuple-dev#34 finding 2, tranché « documenter » 2026-08-24) :
//   • bas plafonné à -12 (regBase 36 = C2) : DÉLIBÉRÉ. Plus bas, les clusters serrés sonnent
//     boueux — le registre que _vl2_LOW_LIMITS existe justement pour éviter. Conséquence assumée :
//     OCT -2 rend EXACTEMENT OCT -1 (mesuré identique). La position -2 de l'enum Live reste
//     (retrait interdit : remappe les sets sauvés) ; elle est simplement un synonyme de -1.
//   • haut à +24 (regBase 72 = C5) : c'est ce +24 qui poussait les shapes ABSOLUTE hors fenêtre —
//     traité par _vl2_fitWindow (finding 1), PAS en rabotant la borne (ça retirerait un octave qui joue).
// ⚠️ LA BORNE BASSE A ÉTÉ `-12` JUSQU'AU 2026-09-16 (tuple-dev#39, sorti de #34), et elle
// rendait la position OCT −2 SANS EFFET — mais seulement pour les styles qui passent par ici.
// `_vl2_center` envoie `classic`, `root` et `piano` sur `regBase` ; les trois autres prennent
// `60 + currentOctave * 12`, jamais borné. Mesuré style par style sur 2658 cellules :
//   classic / root / piano  — −2 identique à −1      open / drop2 / drop3  — −2 vivant
// Et `classic` est le style par DÉFAUT, donc pour l'utilisateur ordinaire −2 ne faisait rien.
// Coup de la descente à −24, mesuré AVANT de la poser : **zéro** cellule muette gagnée (0 → 0).
// Le garde-boue que #34 redoutait (`_vl2_LOW_LIMITS`, « mange-t-il tout sous C2 ? ») ne mord
// pas. Le grave passe de 34 à 24 en `classic`, de 36 à 24 en `root`.
// L'asymétrie −12/+24 n'était documentée nulle part ; elle est maintenant symétrique.
function _vl2_regBase(){ return 48 + Math.max(-24, Math.min(24, currentOctave * 12)); }
function _vl2_center(vc){ var rb = _vl2_regBase(); return (vc === "classic" || vc === "root") ? (rb + root) : (vc === "piano") ? (rb + 6) : (60 + currentOctave * 12); }   // piano : centre plus bas (basse grave) -> pas de dérive FLOW vers le haut ; root : ancré sur la tonique comme classic (heat-map _sg_fluid alignée sur ce qui joue)
// SOURCE UNIQUE du centre de sélection — utilisée par _vl2_play ET _sg_fluid (sinon la heat-map VL
// et le playback divergent → sauts d'octave). cands = sortie de _vl2_realize ; cands[0] = forme canonique.
// ABSOLUTE : centre = poche d'origine du grip (moyenne de la canonique), sinon _vl2_center (classic/piano/C4).
// FIX SAUT FALLBACK : quand un voicing retombe sur classic (trap sur triade…), centrer au registre MAISON
// du voicing (pas la tonique) → la triade fallback se pose au même étage que ses grips de 7e. Miroir engine.js.
// (N.B. classic refuse de voicer trop grave via la règle low-interval → marche pour les planchers ~48, partiel pour trap.)
var _vl2_FB_HOME = { drop2:54, drop3:54 };
function _vl2_selCtr(cands){
	var realized = cands[0].voicing, fb = cands[0].fallback;
	if (fb && _vl2_FB_HOME[fb] != null) return _vl2_FB_HOME[fb] + (_vl2_regBase() - 48);
	if (_vl2_ABSOLUTE.has(realized)){ var ns = cands[0].notes, s = 0, i; for (i = 0; i < ns.length; i++) s += ns[i]; return s / ns.length; }
	return _vl2_center(realized);
}
// Référence de mouvement du voice-leading : le dernier accord JOUÉ (survit au note-off),
// sinon les notes tenues. Source UNIQUE — _sg_fluid la reçoit, _sg_rank gate dessus ;
// les deux ne peuvent plus diverger en silence. Miroir : la démo la dérive une fois
// et la passe à fluidity(spec, refNotes, …) — même forme.
function _sg_ref(){ return (typeof lastChordNotes !== "undefined" && lastChordNotes && lastChordNotes.length) ? lastChordNotes : activeNotes; }
// Fluidité de voice-leading : coût de mouvement vers le candidat dont la moyenne est la plus
// proche du centre de registre, avec le voicing + l'octave courants. C'est une APPROXIMATION
// du jeu, pas son égal : à froid, _vl2_select verrouille la forme CANONIQUE (-1000), qui peut
// différer du candidat le plus centré (mesuré sur drop2 à l'audit du 2026-08-20 — moyenne
// jouée 50,5 pour un centre à 60). Assumé : la heat-map classe des cases entre elles, le rang
// relatif reste pertinent. Plus bas = plus fluide. Pur (ne mute pas _vl2_st). Sensible au
// voicing (≠ ancien minimum sur ±2 octaves, qui rendait tous les voicings identiques).
// Miroir : site/vl2/fluidity.js (même critère, même écart assumé).
function _sg_fluid(sp, ref){
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

// ── Tirage AVANT (tranche B) ────────────────────────────────────────────────
// Quand on insère ENTRE deux accords, le candidat a deux voisins. Le tirage arrière existe depuis
// toujours ; celui-ci est son miroir, le candidat devenant la SOURCE et `nextRef` la cible.
//
// Seul `_sg_base` s'inverse réellement : `_sg_common` compte des hauteurs partagées, donc il est
// symétrique, et `_sg_quality`/`_sg_context` sont des propriétés du candidat ou de l'historique de
// JEU — les compter deux fois pondérerait la qualité du candidat au lieu de la direction.
// Arbitré `tuple-dev#29`.
function _sg_fwdDiat(cell, nextRef, isMin){
	return _sg_clamp(_sg_base(cell.degree, nextRef.deg, isMin) + _sg_common(cell.pcs, nextRef.pcs));
}
// Miroir de `_sg_borrowedScore` : un emprunt candidat tire vers l'avant à proportion de la distance
// entre ce vers quoi il RÉSOUT et la cible. Le cas « il résout exactement dessus » reprend le 0.92
// que `_sg_rank` emploie déjà quand la source est un emprunt — pas de constante inventée.
function _sg_fwdBor(bc, nextRef, isMin, degByRoot, tonicPc){
	var res = _sg_borrowedResolveDeg(bc.pcs, tonicPc, isMin, degByRoot);
	var base = (res >= 0 && res === nextRef.deg) ? 0.92 : (0.30 + 0.55 * _sg_base(res, nextRef.deg, isMin));
	return _sg_clamp(base + _sg_common(bc.pcs, nextRef.pcs));
}
// Combinaison des deux tirages. 70/30 mesuré, pas choisi : cinq combinaisons sur sept remontent la
// bonne réponse au rang 1 (le classement sature), et c'est la SURVIE des cases qui départage —
// `_sg_level` n'émet rien sous 0.40. 70/30 est la seule qui corrige le classement sans déplacer la
// densité de la heat-map (81 %/94 % contre 78 %/92 % aujourd'hui). Bench :
// `device/tests/mesure-scoring-bidirectionnel.mjs`, arbitré `tuple-dev#30`.
// L'asymétrie a sa raison : l'accord d'où l'on VIENT a été entendu, celui où l'on VA ne l'est pas.
function _sg_combine(sBack, sFwd){ return 0.7 * sBack + 0.3 * sFwd; }

// Coeur de suggestion : classe + ordonne les cases candidates APRÈS la source (= queue de _sg_hist).
// Extrait de _sg_broadcast pour être réutilisé par _suiteOptions (mode Suite du Push). skip* = l'accord
// à NE PAS re-suggérer (la source elle-même). Retourne le tableau `emit` (cases retenues, triées +
// nivelées) SANS rien émettre — ne lit que _sg_hist + l'état de gamme, jamais l'accord live.
//
// `nextRef` (optionnel, `{deg, fn, pcs}`) = l'accord SUIVANT quand on insère au milieu. Absent, la
// fonction se comporte EXACTEMENT comme avant — un côté manquant est absent, pas neutre : un « 0 »
// neutre passé à `_sg_combine` diviserait tous les scores et déplacerait chaque palier de
// `_sg_level`. L'argument est en FIN de liste : les deux appelants historiques restent inchangés.
function _sg_rank(skipFn, skipDeg, skipSemis, skipType, nextRef){
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
		if (nextRef) s = _sg_combine(s, _sg_fwdDiat(cell, nextRef, isMin));
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
		if (nextRef) s = _sg_combine(s, _sg_fwdBor(bc, nextRef, isMin, degByRoot, tonicPc));
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
		// SEULEMENT avec une référence jouée : sans elle _sg_fluid rend 0 partout, et trier
		// des coûts tous nuls écrase le palier harmonique par le RANG D'ÉMISSION — un
		// artefact (8 cellules changeaient de luminosité au chargement, audit 2026-08-20).
		// Même garde que la démo. La référence vient de _sg_ref, PARTAGÉE avec _sg_fluid (à
		// qui on la passe) : lastChordNotes, qui survit au note-off — après un release, le
		// rang reste donc calculé.
		var refVL = _sg_ref();
		if (refVL && refVL.length){
			var k, by = emit.slice();
			for (k = 0; k < by.length; k++) by[k]._f = _sg_fluid(by[k].sp, refVL);
			by.sort(function(a,b){ return a._f - b._f; });
			for (k = 0; k < by.length; k++) by[k].lvl = _sg_fluidLevel(k, by.length);
		}
	}
	return emit;
}

// Une carte de progression, sous la forme que lit le scorer. `null` si l'étape n'existe pas ou
// n'est pas réalisable — le tirage avant est alors ABSENT, et le scoring redevient celui d'avant.
function _sg_progRef(i){
	if (i < 0 || i >= progression.length) return null;
	var p = progression[i], sp = _vl2_specFor(p.fn, p.deg, p.colorSemis, p.colorType);
	if (!sp) return null;
	return { deg: (p.fn === "color") ? -1 : p.deg, fn: p.fn, pcs: _sg_pcs(sp) };
}

// Ancrage sur le CURSEUR D'INSERTION. `insertCursor` est l'index où la prochaine carte s'insère :
// le voisin AVANT est donc progression[insertCursor-1], le voisin APRÈS progression[insertCursor].
// Rend `null` quand rien n'est ancrable — le scoring live reprend la main, inchangé.
// ⚠️ Curseur en 0 : pas de voisin arrière, mais un voisin avant. C'est l'accord d'approche, et il
// est autorisé (`_sg_base(-1, …)` rend 0, `_sg_common` tolère le tableau vide).
function _sg_cursorAnchor(){
	if (insertCursor < 0 || !progression.length) return null;
	// tuple-dev#72 : le curseur est une MESURE de la règle. Les voisins se lisent dans le temps — l'historique
	// est fait des cartes qui FINISSENT avant le curseur (ou dessus), le suivant est la première carte qui
	// COMMENCE au curseur ou après. `progression[]` est trié par temps, donc l'historique est un préfixe.
	var i, p, sp, hist = [], nextIdx = -1, lastBefore = -1;
	for (i = 0; i < progression.length; i++){
		p = progression[i];
		if (_entryStart(i) + _entryBars(p) <= insertCursor + 1e-9) {
			lastBefore = i;
			sp = _vl2_specFor(p.fn, p.deg, p.colorSemis, p.colorType);
			if (!sp) continue;
			hist.push({ kind:(p.fn === "color") ? "b" : "d", degree:(p.fn === "color") ? -1 : p.deg, pcs:_sg_pcs(sp) });
		} else if (nextIdx < 0 && _entryStart(i) >= insertCursor - 1e-9) {
			nextIdx = i;
		}
	}
	var next = _sg_progRef(nextIdx);
	if (!hist.length && !next) return null;
	var src = (lastBefore >= 0) ? progression[lastBefore] : null;
	return {
		hist: hist, next: next,
		srcFn: src ? src.fn : "", srcDeg: src ? src.deg : -1,
		srcSemis: src ? src.colorSemis : -1, srcType: src ? src.colorType : ""
	};
}

// Recalcule + diffuse la heat-map (outlet 7). Émis seulement si SMART on ; sinon neutralise.
function _sg_broadcast(){
	outlet(7, "smartclear");
	if (!smartOn) { outlet(7, "smartdone"); return; }
	// Curseur posé sur une progression : le scoring s'ancre là et lit des DEUX côtés. Même truc
	// que _suiteOptions pour l'arrière (échange temporaire de _sg_hist, restauré) ; l'avant passe
	// par l'argument explicite, faute de global équivalent — en inventer un créerait un état
	// partagé muté par deux appelants.
	var anc = _sg_cursorAnchor();
	if (!anc && !_sg_hist.length) { outlet(7, "smartdone"); return; }
	var emit, j, x;
	if (anc){
		var saved = _sg_hist;
		_sg_hist = anc.hist;
		emit = _sg_rank(anc.srcFn, anc.srcDeg, anc.srcSemis, anc.srcType, anc.next);
		_sg_hist = saved;
	} else {
		emit = _sg_rank(lastFn, lastDegree, lastColorSemis, lastColorType);   // skip = l'accord qu'on vient de jouer
	}
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
	// Le mode Suite score « ce qu'on joue APRÈS l'étape idx ». Quand idx+1 existe, il y a donc un
	// accord suivant — et il était ignoré. Un seul chemin de scoring (`tuple-dev#29`) : l'écran et
	// le Push répondent la même chose au même geste. Sur la dernière étape, `_sg_progRef` rend
	// `null` et le comportement d'avant est conservé au bit près.
	var emit = _sg_rank(src.fn, src.deg, src.colorSemis, src.colorType, _sg_progRef(idx+1));   // skip = l'étape elle-même
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
// ⚠️ ORDRE OBLIGATOIRE : construire dans des LOCALES, émettre, publier l'index en DERNIER.
// `flatGrid = []` en tête laissait l'index amputé dès qu'une étape levait, et `flatGrid`
// est ce qui traduit une touche en case pour les TROIS surfaces de jeu (clavier matériel,
// pads Push 2, clavier ordinateur de l'UI) — toutes par `midinote`, qui calcule
// `_idx(pitch - MIDI_BASE, flatGrid.length)` et ne joue plus rien à zéro case.
// Mesuré avant correction : `gridLabel` ou `validGridCells` qui lève → 51 cases à 0,
// clavier MUET à vie ; `borrowedFor` qui lève → 44 sur 51, emprunts injouables. Sans
// erreur visible ni trace, et rien ne déclenche de re-diffusion.
// Un index PÉRIMÉ se rejoue ; un index VIDE ne se récupère pas.
// Épinglé par device/tests/grille-index-robustesse.test.mjs.
function broadcastGrid() {
	var nFlat = [], nCols = [[],[],[],[],[],[],[]], nBor = [];
	outlet(7, "gridclear");
	var cells = validGridCells(), ci, c2;
	for (ci = 0; ci < cells.length; ci++) {
		c2 = cells[ci];
		outlet(7, "gridcell", c2.d, c2.fn, gridLabel(c2.d, c2.fn, c2.iv));
		nFlat.push({ kind:"d", fn:c2.fn, degree:c2.d });
		nCols[c2.d].push({ fn:c2.fn });
	}
	var bl = borrowedFor();
	for (var i = 0; i < bl.length; i++) {
		var c = bl[i];
		var lbl = NOTE_NAMES[(root + c.semis) % 12] + c.suf;
		outlet(7, "gridbor", i, lbl, c.semis, c.type, c.roman);
		nFlat.push({ kind:"b", semis:c.semis, type:c.type });
		nBor.push({ semis:c.semis, type:c.type });
	}
	var quals = [];
	for (var qd = 0; qd < 7; qd++) quals.push(chordQuality(qd));
	outlet(7, "qualities", quals[0], quals[1], quals[2], quals[3], quals[4], quals[5], quals[6]);
	flatGrid = nFlat;                      // publication : rien au-dessus ne doit plus lever
	gCols    = nCols;
	gBor     = nBor;
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


// ⚠️ Les quatre réglages d'expression marquent le clip à réécrire depuis le 2026-08-18 : ils
// entrent DANS le clip, donc les changer sans réécrire les rendrait sans effet visible jusqu'à la
// prochaine édition d'accord. C'est la panne la plus trompeuse qui soit — rien n'échoue, le
// réglage a juste l'air mort. `_clipSyncDirty` ne fait rien sans lien actif : coût nul sinon.
// Les CC d'expression (2026-09-11, Antoine : « émets du CC à chaque changement ») : chaque réglage de la plaque
// EXPRESSION sort aussi en contrôleur MIDI, sur `ctlout` via `[route cc] → [unpack i i]` dans le patch. Message
// `cc <valeur> <numéro>` — la VALEUR d'abord : `unpack` pose le numéro (sortie droite, froide) avant la valeur
// (sortie gauche, chaude). Numéros 20 à 23, « general purpose » libres dans la norme MIDI ; bipolaire → zéro à 64.
// Émis au CHANGEMENT seulement, jamais par `pushUIState` (un rechargement ne doit pas bouger l'instrument).
var CC_STRUM = 20, CC_STRUM_RAMP = 21, CC_STRUM_CURVE = 22, CC_HUMANIZE = 23;
// Le filtre de vélocité (#38) prend les deux suivants. `amxd_contract.mjs` vérifie qu'ils
// restent dans la plage « general purpose » 20..31 et qu'aucun numéro n'est partagé.
var CC_VEL_MIN = 24, CC_VEL_MAX = 25;
// ⚠️ AU CHANGEMENT SEULEMENT — et ça ne l'était pas. Mesuré dans Live le 2026-09-15, deux pistes
// jetables et le device neutralisé : un clip enregistré sur la sortie de Tuple porte des
// enveloppes ALORS QUE PERSONNE N'A TOUCHÉ À L'EXPRESSION — et n'en porte aucune device éteint.
// Cause : chaque setter appelait `_cc` sans comparer, et Live REPOUSSE les valeurs de paramètres
// (démarrage du transport, réactivation du device, chargement d'un set). Tuple arrosait donc le
// fil de CC 20..23 à chaque fois, au milieu de l'enregistrement de l'utilisateur.
// La mémoire est amorcée juste après les setters : le premier push de Live, qui vaut la valeur
// de départ, n'émet rien. Un set qui restaure une AUTRE valeur, lui, est un vrai changement.
function _ccQuant(val) { return Math.max(0, Math.min(127, Math.round(val))); }
var _ccLast = {};
function _cc(num, val) {
	var q = _ccQuant(val);
	if (_ccLast[num] === q) return;
	_ccLast[num] = q;
	outlet(7, "cc", q, num);
}
function strumms(v) {
	_strumMs = Math.max(-250, Math.min(250, parseInt(v) || 0));  // signé : <0 descendant, >0 montant. >~60ms = arpège
	outlet(7, "strumms", _strumMs);
	_cc(CC_STRUM, (_strumMs + 250) / 500 * 127);
	_clipSyncDirty();
}
function strumramp(v) {
	strumRamp = Math.max(-100, Math.min(100, parseInt(v) || 0));
	outlet(7, "strumramp", strumRamp);
	_cc(CC_STRUM_RAMP, (strumRamp + 100) / 200 * 127);
	_clipSyncDirty();
}
function strumcurve(v) {
	var i = parseInt(v);
	if (i >= 0 && i < STRUM_CURVE_P.length) strumCurve = i;
	outlet(7, "strumcurve", strumCurve);
	_cc(CC_STRUM_CURVE, strumCurve / (STRUM_CURVE_P.length - 1) * 127);
	_clipSyncDirty();
}
function humanizeamt(v) {
	humanizeAmt = Math.max(0, Math.min(100, parseInt(v)));
	outlet(7, "humanize", humanizeAmt);
	_cc(CC_HUMANIZE, humanizeAmt / 100 * 127);
	_clipSyncDirty();
}

// Amorçage de la mémoire des CC : les valeurs de DÉPART sont déjà « connues », donc le premier
// push de Live n'émet rien. Les formules sont celles des quatre setters ci-dessus — les changer
// ici sans les changer là-haut ferait ré-émettre au chargement, silencieusement.
_ccLast[CC_STRUM]       = _ccQuant((_strumMs + 250) / 500 * 127);
_ccLast[CC_STRUM_RAMP]  = _ccQuant((strumRamp + 100) / 200 * 127);
_ccLast[CC_STRUM_CURVE] = _ccQuant(strumCurve / (STRUM_CURVE_P.length - 1) * 127);
_ccLast[CC_HUMANIZE]    = _ccQuant(humanizeAmt / 100 * 127);
_ccLast[CC_VEL_MIN]     = _ccQuant(velMin);
_ccLast[CC_VEL_MAX]     = _ccQuant(velMax);

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

// Index validé, ou -1. À utiliser PARTOUT où on indexe un tableau avec une valeur reçue de
// l'extérieur (jweb, Push, LiveAPI).
//
// PIÈGE : `parseInt` rend NaN sur une entrée non numérique, et NaN met en ÉCHEC toute
// comparaison — `NaN < 0` et `NaN >= len` sont FAUX tous les deux. Le garde-fou classique
// `if (i < 0 || i >= len) return;` laisse donc passer NaN, puis `tab[NaN]` vaut `undefined`
// et la lecture du champ suivant lève. L'exception remonte et AVORTE l'appel en cours, en
// général au milieu d'une mutation d'état. Ce trou était ouvert dans 6 points d'entrée
// (midinote, playprog, previewprog, selprog, moveprog, progmode) — trouvé au fuzz du
// 2026-08-05, cf. device/tests/entrypoint-fuzz.test.mjs.
function _idx(v, len) {
	var i = parseInt(v);
	return (isNaN(i) || i < 0 || i >= len) ? -1 : i;
}

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
		default:
			// Un type absent d'ici alors qu'il est valide dans GRID_TYPES/gridTypeValid rend la case
			// cliquable dans la grille/Push/MIDI mais SILENCIEUSE (zéro son, zéro diagnostic) — c'est
			// exactement la classe du bug A7sus4/quartal du 2026-07-15. Échouer bruyamment ici.
			post("playFlatCell: type de cellule inconnu '" + cell.fn + "'\n");
			break;
	}
}

// ── Passthrough de lecture (tuple-dev#77, 2026-09-18) ────────────────────────
// Pendant que le clip LIÉ joue, ce qui entre par midinote EST le clip — les accords finaux
// que Tuple a lui-même écrits. Les remapper re-déclenchait un accord de grille PAR NOTE
// (mesuré dans Live avant ce code : un ré seul ressortait en accords de cinq sons,
// enregistrés en aval). Ils passent donc INTACTS, par la porte de vélocité (_emitVel).
// `_passActive` garantit le note-off si la lecture s'arrête entre un on et son off ;
// un note-off inconnu passe quand même — on n'avale JAMAIS un note-off.
var _passActive = {};
function _passNote(pitch, vel) {
	if (vel > 0) _passActive[pitch] = true;
	else delete _passActive[pitch];
	_emitVel(vel);
	outlet(1, pitch);
}
function _passRelease() {
	var p;
	for (p in _passActive) { _emitVel(0); outlet(1, parseInt(p)); }
	_passActive = {};
}

function midinote(pitch, vel) {
	pitch = parseInt(pitch);
	vel   = parseInt(vel);

	// Lecture du clip lié : passthrough intégral, note-offs compris (bloc ci-dessus).
	// Conséquence assumée : clavier MIDI et pads Push passent aussi en direct tant que
	// la lecture court — la lecture appartient à Live (CONTEXT.md), Tuple s'efface.
	if (_linkPlaying) { _passNote(pitch, vel); return; }

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

	var idx = _idx(pitch - MIDI_BASE, flatGrid.length);
	if (idx < 0) return;

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
// Cale un accord à candidat unique (ABSOLUTE, ou root/classic VL-off) sous le plafond 108 en
// descendant par octave — sans lui, à oct+2 (regBase 72) les shapes à registre haut débordent,
// _vl2_realize renvoie [] et sendChord retombe SILENCIEUSEMENT sur applyVoicing serré (perte du
// style, des tensions EXT). tuple-dev#34 finding 1, tranché « caler dans la fenêtre » 2026-08-24.
// N'agit qu'au registre extrême : aux octaves normales max≤108 déjà, la boucle ne tourne pas.
// Rend false si infittable (le grave passerait sous 24). Mute `notes` en place. Miroir : realizer.js.
function _vl2_fitWindow(notes){
	var mx=Math.max.apply(null,notes);
	while(mx>108){
		if(Math.min.apply(null,notes)-12<24)return false;
		for(var i=0;i<notes.length;i++)notes[i]-=12;
		mx-=12;
	}
	return Math.min.apply(null,notes)>=24;
}
function _vl2_dominantThirdPc(spec) {
	if (!spec.isDominant) return null;
	var e = _vl2_rolePc(spec.pcs, 'third');
	return e ? e.pc : null;
}

// --- identity ---
function _vl2_checkIdentity(voicing, notes, spec) {
	var v = [];
	var ns = notes.slice().sort(function(a,b){return a-b;});
	// ⚠️ Le Set des classes de hauteur ne sert QU'À la branche `hasSeventh`, et cette
	// fonction tourne surtout sur des TRIADES : mesuré, 15 appels par note en classic et 27
	// en piano, dont 100 % sans septième. Le construire en tête revenait à allouer un Set
	// polyfillé, un tableau et deux fermetures par appel, pour ne jamais les lire. Il se
	// construit donc là où il est lu. (`m` local a disparu : `_vl2_m` est global et hoisté.)
	if (spec.hasSeventh) {   // guide tones sur les 7e. EXCEPTION house : 6/9 en EXT (lâche la 7e, GARDE la 3ce).
		var pcs = new Set(ns.map(_vl2_m));
		var has = function(role){ var e=_vl2_rolePc(spec.pcs,role); return e&&pcs.has(e.pc); };
		if (!has('seventh')) v.push('guide:7e absente');
		var hasThird = !!_vl2_rolePc(spec.pcs, 'third');
		if (hasThird && !has('third')) v.push('guide:3ce absente');
	}
	// Les cinq styles vivants n'ont pas de verrou rootless / sus / power : ces branches
	// appartenaient aux 24 styles retires (2026-09-14).
	if (voicing==='drop2'||voicing==='drop3') {
		// drop2 accepte TROIS voix : la triade ouverte (« open triad » / « drop 2 triad ») est une
		// forme nommée, sans doublure, avec ses trois renversements catalogués — tuple-dev#20,
		// décision 5. drop3 reste à quatre : les sources ne définissent pas de « triade drop 3 »,
		// et le drop 3 littéral à trois voix rend `Two Hands` à l'identique 20/21.
		// ⚠️ Ce verrou ne sait que REJETER. C'est _vl2_realize qui PRODUIT la triade ouverte (il
		// cesse de rediriger drop2 vers classic) ; sans ça, ouvrir la borne ici ne ferait rien.
		var dropMinV = (voicing==='drop2') ? 3 : 4;
		if (ns.length < dropMinV) { v.push('dropN:<' + dropMinV + ' voix'); }
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
		if (_vl2_m(ns[0])!==spec.rootPc) v.push('piano:basse ≠ fondamentale');
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

// EXTENDED n'ajoute que les tensions JUSTES : 9 majeure (2), 11 juste (5), 13 majeure (9). Une
// tension altérée — ♭9 / ♯9, ♯11, ♭13 — est une COULEUR, pas un enrichissement : elle a ses
// propres cases de grille (`sevenflat9` / `sevensharp9` dans gridTypeValid), elle se pose à la
// main par la rangée TENSIONS d'une carte, et `isValid` la refuse déjà partout ailleurs —
// `add9`, `nine`, `maj9`, `min9` et `sixnine` exigent tous `iv[8] === 2`.
//
// EXTENDED était le seul chemin qui ne posait pas la question. Mesuré le 2026-09-14, en fa
// majeur : ♭9 sur CINQ cases (Amadd9, Am11, A7sus4, Edim, Eø11), dont deux dont le label ne
// revendiquait aucune 9 ; en mineur harmonique : ♭13 sur G6/9 et G13, 11 majeure (4 demi-tons,
// donc la tierce) sur Bdim9.
//
// Rend le pitch class à ajouter, ou null. `gridLabel` se gate sur les MÊMES trois conditions
// (`iv[8]===2`, `iv[3]===5`, `iv[5]===9`) : une seule règle, deux lectures, pas de dérive.
// `oks` = les intervalles qui font VRAIMENT de cette tension une tension (une « 11 » à 4 demi-tons
// est la tierce, pas une 11 : mesuré sur Bdim9 en mineur harmonique). Passé ce garde-fou
// d'intégrité, c'est `_tensAvoid` — la table d'avoid-notes du moteur, celle qui filtre déjà les
// tensions posées à la main sur une carte — qui décide, et seulement quand AVOID NOTES est allumé.
// Une seule table pour les deux surfaces : la grille ne peut plus enrichir avec ce qu'une carte
// refuserait, ce qui était exactement l'écart signalé (♭9 sur III et VII en fa majeur).
function _vl2_extTensionPc(spec, step, oks){
	var pc = spec.scalePcs[(spec.degree + step) % 7], iv = _vl2_m(pc - spec.rootPc), i;
	for (i = 0; i < oks.length; i++) if (oks[i] === iv) break;
	if (i === oks.length) return null;                       // pas une tension de cette famille
	// Une pentatonique n'a que cinq notes : la 9 diatonique de la gamme PARENTE peut en sortir
	// (le si d'un Am en do majeur pentatonique). gridTypeValid juge le spec AVANT enrichissement,
	// donc c'est ici, et seulement ici, que la case peut encore fuir. Mesuré : 3 cases sur 14.
	if (SCALE_VALID_DEGREES[scaleName] && !scalePcSet()[_vl2_m(pc)]) return null;
	if (avoidNotesOn && _tensAvoid(spec, { iv: iv })) return null;   // avoid note : la table tranche
	return pc;
}
function _vl2_enrichSpec(spec){
	if(!spec||!spec.scalePcs)return spec;
	var hasRole=function(r){return !!_vl2_rolePc(spec.pcs,r);};
	var third=_vl2_rolePc(spec.pcs,'third');
	var ninthPc=_vl2_extTensionPc(spec,1,[1,2,3]);        // ♭9 · 9 · ♯9 — _tensAvoid filtre
	if(!third){   // sus / sans 3ce
		var sus=_vl2_rolePc(spec.pcs,'sus');
		if(sus&&spec.hasSeventh&&!hasRole('ninth')&&ninthPc!==null)   // 7sus4 -> 9sus4 (la 9 est diatonique)
			return {pcs:spec.pcs.slice().concat([{pc:ninthPc,role:'ninth'}]),rootPc:spec.rootPc,fn:spec.fn,degree:spec.degree,scalePcs:spec.scalePcs,hasSeventh:spec.hasSeventh,isDominant:spec.isDominant};
		return spec;   // sus sans 7e : laissé tel quel
	}
	var fifth=_vl2_rolePc(spec.pcs,'fifth');
	var fifthIv=fifth?_vl2_m(fifth.pc-spec.rootPc):7;
	// Triade diminuée ou augmentée SANS 7e : accord de couleur, pas d'enrichissement. gridLabel
	// n'a d'ailleurs aucune forme étendue pour « dim » / « aug » — il restait muet pendant que le
	// moteur ajoutait une 9 (mesuré : Adim en mineur mélodique, D♯aug en harmonique).
	if(!spec.hasSeventh&&fifthIv!==7)return spec;
	var minor=_vl2_m(third.pc-spec.rootPc)===3;
	var add=[];
	if(!hasRole('ninth')&&ninthPc!==null) add.push({pc:ninthPc,role:'ninth'});
	var eleventhPc=_vl2_extTensionPc(spec,3,[5,6]);     // 11 · ♯11
	var thirteenthPc=_vl2_extTensionPc(spec,5,[8,9]);   // ♭13 · 13
	if(minor&&spec.hasSeventh&&!hasRole('eleventh')&&eleventhPc!==null) add.push({pc:eleventhPc,role:'eleventh'});
	if(!minor&&!hasRole('thirteenth')&&!hasRole('sixth')&&thirteenthPc!==null) add.push({pc:thirteenthPc,role:'thirteenth'});
	if(!add.length)return spec;
	return {pcs:spec.pcs.slice().concat(add),rootPc:spec.rootPc,fn:spec.fn,degree:spec.degree,scalePcs:spec.scalePcs,hasSeventh:spec.hasSeventh,isDominant:spec.isDominant};
}
// PIPELINE DE SPEC UNIQUE — construit le spec d'une case (diatonique OU emprunt) et applique les transforms
// de niveau spec (EXT enrich aujourd'hui ; futurs : polychord…). Utilisé par play, preview ET smart → ils
// ne peuvent plus diverger (la classe de bug « le smart n'a pas eu l'EXT » disparaît à la racine).
// ⚠️ PLUS DE PARAMÈTRE `tensions`, et ce n'est pas un oubli. Il a existé pour tuple-dev#68 :
// les tensions d'une carte entraient dans le spec, qui repassait par `_vl2_realize`. Le
// 2026-09-11 Antoine a signalé que « l'écriture des tensions semble changer la structure de
// l'accord » — C + 9 sortait renversé, G + 13 mettait la 13 à la basse, Dm + 11 faisait un
// cluster. Le chemin a été remplacé par `_tensStack`, qui EMPILE au-dessus du sommet sans
// toucher à la base. Le paramètre est resté câblé à `null` par son unique appelant, et
// `_tensApply` avec lui : onze lignes qu'aucune exécution n'atteignait depuis.
function _vl2_specFor(fn,d,colorSemis,colorType){
	var spec=(fn==='color')?_vl2_buildColorSpec(colorSemis,colorType):_vl2_buildSpec(fn,d);
	if(!spec)return null;
	if(extendedOn)spec=_vl2_enrichSpec(spec);                      // EXTENDED ne complète ensuite que les rôles vides
	return spec;
}
// tuple-dev#73 : l'identité d'une tension est son INTERVALLE à la fondamentale (sa couleur) ; la famille
// (9 / 11 / 13) ne sert qu'au rôle dans le voicing et au nom.
var _TENS_NAMES = ["b9", "9", "#9", "11", "#11", "b13", "13"];              // ordre du fil ; une carte porte ces NOMS
var _TENS_ROLE = { 1:"ninth", 2:"ninth", 3:"ninth", 5:"eleventh", 6:"eleventh", 8:"thirteenth", 9:"thirteenth" };
var _TENS_FAM  = { 1:9, 2:9, 3:9, 5:11, 6:11, 8:13, 9:13 };
var _TENS_BY_NAME = { "b9":1, "9":2, "#9":3, "11":5, "#11":6, "b13":8, "13":9 };
// ══ TENSIONS DIATONIQUES des cartes de progression (tuple-dev#68) ═══════════════════════
// Trois candidates par carte, jamais plus : la 9, la 11 et la 13 DE LA GAMME. Leur couleur
// (b9 / 9 / #9, 11 / #11, b13 / 13) se lit par l'intervalle à la fondamentale — la ♯11
// n'existe que là où la gamme la donne (IV en majeur), la ♭9 aussi (V en mineur harmonique).
// AVOID NOTES (global, débrayable) refuse ensuite ce que la théorie tonale évite ; éteint,
// les trois diatoniques sont offertes telles quelles. Le moteur DÉCIDE, l'UI affiche.
var avoidNotesOn = true;
var _TENS_COLOR = { 1:"b9", 2:"9", 3:"#9", 5:"11", 6:"#11", 8:"b13", 9:"13" };
// Spec de BASE d'une carte (sans enrichissement EXTENDED) : c'est sur lui qu'on lit la qualité.
function _tensBaseSpec(p) {
	return (p.fn === "color") ? _vl2_buildColorSpec(p.colorSemis, p.colorType) : _vl2_buildSpec(p.fn, p.deg);
}
// Les notes de la gamme courante (classes de hauteur), pour les cartes empruntées dont le
// spec n'a pas de degré : « rester dans la gamme » = la tonalité de KEY · SCALE.
function _tensScalePcs() {
	var out = [], i; for (i = 0; i < scale.length; i++) out.push(((root + scale[i]) % 12 + 12) % 12); return out;
}
// Candidate d'une tension (9, 11 ou 13) : { pc, iv, color } ou null si la gamme ne la donne pas.
function _tensCandidate(spec, t) {
	var m = function(n){ return ((n % 12) + 12) % 12; }, pcs = spec.scalePcs || _tensScalePcs(), i, j, iv = _tensIv(spec, t);
	if (iv < 0) return null;
	var pc = m(spec.rootPc + iv), diat = false;
	for (j = 0; j < pcs.length; j++) if (m(pcs[j]) === pc) diat = true;
	return { pc: pc, iv: iv, color: _TENS_COLOR[iv], diat: diat };
}
// L'intervalle d'une tension telle qu'on la reçoit : une couleur (1 2 3 5 6 8 9, ou son nom « b9 » … « 13 »), ou
// une FAMILLE (9 / 11 / 13 — sets sauvés avant #73, Push, ancienne UI) qui désigne la couleur DE LA GAMME de
// cette famille, à défaut la naturelle. -1 si rien.
function _tensIv(spec, t) {
	var m = function(n){ return ((n % 12) + 12) % 12; }, pcs = spec.scalePcs || _tensScalePcs(), i, j;
	if (_TENS_BY_NAME.hasOwnProperty(String(t)) && !(t === 9 || t === 11 || t === 13)) return _TENS_BY_NAME[String(t)];
	t = parseInt(t);
	if (t === 9 || t === 11 || t === 13) {
		var want = (t === 9) ? [2, 1, 3] : (t === 11) ? [5, 6] : [9, 8];
		for (i = 0; i < want.length; i++) for (j = 0; j < pcs.length; j++) if (m(pcs[j] - spec.rootPc) === want[i]) return want[i];
		return want[0];
	}
	return -1;
}
// Raison de refus (AVOID NOTES) ou "" — lue sur la qualité du spec : tierce, quinte, septième.
function _tensAvoid(spec, cand) {
	var m = function(n){ return ((n % 12) + 12) % 12; };
	var third = _vl2_rolePc(spec.pcs, "third"), fifth = _vl2_rolePc(spec.pcs, "fifth");
	var t3 = third ? m(third.pc - spec.rootPc) : -1, t5 = fifth ? m(fifth.pc - spec.rootPc) : -1, iv = cand.iv;
	if (t3 < 0) return (iv === 1) ? "4th" : "";                                  // sus : la ♭9 frotte la quarte
	if (t3 === 4) {                                                              // majeur ou dominante
		if (iv === 5) return spec.isDominant ? "sus" : "3rd";                    // 11 : sur une dominante → 7sus4
		if (!spec.isDominant && (iv === 1 || iv === 3 || iv === 8)) return "major";   // ♭9 ♯9 ♭13 ne sont pas des couleurs majeures
		return "";
	}
	if (t3 === 3) {                                                              // mineur, demi-diminué, diminué
		// ø : la 13 n'est pas sa couleur, la ♭13 si. La 9 — naturelle OU bémol — est celle que la
		// GAMME donne : en majeur le VII est locrien (♭9 diatonique), en mineur mélodique le VI est
		// locrien ♮2 (9 naturelle). Les sources se contredisent sur ce point (TJPS donne ♭9
		// disponible et 9 à éviter, jazzguitar.be et Jens Larsen l'inverse) ; arbitrage du
		// 2026-09-14 : la gamme sélectionnée tranche, le moteur ne préjuge pas. La ligne refusait
		// `iv === 1` d'office.
		if (t5 === 6) return (iv === 9) ? "hdim" : "";
		if (iv === 6) return "5th";                                              // ♯11 contre la quinte juste
		return (iv === 1 || iv === 8) ? "minor" : "";
	}
	return "";
}
// L'offre d'une carte : [{ t:9, color:"9", state:"off"|"on"|"built"|"avoid:<raison>" }, ×3].
function _tensOffer(p) {
	var spec = _tensBaseSpec(p), out = [], i;
	if (spec) _tensNormalize(p, spec);
	for (i = 0; i < _TENS_NAMES.length; i++) {
		var nm = _TENS_NAMES[i], iv = _TENS_BY_NAME[nm], c = spec ? _tensCandidate(spec, nm) : null;
		if (!c) { out.push({ t: nm, iv: iv, color: nm, state: "none", diat: false }); continue; }
		var state, has = p.tensions && p.tensions.indexOf(nm) >= 0, j, built = false;
		for (j = 0; j < spec.pcs.length; j++) if (spec.pcs[j].pc === c.pc) built = true;
		if (built) state = "built";
		else if (has) state = (p.tensMuted && p.tensMuted.indexOf(nm) >= 0) ? "muted" : "on";   // posée : reste posée même si le filtre la refuserait ; muted = posée, non rendue
		else { var why = avoidNotesOn ? _tensAvoid(spec, c) : ""; state = why ? ("avoid:" + why) : "off"; }
		out.push({ t: nm, iv: iv, color: nm, state: state, pc: c.pc, diat: c.diat });
	}
	return out;
}
// Les tensions d'une carte sont des INTERVALLES. Une carte d'avant #73 porte des familles (9 / 11 / 13) : au
// premier passage chacune devient la couleur diatonique de sa famille — ce que #68 offrait.
function _tensNormalize(p, spec) {
	if (!p.tensions || !p.tensions.length) return;
	var out = [], i, iv, nm;
	for (i = 0; i < p.tensions.length; i++) { iv = _tensIv(spec, p.tensions[i]); nm = _TENS_COLOR[iv]; if (iv > 0 && out.indexOf(nm) < 0) out.push(nm); }
	out.sort(function(a, b){ return _TENS_BY_NAME[a] - _TENS_BY_NAME[b]; });
	p.tensions = out;
}
// Nom d'une carte avec ses tensions, dans la convention de la grille (M7, m7, ø7, 7sus4, #, b).
// La chaîne naturelle (9 → 11 → 13) remplace le chiffre 7 : G7 + 13 → G13, FM7 + 9 → FM9,
// Bø7 + 11 → Bø11, G7sus4 + 9 → G9sus4. Les altérations (b9, #9, #11, b13) suivent en clair sur
// une dominante (E7b9, G13#11) et pour la #11 d'un majeur (FM7#11) ; entre parenthèses sinon
// (Bø7(b13)). Sans septième : add9 / add11 / add13. Sans tension : le nom d'origine, tel quel.
function _tensName(p) {
	var base = p.baseName || p.name, o = _tensOffer(p), spec = _tensBaseSpec(p), i;
	var nat = [], alt = [];
	for (i = 0; i < o.length; i++) {
		if (o[i].state !== "on" && o[i].state !== "muted") continue;
		var iv = o[i].iv;
		if (iv === 2 || iv === 5 || iv === 9) nat.push(_TENS_FAM[iv]); else alt.push({ iv: iv, color: o[i].color });
	}
	if (!nat.length && !alt.length) return base;
	var name = base, top = nat.length ? nat[nat.length - 1] : 0;
	if (/7(sus4|b9|#9)?$/.test(base)) { if (top) name = base.replace(/7(sus4|b9|#9)?$/, String(top) + "$1"); }
	else if (top) { name = base + "add" + top; }
	var thirdMaj = (function(){ var t = _vl2_rolePc(spec.pcs, "third"); return t && (((t.pc - spec.rootPc) % 12 + 12) % 12) === 4; })();
	for (i = 0; i < alt.length; i++) {
		var bare = spec.isDominant || (alt[i].iv === 6 && thirdMaj);
		name += bare ? alt[i].color : ("(" + alt[i].color + ")");
	}
	return name;
}
// Toggle UI : "avoidnotes 1/0" — global, comme "extended". Ne touche aucune carte : seule l'offre change.
function avoidnotes(v) {
	avoidNotesOn = (parseInt(v) === 1);
	outlet(7, "avoidnotes", avoidNotesOn ? 1 : 0);
	broadcastProgTens();
}
// Au changement de KEY ou SCALE : chaque carte recalcule son offre, une tension posée qui
// n'est plus offerte (candidate disparue, devenue partie du type, ou refusée par le filtre)
// est retirée et le nom remis. Les NOTES ne sont pas re-réalisées ici — aucun changement de
// tonalité ne re-réalise la progression aujourd'hui (elles suivent à la prochaine édition) ;
// ce mécanisme ne change pas ce contrat, il n'élague que les tensions.
function _tensPrune() {
	var i, j, changed = false;
	for (i = 0; i < progression.length; i++) {
		var p = progression[i]; if (!p.tensions || !p.tensions.length) continue;
		var spec = _tensBaseSpec(p), keep = [], avant = p.tensions.join(".");
		if (spec) _tensNormalize(p, spec);
		// Session 73 (Antoine : « le but c'est d'ajouter des tensions qui restent dans la
		// couleur diatonique ») : au changement de gamme une tension SUIT SA FAMILLE — la
		// couleur re-dérive vers la diatonique de la famille (13 → ♭13 en mineur) AVANT le
		// filtre. La règle #73 « posée hors gamme reste, en creux » ne vaut plus qu'à la
		// POSE (une couleur off~ posée exprès) — plus à travers un changement de tonalité.
		if (spec) {
			var red = [], seen = {};
			for (j = 0; j < p.tensions.length; j++) {
				var iv0 = _TENS_BY_NAME[p.tensions[j]];
				var iv1 = _tensIv(spec, _TENS_FAM[iv0]);
				var nm = _TENS_COLOR[(iv1 > 0) ? iv1 : iv0];
				if (!seen[nm]) { seen[nm] = 1; red.push(nm); }
			}
			red.sort(function(a, b){ return _TENS_BY_NAME[a] - _TENS_BY_NAME[b]; });
			p.tensions = red;
		}
		for (j = 0; j < p.tensions.length; j++) {
			var c = spec ? _tensCandidate(spec, p.tensions[j]) : null; if (!c) continue;
			var built = false, k; for (k = 0; k < spec.pcs.length; k++) if (spec.pcs[k].pc === c.pc) built = true;
			if (built) continue;
			if (avoidNotesOn && _tensAvoid(spec, c)) continue;
			keep.push(p.tensions[j]);
		}
		if (keep.join(".") !== avant) { p.tensions = keep; p.name = _tensName(p); changed = true; }
		else p.tensions = keep;
	}
	if (changed) broadcastProg(); else broadcastProgTens();   // la gamme a changé : les marques aussi, même si rien ne bouge (tuple-dev#73)
}
// Sur une carte, EXTENDED ne complète les rôles vides qu'avec les tensions OFFERTES : ce que le
// filtre AVOID NOTES refuse (la ♭9 diatonique d'un mineur, la 11 d'un majeur) n'est pas ajouté par
// l'enrichissement. Une tension POSÉE par l'utilisateur reste, même refusée depuis. La grille jouée
// en direct ne passe pas ici : son enrichissement EXTENDED est inchangé (hors périmètre).
function _tensStripAvoided(spec, entry) {
	var base = _tensBaseSpec(entry); if (!base) return spec;
	_tensNormalize(entry, base);
	var posed = entry.tensions || [], pcs = [], i, j, dropped = false;
	for (i = 0; i < spec.pcs.length; i++) {
		var e = spec.pcs[i], keep = true;
		if (e.role === "ninth" || e.role === "eleventh" || e.role === "thirteenth") {
			var posee = false;
			for (j = 0; j < posed.length; j++) { var pc = _tensCandidate(base, posed[j]); if (pc && pc.pc === e.pc) posee = true; }
			if (!posee) {                                          // ajoutée par l'enrichissement, pas par l'utilisateur
				var fam = (e.role === "ninth") ? 9 : (e.role === "eleventh") ? 11 : 13;
				var c = _tensCandidate(base, fam);                  // la diatonique de la famille
				if (!c || c.pc !== e.pc || _tensAvoid(base, c)) keep = false;
			}
		}
		if (keep) pcs.push(e); else dropped = true;
	}
	if (!dropped) return spec;
	return { pcs: pcs, rootPc: spec.rootPc, fn: spec.fn, degree: spec.degree, scalePcs: spec.scalePcs, hasSeventh: spec.hasSeventh, isDominant: spec.isDominant };
}
// Les couleurs posées d'une carte, en noms séparés d'un point (« b9.#9.13 ») — le 8e atome de `prog`.
function _tensNames(p) {
	var spec = _tensBaseSpec(p), out = [], i;
	if (spec) _tensNormalize(p, spec);
	for (i = 0; i < p.tensions.length; i++) out.push(String(p.tensions[i]));
	return out.join(".");
}
// ⚠️ Les largeurs des trois trames positionnelles sont un CONTRAT avec l'UI, qui lit
// `flat[i * largeur + k]`. Celle de "prog" était nommée et gardée ; les deux autres étaient
// implicites — `o.length` d'un côté, un `2` et un `7` littéraux de l'autre. Une largeur qui
// change décale alors toutes les cartes sauf la première, en silence, et c'est exactement
// le mode de panne que le commentaire de `broadcastProg` décrit déjà pour "progvoic".
// Les trois sont épinglées par device/tests/prog-wire-contract.test.mjs.
var PROGVOIC_STRIDE = 2;   // clé de voicing, libellé affiché
var PROGTENS_STRIDE = 7;   // ♭9 · 9 · ♯9 · 11 · ♯11 · ♭13 · 13, ordre fixe (tuple-dev#73)

function broadcastProgTens() {
	var flat = [], i, j;
	for (i = 0; i < progression.length; i++) {
		var o = _tensOffer(progression[i]);
		// Refuser de diffuser une trame qui ne respecte pas sa largeur : l'UI n'a aucun
		// moyen de s'en apercevoir, elle indexe.
		if (o.length !== PROGTENS_STRIDE) { post("progtens: " + o.length + " tensions pour " + PROGTENS_STRIDE + " attendues\n"); return; }
		for (j = 0; j < o.length; j++) flat.push(o[j].state + (o[j].diat ? "" : "~"));   // tuple-dev#73 : ordre fixe ♭9 9 ♯9 11 ♯11 ♭13 13
	}
	outlet(7, ["progtens"].concat(flat));
}
// Toggle UI : "extended 1/0". Orthogonal au voicing.
function extended(v){
	_releaseHeld();    // libère toute note tenue (comme voiceleading/vlmode) → le toggle ne laisse pas de note coincée
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
// "Trouver le pc-entry d'un rôle donné" était réimplémenté ~15x en boucle inline (closures roleP/role/has,
// boucles nues) à travers checkIdentity et les transforms de voicing — dédup pure, sortie identique
// (audit 2026-07-15). Retourne l'entry {pc,role} entière (pas juste .pc) : la plupart des sites l'utilisent
// telle quelle ou lisent .pc dessus, quelques-uns ont juste besoin d'un test d'existence (!!résultat).
function _vl2_rolePc(pcs,role){for(var i=0;i<pcs.length;i++)if(pcs[i].role===role)return pcs[i];return null;}
function _vl2_rotOf(arr){
	var out=[],r=_vl2_vs(arr);
	for(var i=0;i<arr.length;i++){out.push(r.slice());r=_vl2_vs(r.slice(1).concat([r[0]+12]));}
	return out;
}
// La BASE SERREE de toute realisation : `classic` la joue telle quelle, `drop2` / `drop3` en
// descendent une voix, et _vl2_checkIdentity exige d'eux qu'elle le soit (`dropN:base non-close`).
//
// ⚠️ Elle empilait les roles dans l'ordre _vl2_ROLE_ORDER — root, 3ce, 5te, 7e, 9e… — c'est-a-dire
// PAR TIERCES. C'est la position fondamentale, pas la position serree : des la 9e, la tension se
// pose une octave trop haut et sa propre octave basse tient dans le trou. Mesure du 2026-09-14 :
// CM9 rendait C2 E2 G2 B2 D3, et re2 s'insere entre do2 et mi2 — position serree sur 62 % des
// cases en normal, 29 % en EXTENDED. L'ordre correct est celui des HAUTEURS depuis la basse, pas
// celui des roles : CM9 devient C2 D2 E2 G2 B2. Verifie par device/tests/mesure-close-position.mjs.
// MODE NEUTRE (`root`) — les notes de l'accord à leur position PAR DÉFAUT, dans l'ordre :
// fondamentale, 3ce, 5te, 7e, 9e, 11e, 13e (l'ordre de _vl2_ROLE_ORDER), chacune posée au plus
// bas au-dessus de la précédente. C'est la position fondamentale empilée par tierces, sans aucun
// stylage — ce que `_vl2_closeFrom` faisait pour TOUT LE MONDE jusqu'au 2026-09-14, à tort pour
// `classic` (qui doit serrer) et à raison pour ce mode-ci, qui existe pour ne rien faire.
// Le chemin `vc==='root'` ne produit qu'UN candidat : le sélecteur n'a rien à choisir, donc ni
// Anchor ni Follow ne peuvent le renverser. Mesuré : avec classic, Anchor déplaçait 88/91 accords
// hors position fondamentale, Follow 72/91 ; Root, 0/91.
function _vl2_stackFrom(spec,rootMidi){
	var ord=spec.pcs.slice().sort(function(a,b){return _vl2_ROLE_ORDER.indexOf(a.role)-_vl2_ROLE_ORDER.indexOf(b.role);});
	var out=[rootMidi],last=rootMidi;
	for(var i=1;i<ord.length;i++){var n=last+1;n+=_vl2_m(ord[i].pc-_vl2_m(n));out.push(n);last=n;}
	return out;
}
function _vl2_closeFrom(spec,rootMidi){
	var bassPc=_vl2_m(rootMidi),seen={},pcs=[],i,pc,n;
	seen[bassPc]=1;
	for(i=0;i<spec.pcs.length;i++){pc=_vl2_m(spec.pcs[i].pc);if(seen[pc])continue;seen[pc]=1;pcs.push(pc);}
	pcs.sort(function(a,b){return _vl2_m(a-bassPc)-_vl2_m(b-bassPc);});
	var out=[rootMidi],last=rootMidi;
	for(i=0;i<pcs.length;i++){n=last+1;n+=_vl2_m(pcs[i]-_vl2_m(n));out.push(n);last=n;}
	return out;
}
var _vl2_STRUCT=new Set(['piano','drop2','drop3']);
var _vl2_ABSOLUTE=new Set([]);   // plus aucun des cinq styles vivants n'est a registre absolu (les 24 retires l'etaient)
// QUELLE BASE CHAQUE STYLE HABILLE. Par defaut la position serree de `_vl2_closeFrom` : c'est ce
// que `Closed` joue tel quel, et ce dont `Section` / `Chord Melody` descendent une voix — leur
// definition meme. `Two Hands` n'en est pas : il jette la fondamentale, prend le reste comme main
// droite, et pose la basse une octave sous la note la plus grave de cette main.
//
// ⚠️ Il a herite du resserrement du 2026-09-14 par effet de bord, et ca lui coutait une OCTAVE.
// Mesure du 2026-09-15 (device/tests/mesure-migration-palette.mjs, puis neutralisation de
// `_vl2_closeFrom` seul) : 35 cellules sur 91 — les cinq familles portant une 9e — translatees
// rigidement de -12. Basse moyenne F3 -> F2, sommet moyen D5 -> D4, CM9 passant de C3 D4 E4 G4 B4
// a C2 D3 E3 G3 B3. Cause : le resserrement fait descendre la 9e du sommet de l'accord a juste
// au-dessus de la fondamentale, donc la main droite commence sur elle, une octave plus bas, et la
// basse suit. Le plancher C2 etait respecte des deux cotes : rien ne le signalait.
// `_vl2_stackFrom` est mot pour mot l'ancien `_vl2_closeFrom` — empiler par tierces rend donc a
// `Two Hands` exactement son registre d'avant, 0 cellule changee sur 91.
var _vl2_STACK_BASE=new Set(['piano']);
// Replie une extension qui flotte tout en haut (EXT : la 13e empilée une octave au-dessus → span 2 octaves,
// injouable d'une main). Voir realizer.js compactFloatingTop. FOLD = voicings SERRÉS uniquement (les
// open/spread/funk/prog/trance/nuhouse/drop/piano/upper gardent leur déplacement d'octave voulu).
var _vl2_FLOAT_GAP=5;
// Le repli CRÉE-t-il une seconde ? On ne regarde que l'intervalle entre la note repliée et
// celles qui restent : les secondes DÉJÀ présentes dans l'accord (sus2, sus4, six, sixnine,
// sevensus4 — où la seconde EST le style) ne sont pas concernées et ne sont pas touchées.
// On ne refuse le repli que s'il colle à la BASSE. Mesuré le 2026-08-12 : une seconde créée
// contre la note la plus grave est de la boue (add9 -> C-D-E-G, la 9e collée à la fondamentale),
// alors qu'une seconde créée au MILIEU est une couleur (CM13 EXT -> G-A-B, repli légitime que le
// mode EXT existe pour rendre jouable d'une main). Refuser les deux ramenait CM13 à 32 demi-tons.
// Cohérent avec le basso separato : pas de seconde dans la basse, plus haut c'est de la couleur.
function _vl2_foldMakesSecond(rest,folded){
	return rest.length ? Math.abs(rest[0]-folded)<=2 : false;
}
function _vl2_compactFloatingTop(notes){
	var r=_vl2_vs(notes),g;
	for(g=0;g<8&&r.length>=2;g++){
		var n=r.length;
		if(r[n-1]-r[n-2]<=_vl2_FLOAT_GAP)break;
		var folded=r[n-1]-12;
		if(folded<=r[0]||r.indexOf(folded)!==-1)break;
		// ⚠️ GARDE-FOU MUSICAL (2026-08-12). Le repli existe pour la jouabilité à une main ;
		// il ne doit jamais créer un cluster. Sur add9 il n'y a pas de 7e pour combler l'écart :
		// la 9e flotte à 7 demi-tons au-dessus de la quinte (> FLOAT_GAP), était repliée, et
		// atterrissait collée à la fondamentale — C-D-E-G, seconde dans le GRAVE. Mesuré sur les
		// 4 styles de _vl2_FOLD ; open et piano avaient le même défaut vers le haut.
		// nine n'a jamais été touché parce que sa 7e comble l'écart (3 demi-tons < FLOAT_GAP).
		if(_vl2_foldMakesSecond(r.slice(0,n-1),folded))break;
		r=_vl2_vs(r.slice(0,n-1).concat([folded]));
	}
	return r;
}
var _vl2_FOLD=new Set(['classic']);   // `root` EXCLU : le mode neutre ne replie rien, c'est sa definition (sans voicing)
var _vl2_T={
	// Closed = POSITION SERREE, pas l'empilement par tierces. Mesure du 2026-09-14 : l'identite
	// (`return[c]`) rendait une position serree sur 62 % des cases en normal et 29 % en EXTENDED —
	// des la 9e, l'empilement laisse un trou (CM9 jouait C2 E2 G2 B2 D3, et re2 s'insere entre
	// do2 et mi2). Definition appliquee ici : depuis la basse, chaque note de l'accord est posee
	// AU PLUS BAS au-dessus de la precedente, donc aucune note de l'accord ne peut s'inserer
	// entre deux voix voisines. Verifie par device/tests/mesure-close-position.mjs.
	// La basse est conservee telle quelle : c'est elle qui porte le renversement, et _vl2_realize
	// fait tourner `c` pour les produire.
	classic:function(c){return[c];},   // la base vient de _vl2_closeFrom, deja en position serree
	open:function(c){return c.length<2?[c]:[_vl2_vs(c.map(function(n,i){return i===1?n+12:n;}))];},
	piano:function(c){
		if(c.length<3)return[c];
		var pm=function(n){return((n%12)+12)%12;},rootPc=pm(c[0]);
		return _vl2_rotOf(c.slice(1)).map(function(rh){
			var lo=Math.min.apply(null,rh),d=pm(rootPc-pm(lo-12));if(d>6)d-=12;
			return[lo-12+d].concat(rh);  // basse ~1 octave sous la MD
		});
	},
	drop2:function(c){var r=_vl2_vs(c);r[r.length-2]-=12;return[_vl2_vs(r)];},
	drop3:function(c){var r=_vl2_vs(c);r[r.length-3]-=12;return[_vl2_vs(r)];}
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
		var fifth=_vl2_rolePc(spec.pcs,'fifth');
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
	// quartal a besoin de la 7e + la gamme + une VRAIE 3ce (sus4/sus2 n'en ont pas — son fallback
	// interne renvoie alors l'accord AVEC la fondamentale, ce qui viole l'identité rootless de
	// quartal et vide silencieusement tous les candidats — Bug: A7sus4 muet, 2026-07-14).
	if(vc==='sus'&&!spec.scalePcs){fallback=vc;vc='classic';}   // sus a besoin de la gamme (le 2)
	// Repli DOCUMENTÉ de `Chord Melody` sur une triade : pas de « triade drop 3 » dans les sources,
	// et le drop 3 littéral à trois voix rend `Two Hands` à l'identique 20/21 — on échangerait un
	// doublon contre un autre. Il emprunte donc la triade ouverte de `Section` : le contrôle reste
	// audible (l'accord s'ouvre), ce que le repli sur classic ne faisait pas. tuple-dev#20.
	if(vc==='drop3'&&spec.pcs.length<4){fallback=vc;vc='drop2';}
	// drop2 descend à TROIS voix depuis le 2026-08-16 : c'est la triade ouverte. Le seuil était <4,
	// et il rendait `Section` inerte sur 21 cellules en normal / 14 en EXTENDED (identiques à
	// `Closed`, mesuré). En dessous de 3 il n'y a plus de « 2e voix depuis le haut » à descendre.
	if(vc==='drop2'&&spec.pcs.length<3){fallback=fallback||vc;vc='classic';}
	// Garde inerte aujourd'hui (tous les specs ont ≥3 pcs) mais évite la classe de bug A7sus4 : ces 6
	// voicings rootless-identity ont un early-return interne `c.length<3 -> [vsort(c)]` qui renvoie un
	// accord AVEC la fondamentale dès qu'il manque une note — _vl2_checkIdentity le rejetterait (identité
	// rootless violée) et viderait tous les candidats en silence, comme quartal avant son fix. Fallback
	// explicite au lieu de compter sur l'early-return interne, cohérent avec les gardes ci-dessus.
	// classic VL off : position fondamentale (root en basse, empilé au-dessus). VL ON : la boucle générale
	// génère les renversements et le VL invertit pour lisser — MAIS à froid (1er accord / hover) le sélecteur
	// VERROUILLE la canonique (= position fondamentale, cf. cold-lock classic dans _vl2_select). Défaut = root, VL peut inverser.
	// 'root' (chantier 1) emprunte EXACTEMENT ce chemin, mais SANS condition sur opts.rootPos :
	// c'est ce qui le rend indépendant du voice leading. Un seul candidat -> le sélecteur n'a
	// rien à choisir, donc ni Anchor ni Auto ne peuvent le renverser. Mesuré : avec classic,
	// Anchor déplaçait 88/91 accords hors position fondamentale, Auto 72/91 ; Root, 0/91.
	// C'est la différence entre « un état neutre qu'il faut composer » et « une position nommée ».
	if(vc==='root'||(vc==='classic'&&opts&&opts.rootPos)){
		var tonicPos=regBase+root;
		var cr=tonicPos+_vl2_m(spec.rootPc-root);
		var cn=_vl2_vs((vc==='root'?_vl2_stackFrom:_vl2_closeFrom)(spec,cr)).slice(0,6);
		if(_vl2_FOLD.has(vc))cn=_vl2_compactFloatingTop(cn);   // 13e flottante (EXT) repliée → jouable 1 main (comme le general loop)
		if(!_vl2_fitWindow(cn))return[];   // candidat unique (root/classic VL-off) → caler sous 108 plutôt que renvoyer [] muet (finding 1)
		if(_vl2_checkIdentity(vc,cn,spec).length)return[];
		return[{notes:cn,voicing:vc,fallback:fallback,canonical:true}];
	}
	var rotUp=function(arr){var r=_vl2_vs(arr);r.push(r.shift()+12);return _vl2_vs(r);};
	var seen=new Set(),out=[],canonTagged=false;
	// Ces quatre-là ne dépendent QUE de `vc`, invariant sur les trois boucles. Ils étaient
	// relus à chaque tour : mesuré sur un seul appel, 57 `_vl2_ABSOLUTE.has` et 20
	// `_vl2_FOLD.has` en classic, 89 et 60 en piano. Et ce ne sont pas des `Set` natifs dans
	// Max — c'est le polyfill maison, dont `has` concatène `(typeof v)+':'+v` à chaque appel.
	// `_vl2_T[vc]` était lu dans la boucle `k`, jusqu'à 30 fois pour la même valeur.
	// Hoists purement mécaniques : aucune des quatre valeurs ne peut changer en cours de route.
	// isAbs et isFold s'AUTO-ASSIGNAIENT (`isAbs=isAbs, isFold=isFold`). Le hoisting `var` les
	// rend `undefined` au moment de l'affectation : les deux valaient `undefined` a vie, et les
	// cinq sites de lecture plus bas prenaient tous la branche falsy. Le commentaire ci-dessus
	// decrit pourtant l'intention exacte — le hoist des deux `has` hors des trois boucles.
	//
	// MESURE de la reparation, 7200 cellules (5 tonalites x 6 styles x 4 types x 6 jeux de
	// tensions, normal ET EXTENDED, par `_vl2_specFor` donc specs ENRICHIS) :
	//     isAbs  : `_vl2_ABSOLUTE` est VIDE depuis le retrait des 24 styles -> rien ne change,
	//              jamais, pour aucun spec.
	//     isFold : 0 appel a `_vl2_compactFloatingTop` avant, 31 725 apres — et ZERO qui
	//              modifie les notes. `_vl2_FOLD` ne contient plus que `classic`, dont les
	//              voicings serres ne peuvent pas etre replies : le pire ecart au sommet est
	//              de 6 demi-tons (> FLOAT_GAP = 5), mais replier passerait SOUS la
	//              fondamentale et la garde `folded<=r[0]` sort au premier tour.
	//     cout   : -1,0 % sur 960 realize — dans le bruit, le repli sort immediatement.
	//
	// Donc la reparation est INERTE aujourd'hui. Ce qu'elle repare est l'avenir : `_vl2_FOLD`
	// etait a MOITIE cable. Remettre un style ouvert dedans faisait replier la branche
	// `rootPos` (l. ~2621, ecrite correctement) et PAS la boucle generale — deux chemins
	// divergents pour le meme style, VL off contre VL on.
	var isStack=_vl2_STACK_BASE.has(vc), isAbs=_vl2_ABSOLUTE.has(vc), isFold=_vl2_FOLD.has(vc);
	var isStruct=_vl2_STRUCT.has(vc), TF=_vl2_T[vc]||_vl2_T.classic;
	for(var oct=-2;oct<=2;oct++){
		var base=48+oct*12,rootMidi=base+_vl2_m(spec.rootPc-_vl2_m(base));
		var inv=(isStack?_vl2_stackFrom:_vl2_closeFrom)(spec,rootMidi);
		var nInv=isAbs?1:spec.pcs.length;
		for(var k=0;k<nInv;k++){
			var shapes=TF(inv,octShift,spec);
			for(var si=0;si<shapes.length;si++){
				var notes=(want!=null&&!isStruct)?_vl2_stabilize(shapes[si],spec,want):_vl2_vs(shapes[si]).slice(0,6);
				if(isFold)notes=_vl2_compactFloatingTop(notes);   // replie l'extension flottante (EXT, voicings serrés) → jouable 1 main
				// (pas de repli de basse ici — supprimé le 2026-08-13, ticket #16 ; cf. tombstone près de _vl2_FOLD)
				if(isAbs){if(!_vl2_fitWindow(notes))continue;}   // ABSOLUTE = candidat unique (nInv=1) → caler sous 108 plutôt que jeter et retomber legacy muet (finding 1)
				else if(Math.min.apply(null,notes)<24||Math.max.apply(null,notes)>108)continue;
				if(_vl2_checkIdentity(vc,notes,spec).length)continue;
				if(!isAbs&&_vl2_lowIntervalViolations(notes,octShift).length)continue;
				var key=notes.join(',');if(seen.has(key))continue;seen.add(key);
				// forme maison : ABSOLUTE (registre fixe, shape indépendante de l'octave de boucle) → le 1er candidat émis EST la canonique ; sinon 1re inversion à base===regBase.
				var canon=isAbs?!canonTagged:(base===regBase&&k===0&&!canonTagged);if(canon)canonTagged=true;
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
// prevSorted=true : `prev` est déjà trié (appelant l'a mis en cache — voir _vl2_select) -> saute le tri
// interne. Défaut false (comportement inchangé) car aussi appelé depuis _sg_fluid avec un `ref` non garanti
// trié (lastChordNotes/activeNotes) — audit perf 2026-07-15 : évite de retrier l'invariant st.voices à
// chaque candidat de la boucle chaude de sélection VL.
function _vl2_movCost(prev,cand,w,prevSorted){
	if(!w)w=_vl2_W;
	var a=prevSorted?prev:_vl2_vs(prev),b=_vl2_vs(cand),n=Math.min(a.length,b.length);
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
function _vl2_harmBonus(prev,cand,opts,w,prevSorted){
	var ps=opts.prevSpec,sp=opts.spec;if(!ps||!sp||!prev||!prev.length)return 0;
	if(!w)w=_vl2_W;
	var a=prevSorted?prev:_vl2_vs(prev),b=_vl2_vs(cand),n=Math.min(a.length,b.length),bonus=0,chrom=0;
	var apcs={},bpcs={},_pc;
	for(_pc=0;_pc<a.length;_pc++) apcs[_vl2_m(a[_pc])]=true;
	for(_pc=0;_pc<b.length;_pc++) bpcs[_vl2_m(b[_pc])]=true;
	if(ps.isDominant){
		var tri3=_vl2_rolePc(ps.pcs,'third'),tri7=_vl2_rolePc(ps.pcs,'seventh');
		if(tri3&&apcs[tri3.pc]&&bpcs[_vl2_m(tri3.pc+1)])bonus+=w.tendency;
		if(tri7&&apcs[tri7.pc]&&bpcs[_vl2_m(tri7.pc-1)])bonus+=w.tendency;
		if(_vl2_m(ps.rootPc-sp.rootPc)===7){
			var thi=_vl2_rolePc(sp.pcs,'third');
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
	// st.voices est invariant sur toute la boucle candidats -> trié UNE fois ici plutôt que 2x par
	// candidat dans movCost+harmBonus (audit perf 2026-07-15). c.notes (varie par candidat) reste
	// trié à l'intérieur de chaque fonction, inchangé.
	var stSorted=first?null:_vl2_vs(st.voices);
	for(var ci=0;ci<cands.length;ci++){
		var c=cands[ci],cost;
		// ABSOLUTE (registre fixe) : à froid on VERROUILLE la forme canonique signature (sinon la proximité-centre choisirait une rotation/octave secondaire et casserait l'identité). Les candidats ne servent qu'au VL chaud.
		// À FROID, la forme MAISON du style gagne toujours. Le verrou canonique ne valait avant
		// que pour les ABSOLUTE et pour classic ; partout ailleurs la canonique n'avait qu'une
		// avance de 3 points, que la distance au centre écrasait — open/spread/drop2/drop3/
		// rootless* partaient donc se recentrer sur 60 au lieu de jouer leur forme. Un « drop 2 »
		// qui ne sonne pas comme un drop 2 n'est pas un drop 2 : choisir un style DOIT donner sa
		// forme, et c'est au voice leading — et à lui seul — de bouger les notes ensuite.
		// Mesuré : 118 cas sur 672 changent, tous dans open/spread/drop2/drop3/rootless*.
		// classic et les ABSOLUTE sont inchangés (ils verrouillaient déjà).
		if(first){cost=(c.canonical?-1000:3)+Math.abs(mean(c.notes)-center);}   // le VL chaud peut ensuite inverser
		else{
			cost=_vl2_movCost(stSorted,c.notes,w,true)+_vl2_harmBonus(stSorted,c.notes,opts,w,true);
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
	// best reste null si AUCUN candidat n'a marqué un coût fini (tout NaN/Infinity — arrive dès
	// qu'une config pousse les notes hors 0..127 : la moyenne d'un tableau vide vaut NaN, et
	// NaN<Infinity est faux). Sans ce garde-fou on déréférence null : l'exception remonte
	// jusqu'à midinote() et AVORTE la note, touche après touche — le clavier a l'air mort.
	// On retombe sur le 1er candidat (miroir de site/vl2/selector.js) ; s'il est vide,
	// sendChord voit un v2 vide et applique son filet de secours applyVoicing().
	if(!best)best=cands[0];
	// Un candidat SANS notes ne doit RIEN commiter : st.voices=[] n'est pas `null`, donc le
	// prochain appel ne repart pas "à froid" et recalcule des coûts NaN — l'état dégradé
	// s'auto-entretient même une fois la config revenue à la normale. Pire, en mode anchor
	// st.recall rendrait cet accord vide À VIE (relecture en tête de fonction). On repart
	// froid et on laisse sendChord appliquer son filet de secours applyVoicing().
	if(!best||!best.notes||!best.notes.length){ st.voices=null; return []; }
	st.voices=best.notes.slice();
	if(st.recall.size>64)st.recall.delete(st.recall.keys().next().value);
	st.recall.set(key,best.notes.slice());
	return best.notes;
}

// --- façade vl2 ---
// Clone superficiel du recall (les notes mémorisées sont des slices que _vl2_select ne
// mute pas — l'alias de valeur est sûr). Surface polyfill Map suffisante : keys()/next
// + get + set, rien d'autre (voir l'en-tête du fichier).
function _vl2_recallClone(m){
	var out=new Map(),it=m.keys(),n=it.next();
	while(!n.done){out.set(n.value,m.get(n.value));n=it.next();}
	return out;
}
// UN SEUL CORPS pour le jeu ET l'aperçu (fusion 2026-08-20). L'aperçu (hover / audition
// d'option) doit montrer EXACTEMENT ce que le clic jouerait — « l'affichage hover == le
// jeu » — et deux corps parallèles ne tiennent pas ce contrat : ils dérivent en silence
// (audit 2026-08-20, avant le clone du recall : Anchor chaud divergeait sur 7/10 voicings,
// Flow chaud sur 3/10). Un seul chemin ici, et un drapeau `opts.preview` qui ne change QUE
// l'isolation de l'état VL — le calcul (spec, realize, centre, clé, mode) est partagé.
// Mapping mode v1 → v2 : "anchored"→"anchor" · "relative"→"flow" · "piano"→ voicing piano + flow
//
// Les quatre chemins (jeu/aperçu × chaud/froid) restent identiques à ce qu'ils étaient
// avant la fusion — équivalences vérifiées ligne à ligne le 2026-08-20 :
//   • prevSpec : l'ancien play passait _vl2_prevSpec INCONDITIONNELLEMENT, mais à froid il
//     sortait de _vl2_reset() qui le met à null — donc (warm?_vl2_prevSpec:null) rend la
//     même valeur sur les quatre chemins.
//   • mode à froid unifié sur 'anchor' (l'aperçu disait 'flow') : mort dans les deux cas.
//     Le rejeu anchor en tête de _vl2_select exige un recall NON VIDE (jeu froid : le reset
//     l'a vidé ; aperçu froid : Map neuve), et la branche `first` (st.voices===null des deux
//     côtés à froid) ne lit pas `mode`. Épinglé par les tests « à froid » de
//     device/tests/preview-parite-jeu.test.mjs.
//   • rejeu anchor à chaud en aperçu : son écriture st.voices=nn.slice() atterrit sur
//     l'objet LOCAL et part au finally — le comportement du fix session 64 est conservé.
//   • le jeu réel commet _vl2_prevSpec=spec inconditionnellement, comme avant (y compris à
//     froid, où c'est invisible : tout chemin suivant re-reset).
//   • rootPos:!warm === l'ancien !voiceLeadingEnabled, écrit à l'identique des deux côtés.
// RÉALISER, PUIS PRÉPARER LA SÉLECTION — un seul corps pour les deux appelants.
//
// `_vl2_play` (le jeu et l'aperçu) et `_revoiceEntryWith` (une carte de progression)
// faisaient ces quatre pas chacun de leur côté, à cent lignes d'écart : le plancher
// d'octave, la réalisation, le centre de sélection, et la CLÉ DE RECALL.
//
// ⚠️ C'EST LA CLÉ QUI COMPTE. `_vl2_select` mémorise ses choix sous `specKey|voicing|centre` ;
// une clé bâtie autrement d'un côté ne fait pas planter le recall, elle le fait MANQUER —
// le même accord ressort ailleurs selon le chemin qui l'a demandé, sans une erreur. Le
// dépôt a déjà payé cette classe de défaut : hover ≠ clic sur 7 voicings sur 10 en Anchor,
// du 2026-06-23 au 2026-08-20, parce que l'aperçu partait d'un recall VIDE.
//
// Rend `null` quand la réalisation ne produit aucun candidat — les deux appelants
// traitaient déjà ce cas en rendant `null` à leur tour.
function _vl2_prepare(spec, vc, rootPos) {
	var regBase = _vl2_regBase();
	var cands = _vl2_realize(spec, vc, { regBase: regBase, rootPos: rootPos });
	if (!cands.length) return null;
	// SOURCE UNIQUE du centre (poche pour ABSOLUTE) — le même que `_sg_fluid`, sans quoi la
	// heat-map VL peindrait un classement que le playback ne joue pas.
	var selCtr = _vl2_selCtr(cands);
	return {
		cands: cands,
		selCtr: selCtr,
		key: _vl2_specKey(spec) + '|' + vc + '|' + selCtr
	};
}
function _vl2_play(fn,d,colorSemis,colorType,opts){
	opts=opts||{};
	var preview=!!opts.preview;
	var spec=_vl2_specFor(fn,d,colorSemis,colorType);   // pipeline de spec unique (build + EXT)
	if(!spec)return null;
	// opts.voicing (aperçu seulement) : réalise sur un style TEMPORAIRE sans toucher le
	// voicing global — remplace l'échange sauvegarde/restauration de _realizeOption.
	// Sûr : les seuls consommateurs de vc dans ce chemin sont _vl2_realize et la clé du
	// recall ; _vl2_specFor ne lit pas currentVoicing (vérifié le 2026-08-20).
	var vc=(preview&&opts.voicing)?String(opts.voicing):currentVoicing;
	var warm=voiceLeadingEnabled;
	var mode='anchor';
	if(warm)mode=(vlMode==='anchored')?'anchor':'flow';
	else if(!preview)_vl2_reset();   // VL OFF, jeu réel : pas de mémoire de mouvement -> chaque accord au plus proche du centre. L'aperçu, lui, n'efface RIEN (isolation).
	// regBase : plancher de l'octave (multiple de 12, invariant).
	// selCtr  : tonique pour classic (ancrage harmonique), C-ancré pour les autres voicings.
	var prep=_vl2_prepare(spec,vc,!warm);
	if(!prep)return null;
	var cands=prep.cands;
	var selOpts={mode:mode,center:prep.selCtr,key:prep.key,voicing:vc,spec:spec,prevSpec:(warm?_vl2_prevSpec:null)};
	if(preview){
		var savedSt=_vl2_st;                                               // snapshot l'état VL
		// Recall CLONÉ, pas vidé : le jeu LIT ses entrées mémorisées (hit anchor, bonus flow
		// de _vl2_select) — l'aperçu doit les lire aussi, sinon hover ≠ clic (audit
		// 2026-08-20 : divergent 7/10 voicings en Anchor chaud, 3/10 en Flow). Les ÉCRITURES
		// restent jetables : l'aperçu ne fige toujours pas l'anchor du jeu. Même idiome
		// d'isolation que _revoiceEntry : objet local, restore de la RÉFÉRENCE en finally.
		_vl2_st=warm?{voices:savedSt.voices,recall:_vl2_recallClone(savedSt.recall)}
		            :{voices:null,recall:new Map()};                       // VL off : froid, comme le _vl2_reset du jeu ci-dessus
		try{return _vl2_select(cands,selOpts);}
		finally{_vl2_st=savedSt;}                                          // restore MÊME si _vl2_select lève (même règle que _revoiceEntry)
	}
	var notes=_vl2_select(cands,selOpts);
	_vl2_prevSpec=spec;
	return notes;
}
// Aperçu (hover) : le MÊME corps, en isolation — pas de second chemin à tenir en phase.
function _vl2_previewNotes(fn,d,colorSemis,colorType){return _vl2_play(fn,d,colorSemis,colorType,{preview:true});}
// Re-réalise les notes d'UNE entrée de progression selon son (fn,deg,colorSemis,
// colorType,voicing,vlMode), en isolation TOTALE de l'état VL live (_vl2_st /
// _vl2_prevSpec) — sinon re-voicer une carte de progression casserait le
// prochain accord joué sur la grille (cross-review 2026-07-20).
// prevEntry = l'entrée PRÉCÉDENTE de la progression (ou null si idx===0 / hors
// contexte) — sert de "prevSpec" local pour le lissage vlMode==="follow".
// Ne modifie PAS l'entrée passée ; retourne le tableau de notes ou null.
// =====================================================
// VALIDATION D'UN NOM DE STYLE — la frontière que tout style franchit.
// Le choix automatique de style (V-auto : scoring, catégories, sentinel "auto") a été
// SUPPRIMÉ le 2026-08-11. Ne rien remettre ici qui choisisse à la place de l'utilisateur :
// mesuré avant le retrait, « auto » libre ne rendait que 4 styles sur 28, et chaque clé de
// catégorie rendait un seul et même membre sur 42/42 cases — 13 des 16 styles proposés
// étaient donc inatteignables. Un style vient maintenant TOUJOURS d'un geste explicite.
// =====================================================
// Un nom de style est-il RÉEL ? _vl2_realize fait `_vl2_T[vc] || _vl2_T.classic` : un nom
// inconnu retombe SILENCIEUSEMENT sur classic tout en s'affichant tel quel sur la carte.
// Toute valeur venant de l'UI (message progvoicing) passe donc d'abord par ici.
// Objet nu et non Set : le polyfill de tête de fichier n'a que add/has/size, et l'ES5 de
// Max n'a pas de Set natif.
var _VOICING_SET = (function () {
	var s = {}, i;
	for (i = 0; i < VOICING_NAMES.length; i++) s[VOICING_NAMES[i]] = true;
	return s;
})();
// hasOwnProperty, PAS `_VOICING_SET[v]` : un objet nu hérite de Object.prototype, donc
// "constructor", "toString", "__proto__", "valueOf"… passaient tous pour des noms de
// voicing valides. Une validation qui dit oui à "constructor" ne valide rien.
function _isVoicingName(v) { return !!v && Object.prototype.hasOwnProperty.call(_VOICING_SET, v); }

// Renversement d'un voicing DÉJÀ réalisé : monte les `inv` notes les plus graves d'une
// octave puis re-trie. Vraie inversion type accord slash (seule la basse change), pas un
// re-voicing — le caractère du voicing capturé est préservé.
// PUR (ne mute pas `base`). inv=0 = no-op STRICT, ordre préservé : sans ça, toutes les
// entrées de progression non inversées verraient leur ordre de notes changer, donc
// l'affectation des voix dans _emitNotes.
// MIROIR EXACT de site/vl2/invert.js — la parité est tenue par
// device/tests/progression-inversion.test.mjs, qui confronte les deux sur la même matrice.
var _INV_LO = 24, _INV_HI = 108;   // fenêtre du réalisateur
function _invertVoicing(base, inv) {
	if (!base || !base.length) return [];
	var n = base.length, i;
	inv = parseInt(inv); if (isNaN(inv)) inv = 0;
	inv = ((inv % n) + n) % n;
	if (!inv) return base.slice();
	var out = base.slice().sort(function (a, b) { return a - b; });
	for (i = 0; i < inv; i++) out[i] += 12;
	out.sort(function (a, b) { return a - b; });
	// Repli tant que le sommet dépasse le plafond ET qu'on peut descendre sans passer sous
	// le plancher. Le repli peut être REFUSÉ (accord plus large que la fenêtre) : on rend
	// alors le renversement là où la montée l'a laissé — le geste doit avoir un effet.
	while (out[n - 1] > _INV_HI && out[0] - 12 >= _INV_LO) for (i = 0; i < n; i++) out[i] -= 12;
	// Filet MIDI dur. INATTEIGNABLE avec une base valide (voir le commentaire du miroir) ;
	// gardé pour borner la fonction, pas parce qu'un cas connu l'atteint.
	if (out[0] < 0 || out[n - 1] > 127) return base.slice();
	return out;
}

// Le style est lu sur la carte elle-même : `entry.voicing` porte TOUJOURS un nom concret
// depuis le retrait du choix automatique. Le paramètre `styleOverride` de la tranche V a
// disparu avec lui — il n'existait que pour injecter le style résolu par le scoring.
// La garde reste : _vl2_realize fait `_vl2_T[vc] || _vl2_T.classic`, donc un nom de style
// inconnu retombe SILENCIEUSEMENT sur la transformée classic et rendrait un accord
// plausible mais FAUX, sans une seule erreur (design.md §9). On refuse bruyamment.
// tuple-dev#68 : on réalise d'abord AVEC les tensions dans le spec. Si le style n'y arrive pas
// (aucun candidat, ou verrou d'identité qui rejette — il ne sait que rejeter), on réalise le
// spec nu et la tension est marquée « muted ». Une carte ne devient jamais muette parce
// qu'on lui a demandé une couleur.
function _revoiceEntry(entry, prevEntry) {
	if (!entry) return null;
	// 2026-09-11 (Antoine : « l'écriture des tensions semble changer la structure de l'accord ») : la BASE se réalise
	// sans ses tensions — mêmes notes, même renversement qu'avant la pose — puis les tensions s'EMPILENT au-dessus du
	// sommet (structure supérieure). Avant, le spec enrichi repassait par _vl2_realize : C + 9 sortait renversé,
	// G + 13 mettait la 13 à la basse, Dm + 11 faisait un cluster.
	var base = _revoiceEntryWith(entry, prevEntry);
	// OCTAVE PAR CARTE (2026-09-18) : le décalage s'applique sur la BASE, avant l'empilement
	// des tensions (elles suivent le sommet décalé) et avant l'écriture de notesBase (la
	// carte suivante suit la position réellement entendue). Toute re-réalisation repasse
	// ici : l'octave survit au rekey, au changement de style, au re-voice all.
	if (base && entry.oct) {
		var _ok, _od = (parseInt(entry.oct) || 0) * 12;
		for (_ok = 0; _ok < base.length; _ok++) base[_ok] += _od;
	}
	entry.notesBase = base;   // la base seule : c'est elle qui conduit les voix de la carte suivante, pas la structure supérieure
	return _tensStack(base, entry);
}
// Empile les tensions d'une carte au-dessus de ses notes : chacune à la position la plus proche STRICTEMENT au-dessus
// du sommet courant, dans l'ordre des couleurs (♭9 … 13). Une tension déjà dans l'accord (construite) ne s'ajoute pas ;
// une couleur que la gamme ne donne pas est dite muette. Ne touche jamais aux notes de la base.
function _tensStack(notes, entry) {
	entry.tensMuted = [];
	if (!notes || !notes.length || !entry.tensions || !entry.tensions.length) return notes;
	var m = function(n){ return ((n % 12) + 12) % 12; }, out = notes.slice(), i, j, base = _tensBaseSpec(entry);
	if (!base) return out;
	_tensNormalize(entry, base);
	var names = entry.tensions.slice().sort(function(a, b){ return _TENS_BY_NAME[a] - _TENS_BY_NAME[b]; });
	for (i = 0; i < names.length; i++) {
		var c = _tensCandidate(base, names[i]);
		if (!c) { entry.tensMuted.push(names[i]); continue; }
		var present = false; for (j = 0; j < out.length; j++) if (m(out[j]) === c.pc) present = true;
		if (present) continue;
		var top = Math.max.apply(null, out), d = (c.pc - m(top) + 12) % 12; if (d === 0) d = 12;
		out.push(top + d);
	}
	return out;
}
function _revoiceEntryWith(entry, prevEntry) {
	var spec = _vl2_specFor(entry.fn, entry.deg, entry.colorSemis, entry.colorType);
	if (spec && extendedOn && avoidNotesOn) spec = _tensStripAvoided(spec, entry);   // sur une CARTE, EXTENDED ne complète qu'avec l'offre (tuple-dev#68)
	if (!spec) return null;
	var vc = entry.voicing || currentVoicing;
	// On refuse TOUT ce qui n'est pas un nom de voicing réel. Valider par appartenance à
	// VOICING_NAMES ferme la classe entière plutôt qu'un cas à la fois : c'est ce qui a
	// rattrapé les jetons de catégorie quand la tranche V avait élargi le domaine de
	// entry.voicing sans toucher à la garde.
	if (!_isVoicingName(vc)) {
		post("tuple: _revoiceEntry a recu '" + vc + "' qui n'est pas un style\n");
		return null;
	}
	// ⚠️ DEUX CHOSES S'APPELLENT vlMode. La GLOBALE vaut "anchored"|"flow" (le contrôle
	// VOICE LEADING) ; CE champ-ci est l'axe INVERSION/REGISTRE d'une carte et vaut
	// "follow"|"pinned" depuis le 2026-08-11 (il disait "auto"|"lock"). Ne pas les confondre :
	// une comparaison avec "flow" ou "anchored" ici ne serait jamais vraie, en silence.
	var rootPos = (entry.vlMode !== "follow");   // pinned (ou tout mode futur ≠ follow) : position canonique, pas de lissage
	var prep = _vl2_prepare(spec, vc, rootPos);
	if (!prep) return null;
	var cands = prep.cands;
	var prevSpec = null;
	if (entry.vlMode === "follow" && prevEntry) {
		prevSpec = _vl2_specFor(prevEntry.fn, prevEntry.deg, prevEntry.colorSemis, prevEntry.colorType);
	}
	var mode = (entry.vlMode === "follow" && prevSpec) ? "flow" : "anchor";
	// État VL LOCAL — jamais _vl2_st global. Seedé avec les notes de l'entrée
	// précédente quand follow+prevEntry existent, sinon null (anchor, pas de lissage) :
	// sans ce seed, select() voit toujours st.voices===null (first=true) et le
	// lissage/harmonicBonus/flow (selector.js branche "else") ne s'exécute JAMAIS —
	// bug trouvé par le bench Tâche 4 (_f0_revoice_bench.mjs), confirmé sur
	// site/vl2/selector.js:120-158.
	// La carte précédente conduit par sa BASE (`notesBase`, sans ses tensions empilées) : poser une 9 sur une carte ne
	// doit pas reformer la suivante (2026-09-11). `notes` reste le repli des cartes d'avant cette règle.
	var prevNotes = prevEntry && ((prevEntry.notesBase && prevEntry.notesBase.length) ? prevEntry.notesBase : prevEntry.notes);
	var seedVoices = (entry.vlMode === "follow" && prevNotes && prevNotes.length) ? prevNotes.slice() : null;
	var localSt = { voices: seedVoices, recall: new Map() };
	var savedSt = _vl2_st, savedPrev = _vl2_prevSpec;   // filet supplémentaire : si _vl2_select touchait _vl2_st par accident
	_vl2_st = localSt;
	var notes;
	try {
		notes = _vl2_select(cands, { mode: mode, center: prep.selCtr, key: prep.key, voicing: vc, spec: spec, prevSpec: prevSpec });
	} finally {
		_vl2_st = savedSt; _vl2_prevSpec = savedPrev;   // restore inconditionnel (même si _vl2_select lève)
	}
	// Tranche I : le renversement s'applique EN SORTIE, sur le voicing déjà réalisé — c'est
	// le point UNIQUE d'application. La cascade (_recascadeFrom), la tranche V (style
	// per-accord) et la tranche M (clip live-sync) en héritent sans une ligne de plus, et
	// l'ordre est le bon : on renverse la forme du style RÉSOLU, pas celle d'un style par
	// défaut. inv=0 = no-op strict, donc aucune entrée non inversée ne bouge.
	// Les tensions ne passent plus par ici (2026-09-11) : _revoiceEntry réalise la base puis les empile (_tensStack).
	return (notes && notes.length && entry.inv) ? _invertVoicing(notes, entry.inv) : notes;
}

// Re-réalise progression[idx] PUIS propage aux entrées SUIVANTES tant qu'elles
// sont en vlMode "follow" (elles dépendent du prevSpec de la précédente, qui vient
// de changer). S'arrête à la première entrée "pinned" (figée, on ne la touche pas)
// ou à la fin de la progression. Mute progression[] EN PLACE. Ne broadcast pas.
function _recascadeFrom(idx) {
	if (idx < 0 || idx >= progression.length) return;
	// Plus aucune résolution de style ici : la carte porte son nom concret depuis la
	// capture, il n'y a donc plus rien à choisir ni à mémoïser (le memo de formes servait
	// au scoring, qui réalisait 16 styles par carte).
	var i, prev, notes, style;
	for (i = idx; i < progression.length; i++) {
		// Garde AVANT toute mutation : la carte épinglée frontière arrête la cascade
		// SANS être re-réalisée. Elle était en fin de boucle jusqu'au 2026-08-20 : la
		// frontière était re-voicée PUIS le break tombait — si le registre global avait
		// changé entre l'épinglage et la cascade (octave), elle sautait d'une octave
		// pendant que l'épinglée suivante restait en place.
		if (i > idx && progression[i].vlMode !== "follow") break;
		prev = (i > 0) ? progression[i - 1] : null;
		style = progression[i].voicing;
		notes = _revoiceEntry(progression[i], prev);
		// voicingResolved n'est écrit QU'EN CAS DE SUCCÈS : l'écrire d'avance laissait,
		// quand _revoiceEntry rend null (spec introuvable), une carte annonçant un style
		// que ses notes — restées les anciennes — ne jouent pas. Un champ dérivé qui ment
		// sur ce qu'on entend est pire que pas de champ du tout.
		if (notes) progression[i].voicingResolved = style;
		if (notes) progression[i].notes = notes;
	}
	_clipSyncDirty();   // live-sync : un re-voicing change les NOTES sans changer la structure — et ne
	                    // passe pas par broadcastProg. Sans ce hook, le clip garderait l'ancien voicing.
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

// FILTRE DE VÉLOCITÉ (tuple-dev#38, arbitré le 2026-09-15 : CLAMP, pas rescale).
// Ce qui dépasse la plage revient au bord ; le MILIEU sort exact. Le rescale, qui remapperait
// 0..127 dans la plage, a été écarté : aucune frappe ne sortirait à sa valeur, et il faudrait
// frapper 127 pour atteindre le max — au Push, c'est tout le jeu qui se tasse.
//
// ⚠️ DERNIER DE LA CHAÎNE, et ce n'est pas un goût. Humanize disperse de ±55 à 100 % et la
// rampe de strum module de ±50 % : placé avant eux, le filtre serait re-dépassé et ne bornerait
// plus rien. Il s'applique donc APRÈS `humanizeVel`, au jeu comme à l'écriture de clip.
//
// ⚠️ ZÉRO N'EST PAS UNE VÉLOCITÉ, C'EST UN NOTE-OFF. Le remonter à `velMin` laisserait toutes
// les notes coincées — le mode de panne le plus cher du device. `_velPlage` le laisse passer,
// et un test l'épingle.
//
// Défaut 1..127 : inactif. Tout autre défaut changerait le son des sets déjà sauvegardés.
var velMin = 1, velMax = 127;
function _velPlage(v) {
	if (!(v > 0)) return 0;                       // note-off : intouchable
	if (v < velMin) return velMin;
	if (v > velMax) return velMax;
	return v;
}
// UNE SEULE PORTE DE SORTIE pour la vélocité. `_emitNotes` a DEUX chemins — un rapide quand ni
// strum ni humanize n'est armé, un autre à Tasks — et poser le filtre sur le second seulement
// l'a rendu invisible dans le cas le plus courant : tout à zéro, la plage ne bornait rien.
// Attrapé par le test du 2026-09-15, pas par la relecture. Passer par ici empêche un troisième
// chemin d'oublier le filtre, et le note-off traverse intact (`_velPlage(0) === 0`).
function _emitVel(v) { outlet(0, _velPlage(v)); }
// Les deux bornes se poussent l'une l'autre plutôt que de se croiser : croiser rendrait la
// plage vide, donc le device muet, sans rien dire. Une valeur HORS 1..127 est un appelant
// fautif : refus bruyant, comme les autres réglages d'expression.
function velmin(v) {
	var n = parseInt(v);
	if (!(n >= 1) || !(n <= 127)) { post("velmin: valeur invalide '" + v + "'" + String.fromCharCode(10)); return; }
	velMin = n; if (velMax < velMin) velMax = velMin;
	outlet(7, "velmin", velMin); outlet(7, "velmax", velMax);
	_cc(CC_VEL_MIN, velMin / 127 * 127);
	_clipSyncDirty();
}
function velmax(v) {
	var n = parseInt(v);
	if (!(n >= 1) || !(n <= 127)) { post("velmax: valeur invalide '" + v + "'" + String.fromCharCode(10)); return; }
	velMax = n; if (velMin > velMax) velMin = velMax;
	outlet(7, "velmin", velMin); outlet(7, "velmax", velMax);
	_cc(CC_VEL_MAX, velMax / 127 * 127);
	_clipSyncDirty();
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
		_emitVel(currentVelocity);
		for (var i = 0; i < n && i < 6; i++) outlet(i + 1, notes[i]);
		return;
	}
	var rank = _strumRank(notes);

	var up = _strumMs >= 0;                      // sens : >0 grave→aigu, <0 aigu→grave
	var T = strum ? (n - 1) * mag : 0;           // durée nominale du strum
	var p = STRUM_CURVE_P[strumCurve] || 1.0;
	for (var k = 0; k < n && k < 6; k++) {
		(function(idx, note) {
			// seq = position dans la SÉQUENCE de jeu (0 = 1ère note jouée), selon le sens.
			var seq = strum ? _strumSeq(rank, idx, n, up) : 0;
			var base = strum ? T * _strumFrac(seq, n, p) : 0;
			var off = base + humanizeTime();
			if (off < 0) off = 0;
			// Rampe de vélocité le long de la séquence : pos 0..1, facteur 1±0.5·ramp.
			var v = currentVelocity;
			if (strum && strumRamp) v = currentVelocity * _strumRampFactor(seq, n, strumRamp);
			var nv = humanizeVel(Math.round(v));   // le filtre s'applique dans `_emitVel`, DERNIER (#38)
			if (off < 0.5) { _emitVel(nv); outlet(idx + 1, note); return; }
			var t = new Task(function() { _emitVel(nv); outlet(idx + 1, note); });
			_emitTasks.push(t);
			t.schedule(off);
		})(k, notes[k]);
	}
}

function sendNoteOff() {
	_cancelEmit();
	if (activeNotes.length === 0) return;
	_emitVel(0);   // velocity=0 arrive en PREMIER dans tous les noteout ; _velPlage la laisse à 0
	for (var i = 0; i < activeNotes.length && i < 6; i++) {
		outlet(i + 1, activeNotes[i]);  // pitches, déclenchent noteout avec vel=0
	}
	activeNotes = [];
	outlet(7, "clearnotes");  // efface le clavier moniteur
}

// Libère toute note tenue AVANT de muter une config qui change l'identité de la note (root/
// scale/octave/voicing/VL/extended/sync) — sinon une note jouée sous l'ancienne config reste
// sonner alors que sa config a changé sous elle. sendNoteOff() seul ne suffit pas : il faut
// aussi armer activeMidiNote=-1, sinon le dédoublonnage de midinote() (pitch===activeMidiNote)
// avale silencieusement le prochain appui de la même touche ("touche morte", trouvé à l'audit
// du 2026-07-15 — état caché sur 2 globals qui doivent rester réinitialisés ensemble).
function _releaseHeld() {
	sendNoteOff();
	activeMidiNote = -1;
}

function sendChord(name, notes) {
	// Voicing TOUJOURS via vl2 (15 voicings) ; le bouton VL ne pilote que le lissage dynamique.
	// ⚠️ La VÉRITÉ = lastFn/lastDegree (posés par chaque fonction d'accord) ; l'argument `notes`
	// n'est qu'un FILET DE SECOURS (applyVoicing) si vl2 ne sort aucun candidat.
	var v2 = _vl2_play(lastFn, lastDegree, lastColorSemis, lastColorType);
	notes = (v2 && v2.length) ? v2 : applyVoicing(notes);
	sendNoteOff();
	activeNotes = notes.slice();
	lastChordNotes = notes.slice();            // survit au note-off → utilisé par le glisser → ajout
	_emitNotes(notes);
	if (captureMode) captureChord(name);       // progression -> clip (capture si ON)
	outlet(7, "active", lastFn, lastDegree);   // highlight grille
	if (smartOn) { _sg_remember(); _taskDefer(_sg_broadcast); }   // smart chords : _sg_remember (léger) reste inline,
	// _sg_broadcast (recalcule _vl2_realize sur ~50 cellules) est différé hors du chemin d'émission de l'accord —
	// sinon il ajoute du jitter sur le thread bas-priorité de Max juste après avoir joué la note (audit 2026-07-15).
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
var PROG_MAX     = 8;          // largeur de la rangée Push (8 pads) — plus un plafond de cartes depuis le
                               // 2026-09-18 (#77) : le compte était l'héritage des cartes bornées à 1 mesure ;
                               // la PLACE décide seule (quart minimum, jusqu'à 32 cartes par page)

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
		baseName: String(name),   // le nom SANS tension — _tensName le rhabille (tuple-dev#68), jamais l'inverse
		roman: currentRoman(),
		deg: (lastFn === "color" ? -1 : lastDegree),   // -1 = emprunt (violet) ; 0..6 = degré
		fn: lastFn,                                     // re-dérivation (substituts/voicings/suite Push)
		colorSemis: lastColorSemis, colorType: lastColorType,
		notes: notesArr.slice(),
		notesBase: notesArr.slice(),   // la base (sans structure supérieure) : ce que les tensions empilent, ce qui conduit la suivante (2026-09-11)
		// La carte naît sur le style CONCRET en vigueur au moment de la capture — celui
		// qu'on vient d'entendre sur la grille. Le picker de carte le remplace ensuite par
		// un autre VOICING_NAME, et c'est le seul domaine possible de ce champ : plus aucun
		// sentinel depuis le retrait du choix automatique.
		voicing: currentVoicing,
		// Champ DÉRIVÉ : le style avec lequel les notes stockées ont RÉELLEMENT été
		// réalisées — ici le voicing global du jeu live, puisque `notes` est exactement ce
		// qui vient de sonner sur la grille. Même contrat que dans _recascadeFrom (écrit
		// seulement quand la réalisation a réussi) : un champ dérivé qui ment sur ce qu'on
		// entend est pire que pas de champ du tout. C'est ce que l'UI affiche sur la carte.
		voicingResolved: currentVoicing,
		// Axe INVERSION/REGISTRE de la carte — à ne pas confondre avec la globale vlMode
		// ("anchored"|"flow"), qui porte le même nom et pilote le contrôle VOICE LEADING.
		vlMode: "follow",          // "follow" = le VL a le droit de bouger cette carte ; "pinned" = figée où l'utilisateur l'a mise (tranche I)
		inv: 0                     // offset d'inversion, pertinent seulement si vlMode==="pinned" (tranche I)
	};
}

// Appelé depuis sendChord() quand captureMode est ON : empile l'accord joué (clic, clavier MIDI
// ou pad Push). 1 déclenchement = 1 carte.
function captureChord(name) {
	var entry = _progEntry(name, activeNotes);
	if (_progCommit) {                                 // édition depuis le Push (rangées 1-7, CAPTURE on)
		var c = _progCommit; _progCommit = null;
		// Mode Voicings du Push : l'utilisateur a DÉSIGNÉ un style au pad -> la carte le
		// porte, plutôt que le style global qu'elle hériterait de _progEntry.
		// (Device-only : le Push n'existe pas côté démo, ne rien répliquer de ce bloc.)
		if (c.voicing) entry.voicing = c.voicing;
		if (c.mode === "replace" && c.idx >= 0 && c.idx < progression.length) {
			// ⚠️ LA PLACE S'HÉRITE. `_progEntry` ne pose ni `start` ni `bars` — ils sont
			// écrits par `_progPlace`, que cette branche court-circuite puisque la taille
			// ne change pas. Sans la reprise ci-dessous la carte remplacée ressortait
			// `start=undefined bars=undefined` : `_entryStart`/`_entryBars` retombaient sur
			// leur défaut (« là où la précédente finit », une mesure), la carte se rendait
			// ailleurs qu'où l'utilisateur l'avait posée, et le clip lié était réécrit au
			// mauvais endroit. Silencieux, parce que les deux lecteurs défensifs font leur
			// travail : ils empêchent `undefined` de partir sur le fil, pas la place d'être
			// perdue. Épinglé par device/tests/prog-push-remplace.test.mjs.
			entry.start = progression[c.idx].start;
			entry.bars = progression[c.idx].bars;
			progression.splice(c.idx, 1, entry);       // Subs/Voicings : remplace l'étape (taille inchangée, ignore PROG_MAX)
		} else if (_progPlace(entry, (c.idx >= 0 && c.idx < progression.length) ? (_entryStart(c.idx) + _entryBars(progression[c.idx])) : -1)) {
			// Suite : la carte se pose juste après la fin de l'étape désignée (tuple-dev#72), dans la place libre
		} else { outlet(7, "progfull"); return; }
		broadcastProg();
		return;
	}
	// Plus de plafond de COMPTE depuis le 2026-09-18 (#77) : la PLACE décide, dans _progPlace.
	// tuple-dev#72 : au CURSEUR (une mesure de la règle) s'il y en a un, sinon juste après la fin de la dernière
	// carte. Pas de place (curseur dans une carte, ou moins d'un quart libre) → progfull, comme la 9e carte.
	if (!_progPlace(entry, insertCursor)) { outlet(7, "progfull"); return; }
	if (_pageOf(entry.start) !== progPage) page(_pageOf(entry.start));   // la carte est partie sur une autre page : la vue y va
	// Le curseur RESTE : il avance à la fin de la carte qu'il vient de poser, pour que la suivante vienne après.
	if (insertCursor >= 0) insertCursor = entry.start + entry.bars;
	broadcastProg();
}

function capture(v) {                      // toggle « Capture » depuis l'UI
	captureMode = (parseInt(v) === 1);
	outlet(7, "capture", captureMode ? 1 : 0);
}
function capturetoggle() {                 // bascule CAPTURE depuis le pad Push (ligne vide) — flippe + re-broadcast (UI + Push synchro)
	capture(captureMode ? 0 : 1);
	if (progPushOn) broadcastProgPush();   // rafraîchit le pad CAPTURE (et l'état audition/édition)
}
function clearprog()  { progression = []; insertCursor = -1; progPages = 1; outlet(7, "pages", 1); page(0); broadcastProg(); }   // toutes les pages, et retour à une (tuple-dev#74)
function removeat(i)  {
	i = parseInt(i);
	if (i >= 0 && i < progression.length) {
		_progSort();                    // départs matérialisés : retirer une carte laisse un trou, rien ne se recolle (tuple-dev#72)
		progression.splice(i, 1);
		broadcastProg();
	}
}
// Style de voicing d'UNE carte de progression (tranche V, design §5). `v` est un
// VOICING_NAME, et rien d'autre. Re-réalise la carte PUIS propage aux cartes suivantes
// restées en vlMode "follow" (_recascadeFrom), puis rediffuse.
// N'ÉCRIT JAMAIS currentVoicing : le voicing GLOBAL reste celui du jeu live sur la grille
// (design §3, face performance intacte).
function progvoicing(i, v) {
	i = _idx(i, progression.length);
	if (i < 0) return;
	var name = String(v);
	if (!_isVoicingName(name)) {
		post("progvoicing: style inconnu '" + name + "'\n");   // refus BRUYANT : silencieux = indébogable dans Max
		return;
	}
	progression[i].voicing = name;
	_recascadeFrom(i);     // re-réalise i, puis les suivantes tant qu'elles sont vlMode "follow"
	broadcastProg();       // -> prog + progvoic + cursor + Push + _clipSyncDirty
}
// Curseur d'insertion posé par l'UI (clic sur une carte). -1 = ajout à la fin.
// Le curseur est une MESURE de la règle (quart), -1 = aucun (tuple-dev#72). Il vit hors des cartes.
function setcursor(s) {
	var v = parseFloat(s);
	insertCursor = (v >= 0) ? Math.round(v / PROG_BARS_MIN) * PROG_BARS_MIN : -1;
	if (insertCursor >= 0 && _pageOf(insertCursor) !== progPage) page(_pageOf(insertCursor));   // la vue va où l'on écrit (tuple-dev#74)
}
// Réordonne : déplace l'accord d'index `from` vers la position `to` (glisser-déposer).
// ALIAS TRANSITOIRE (tuple-dev#72) : déplacer = changer le départ (`progstart`). « Entre la carte to-1 et la
// carte to » se traduit par « à la fin de la carte to-1 » (0 si to ≤ 0), puis les règles de progstart
// (bloquée contre les voisines, huit mesures) s'appliquent. À retirer quand plus personne ne l'envoie.
function moveprog(from, to) {
	from = _idx(from, progression.length); to = parseInt(to);
	if (from < 0 || isNaN(to)) return;
	var at = 0;
	if (to > 0) { var k = Math.min(to, progression.length) - 1; at = _entryStart(k) + _entryBars(progression[k]); }
	progstart(from, at);
}
// ── Tranche I — renversement d'UNE étape ──────────────────────────────────────
// Le geste ± prend la main sur l'axe INVERSION : l'étape est ÉPINGLÉE (vlMode "pinned")
// (design §2.1 — `follow`|`pinned` est l'axe inversion/registre, distinct de l'axe
// `voicing`. Les deux disaient "auto" jusqu'au 2026-08-11 : quatre mécanismes portaient
// ce mot, dont deux sur la même carte. Ici, épinglée veut dire « le voice-leading n'a
// plus le droit de bouger cette carte »). L'inversion est cyclée modulo la taille de l'accord RÉALISÉ, jamais
// bornée en dur : un accord à 3 notes a 3 renversements, un accord à 5 en a 5.
// _idx (et non `if (i<0||i>=len)`) : NaN met en échec TOUTE comparaison, donc la forme
// naïve le laisse passer — trou rebouché sur 6 entrées au fuzz du 2026-08-05.
// settension idx t v — pose (v=1) ou retire (v=0) la tension t (9 | 11 | 13) sur la carte idx.
// Refus silencieux hors bornes, hors {9,11,13}, ou si l'offre ne la propose pas (built, avoid,
// none) : l'UI grise ce que le moteur refuse, et le moteur reste la seule autorité.
function settension(idx, t, v) {
	idx = _idx(idx, progression.length);
	if (idx < 0) return;
	var p = progression[idx], spec = _tensBaseSpec(p);
	if (!spec) return;
	// tuple-dev#73 : `t` est une couleur (« b9 » … « 13 », ou son intervalle 1 2 3 5 6 8 9) ; 9 / 11 / 13 en nombre
	// restent acceptés et désignent la couleur diatonique de la famille (Push, sets anciens).
	var iv = _tensIv(spec, t); v = (parseInt(v) === 1);
	if (iv < 0) return;
	t = _TENS_COLOR[iv];
	var o = _tensOffer(p), i, st = null;
	for (i = 0; i < o.length; i++) if (o[i].color === t) st = o[i].state;
	if (st !== "off" && st !== "on") return;
	var cur = p.tensions ? p.tensions.slice() : [], k = cur.indexOf(t);
	if (v && k < 0) cur.push(t);
	if (!v && k >= 0) cur.splice(k, 1);
	cur.sort(function(a, b){ return _TENS_BY_NAME[a] - _TENS_BY_NAME[b]; });
	p.tensions = cur;
	p.name = _tensName(p);
	// 2026-09-11 : poser ou retirer une tension ne RE-RÉALISE rien — ni cette carte, ni les suivantes. La base de la
	// carte (`notesBase` : ses notes telles que capturées ou voicées) reste, la structure supérieure s'empile dessus.
	// Une carte d'avant cette règle n'a pas de `notesBase` : ses notes courantes en tiennent lieu.
	if (!p.notesBase || !p.notesBase.length) p.notesBase = p.notes ? p.notes.slice() : [];
	p.notes = _tensStack(p.notesBase, p);
	broadcastProg();
	previewprog(idx);
}

// OCTAVE PAR CARTE (2026-09-18, Antoine : « dans les options de cartes je veux un
// sélecteur d'octave ») : un offset -2..+2 borné, ±12 demi-tons par cran, appliqué en
// DELTA sur les notes déjà réalisées (`notes` ET `notesBase` — la carte suivante suit la
// position entendue). La convention : les notes STOCKÉES portent l'octave ; toute
// re-réalisation (_revoiceEntry) la ré-applique depuis sa base canonique.
function setoct(i, v) {
	i = _idx(i, progression.length);
	if (i < 0) return;
	var n = parseInt(v);
	if (isNaN(n)) { post("setoct: octave invalide '" + v + "'\n"); return; }
	if (n < -2) n = -2; if (n > 2) n = 2;
	var p = progression[i], old = parseInt(p.oct) || 0;
	if (n === old) return;
	p.oct = n;
	var d = (n - old) * 12, k;
	if (p.notes) for (k = 0; k < p.notes.length; k++) p.notes[k] += d;
	if (p.notesBase) for (k = 0; k < p.notesBase.length; k++) p.notesBase[k] += d;
	broadcastProg();
}

function setinv(idx, inv) {
	idx = _idx(idx, progression.length);
	if (idx < 0) return;
	var p = progression[idx];
	var n = (p.notes && p.notes.length) ? p.notes.length : 0;
	if (!n) return;
	inv = parseInt(inv);
	if (isNaN(inv)) return;   // refus AVANT de toucher vlMode : un inv invalide ne doit pas épingler la carte
	p.vlMode = "pinned";
	p.inv = ((inv % n) + n) % n;
	_recascadeFrom(idx);   // re-réalise l'étape PUIS propage aux suivantes en "follow" (F0)
	broadcastProg();
	previewprog(idx);      // retour VISUEL au clavier moniteur — previewprog ne joue rien
}

// « désépingler réinitialise » (critère d'acceptation, design §5) : rend l'axe inversion
// au voice-leading. inv=0 + vlMode="follow" -> _revoiceEntry retrouve le voicing lissé.
// Ré-applique le voice leading à TOUTE la progression, d'un bout à l'autre.
//
// Pourquoi ça manquait : `captureone` et le chemin de capture AJOUTENT une carte
// sans jamais appeler `_recascadeFrom`. Chaque accord garde donc le voicing qu'il
// avait au moment où il a été joué, et rien ne conduit les voix d'un accord au
// suivant. La cascade n'existait que sur les ÉDITIONS (inversion, style, dépinglage).
//
// ⚠️ Contrairement à `_recascadeFrom`, cette fonction NE S'ARRÊTE PAS à la première
// carte épinglée. La propagation d'une édition s'y arrête — c'est la sémantique
// gelée dans CONTEXT.md, et elle est juste : éditer une carte ne doit pas déranger
// ce que l'utilisateur a figé plus loin. Mais cette action-ci est explicite et
// globale : une carte épinglée reste exactement où elle est ET sert de référence à
// la suivante. Passer outre ferait perdre le travail d'épinglage ; s'arrêter
// laisserait la moitié de la progression non conduite, ce que le bouton promet.
function voiceleadall() {
	var i, prev, notes;
	for (i = 0; i < progression.length; i++) {
		prev = (i > 0) ? progression[i - 1] : null;
		if (progression[i].vlMode !== "follow") continue;   // épinglée : intacte, mais elle reste `prev` pour la suivante
		notes = _revoiceEntry(progression[i], prev);
		// Même garde que la cascade : `voicingResolved` n'est écrit qu'en cas de
		// succès, sinon la carte annoncerait un style que ses notes ne jouent pas.
		if (notes) { progression[i].voicingResolved = progression[i].voicing; progression[i].notes = notes; }
	}
	broadcastProg();
}

// ══ RE-TONALISATION DE LA PROGRESSION (constat session 71, soldé session 73) ═══════════
// Un changement de KEY / SCALE re-dérive TOUTE la progression : nom, chiffrage et notes
// des cartes restaient figés dans la tonalité de capture — le panneau annonçait « KEY D »
// au-dessus de cartes qui jouaient encore en C. Chaque carte se re-dérive de son identité
// (fn, deg, colorSemis/colorType), jamais de ses notes :
//   - nom     : gridLabel (degrés — même recette que la grille, cf. « identique à la
//               grille » dans seven()/nine()) ou la table d'emprunts (color) ;
//   - chiffre : chordQuality (degrés) ou la table d'emprunts (color) ;
//   - notes   : _revoiceEntry — pinned COMPRIS : l'épinglage fige registre et
//               renversement (rootPos + inv), pas la tonalité. C'est un changement
//               global explicite, pas une cascade d'édition — même raison que
//               voiceleadall() de ne pas s'arrêter aux cartes épinglées.
// Quand la nouvelle gamme ne sait pas réaliser une carte (type invalide sur ce degré),
// ses notes et son nom restent — même convention que _recascadeFrom : un champ qui ment
// sur ce qu'on entend est pire qu'un champ périmé.
// ⚠️ COALESCENCE — une RAFALE de changements de tonalité ne doit re-réaliser qu'UNE fois.
// Mesuré le 2026-09-14 dans Live (sonde de décrochage : ping du remote script toutes les
// 30 ms, un trou > 80 ms est un freeze ressenti). 24 cartes, un `rootidx` toutes les 120 ms :
//   avec re-réalisation immédiate .... 21 pings sur 25 décrochent, pire 102 ms
//   `_progRekey` neutralisé .......... 0 ping sur 28
// Le coût est la RÉALISATION, pas la diffusion — chronométré dans le harnais sur 24 cartes :
// `_progRekey` 6,9 ms, `broadcastProg` 0,6 ms, `_tensPrune` 0,5 ms. On ne peut donc pas le
// rendre gratuit, seulement ne le payer qu'une fois par rafale. Une molette sur KEY, une
// automation Live sur `rootidx`, un `synclive` qui suit la gamme de Live produisent
// exactement cette rafale ; un geste isolé, lui, ne voit que 60 ms de retard.
// ⚠️ Un appelant ne doit donc PAS lire `progression[].notes` juste après un changement de
// tonalité : c'est le Task qui les écrit. Sous le harnais, `env.clock.advance(100)`.
var _rekeyTask = null;
function _progRekeyDefer() {
	if (!progression.length) return;
	if (typeof Task === 'undefined') { _progRekey(); return; }   // hors Max : pas d'ordonnanceur, on paie tout de suite
	if (!_rekeyTask) _rekeyTask = new Task(_progRekey, this);
	_rekeyTask.schedule(60);   // `schedule` sur un Task en attente le REPLANIFIE : la rafale glisse au lieu d'empiler
}
function _progRekey() {
	if (!progression.length) return;
	var i, p, prev, notes;
	for (i = 0; i < progression.length; i++) {
		p = progression[i];
		prev = (i > 0) ? progression[i - 1] : null;
		notes = _revoiceEntry(p, prev);
		if (notes) {
			p.voicingResolved = p.voicing;
			p.notes = notes;
			if (p.fn === "color") {
				var bl = borrowedFor(), suf = null, rom = null, j;
				for (j = 0; j < bl.length; j++) if (bl[j].semis === p.colorSemis && bl[j].type === p.colorType) { suf = bl[j].suf; rom = bl[j].roman; }
				// Hors table de la nouvelle gamme : le suffixe se re-dérive du type (même
				// recette que colorchord), le chiffrage — relatif à la tonique — reste vrai.
				if (suf === null) suf = (p.colorType === "min") ? "m" : (p.colorType === "dim7") ? "dim7"
				                      : (p.colorType === "maj7") ? "maj7" : (p.colorType === "dom7") ? "7" : "";
				p.baseName = NOTE_NAMES[((root + p.colorSemis) % 12 + 12) % 12] + suf;
				if (rom) p.roman = rom;
			} else {
				// ext=false : les noms de capture viennent des handlers (seven, nine…), qui
				// n'écrivent jamais la forme étendue — gridLabel non plus avec ce drapeau.
				p.baseName = gridLabel(p.deg, p.fn, null, false);
				var ROMAN = ["I","II","III","IV","V","VI","VII"];
				var base = ROMAN[p.deg] || "·", q = chordQuality(p.deg);
				p.roman = (q === 1) ? base.toLowerCase() : (q === 2) ? base.toLowerCase() + "°"
				        : (q === 3) ? base + "+" : base;
			}
			p.name = (p.tensions && p.tensions.length) ? _tensName(p) : p.baseName;
		}
	}
	broadcastProg();
}

function resetinv(idx) {
	idx = _idx(idx, progression.length);
	if (idx < 0) return;
	progression[idx].vlMode = "follow";
	progression[idx].inv = 0;
	_recascadeFrom(idx);
	broadcastProg();
	previewprog(idx);
}

// Ajoute l'accord COURANT (dernier joué/glissé) à la position `pos` — hors mode capture
// (utilisé par le glisser d'une case de la grille vers la progression).
function captureone(name, pos) {
	pos = parseFloat(pos);                            // tuple-dev#72 : une MESURE de la règle (quart), -1 = après la dernière
	var entry = _progEntry(name, lastChordNotes);   // ← dernier accord joué (activeNotes a pu être vidé par le release)
	if (!_progPlace(entry, (pos >= 0) ? pos : -1, true)) { outlet(7, "progfull"); return; }   // depuis la grille : coupe ce qu'il recouvre
	if (_pageOf(entry.start) !== progPage) page(_pageOf(entry.start));   // la vue va où la carte s'est posée (tuple-dev#74)
	broadcastProg();
}
// Écoute (audition) d'UN accord de la progression : rejoue ses notes puis note-off auto (~0.8 s).
// Pas de séquence — un seul accord, conforme au principe « pas un séquenceur ».
function playprog(i) {
	i = _idx(i, progression.length);
	if (i < 0) return;
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
	idx = _idx(idx, progression.length);
	if (idx < 0) return;
	var p = progression[idx];
	if (p.notes && p.notes.length) outlet(7, ["previewnotes"].concat(p.notes));
}

// Diffuse la progression à l'UI par n-uplets de PROG_STRIDE atomes (7 depuis la durée par
// carte, 2026-08-18) : "prog <nom> <romain> <deg> <inv> <bassPc> <épinglé> <bars> …"
// (vide = "prog" seul).
// deg : -1 = emprunt (carte violette) ; 0..6 = degré (couleur de la grille).
// Ce que l'UI doit AFFICHER pour une carte : le style DEMANDÉ (ce que l'utilisateur a
// choisi au picker) et le style avec lequel ses notes ont réellement été réalisées.
// Depuis le retrait du choix automatique les deux coïncident tant que la réalisation
// réussit ; ils divergent encore quand _revoiceEntry rend null, cas où voicingResolved
// reste sur le style que les notes stockées jouent VRAIMENT — c'est ce qu'il faut montrer.
function _progVoicKey(p) { return (p && p.voicing) ? String(p.voicing) : "classic"; }
function _progVoicShown(p) {
	if (p && _isVoicingName(p.voicingResolved)) return p.voicingResolved;
	if (p && _isVoicingName(p.voicing)) return p.voicing;
	return "classic";   // dernier repli : _vl2_realize retombe de toute façon sur classic
}
// Classe de hauteur de la basse RÉELLE si elle diffère de la fondamentale, sinon -1.
// La fondamentale est relue sur le spec (clé COURANTE) et non figée à la capture : les
// notes sont dérivées depuis F0, un rootPc gelé se désaccorderait d'elles dès un
// changement de tonalité.
// min() et NON notes[0] : l'ordre interne d'un voicing n'est pas trié (cf. _emitNotes),
// lire la première note stockée rendrait un slash faux sans rien casser d'autre.
function _progBassPc(p) {
	if (!p.notes || !p.notes.length) return -1;
	var spec = _vl2_specFor(p.fn, p.deg, p.colorSemis, p.colorType);
	if (!spec) return -1;
	var pc = _vl2_m(Math.min.apply(null, p.notes));
	return (pc === _vl2_m(spec.rootPc)) ? -1 : pc;
}
// Largeur du n-uplet — le parseur UI (tuple_ui.html renderProg) DOIT coller.
// 5 → 6 le 2026-08-16 (tuple-dev#9, atome épinglé) ; 6 → 7 le 2026-08-18 (durée en mesures,
// ajoutée EN FIN du n-uplet, session 60b).
var PROG_STRIDE = 10;   // 9e atome (tuple-dev#72) : le départ, en mesures ; 10e (2026-09-18) : l'octave de la carte
function broadcastProg() {
	var flat = [], voic = [];
	for (var i = 0; i < progression.length; i++) {
		var p = progression[i];
		flat.push(p.name);
		flat.push(p.roman || "·");
		flat.push(p.deg);
		// Tranche I. inv : renversement courant de l'étape, 0 = aucun.
		// bassPc : classe de hauteur (0-11) de la note la plus GRAVE si elle diffère de la
		// fondamentale, sinon -1. C'est la « vérité de la basse » — un voicing rootless
		// affiche son slash MÊME à inv=0, et un renversement le fait suivre. Le moteur
		// diffuse un ENTIER, jamais un nom : l'orthographe ♯/♭ appartient à l'UI (useflats
		// est un simple relais, le moteur ne stocke pas la préférence).
		flat.push(p.inv || 0);
		flat.push(_progBassPc(p));
		// tuple-dev#9 — l'état ÉPINGLÉ, diffusé TEL QUEL ("follow" | "pinned"). L'UI le
		// DÉDUISAIT de `inv`, ce qui mentait dès que le cycle ▲ ramenait inv à 0 : la carte
		// restait épinglée sans badge, donc sans le seul contrôle qui la rend au voice-leading.
		// Mesuré : borner le cycle n'aurait rien réglé (▼ atteint inv=0 tout autant), et faire
		// que inv=0 désépingle aurait DÉTRUIT un état réel — épinglée en position fondamentale
		// rend 48 52 55 là où la même carte en "follow" rend 55 60 64 (anchor) / 52 55 60 (flow).
		// ⚠️ C'est le vlMode DE LA CARTE (axe inversion/registre), jamais la globale
		// "anchored"|"flow" — deux choses portent ce nom, elles ne partagent aucune valeur.
		// Un NOM et non un booléen : `rootPos` se lit `!== "follow"`, donc un futur 3e mode
		// épinglant reste diffusable sans re-changer la largeur du n-uplet.
		flat.push(p.vlMode || "follow");
		// Durée de la carte, en mesures. AJOUTÉE EN FIN du n-uplet, comme tout ce qui s'ajoute au
		// fil : insérer ailleurs décalerait tous les atomes suivants et l'UI lirait le champ d'à
		// côté, en silence. `_entryBars` et pas `p.bars` — une carte capturée avant ce champ n'en
		// a pas, et le fil ne doit jamais porter `undefined`.
		flat.push(_entryBars(p));
		// 8e atome (tuple-dev#68) : les tensions POSÉES de la carte, croissantes, séparées par un
		// point (« 9.13 »), ou « - » — jamais une chaîne vide, un atome vide se perd sur le fil.
		flat.push((p.tensions && p.tensions.length) ? _tensNames(p) : "-");
		// 9e atome (tuple-dev#72) : le départ de la carte, en mesures — toujours un nombre, jamais `undefined`.
		flat.push(_entryStart(i));
		// 10e atome (2026-09-18) : l'octave de la carte (-2..+2, 0 = aucune) — en FIN, comme tout ajout au fil.
		flat.push(p.oct || 0);
		// 2 atomes par carte, alignés sur les n-uplets de "prog" PAR CARTE : un décalage
		// poserait la mauvaise pastille sur la mauvaise carte, en silence.
		voic.push(_progVoicKey(p));
		voic.push(_progVoicShown(p));
	}
	outlet(7, ["prog"].concat(flat));
	outlet(7, ["progvoic"].concat(voic));   // point de passage UNIQUE, comme "prog"
	broadcastProgTens();                    // l'offre de tensions par carte, alignée comme "progvoic"
	outlet(7, "cursor", insertCursor);
	if (progPushOn) broadcastProgPush();   // le Push reflète la progression à chaque changement
	_clipSyncDirty();                      // live-sync : point de passage UNIQUE de toutes les mutations
	                                       // (capture/insert/reorder/remove/clear) — accrocher
	                                       // ici plutôt que dans chaque fonction évite d'en oublier une.
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
var PROG_OPT_MAX = 48;   // options de l'étape sélectionnée → remplissent la grille 6×8 (rows 0-5)
// Ordre d'affichage des voicings en mode Voic, GROUPÉ par famille (bottom-up : basiques en bas, près des étapes).
var _VOIC_ORDER = ["root", "classic", "open", "drop2", "drop3", "piano"];   // = SPACING_NAMES, neutre en tete (ordre d'AFFICHAGE, sans effet sur les index)
function _progOptions(idx){
	if (idx < 0 || idx >= progression.length) return [];
	var step = progression[idx], out, v;
	if (progMode === PROG_MODE_VOIC){
		out = [];                                       // voicings de CET accord, ordre par famille (_VOIC_ORDER)
		for (v = 0; v < _VOIC_ORDER.length && out.length < PROG_OPT_MAX; v++)
			out.push({ deg:step.deg, fn:step.fn, kind:"voic", voicing:_VOIC_ORDER[v], colorSemis:step.colorSemis, colorType:step.colorType });
		return out;
	}
	out = (progMode === PROG_MODE_SUITE) ? _suiteOptions(idx) : substitutesFor({ deg:step.deg, fn:step.fn });
	if (progMode === PROG_MODE_SUITE) out.sort(function(a,b){ return (b.lvl||0) - (a.lvl||0); });   // meilleur enchaînement d'abord (option 0 = bas)
	return (out.length > PROG_OPT_MAX) ? out.slice(0, PROG_OPT_MAX) : out;
}

// Diffuse la progression + les options PAR COLONNE vers le Push (outlet 7). Layout : rangée du bas =
// Rangée du bas = les étapes. Au-dessus = les options de la SEULE étape SÉLECTIONNÉE, en liste À PLAT
// (le spike/UI les étalent sur la grille 6×8, bottom-up). progopt = (flatIdx, deg, kind).
// progclear → progstep* → progopt* → capture → progsel → progdone.
function broadcastProgPush(){
	outlet(7, "progclear");
	var i, j, opts, sel = _progSelIdx(), loc = _pageCards(progPage);
	// tuple-dev#74 : la rangée du bas montre la PAGE AFFICHÉE — ses cartes, en colonnes locales.
	// ⚠️ HUIT pads de large : depuis la chute du plafond de cartes (2026-09-18, #77) une page
	// peut en porter jusqu'à 32 — la rangée montre les huit PREMIÈRES, les autres s'éditent à
	// l'écran. Sans cette borne, progstep 8+ viserait un pad hors matrice.
	for (i = 0; i < loc.length && i < PROG_MAX; i++)
		outlet(7, "progstep", i, progression[loc[i]].deg);        // rangée du bas (deg : -1 emprunt ; 0..6 degré)
	// Progression VIDE : _progSelIdx() rend length-1 = -1, et _progOptions(-1) lirait
	// progression[-1] (undefined) → TypeError. Activer le layout Push progression avant
	// d'avoir capturé le moindre accord suffisait à le déclencher (fuzz du 2026-08-05).
	opts = (sel >= 0) ? _progOptions(sel) : [];                   // options de l'étape SÉLECTIONNÉE
	for (j = 0; j < opts.length; j++)
		outlet(7, "progopt", j, (opts[j].deg == null ? -1 : opts[j].deg), opts[j].kind);   // flatIdx, deg, kind
	outlet(7, "capture", captureMode ? 1 : 0);                   // état CAPTURE (pad ligne vide)
	var selCol = _indexOfInt(loc, sel);
	if (selCol >= PROG_MAX) selCol = -1;                         // au-delà des huit pads : pas de colonne à allumer
	outlet(7, "progsel", selCol, progMode);                      // colonne LOCALE, -1 si la carte choisie est sur une autre page (ou hors rangée)
	outlet(7, "progdone");
}
// Index (globaux, triés) des cartes d'une page.
function _pageCards(pg) { var k, r = []; for (k = 0; k < progression.length; k++) if (_pageOf(_entryStart(k)) === pg) r.push(k); return r; }
function _indexOfInt(arr, v) { var k; for (k = 0; k < arr.length; k++) if (arr[k] === v) return k; return -1; }

// --- Handlers du layout Push « progression » (toggle / cycle de mode / sélection d'étape / option) ---
var _progCommit = null;   // {mode:"replace"|"insert", idx} : posé par selopt, consommé par captureChord

// Réalise les notes d'une option SANS effet de bord (preview VL jetable) — pour l'audition (CAPTURE off).
function _realizeOption(idx, opt){
	var step = progression[idx], fn, d, cs, ct;
	if (opt.kind === "voic"){ fn = step.fn; d = step.deg; cs = step.colorSemis; ct = step.colorType; }   // re-voice de l'étape
	else if (opt.fn === "color"){ fn = "color"; d = 0; cs = opt.colorSemis; ct = opt.colorType; }        // emprunt (suite)
	else { fn = opt.fn; d = opt.deg; cs = 0; ct = ""; }                                                   // diatonique
	if (fn === "color") d = 0;
	// Style temporaire : passé en option d'aperçu, plus d'échange sur currentVoicing — le
	// voicing global n'est jamais écrit, donc rien à restaurer et rien à perdre sur exception.
	var notes;
	if (opt.kind === "voic" && opt.voicing) notes = _vl2_play(fn, d, cs, ct, {preview:true, voicing:opt.voicing});
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

// ⚠️ Allumer PROG remettait la sélection à 0 SANS CONDITION, écrasant l'étape que
// l'utilisateur venait de choisir dans le tiroir — le focus Push sautait à la
// première carte au moment précis où on activait Push pour la regarder. La remise
// à 0 ne vaut que pour une sélection ABSENTE ou périmée ; sinon on garde celle qui
// existe. Mesuré le 2026-09-02 avec l'audit des contrôles du tiroir.
function progmode(v){
	progPushOn = (parseInt(v) === 1);
	if (progPushOn && (progSel < 0 || progSel >= progression.length)) progSel = 0;
	outlet(7, "progmode", progPushOn ? 1 : 0);
	if (progPushOn) broadcastProgPush();
}
function progmodecycle(){ progMode = (progMode + 1) % 3; outlet(7, "progmodeui", progMode); if (progPushOn) broadcastProgPush(); }
// Sélection d'une étape (rangée 0 du Push) : la sélectionne + l'écoute (réutilise playprog).
function selprog(col){
	var loc = _pageCards(progPage), c = _idx(col, loc.length);   // colonne de la page affichée (tuple-dev#74)
	if (c < 0) return;
	var i = loc[c];
	progSel = i;
	playprog(i);
	if (progPushOn) broadcastProgPush();
}
// Appui d'une option dans la grille. `flat` = index à plat dans les options de l'étape SÉLECTIONNÉE.
// CAPTURE off -> écoute ; CAPTURE on -> édite : Subs/Voicings remplacent l'étape, Suite insère après —
// en rejouant l'option par le VRAI chemin (son/nom/état) via _progCommit.
function selopt(flat){
	var idx = _progSelIdx(), f = parseInt(flat);
	if (idx < 0 || idx >= progression.length) return;
	var opts = _progOptions(idx);
	if (f < 0 || f >= opts.length) return;
	var opt = opts[f];
	if (!captureMode){ _auditionNotes(_realizeOption(idx, opt), _optName(opt), (opt.deg == null ? -1 : opt.deg)); return; }   // écoute + nom dans le Monitor
	var step = progression[idx], cell, savedVc = null;
	if (opt.kind === "voic"){
		cell = _cellFor({ fn:step.fn, deg:step.deg, colorSemis:step.colorSemis, colorType:step.colorType });
		if (opt.voicing){ savedVc = currentVoicing; currentVoicing = opt.voicing; }   // re-voice temporaire (n'altère pas le voicing live)
		_progCommit = { mode:"replace", idx:idx, voicing: opt.voicing };             // style EXPLICITE sur la carte (sinon le style global, cf. _progEntry)
	} else if (progMode === PROG_MODE_SUITE){
		cell = _cellFor(opt);
		_progCommit = { mode:"insert", idx:idx };
	} else {                                                                          // SUBS
		cell = _cellFor(opt);
		_progCommit = { mode:"replace", idx:idx };
	}
	try {
		playFlatCell(cell);             // -> sendChord -> captureChord consomme _progCommit (splice)
	} finally {
		if (savedVc !== null) currentVoicing = savedVc;   // le voicing global survit à une exception de jeu
		_progCommit = null;             // filet : déjà consommé en temps normal — et JAMAIS laissé à une capture future
	}
}

// Écrit la progression dans le clip de l'emplacement SÉLECTIONNÉ (1 accord = 1 mesure).
// NON destructif : si le slot contient déjà un clip -> "clipbusy" (on n'écrase pas).
// Notes "block" propres (pas de strum/humanize : ce sont des effets de jeu).
// Construit les notes de la progression — 1 accord = 1 mesure, à la signature rythmique RÉELLE de
// Live (était 4/4 EN DUR -> faux en 3/4, 6/8…). Le temps de clip Live se compte en noires :
// 1 mesure = num * 4/den noires (4/4->4, 3/4->3, 6/8->3).
// Renvoie null sur progression vide. PARTAGÉ par les trois chemins d'écriture du live-sync :
// les deux doivent produire exactement les mêmes notes, sinon lier un clip changerait le rendu.
// Durée d'une carte, en MESURES. Une carte d'avant l'introduction du champ (ou toute carte dont
// la valeur ne tient pas debout) vaut UNE mesure : c'est le comportement historique, et le défaut
// doit être celui-là, jamais zéro — une carte de durée nulle empilerait deux accords sur le même
// temps sans qu'aucune erreur ne le dise.
var PROG_BARS_MIN = 0.25;   // quart de mesure : la plus petite place lisible sur une pastille
var PROG_BARS_MAX = 16;
// La progression TIENT DANS L'ÉCRAN : huit mesures en tout, jamais plus (2026-09-10, Antoine a refusé le
// défilement). Règle du moteur, pas de l'UI : progbars prend la place qui reste, une capture sans place est
// refusée (progfull), une capture qui a moins d'une mesure prend ce qui reste. Test : prog-huit-mesures.
var PROG_BARS_TOTAL = 8;        // la BOUCLE : longueur de la règle et du clip ; réglable par `loopbars`, jamais plus de LOOP_MAX
var LOOP_MAX = 8;
// LES PAGES (tuple-dev#74) : une page EST une boucle ; le morceau fait `progPages × boucle` mesures, jusqu'à quatre
// pages. Les départs des cartes restent absolus sur le morceau ; une carte ne franchit pas une frontière de page.
var progPages = 1, PAGES_MAX = 4;
var progPage = 0;               // la page AFFICHÉE (0-based) : le moteur la tient, la capture, le curseur et le Push en dépendent
function _songBars() { return progPages * PROG_BARS_TOTAL; }
// La page affichée : bornée aux pages existantes, diffusée `page N`.
function page(n) {
	n = parseInt(n); if (!(n >= 0)) n = 0; if (n > progPages - 1) n = progPages - 1;
	progPage = n;
	outlet(7, "page", progPage);
	if (progPushOn) broadcastProgPush();   // le Push montre la page affichée
}
function _pageOf(bar) { return Math.max(0, Math.min(progPages - 1, Math.floor((bar + 1e-9) / PROG_BARS_TOTAL))); }
// Nombre de pages : ajoute des pages vides à la fin, ou en retire — jamais une page qui porte une carte.
function pages(n) {
	n = parseInt(n);
	if (!(n >= 1) || n > PAGES_MAX) { post("pages: hors de 1.." + PAGES_MAX + " : '" + n + "'" + String.fromCharCode(10)); outlet(7, "pages", progPages); return; }
	if (n < progPages) {
		var i, occupee = 0;
		for (i = 0; i < progression.length; i++) occupee = Math.max(occupee, _pageOf(_entryStart(i)) + 1);
		if (n < occupee) { post("pages: la page " + occupee + " porte une carte" + String.fromCharCode(10)); outlet(7, "pages", progPages); return; }
	}
	progPages = n;
	if (insertCursor >= _songBars()) insertCursor = -1;
	outlet(7, "pages", progPages);
	if (progPage > progPages - 1) page(progPages - 1);   // la page affichée n'existe plus : la dernière
	broadcastProg();
}
// La boucle : 1 à 8 mesures. Le clip Live fait cette longueur (pas celle de la dernière carte). Raccourcir coupe ce
// qui dépasse et retire ce qui commence au-delà (règle « couper ») ; rallonger ne ramène rien (2026-09-11).
function loopbars(n) {
	n = parseInt(n);
	if (!(n >= 1) || n > LOOP_MAX) { post("loopbars: hors de 1.." + LOOP_MAX + " : '" + n + "'" + String.fromCharCode(10)); return; }
	if (n === PROG_BARS_TOTAL) { outlet(7, "loopbars", n); return; }
	if (progPages > 1) { post("loopbars: " + progPages + " pages — la boucle ne change qu'à une page" + String.fromCharCode(10)); outlet(7, "loopbars", PROG_BARS_TOTAL); return; }   // tuple-dev#74
	PROG_BARS_TOTAL = n;
	var i;
	for (i = 0; i < progression.length; i++) progression[i].start = _entryStart(i);   // départs matérialisés avant de retirer
	for (i = progression.length - 1; i >= 0; i--) {
		var st = progression[i].start, b = _entryBars(progression[i]);
		if (st >= n - 1e-9) { progression.splice(i, 1); continue; }
		if (st + b > n + 1e-9) progression[i].bars = Math.round((n - st) / PROG_BARS_MIN) * PROG_BARS_MIN;
		if (_entryBars(progression[i]) < PROG_BARS_MIN) progression.splice(i, 1);
	}
	if (insertCursor >= n) insertCursor = -1;
	outlet(7, "loopbars", n);
	broadcastProg();
}
// Fin de la dernière carte dans le temps (0 si aucune).
function _progEnd() {
	var t = 0, k, e;
	for (k = 0; k < progression.length; k++) { e = _entryStart(k) + _entryBars(progression[k]); if (e > t) t = e; }
	return t;
}
// Pose une NOUVELLE carte (tuple-dev#72) : à la mesure `at` si elle est donnée (≥ 0), sinon juste après la fin de
// la dernière carte. La place libre va de `at` au début de la première carte qui commence après (ou 8) ; si `at`
// tombe DANS une carte, ou s'il reste moins d'un quart, il n'y a pas de place → false (l'appelant dit progfull).
// Une carte qui a moins d'une mesure de libre prend ce qui reste. La carte est insérée triée.
function _progPlace(entry, at, cut) {
	var q = function (x) { return Math.round(x / PROG_BARS_MIN) * PROG_BARS_MIN; };
	var st, k, ks, ke, song = _songBars();
	if (at !== undefined && at !== null && at >= 0) st = q(at);
	else {
		// Après la fin de la dernière carte ; si sa page n'a plus un quart de libre,
		// au début de la page suivante — ouverte s'il le faut, jusqu'à PAGES_MAX (tuple-dev#74).
		// (Le plafond de HUIT CARTES par page est tombé le 2026-09-18, #77 : il datait des
		// cartes bornées à une mesure — seule la PLACE décide désormais.)
		st = q(_progEnd());
		var pgFin = Math.floor((st + 1e-9) / PROG_BARS_TOTAL);
		if (pgFin >= progPages || st > pgFin * PROG_BARS_TOTAL + PROG_BARS_TOTAL - PROG_BARS_MIN + 1e-9) {
			pgFin = (st > pgFin * PROG_BARS_TOTAL + 1e-9) ? pgFin + 1 : pgFin;
			if (pgFin >= PAGES_MAX) return false;
			if (pgFin >= progPages) { progPages = pgFin + 1; outlet(7, "pages", progPages); }
			st = pgFin * PROG_BARS_TOTAL;
		}
	}
	song = _songBars();                                               // une page a pu s'ouvrir
	if (st > song - PROG_BARS_MIN + 1e-9) return false;
	var pg = _pageOf(st), hi = (pg + 1) * PROG_BARS_TOTAL;
	for (k = 0; k < progression.length; k++) {
		ks = _entryStart(k); ke = ks + _entryBars(progression[k]);
		if (ks <= st + 1e-9 && ke > st + 1e-9) {
			if (!cut) return false;                                // `at` est dans une carte : pas de place ici (capture au curseur)
			// Dépôt depuis la grille SUR une carte (2026-09-11) : la nouvelle prend sa mesure et COUPE ce qu'elle recouvre.
			var b0 = (entry.bars > 0) ? entry.bars : 1; if (st + b0 > hi) b0 = hi - st;
			entry.start = st; entry.bars = b0;
			progression.push(entry);
			var res = _progLayout(progression.length - 1, st, b0, false);
			if (!res) { progression.pop(); return false; }
			_progApply(res);
			_progSort();
			return true;
		}
		if (ks > st + 1e-9 && ks < hi) hi = ks;
	}
	var room = hi - st;
	if (room < PROG_BARS_MIN - 1e-9) return false;
	var b = (entry.bars > 0) ? entry.bars : 1;
	if (b > room) b = Math.floor(room / PROG_BARS_MIN + 1e-9) * PROG_BARS_MIN;
	entry.bars = b; entry.start = st;
	progression.push(entry);
	_progSort();
	return true;
}
// Départ d'une carte en MESURES (tuple-dev#72). Une carte sans `start` (set sauvé avant, message ancien) part
// où la précédente finit : une progression ancienne se recharge collée, à l'identique.
function _entryStart(i) {
	var e = progression[i];
	if (e && e.start !== undefined && e.start >= 0) return parseFloat(e.start);
	return (i > 0) ? (_entryStart(i - 1) + _entryBars(progression[i - 1])) : 0;
}
// Pose le départ d'une carte : quantifié au quart. (Voisines et borne des 8 mesures : tranches suivantes.)
function progstart(i, s) {
	i = _idx(i, progression.length);
	if (i < 0) return;
	var v = parseFloat(s);
	if (!(v >= 0)) { post("progstart: départ invalide '" + s + "'\n"); return; }
	v = Math.round(v / PROG_BARS_MIN) * PROG_BARS_MIN;
	// La carte se pose là, et POUSSE ce qui la gêne (cascade, à droite comme à gauche) ; si plus rien ne tient dans
	// les huit mesures, elle s'arrête au dernier point où tout tient. Antoine, 2026-09-10 : « on ne peut plus
	// pousser une carte » — la spec #72 disait bloquer, la poussée a gagné.
	var res = _progLayout(i, v, _entryBars(progression[i]), false);
	if (!res) return;
	_progApply(res);
	_progSort();
	broadcastProg();
}
// Bord GAUCHE d'une carte (tuple-dev#72, révision) : le départ change, la FIN reste. Au moins un quart ;
// ce qui gêne à gauche est poussé, et si rien ne peut reculer (mesure 0), le bord s'arrête là où tout tient.
function progleft(i, s) {
	i = _idx(i, progression.length);
	if (i < 0) return;
	var v = parseFloat(s);
	if (isNaN(v)) { post("progleft: départ invalide '" + s + "'" + String.fromCharCode(10)); return; }   // sous 0 : ramené à 0, pas refusé
	var fin = _entryStart(i) + _entryBars(progression[i]);
	v = Math.round(v / PROG_BARS_MIN) * PROG_BARS_MIN;
	if (v > fin - PROG_BARS_MIN) v = fin - PROG_BARS_MIN;
	if (v < 0) v = 0;
	var res = _progLayout(i, v, fin - v, "end");
	if (!res) return;
	_progApply(res);            // pose aussi start et bars de la carte i (res.starts / res.bs)
	_progSort();
	broadcastProg();
}
// Pose la carte i à (st, bars) et COUPE ce qu'elle recouvre (tuple-dev#72, révision du 2026-09-10 : « une carte
// ne devrait pas en pousser une autre, juste la couper »). La voisine perd la partie recouverte — sa queue si elle
// commence avant, sa tête si elle finit après ; recouverte entièrement, ou réduite à moins d'un quart, elle
// disparaît. La carte i, elle, est bornée à la règle : `mode` true = départ fixe (la durée se borne à la 8e
// mesure), "end" = fin fixe (le départ ne passe pas sous 0), false = durée fixe (le départ se borne des deux
// côtés). Rend { st, bars, starts[], bs[], keep[] } ou null.
function _progLayout(i, st, bars, mode) {
	var q = function (x) { return Math.round(x / PROG_BARS_MIN) * PROG_BARS_MIN; };
	var b = bars, n = progression.length, k, song = _songBars(), pg, lo, hi;
	// ── mode "grow" : ÉTIRER pousse, il ne mange pas ────────────────────────────────────────
	// Antoine, 2026-09-15 : « quand on veut redimensionner une carte et qu'on la fait passer par
	// dessus une autre carte complètement […] elle ne s'arrête pas là où on lâche et supprime au
	// passage l'autre carte ». Mesuré sur C@0 Dm@1 Em@2, `progbars(0, 2.5)` rendait
	// `C@0+2.5 Em@2.5+0.5` — Dm supprimée, Em amputée de moitié.
	//
	// La COUPE reste le geste du DÉPLACEMENT (modes false / "end") : poser une carte sur une
	// autre la remplace, et c'est délibéré (#72, révision du 2026-09-10). L'étirement est un cas
	// neuf, et `progbars` promettait déjà la cascade dans son propre commentaire sans l'avoir.
	if (mode === "grow") {
		pg = _pageOf(st); lo = pg * PROG_BARS_TOTAL; hi = lo + PROG_BARS_TOTAL;
		b = q(b);
		if (b < PROG_BARS_MIN) b = PROG_BARS_MIN;
		// L'ordre de poussée est celui du TEMPS, pas celui des index : `_progSort` les aligne, mais
		// cette fonction tourne aussi sur un tableau que l'appelant vient de modifier.
		var ordre = [], j;
		for (k = 0; k < n; k++) if (k !== i) ordre.push(k);
		ordre.sort(function (a, c) { return _entryStart(a) - _entryStart(c); });
		// Deux passes au plus : la première pousse, la seconde re-pousse après avoir raboté `b` du
		// débordement. La cascade étant affine en `b` une fois toutes les cartes poussées, une
		// seule correction suffit — la seconde passe le VÉRIFIE au lieu de le supposer.
		var pousse = function (largeur) {
			var st2 = [], curseur = st + largeur, cs2, cb2;
			for (j = 0; j < ordre.length; j++) {
				k = ordre[j]; cs2 = _entryStart(k); cb2 = _entryBars(progression[k]);
				if (cs2 + cb2 <= st + 1e-9) { st2[k] = cs2; continue; }       // entièrement avant : intacte
				if (cs2 >= curseur - 1e-9) { curseur = cs2 + cb2; st2[k] = cs2; continue; }  // déjà au large
				st2[k] = q(curseur); curseur = st2[k] + cb2;                   // poussée
			}
			return { st2: st2, fin: curseur };
		};
		var p1 = pousse(b);
		if (p1.fin > hi + 1e-9) {
			b = q(b - (p1.fin - hi));
			if (b < PROG_BARS_MIN) b = PROG_BARS_MIN;
			p1 = pousse(b);
		}
		// Si ça déborde ENCORE, les seules cartes suivantes ne tiennent déjà plus : on refuse le
		// geste plutôt que d'en sacrifier une. Rien ne bouge, et l'appelant le voit à `null`.
		if (p1.fin > hi + 1e-9) return null;
		var starts2 = [], bs2 = [], keep2 = [];
		for (k = 0; k < n; k++) {
			keep2[k] = true;
			starts2[k] = (k === i) ? st : p1.st2[k];
			bs2[k] = (k === i) ? b : _entryBars(progression[k]);
		}
		return { st: st, bars: b, starts: starts2, bs: bs2, keep: keep2 };
	}
	// La carte reste dans SA page (tuple-dev#74) : la page se lit sur le départ demandé (ou sur la fin, bord gauche).
	if (mode === true) { pg = _pageOf(st); hi = (pg + 1) * PROG_BARS_TOTAL; if (st + b > hi) b = hi - st; }
	else if (mode === "end") { pg = _pageOf(st + b - PROG_BARS_MIN); lo = pg * PROG_BARS_TOTAL; if (st < lo) { b -= (lo - st); st = lo; } }
	else {
		if (st + b > song) st = song - b; if (st < 0) st = 0;
		pg = _pageOf(st); lo = pg * PROG_BARS_TOTAL; hi = lo + PROG_BARS_TOTAL;
		if (st + b > hi) st = hi - b; if (st < lo) st = lo;
	}
	st = q(st); b = q(b);
	if (b < PROG_BARS_MIN - 1e-9 || st < -1e-9 || st + b > song + 1e-9) return null;
	var fin = st + b, starts = [], bs = [], keep = [], cs, cb, ce;
	for (k = 0; k < n; k++) {
		if (k === i) { starts[k] = st; bs[k] = b; keep[k] = true; continue; }
		cs = _entryStart(k); cb = _entryBars(progression[k]); ce = cs + cb; keep[k] = true;
		if (ce <= st + 1e-9 || cs >= fin - 1e-9) { }                       // pas touchée
		else if (cs < st - 1e-9) { cb = st - cs; }                         // elle commence avant : sa queue tombe (ce qui dépasse aussi)
		else if (ce > fin + 1e-9) { cs = fin; cb = ce - fin; }              // elle finit après : sa tête tombe
		else { keep[k] = false; }                                          // recouverte
		if (keep[k] && cb < PROG_BARS_MIN - 1e-9) keep[k] = false;
		starts[k] = q(cs); bs[k] = q(cb);
	}
	return { st: st, bars: b, starts: starts, bs: bs, keep: keep };
}
// Applique une disposition : départs et durées, et retire les cartes recouvertes (de la fin vers le début,
// pour que les index de `res` restent valables). La sélection moteur suit sa carte, ou tombe.
function _progApply(res) {
	var k, sel = (progSel >= 0 && progSel < progression.length) ? progression[progSel] : null;
	for (k = progression.length - 1; k >= 0; k--) {
		if (!res.keep[k]) { progression.splice(k, 1); continue; }
		progression[k].start = res.starts[k];
		progression[k].bars = res.bs[k];
	}
	if (sel) { progSel = -1; for (k = 0; k < progression.length; k++) if (progression[k] === sel) { progSel = k; break; } }
}
// `progression[]` est TRIÉ PAR TEMPS (tuple-dev#72) : l'index reste l'ordre joué — Push, écoute, numéros,
// tensions et inspecteur continuent de travailler par index sans rien savoir des départs. Avant de trier,
// chaque carte reçoit son départ (une carte ancienne prend la fin de la précédente), sinon le tri
// changerait ce que « la précédente » veut dire. La sélection moteur suit sa carte.
function _progSort() {
	var i, sel = (progSel >= 0 && progSel < progression.length) ? progression[progSel] : null;
	for (i = 0; i < progression.length; i++) progression[i].start = _entryStart(i);
	progression.sort(function (a, b) { return a.start - b.start; });
	if (sel) { for (i = 0; i < progression.length; i++) if (progression[i] === sel) { progSel = i; break; } }
}
function _entryBars(e) {
	var b = (e && e.bars !== undefined) ? parseFloat(e.bars) : 1;
	if (!(b >= PROG_BARS_MIN) || !(b <= PROG_BARS_MAX)) return 1;
	return b;
}

// Règle la place d'UNE carte dans le temps du clip. Passe par broadcastProg, donc le clip lié se
// réécrit tout seul (broadcastProg -> _clipSyncDirty -> _clipRewrite), et en Arrangement l'étendue
// suit via _clipArrFit.
function progbars(i, n) {
	i = _idx(i, progression.length);
	if (i < 0) return;
	var b = parseFloat(n);
	// Refus BRUYANT plutôt que valeur rabotée : une durée hors bornes vient d'un appelant fautif,
	// et la corriger en silence masquerait le défaut au lieu de le montrer.
	if (!(b >= PROG_BARS_MIN) || !(b <= PROG_BARS_MAX)) { post("progbars: duree invalide '" + n + "'\n"); return; }
	b = Math.round(b / PROG_BARS_MIN) * PROG_BARS_MIN;   // quantifié au quart de mesure
	// Allonger POUSSE les cartes suivantes (cascade) ; si plus rien ne tient dans les huit mesures, la durée
	// s'arrête au dernier quart où tout tient. Raccourcir ne ramène personne : le trou reste.
	// ⚠️ Ce commentaire promettait la cascade depuis le 2026-09-10 et le code COUPAIT — mode `true`,
	// qui supprime une carte entièrement recouverte. Mesuré sur C@0 Dm@1 Em@2 : `progbars(0, 2.5)`
	// rendait `C@0+2.5 Em@2.5+0.5`, Dm perdue et Em amputée. Le mode `"grow"` tient la promesse.
	var res = _progLayout(i, _entryStart(i), b, "grow");
	if (!res) return;
	if (res.bars === _entryBars(progression[i])) { var same = true, k; for (k = 0; k < progression.length; k++) if (!res.keep[k] || Math.abs(res.starts[k] - _entryStart(k)) > 1e-9 || Math.abs(res.bs[k] - _entryBars(progression[k])) > 1e-9) { same = false; break; } if (same) return; }
	_progApply(res);
	_progSort();
	broadcastProg();
}

// ── Sélection multiple (tuple-dev#77) ─────────────────────────────────────────
// `progmulti("move"|"copy", delta, i…)` et `progmulti("del", i…)` : UN geste ATOMIQUE sur
// plusieurs cartes, UN seul broadcast (donc une seule réécriture du clip lié). Le groupe
// garde ses écarts — delta commun, quantifié au quart — et COUPE les cartes non
// sélectionnées qu'il recouvre : la règle du déplacement simple (#72, rév. 2026-09-10),
// queue/tête/disparaît. Refus BRUYANT (progfull) et RIEN ne bouge quand une destination
// sort du morceau ou chevauche une frontière de page : tout se calcule sur des tableaux
// de travail, la mutation n'arrive qu'une fois le geste entier validé. (Le plafond de
// huit cartes par page est tombé le 2026-09-18 — la place décide.)
// Le premier index reçu est la carte PRIMAIRE : la sélection
// moteur la suit (move : la carte elle-même ; copy : son clone).
function _cloneEntry(p) {
	var c = {}, k;
	for (k in p) if (p.hasOwnProperty(k)) c[k] = p[k];
	if (p.notes && p.notes.slice) c.notes = p.notes.slice();
	if (p.notesBase && p.notesBase.slice) c.notesBase = p.notesBase.slice();
	if (p.tensions && p.tensions.slice) c.tensions = p.tensions.slice();
	if (p.colorSemis && p.colorSemis.slice) c.colorSemis = p.colorSemis.slice();
	return c;
}
function progmulti(verb) {
	var v = String(verb), a = Array.prototype.slice.call(arguments, 1);
	var q = function (x) { return Math.round(x / PROG_BARS_MIN) * PROG_BARS_MIN; };
	var i, k, idxs = [], seen = {}, delta = 0, from = 0;
	if (v === "move" || v === "copy") {
		delta = q(parseFloat(a[0])); from = 1;
		if (isNaN(delta)) { post("progmulti: delta invalide '" + a[0] + "'\n"); return; }
	} else if (v !== "del") { post("progmulti: verbe inconnu '" + v + "'\n"); return; }
	_progSort();                                       // départs matérialisés : index = ordre du temps
	var primary = _idx(a[from], progression.length);
	for (k = from; k < a.length; k++) {
		i = _idx(a[k], progression.length);
		if (i < 0 || seen[i]) continue;
		seen[i] = true; idxs.push(i);
	}
	if (!idxs.length) return;
	if (v === "del") {
		var selRef = (progSel >= 0 && progSel < progression.length) ? progression[progSel] : null;
		idxs.sort(function (x, y) { return y - x; });   // de la fin vers le début : les index restent vrais
		for (k = 0; k < idxs.length; k++) progression.splice(idxs[k], 1);
		progSel = -1;
		if (selRef) for (i = 0; i < progression.length; i++) if (progression[i] === selRef) { progSel = i; break; }
		broadcastProg();
		return;
	}
	if (Math.abs(delta) < PROG_BARS_MIN / 2) return;    // move de rien ; copy sur place mangerait son original
	idxs.sort(function (x, y) { return x - y; });
	// 1. Destinations : chaque carte du groupe, même delta — chacune entière dans UNE page.
	var song = _songBars(), st = [], en = [], pg;
	for (k = 0; k < idxs.length; k++) {
		i = idxs[k];
		var ns = q(_entryStart(i) + delta), nb = _entryBars(progression[i]);
		pg = Math.floor((ns + 1e-9) / PROG_BARS_TOTAL);
		if (ns < -1e-9 || ns + nb > song + 1e-9 || ns + nb > (pg + 1) * PROG_BARS_TOTAL + 1e-9) { outlet(7, "progfull"); return; }
		st[k] = ns; en[k] = ns + nb;
	}
	// 2. Coupe, sur tableaux de travail — en move, les cartes du groupe ne se coupent jamais
	// entre elles (même delta : leurs écarts, donc leurs non-recouvrements, sont préservés).
	var keep = [], starts = [], bs = [];
	for (i = 0; i < progression.length; i++) { keep[i] = true; starts[i] = _entryStart(i); bs[i] = _entryBars(progression[i]); }
	for (i = 0; i < progression.length; i++) {
		if (v === "move" && seen[i]) continue;
		for (k = 0; k < idxs.length && keep[i]; k++) {
			var cs = starts[i], cb = bs[i], ce = cs + cb;
			if (ce <= st[k] + 1e-9 || cs >= en[k] - 1e-9) continue;
			if (cs < st[k] - 1e-9) cb = st[k] - cs;                       // sa queue tombe (ce qui dépasse aussi)
			else if (ce > en[k] + 1e-9) { cs = en[k]; cb = ce - en[k]; }  // sa tête tombe
			else { keep[i] = false; break; }                              // recouverte
			starts[i] = q(cs); bs[i] = q(cb);
			if (bs[i] < PROG_BARS_MIN - 1e-9) keep[i] = false;
		}
	}
	if (v === "move") for (k = 0; k < idxs.length; k++) starts[idxs[k]] = st[k];
	// (Pas de plafond de compte : il est tombé le 2026-09-18, #77 — la place décide seule.)
	// 3. Mutation : clones d'abord (sur les valeurs d'AVANT la coupe), puis coupe, puis départs.
	var clones = [], selCard = null;
	if (v === "copy") {
		for (k = 0; k < idxs.length; k++) {
			var c = _cloneEntry(progression[idxs[k]]);
			c.start = st[k];
			clones.push(c);
			if (idxs[k] === primary) selCard = c;
		}
	} else if (primary >= 0) selCard = progression[primary];
	for (i = progression.length - 1; i >= 0; i--) {
		if (!keep[i]) { progression.splice(i, 1); continue; }
		progression[i].start = starts[i];
		progression[i].bars = bs[i];
	}
	for (k = 0; k < clones.length; k++) progression.push(clones[k]);
	_progSort();
	progSel = -1;
	if (selCard) for (i = 0; i < progression.length; i++) if (progression[i] === selCard) { progSel = i; break; }
	broadcastProg();
}

// Hasard REPRODUCTIBLE pour l'écriture de clip. Le jeu live tire `Math.random()` et c'est très
// bien : chaque passe doit respirer différemment. Un clip, non — il est ÉCRIT, puis réécrit à
// chaque édition de la progression. Avec `Math.random()`, allonger la 5e carte re-tirerait le feel
// des quatre premières, et le geste le plus anodin détruirait un réglage qu'on venait d'aimer.
// D'où une suite déterministe, clavetée sur (carte, note) : elle a l'air aléatoire, elle ne bouge
// jamais. Pas de graine stockée sur la carte — la position EST la graine, donc rien à migrer.
function _clipRand(cardIdx, noteIdx, salt) {
	var x = (cardIdx + 1) * 374761393 + (noteIdx + 1) * 668265263 + salt * 2246822519;
	x = (x ^ (x >>> 13)) >>> 0;
	x = (x * 1274126177) >>> 0;
	x = (x ^ (x >>> 16)) >>> 0;
	return x / 4294967296;                     // [0, 1)
}
// Même forme en cloche que `_bell()` (somme de deux tirages), mais reproductible.
function _clipBell(cardIdx, noteIdx, salt) {
	return _clipRand(cardIdx, noteIdx, salt) + _clipRand(cardIdx, noteIdx, salt + 977) - 1;
}

function _progToNotes() {
	if (!progression.length) return null;
	var song = new LiveAPI(function(){}, "live_set");
	var num = song.get("signature_numerator");   num = parseInt((num instanceof Array) ? num[0] : num);
	var den = song.get("signature_denominator"); den = parseInt((den instanceof Array) ? den[0] : den);
	var barLen = (num > 0 && den > 0) ? (num * 4 / den) : CLIP_BEATS_PER_BAR;
	var notes = [], i, k;
	// Départ CUMULÉ, et non `i * barLen` : chaque carte occupe sa propre durée, donc la position
	// d'une carte dépend de tout ce qui la précède. C'est le seul endroit qui décide de la place
	// des accords dans le temps du clip.
	// EXPRESSION. Le clip reçoit ce qu'on entend : strum et humanize s'y écrivent, avec les
	// contrôles STRUM / HUMANIZE pour seule vérité. Tout à zéro (le défaut) redonne exactement le
	// bloc propre d'avant — pas de nouveau réglage, pas de surprise pour un set existant.
	// ⚠️ Le jeu live programme des Tasks en MILLISECONDES ; un clip se compte en TEMPS. La
	// conversion passe par le tempo, qu'il faut donc lire — l'oublier écrirait des strums 500 fois
	// trop larges à 120 BPM.
	var tempo = song.get("tempo"); tempo = parseFloat((tempo instanceof Array) ? tempo[0] : tempo);
	if (!(tempo > 0)) tempo = 120;
	var msToBeats = tempo / 60000;

	var mag = Math.abs(_strumMs), up = (_strumMs >= 0);
	var curveP = STRUM_CURVE_P[strumCurve] || 1.0;

	// tuple-dev#72 : chaque carte part de SON départ (mesures × longueur de mesure), plus du cumul — les trous
	// entre cartes sont des silences dans le clip. La longueur totale est la fin de la dernière carte.
	var acc = 0, total = _songBars() * barLen;       // le clip fait TOUTES les pages bout à bout (tuple-dev#74), même si la dernière carte finit avant
	for (i = 0; i < progression.length; i++) {
		var span = _entryBars(progression[i]) * barLen, ns = progression[i].notes;
		acc = _entryStart(i) * barLen;
		var n = ns.length;
		var strum = (mag > 0 && n > 1);

		var rank = _strumRank(ns);

		var T = strum ? (n - 1) * mag : 0;
		for (k = 0; k < n; k++) {
			var seq = strum ? _strumSeq(rank, k, n, up) : 0;
			var offMs = strum ? T * _strumFrac(seq, n, curveP) : 0;
			if (humanizeAmt) offMs += _clipBell(i, k, 1) * (humanizeAmt / 100 * 60);
			var off = offMs * msToBeats;
			// Jamais avant le départ de la carte : une note qui recule empiéterait sur l'accord
			// précédent, que l'utilisateur n'a pas touché.
			if (off < 0) off = 0;
			// Ni au-delà : un strum large sur une carte courte sortirait de sa place.
			if (off > span * 0.5) off = span * 0.5;

			var v = 100;
			if (strum && strumRamp) v = 100 * _strumRampFactor(seq, n, strumRamp);
			if (humanizeAmt) v += _clipBell(i, k, 2) * (humanizeAmt * 0.55);
			v = Math.round(v); if (v < 1) v = 1; if (v > 127) v = 127;
			v = _velPlage(v);   // même filtre qu'au jeu (#38) : un clip qui sonnerait plus fort mentirait

			// La note garde sa FIN sur la frontière de la carte : le strum retarde l'attaque, il ne
			// pousse pas la fin de l'accord dans le suivant.
			notes.push({ pitch: ns[k], start: acc + off, dur: span - off, vel: v });
		}
	}
	return { notes: notes, total: total, barLen: barLen };
}

// =====================================================
// LIVE-SYNC (tranche M) — lien PERSISTANT vers UN clip.
// sendclip ci-dessus résout le slot AU MOMENT DU CLIC (chemin highlighted_clip_slot, qui SUIT la
// sélection de l'utilisateur dans Live) puis oublie tout. Le lien, lui, mémorise l'**id LiveAPI
// concret** du clip à l'établissement : sans ça la 2e écriture partirait dans le slot sélectionné du
// moment, pas dans le clip lié. D'où la séparation établissement (crée) / réécriture (adresse par id).
// Plan : docs/superpowers/changes/2026-07-20-harmonybeam-integration/plan-m.md
// =====================================================

var _clipLink  = { id: null, track: "", clip: "", target: "session" };   // id null = aucun lien actif
var _clipDirty = false;                                        // une réécriture est déjà planifiée

// CLIP-AUTO-FOCUS (#45) — trois états qui décident SEULS si Tuple a le droit d'écrire.
//   _clipFollow   : le suivi de la sélection Live est-il armé (toggle utilisateur, OFF au chargement).
//   _clipOwned    : Tuple a-t-il CRÉÉ ce clip ? Un clip qu'il a créé lui appartient — écritures
//                   libres. Un clip ATTACHÉ par Follow appartient à l'utilisateur : la première
//                   écriture demande un oui, UNE fois, et le clip devient nôtre ensuite.
//   _replaceArmed : cette question est-elle posée en ce moment (l'UI affiche REPLACE?).
// La doctrine vient de _linkAdopt, supprimé ici : « adopter un clip qu'on voulait lire, c'est le
// perdre — d'où le libellé qui NOMME l'action ». Follow supprime ce geste nommé ; la confirmation
// le remplace, sinon un simple clic dans Live suffirait à effacer le clip de quelqu'un.
var _clipFollow   = false;
var _clipOwned    = false;
var _replaceArmed = false;
var _followObs    = [];

// Le clip lié existe-t-il encore ? (l'utilisateur peut l'avoir supprimé dans Live)
// Renvoie l'objet LiveAPI, ou null — l'appelant rompt alors le lien proprement.
function _clipLinkApi() {
	if (!_clipLink.id) return null;
	try {
		var c = new LiveAPI(function(){}, "id " + _clipLink.id);
		if (!c || !c.id || parseInt(c.id) === 0) return null;
		if (!c.path || String(c.path) === "") return null;   // id survivant mais objet détruit
		return c;
	} catch (e) { post("cliplink: id mort (" + e + ")\n"); return null; }
}

// Réécrit le clip LIÉ. Jamais create_clip : le clip existe déjà et nous appartient.
function _clipRewrite() {
	var c = _clipLinkApi();
	if (!c) { if (_clipLink.id) { post("cliplink: clip disparu -> lien rompu\n"); _linkClear(); } return; }
	try {
		var b = _progToNotes();
		c.call("remove_notes_extended", 0, 128, 0, 1000000);   // table rase sur toute la plage
		if (!b) { post("cliplink: progression vide -> clip vide (lien conserve)\n"); return; }
		c.call("add_new_notes", { notes: _notesLom(b.notes) });
		// Longueur : length et end_time sont LECTURE SEULE au LOM ; loop_end/end_marker sont les
		// seules écrivables. Sans ça, passer de 4 à 8 accords écrirait 8 mesures dans un clip de 4 →
		// la moitié de la progression hors du clip, silencieusement.
		c.set("loop_end", b.total);
		c.set("end_marker", b.total);
		// ⚠️ EN ARRANGEMENT, LES DEUX LIGNES CI-DESSUS NE SUFFISENT PAS, et ça a produit un bug
		// signalé « changer un accord ne marche pas en Arrangement ». Un clip d'arrangement occupe
		// [start_time, end_time] sur la timeline, et cette étendue N'EST PAS `loop_end`. Mesuré le
		// 2026-08-18 sur Live 12.2.1 : `end_time` et `length` n'ont PAS DE SETTER, et écrire
		// `end_marker`/`loop_end` laisse `end_time` inchangé. Constat pris sur le vif — un clip à
		// `start=64 end=80` (16 temps visibles) portait `length=20` : le 5e accord était bien écrit
		// mais tombait HORS de la zone jouée. Rien ne le signalait.
		// La seule sortie est donc de RECRÉER le clip à la bonne longueur, et de relier le neuf.
		if (_clipLink.target === "arrangement") _clipArrFit(b);
		post("cliplink: " + progression.length + " accords reecrits (" + b.total + " temps)\n");
	} catch (e) { outlet(7, "cliperr"); post("cliplink REWRITE ERR " + e + "\n"); }
}

// Ajuste l'ÉTENDUE d'un clip d'arrangement à la longueur de la progression, en le recréant.
// Appelé seulement quand l'étendue ne colle plus : recréer à chaque réécriture ferait clignoter le
// clip et lui ferait perdre son id sans raison.
//
// Ce que la recréation coûte, et il faut le savoir : le clip perd ses propriétés propres (nom,
// couleur, réglages). Tuple est propriétaire du clip lié, donc c'est acceptable — mais c'est le
// seul endroit du live-sync qui DÉTRUIT puis reconstruit, au lieu de réécrire en place.
function _clipArrFit(b) {
	try {
		var c = _clipLinkApi();
		if (!c) return;
		var st = c.get("start_time"); st = parseFloat((st instanceof Array) ? st[0] : st);
		var en = c.get("end_time");   en = parseFloat((en instanceof Array) ? en[0] : en);
		if (!(st >= 0) || !(en > st)) return;
		if (Math.abs((en - st) - b.total) < 0.001) return;      // l'étendue est déjà la bonne

		var tr = new LiveAPI(function(){}, "live_set view selected_track");
		if (!tr || !tr.id || parseInt(tr.id) === 0) return;
		// La piste du LIEN, pas celle sélectionnée : l'utilisateur a pu changer de piste entre-temps.
		var owner = c.get("canonical_parent");
		var ids = _lomIds(owner || []);
		if (ids.length) tr = new LiveAPI(function(){}, "id " + ids[0]);

		tr.call("delete_clip", "id", _clipLink.id);
		tr.call("create_midi_clip", st, b.total);

		// Retrouver le neuf par sa POSITION, comme à l'établissement.
		var found = _clipParPosition(tr, st);
		if (found === null) { post("cliplink: recreation arrangement -> clip introuvable, lien rompu\n"); _linkClear(); return; }

		_clipLink.id = String(found);
		var nc = new LiveAPI(function(){}, "id " + _clipLink.id);
		nc.call("add_new_notes", { notes: _notesLom(b.notes) });
		_linkPlayWatch();   // l'id a changé : l'observateur de lecture suit le clip recréé (tuple-dev#77)
		post("cliplink: clip d'arrangement recree a " + b.total + " temps (id " + _clipLink.id + ")\n");
	} catch (e) { post("cliplink ARRFIT ERR " + e + "\n"); }
}

// DÉTECTION DU CLIP VISÉ — pour pouvoir ADOPTER un clip qui existe déjà, au lieu de ne savoir lier
// que ceux que Tuple vient de créer.
//
// ⚠️ Résolu AU MOMENT DU CLIC, jamais par un observateur, et c'est une correction. Un premier jet
// observait `detail_clip` et basculait l'action sur « adopter » dès qu'un clip était sélectionné.
// Mesuré : dans Live `detail_clip` reste garni en permanence dès qu'on a touché un clip une fois,
// donc WRITE CLIP ne créait PLUS JAMAIS de clip neuf. Une détection ne doit pas détourner l'action
// par défaut.
//
// ⚠️ Et `highlighted_clip_slot` N'EST PAS OBSERVABLE de toute façon : mesuré le 2026-08-18 sur
// Live 12.2.1, `live_set view` n'expose aucun `highlighted_clip_slot_listener` — seuls
// `detail_clip`, `selected_scene` et `selected_track` en ont un. Le réflexe (observer le slot que
// lit déjà `_linkEstablish`) n'existe pas.
//
// La résolution SUIT LA CIBLE, et ce n'est pas un détail — c'est ce qui empêche `detail_clip` de
// détourner l'action une seconde fois :
//   cible Session      -> SEUL le slot surligné fait foi. Slot vide = créer, point. `detail_clip`
//                         reste garni en permanence dès qu'on a ouvert un clip une fois, y compris
//                         un clip d'ARRANGEMENT : le consulter ici ferait « adopter » alors que
//                         l'utilisateur pointe un slot vide (mesuré, deuxième fois).
//   cible Arrangement  -> `detail_clip`, et seulement s'il EST un clip d'arrangement. La vue
//                         Arrangement n'a pas de slots, il n'y a pas d'autre désignation.
// Renvoie l'id, ou null (= créer un clip neuf).
function _clipAimed() {
	try {
		if (_clipLink.target === "arrangement") {
			// ⚠️ PAS `detail_clip` : il reste garni en permanence, donc s'y fier interdirait à
			// jamais de créer un clip neuf dès qu'on en a ouvert un (mesuré deux fois, une fois
			// par cible). Ce qui joue le rôle du slot en vue Arrangement, c'est la POSITION :
			// « y a-t-il un clip là où je vais écrire ? ». Même question qu'en Session, posée à
			// la géométrie plutôt qu'à la sélection.
			var b = _progToNotes();
			if (!b) return null;
			var tr = new LiveAPI(function(){}, "live_set view selected_track");
			if (!tr || !tr.id || parseInt(tr.id) === 0) return null;
			var song = new LiveAPI(function(){}, "live_set");
			var now = song.get("current_song_time"); now = parseFloat((now instanceof Array) ? now[0] : now);
			if (!(now >= 0)) now = 0;
			var at = Math.floor(now / b.barLen) * b.barLen;
			var ids = _lomIds(tr.get("arrangement_clips") || []), i;
			for (i = 0; i < ids.length; i++) {
				var ex = new LiveAPI(function(){}, "id " + ids[i]);
				var s = ex.get("start_time"); s = parseFloat((s instanceof Array) ? s[0] : s);
				var e = ex.get("end_time");   e = parseFloat((e instanceof Array) ? e[0] : e);
				if (s < at + b.total && e > at && _clipIsMidi(ex)) return String(ids[i]);
			}
			return null;
		}
		var slot = new LiveAPI(function(){}, "live_set view highlighted_clip_slot");
		if (slot && slot.id && parseInt(slot.id) !== 0) {
			var has = slot.get("has_clip"); has = (has instanceof Array) ? has[0] : has;
			if (parseInt(has) === 1) {
				var c = new LiveAPI(function(){}, "live_set view highlighted_clip_slot clip");
				if (c && c.id && parseInt(c.id) !== 0 && _clipIsMidi(c)) return String(c.id);
			}
		}
	} catch (e) { post("clipaimed err " + e + "\n"); }
	return null;
}

// Un clip AUDIO ne peut pas porter une progression : l'adopter mènerait à un échec d'écriture
// incompréhensible. Il est traité comme « rien de visé ».
function _clipIsMidi(c) {
	try { var m = c.get("is_midi_clip"); m = (m instanceof Array) ? m[0] : m; return parseInt(m) === 1; }
	catch (e) { return false; }
}

// Cible du lien : Session (défaut, comportement historique) ou Arrangement.
// Changer de cible ROMPT le lien courant — on ne migre pas un clip d'une vue à l'autre, et garder
// un lien Session actif en cible Arrangement ferait réécrire un clip que l'utilisateur ne regarde
// plus. La réécriture, elle, est IDENTIQUE dans les deux cas : elle adresse par id, et un clip
// d'arrangement accepte `remove_notes_extended` / `add_new_notes` comme un clip de session
// (mesuré le 2026-08-18 sur Live 12.2.1). Seule la CRÉATION diverge.
// ⚠️ La cible change la QUESTION : « ce slot est-il occupe ? » en Session,
// « y a-t-il un clip sous la tete de lecture ? » en Arrangement. Le libelle doit
// donc se recalculer ici, aucun observateur ne le reveillera.
function cliptarget(v) {
	var t = (parseInt(v) === 1) ? "arrangement" : "session";
	if (t === _clipLink.target) return;
	if (_clipLink.id) { post("cliplink: changement de cible -> lien rompu\n"); _linkClear(); }
	_clipLink.target = t;
	outlet(7, "cliptarget", t);
	_pushClipHere();
}

// Établit le lien : crée UN clip et mémorise son id.
// Refuse un emplacement occupé par un clip ÉTRANGER (sécurité non destructive héritée de sendclip) ;
// une fois le lien établi, la réécriture de NOTRE clip est libre — refus à l'établissement,
// propriété ensuite.
function _linkEstablish() {
	if (!progression.length) { outlet(7, "clipempty"); post("cliplink: progression vide\n"); return; }
	if (_clipLink.target === "arrangement") { _linkEstablishArr(); return; }
	try {
		var b = _progToNotes();
		var slot = new LiveAPI(function(){}, "live_set view highlighted_clip_slot");
		if (!slot || !slot.id || parseInt(slot.id) === 0) { outlet(7, "clipnoslot"); post("cliplink: aucun slot selectionne\n"); return; }
		var has = slot.get("has_clip"); has = (has instanceof Array) ? has[0] : has;
		if (parseInt(has) === 1) { outlet(7, "clipbusy"); post("cliplink: slot occupe -> choisir un slot vide\n"); return; }
		slot.call("create_clip", b.total);
		var clip = new LiveAPI(function(){}, "live_set view highlighted_clip_slot clip");
		if (!clip || !clip.id || parseInt(clip.id) === 0) { outlet(7, "clipnoslot"); post("cliplink: clip non cree\n"); return; }
		_clipLink.id = String(clip.id);
		_clipLink.clip = _clipName(clip);
		_clipOwned = true;   // créé par Tuple : il est à nous, aucune question à poser
		var tr = new LiveAPI(function(){}, "live_set view selected_track");   // le slot surligné appartient à la piste sélectionnée
		var nm = tr.get("name"); nm = (nm instanceof Array) ? nm[0] : nm;
		_clipLink.track = String(nm);
		_clipRewrite();
		_linkAnnounce();
		_linkPlayWatch();   // le passthrough suit la lecture de CE clip (tuple-dev#77)
		post("cliplink: etabli sur id " + _clipLink.id + " (" + _clipLink.track + ")\n");
	} catch (e) { outlet(7, "cliperr"); post("cliplink ESTABLISH ERR " + e + "\n"); }
}

// Établissement en cible ARRANGEMENT. Chemin LiveAPI DISTINCT de la Session : `Track.create_midi_clip`
// et non `ClipSlot.create_clip`. Signature MESURÉE le 2026-08-18 sur Live 12.2.1 (elle n'est pas
// devinable et le plan interdisait de l'appeler sans la vérifier) : create_midi_clip(start_time, length),
// les DEUX arguments requis — 1 seul ou zéro lève ArgumentError.
function _linkEstablishArr() {
	try {
		var b = _progToNotes();
		var tr = new LiveAPI(function(){}, "live_set view selected_track");
		if (!tr || !tr.id || parseInt(tr.id) === 0) { outlet(7, "clipnoslot"); post("cliplink: aucune piste selectionnee\n"); return; }

		// Position : la tête de lecture, ramenée au DÉBUT DE MESURE. Non arrondie, elle poserait le
		// clip à un temps quelconque (mesuré : 374.37) — inexploitable et impossible à retrouver.
		var song = new LiveAPI(function(){}, "live_set");
		var now = song.get("current_song_time"); now = parseFloat((now instanceof Array) ? now[0] : now);
		if (!(now >= 0)) now = 0;
		var at = Math.floor(now / b.barLen) * b.barLen;

		// Non destructif : refuser si un clip d'arrangement CHEVAUCHE [at, at + total).
		// L'équivalent du « slot occupé » de la Session, qui n'a pas de sens ici (pas de slots).
		var clips = tr.get("arrangement_clips") || [];
		var i, ids = _lomIds(clips);
		for (i = 0; i < ids.length; i++) {
			var ex = new LiveAPI(function(){}, "id " + ids[i]);
			var s = ex.get("start_time"); s = parseFloat((s instanceof Array) ? s[0] : s);
			var e = ex.get("end_time");   e = parseFloat((e instanceof Array) ? e[0] : e);
			if (s < at + b.total && e > at) { outlet(7, "clipbusy"); post("cliplink: arrangement occupe a " + at + " -> deplacer la tete de lecture\n"); return; }
		}

		tr.call("create_midi_clip", at, b.total);

		var found = _clipParPosition(tr, at);
		if (found === null) { outlet(7, "cliperr"); post("cliplink: clip d'arrangement introuvable apres creation\n"); return; }

		_clipLink.id = String(found);
		_clipLink.clip = _clipName(new LiveAPI(function(){}, "id " + _clipLink.id));
		_clipOwned = true;   // créé par Tuple, comme en Session
		var nm = tr.get("name"); nm = (nm instanceof Array) ? nm[0] : nm;
		_clipLink.track = String(nm);
		_clipRewrite();
		_linkAnnounce();
		_linkPlayWatch();   // le passthrough suit la lecture de CE clip (tuple-dev#77)
		post("cliplink: etabli (arrangement) sur id " + _clipLink.id + " a " + at + " (" + _clipLink.track + ")\n");
	} catch (e) { outlet(7, "cliperr"); post("cliplink ESTABLISH ARR ERR " + e + "\n"); }
}

// Une propriété LOM « liste d'objets » revient aplatie en ["id", N, "id", M, …]. Extraire les N.
// Écrit une fois ici : le faire à la main sur chaque site rejouerait l'erreur d'indice à chaque appel.
function _lomIds(flat) {
	var out = [], i;
	if (!flat || !flat.length) return out;
	for (i = 0; i < flat.length; i++) {
		if (String(flat[i]) === "id" && i + 1 < flat.length) { out.push(flat[i + 1]); i++; }
	}
	// Certaines versions rendent déjà une liste d'ids nus : ne pas rendre un tableau vide en silence.
	if (!out.length) for (i = 0; i < flat.length; i++) if (parseInt(flat[i]) > 0) out.push(flat[i]);
	return out;
}

// Les notes de `_progToNotes` vers les dicts que `add_new_notes` attend. La boucle vivait
// en DEUX copies a soixante lignes d'ecart, avec deux noms d'accumulateur (`arr`, `arr2`)
// et deux noms d'indice pour eviter la collision — le genre de divergence cosmetique qui
// masque une divergence reelle. Meme raison que `_lomIds` juste au-dessus.
function _notesLom(notes) {
	var out = [], i;
	for (i = 0; i < notes.length; i++) {
		out.push({ pitch: notes[i].pitch, start_time: notes[i].start, duration: notes[i].dur, velocity: notes[i].vel });
	}
	return out;
}

// Retrouve un clip d'arrangement par sa POSITION, jamais par la valeur de retour de
// `create_midi_clip` : `call` ne rend pas un id exploitable de facon fiable cote Max, et
// `start_time` est exact. Rend l'id, ou null — jamais une valeur plausible.
//
// ⚠️ LA TOLERANCE EST LOAD-BEARING. Les temps du LOM sont des flottants : une comparaison
// stricte raterait le clip qu'on vient de creer. Elle etait ecrite 0.001 aux deux sites ;
// deux copies d'un seuil, c'est un seuil qu'on peut regler a moitie.
function _clipParPosition(tr, at) {
	var ids = _lomIds(tr.get("arrangement_clips") || []), i;
	for (i = 0; i < ids.length; i++) {
		var c = new LiveAPI(function(){}, "id " + ids[i]);
		var cs = c.get("start_time"); cs = parseFloat((cs instanceof Array) ? cs[0] : cs);
		if (Math.abs(cs - at) < 0.001) return ids[i];
	}
	return null;
}

// Rompt le lien. NE TOUCHE PAS au clip dans Live : il reste tel quel, il cesse simplement d'être suivi.
function _linkClear() {
	_clipLink.id = null; _clipLink.track = ""; _clipLink.clip = "";
	_clipOwned = false;
	if (_replaceArmed) { _replaceArmed = false; outlet(7, "clipreplace", 0); }
	_linkPlayWatch();   // id null : l'observateur tombe, le passthrough se relâche
	outlet(7, "linkoff");
}

// ── Observateur de lecture du clip lié (tuple-dev#77, 2026-09-18) ─────────────
// `is_playing` du clip lié pilote le passthrough de midinote (voir _passNote). Posé à
// chaque (ré)attache — établissement Session/Arrangement, FOLLOW, recréation d'étendue —
// et retiré au linkoff. À la PRISE de lecture, l'accord de grille tenu est relâché
// (sinon il sonnerait sous le clip) ; à l'ARRÊT, les passthrough tenues partent en
// note-off et le remappage grille reprend.
var _linkPlayObs = null, _linkPlaying = false;
function _linkPlayCb(args) {
	if (!args || String(args[0]) !== "is_playing") return;
	var on = !!parseInt(args[1]);
	if (on === _linkPlaying) return;
	_linkPlaying = on;
	if (on) _releaseHeld();
	else _passRelease();
}
function _linkPlayWatch() {
	if (_linkPlaying) { _linkPlaying = false; _passRelease(); }
	try {
		if (_linkPlayObs) { try { _linkPlayObs.property = ""; } catch (e) {} }
		_linkPlayObs = null;
		if (!_clipLink.id) return;
		_linkPlayObs = new LiveAPI(_linkPlayCb, "id " + _clipLink.id);
		_linkPlayObs.property = "is_playing";
	} catch (e) { post("linkplay: " + e + "\n"); }
}

// Nom du clip lié, pour l'indicateur 🔗. Un clip sans nom rend "" et l'UI n'affiche alors que la
// piste : fabriquer « Clip 3 » côté moteur mentirait sur ce que Live montre.
function _clipName(c) {
	try { var n = c.get("name"); n = (n instanceof Array) ? n[0] : n; return (n === undefined || n === null) ? "" : String(n); }
	catch (e) { return ""; }
}

// Une seule façon d'annoncer le lien : trois sites l'émettaient à la main, et le nom du clip
// aurait dû s'ajouter aux trois.
function _linkAnnounce() {
	outlet(7, "linkon", _clipLink.track, _clipLink.clip);
}

// Marque « à réécrire » et planifie UNE réécriture. Le drapeau est ce qui coalesce : dix mutations dans
// le même geste produisent UNE écriture, pas dix.
// Le passage par _taskDefer n'est PAS cosmétique : une modif de Live appelée depuis un callback
// d'OBSERVATEUR LiveAPI échoue SILENCIEUSEMENT (ré-entrance) — cf. docs/decisions.md § Gotchas LiveAPI.
function _clipSyncDirty() {
	if (!_clipLink.id) return;
	// Clip attaché par Follow et jamais confirmé : on POSE la question au lieu d'écrire. L'écriture
	// n'est pas mise en file — répondre oui relance _clipSyncDirty, et une file voudrait dire qu'un
	// oui donné plus tard écrit un état de progression qui n'existe plus.
	if (!_clipOwned) {
		if (!_replaceArmed) { _replaceArmed = true; outlet(7, "clipreplace", 1); post("cliplink: clip etranger vise -> REPLACE? en attente\n"); }
		return;
	}
	if (_clipDirty) return;
	_clipDirty = true;
	_taskDefer(function(){ _clipDirty = false; _clipRewrite(); });
}

// CLIP-AUTO-FOCUS (#45) — Follow : le clip SÉLECTIONNÉ dans Live devient la cible d'édition.
//
// Remplace l'ADOPTION à deux clics (supprimée ici) : le bouton unique armait « REPLACE? » puis
// adoptait au second clic. Follow rend l'attache automatique, donc le geste qui NOMMAIT le
// remplacement disparaît — la confirmation se déplace au premier ÉCRIT (voir _clipSyncDirty),
// une fois par clip. Attacher ne détruit rien ; écrire, si.
//
// ⚠️ `detail_clip` est TOUJOURS garni dès qu'un clip a été ouvert une fois (mesuré, deux fois).
// L'absence de cible est donc un état de TUPLE (`_clipLink.id === null`), jamais une lecture de
// Live. Un slot vide sélectionné ne détache pas : il n'y a simplement rien à viser.
//
// ⚠️ `highlighted_clip_slot` n'est PAS observable (mesuré le 2026-08-18, Live 12.2.1) — d'où
// l'observateur COMPOSÉ : `detail_clip` bouge quand on ouvre un clip, `selected_track` et
// `selected_scene` couvrent le déplacement de la sélection dans la grille de Session. À chaque
// réveil on RÉSOUT, on ne croit pas la propriété qui a bougé.

var FOLLOW_PROPS = ["detail_clip", "selected_track", "selected_scene"];

// Quel clip l'utilisateur regarde-t-il ? Distinct de `_clipAimed()`, qui répond « où écrirais-je
// si je créais » et suit donc le réglage de CIBLE. Ici la question est « que montre Live », et la
// réponse suit le clip, pas le réglage.
//   Session     : le slot surligné fait foi. `detail_clip` y est trompeur (il reste garni).
//   Arrangement : pas de slots, `detail_clip` est la seule désignation — et seulement s'il EST
//                 un clip d'arrangement, sinon un vieux clip de session serait re-visé.
function _clipSelected() {
	try {
		var slot = new LiveAPI(function(){}, "live_set view highlighted_clip_slot");
		if (slot && slot.id && parseInt(slot.id) !== 0) {
			var has = slot.get("has_clip"); has = (has instanceof Array) ? has[0] : has;
			if (parseInt(has) === 1) {
				var c = new LiveAPI(function(){}, "live_set view highlighted_clip_slot clip");
				if (c && c.id && parseInt(c.id) !== 0) return _clipIsMidi(c) ? String(c.id) : null;
			}
		}
		var d = new LiveAPI(function(){}, "live_set view detail_clip");
		if (d && d.id && parseInt(d.id) !== 0 && _clipIsMidi(d)) {
			var arr = d.get("is_arrangement_clip"); arr = (arr instanceof Array) ? arr[0] : arr;
			if (parseInt(arr) === 1) return String(d.id);
		}
	} catch (e) { post("clipselected err " + e + "\n"); }
	return null;
}

// Attache SANS écrire. C'est tout l'écart avec l'adoption : le clip devient la cible, son contenu
// reste intact tant que la progression ne bouge pas — et la première écriture demandera un oui.
function _clipAttach(id) {
	try {
		var c = new LiveAPI(function(){}, "id " + id);
		if (!c || !c.id || parseInt(c.id) === 0) return;
		_clipLink.id = String(id);
		_clipOwned = false;
		if (_replaceArmed) { _replaceArmed = false; outlet(7, "clipreplace", 0); }
		// La cible suit le clip attaché : un clip d'arrangement suivi en réglage Session ferait
		// mentir l'affichage, et la RECRÉATION d'étendue (_clipArrFit) se poserait sur la mauvaise
		// branche.
		var arr = c.get("is_arrangement_clip"); arr = (arr instanceof Array) ? arr[0] : arr;
		var t = (parseInt(arr) === 1) ? "arrangement" : "session";
		if (t !== _clipLink.target) { _clipLink.target = t; outlet(7, "cliptarget", t); }
		var tr = new LiveAPI(function(){}, "live_set view selected_track");
		var nm = tr.get("name"); nm = (nm instanceof Array) ? nm[0] : nm;
		_clipLink.track = String(nm);
		_clipLink.clip = _clipName(c);
		_linkAnnounce();
		_linkPlayWatch();   // le passthrough suit la lecture du clip attaché (tuple-dev#77)
		post("cliplink: FOLLOW attache le clip id " + _clipLink.id + " (" + _clipLink.track + ")\n");
	} catch (e) { outlet(7, "cliperr"); post("cliplink ATTACH ERR " + e + "\n"); }
}

// Réveil d'observateur. VERROU PAR ID : re-attacher le clip déjà suivi ré-émettrait `linkon` et
// remettrait `_clipOwned` à false — donc reposerait REPLACE? sur un clip déjà confirmé, à chaque
// clic dans Live.
// Reveil d'observateur : DEUX consommateurs, un seul jeu d'observateurs.
// `_followResolve` ne travaille que si FOLLOW est arme ; `_pushClipHere` travaille
// toujours, parce que le bouton doit dire ce qu'il fera meme sans suivi.
function _followReveil() {
	_followResolve();
	_pushClipHere();
}

function _followResolve() {
	if (!_clipFollow) return;
	var id = _clipSelected();
	if (!id) return;                                       // slot vide, clip audio : rien à viser
	if (_clipLink.id && String(id) === String(_clipLink.id)) return;
	_clipAttach(id);
}

// ⚠️ Le corps est DIFFÉRÉ : toute écriture LiveAPI faite depuis un callback d'observateur échoue
// SILENCIEUSEMENT (ré-entrance). _clipAttach ne fait que lire, mais une confirmation peut suivre
// immédiatement — et la règle tient mieux appliquée partout qu'au cas par cas.
// ⚠️ Demarre au CHARGEMENT, plus seulement quand FOLLOW s'allume : le libelle du
// bouton depend de la selection dans Live, donc il lui faut les memes reveils.
// `_followResolve` garde son propre garde `if (!_clipFollow) return`, le suivi ne
// s'active donc pas pour autant.
function _followStart() {
	if (typeof LiveAPI === 'undefined') return;
	if (_followObs.length) return;
	var i;
	for (i = 0; i < FOLLOW_PROPS.length; i++) {
		try {
			var o = new LiveAPI(function(){ _taskDefer(_followReveil); }, "live_set view");
			o.property = FOLLOW_PROPS[i];
			_followObs.push(o);
		} catch (e) { post("follow: observateur " + FOLLOW_PROPS[i] + " refuse (" + e + ")\n"); }
	}
}

function _followStop() {
	var i;
	for (i = 0; i < _followObs.length; i++) {
		try { _followObs[i].property = ""; } catch (e) {}
	}
	_followObs = [];
}

// Toggle FOLLOW. OFF ne détache que ce que FOLLOW a attaché : un clip CRÉÉ par Tuple (CREATE CLIP)
// lui appartient et reste lié — couper le suivi n'est pas jeter son propre clip.
function clipfollow(v) {
	var on = parseInt(v) !== 0;
	_clipFollow = on;
	outlet(7, "clipfollow", on ? 1 : 0);
	if (on) { _followStart(); _taskDefer(_followResolve); }
	else {
		// ⚠️ On ne coupe PLUS les observateurs ici. Ils servent aussi au libelle du
		// bouton, qui doit rester juste quand le suivi est eteint. `_followResolve`
		// se garde tout seul.
		if (_clipLink.id && !_clipOwned) _linkClear();
	}
	post("cliplink: follow " + (on ? "ON" : "OFF") + "\n");
}

// « × détacher » de la barre Follow. Détacher en LAISSANT le suivi armé n'aurait pas de sens : le
// clic suivant dans Live ré-attacherait aussitôt. Le geste coupe donc les deux, et l'UI retombe
// exactement sur l'état « Détaché — aucun clip édité » de la maquette.
function clipdetach() {
	if (_clipFollow) { _clipFollow = false; _followStop(); outlet(7, "clipfollow", 0); }
	if (_clipLink.id) { post("cliplink: detache par l'utilisateur\n"); _linkClear(); }
	else outlet(7, "linkoff");
}

// Réponse à REPLACE? — 1 = oui, écrase ; 0 = non, on reste attaché sans rien écrire.
// Le oui rend le clip NÔTRE : la question ne se repose pas à chaque accord.
function clipreplace(v) {
	if (!_replaceArmed) return;
	_replaceArmed = false;
	outlet(7, "clipreplace", 0);
	if (parseInt(v) !== 1) { post("cliplink: REPLACE refuse -> clip intact\n"); return; }
	_clipOwned = true;
	post("cliplink: REPLACE accepte -> le clip " + _clipLink.id + " devient la cible\n");
	_clipSyncDirty();
}

// CREATE CLIP (ex-WRITE CLIP) — un seul rôle depuis #45 : CRÉER un clip là où il n'y en a pas.
// Sur un clip existant il est INERTE : c'est Follow qui édite un clip déjà là, et lui seul demande
// la confirmation. Un bouton qui ferait les deux redeviendrait le bouton qui détruit en silence.
// « Y a-t-il un clip la ou j'ecrirais ? », diffuse a l'UI pour que le bouton DISE
// ce qu'il va faire au lieu de le decouvrir au clic. `_clipAimed()` pose deja la
// question a la GEOMETRIE — slot surligne en Session, tete de lecture en
// Arrangement — et non a `detail_clip`, qui reste garni en permanence.
//
// ⚠️ Memoise : sans le garde d'egalite, chaque reveil d'observateur reemettrait
// le meme etat, et l'UI repeindrait un bouton qui n'a pas change.
var _clipHere = -1;
function _pushClipHere() {
	var v = _clipAimed() ? 1 : 0;
	if (v === _clipHere) return;
	_clipHere = v;
	outlet(7, "cliphere", v);
}

// CREATE CLIP / APPLY TO CLIP — un seul bouton, deux actions selon ce qui est vise.
//
// Il REFUSAIT quand un clip occupait la cible (`clipbusy`), en renvoyant vers
// FOLLOW. C'etait une impasse : le geste naturel — selectionner un clip, cliquer
// pour y imprimer la progression — ne menait nulle part.
//
// ⚠️ Adopter n'ECRIT PAS. `_clipAttach` pose `_clipOwned = false`, donc la
// premiere ecriture passe par `_clipSyncDirty` qui arme REPLACE? et attend un
// oui. C'est ce qui rend l'adoption sure : attacher ne detruit rien, ecrire si.
function writeclip() {
	var aim = _clipAimed();
	if (aim) {
		_clipAttach(aim);
		_clipSyncDirty();   // arme REPLACE? : le clip appartient encore a l'utilisateur
		post("cliplink: clip existant adopte (id " + aim + ") -> REPLACE? en attente\n");
		return;
	}
	_linkEstablish();
}

// CHORDIFY : SUPPRIMÉ le 2026-08-20. Transformait un clip de notes-déclencheurs en accords
// Tuple — remplacé par l'édition en direct du clip (Clip Target + live-sync, sessions 60/60b),
// qui écrit les accords sans passer par un enregistrement de déclencheurs. Retiré : message
// `chordify` (table LIST_DISPATCH + bouton du dock jweb), _chordifyMode/_chordifyResult,
// _readClipNotes, _chordifyNotes. Historique complet : docs/decisions.md (2026-06-16 → 2026-08-20).

// =====================================================
// TYPES D'ACCORDS
// =====================================================
// ⚠️ LES QUATRE `var q` ONT ÉTÉ RETIRÉS LE 2026-09-16. Chacun classait la qualité de
// l'accord — dim/aug/m, M7/ø7/dim7/m7, M9/m9, m — puis n'était JAMAIS relu : `sendChord`
// reçoit `gridLabel(d, fn, iv)`, qui refait la classification pour son compte. Neuf lignes
// sur le chemin chaud d'émission de note, pour rien. `iv` reste : il est l'argument de
// `gridLabel`.

function triad(d) {
	d = parseInt(d); lastFn = "triad"; lastDegree = d;
	if (!gridTypeValid(d, "triad")) { post("triad " + d + " : hors grille\n"); return; }
	var notes = buildNotes(d, [0,2,4]);
	var iv = getIntervals(d);
	sendChord(gridLabel(d, "triad", iv), notes);
}

function seven(d) {
	d = parseInt(d); lastFn = "seven"; lastDegree = d;
	if (!gridTypeValid(d, "seven")) { post("seven " + d + " : invalid\n"); return; }
	var notes = buildNotes(d, [0,2,4,6]);
	var iv = getIntervals(d);
	sendChord(gridLabel(d, "seven", iv), notes);
}

function nine(d) {
	d = parseInt(d); lastFn = "nine"; lastDegree = d;
	// La grille tranche seule. Les deux `isValid` qui élargissaient cette garde acceptaient
	// une neuvième sur un degré dont la gamme n'a pas la note — huit cases sur les deux
	// pentatoniques, que `_scaleAllowsSpec` refuse et que la grille ne montre donc jamais.
	if (!gridTypeValid(d, "nine")) { post("nine " + d + " : hors grille\n"); return; }
	var notes = buildNotes(d, [0,2,4,6,8]);
	var iv = getIntervals(d);
	sendChord(gridLabel(d, "nine", iv), notes);
}

function add9(d) {
	d = parseInt(d); lastFn = "add9"; lastDegree = d;
	if (!gridTypeValid(d, "add9")) { post("add9 " + d + " : invalid\n"); return; }
	var notes = buildNotes(d, [0,2,4,8]);
	var iv = getIntervals(d);
	sendChord(gridLabel(d, "add9", iv), notes);
}

function sus2(d) {
	d = parseInt(d); lastFn = "sus2"; lastDegree = d;
	if (!gridTypeValid(d, "sus2")) { post("sus2 " + d + " : invalid\n"); return; }
	var notes = buildNotes(d, [0,1,4]);
	sendChord(gridLabel(d, "sus2"), notes);
}

function sus4(d) {
	d = parseInt(d); lastFn = "sus4"; lastDegree = d;
	if (!gridTypeValid(d, "sus4")) { post("sus4 " + d + " : invalid\n"); return; }
	var notes = buildNotes(d, [0,3,4]);
	sendChord(gridLabel(d, "sus4"), notes);
}

// ----- Nouveaux types -----

function six(d) {
	d = parseInt(d); lastFn = "six"; lastDegree = d;
	if (!gridTypeValid(d, "six")) return;
	var notes = buildNotes(d, [0,2,4,5]);        // root, 3ce, 5te, 6te
	var iv = getIntervals(d);
	sendChord(gridLabel(d, "six", iv), notes);
}

function sixnine(d) {
	d = parseInt(d); lastFn = "sixnine"; lastDegree = d;
	if (!gridTypeValid(d, "sixnine")) return;
	var notes = buildNotes(d, [0,2,4,5,8]);      // + 9e
	var iv = getIntervals(d);
	sendChord(gridLabel(d, "sixnine", iv), notes);
}

function sevensus4(d) {
	d = parseInt(d); lastFn = "sevensus4"; lastDegree = d;
	if (!gridTypeValid(d, "sevensus4")) return;
	var notes = buildNotes(d, [0,3,4,6]);        // root, 4te, 5te, 7e
	sendChord(gridLabel(d, "sevensus4"), notes);
}

function mmaj7(d) {
	d = parseInt(d); lastFn = "mmaj7"; lastDegree = d;
	if (!gridTypeValid(d, "mmaj7")) return;
	var notes = buildNotes(d, [0,2,4,6]);        // root, 3ce min, 5te, 7e maj
	sendChord(gridLabel(d, "mmaj7"), notes);
}

function sevenflat9(d) {
	d = parseInt(d); lastFn = "sevenflat9"; lastDegree = d;
	if (!gridTypeValid(d, "sevenflat9")) return;
	var notes = buildNotes(d, [0,2,4,6,8]);      // + b9
	sendChord(gridLabel(d, "sevenflat9"), notes);
}

function sevensharp9(d) {
	d = parseInt(d); lastFn = "sevensharp9"; lastDegree = d;
	if (!gridTypeValid(d, "sevensharp9")) return;
	var notes = buildNotes(d, [0,2,4,6,8]);      // + #9
	sendChord(gridLabel(d, "sevensharp9"), notes);
}

function m7s5(d) {
	d = parseInt(d); lastFn = "m7s5"; lastDegree = d;
	if (!gridTypeValid(d, "m7s5")) return;
	var notes = buildNotes(d, [0,2,4,6]);
	// Augmenter la quinte (index 2) d'un demi-ton
	if (notes.length > 2) notes[2]++;
	sendChord(gridLabel(d, "m7s5"), notes);
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

// Observateurs de SELECTION (detail_clip / selected_track / selected_scene) : ils
// ne servaient qu'à FOLLOW et ne démarraient donc qu'avec lui. Le libellé du
// bouton CLIP en dépend aussi — il doit dire « APPLY TO CLIP » dès qu'un clip
// occupe la cible, suivi armé ou non. Ils démarrent donc au chargement, et
// `_followResolve` garde son propre garde : les observer n'active pas le suivi.
// Portée globale, comme les autres : un reload autowatch les recrée.
var _clipHereInitTask = new Task(function(){ _followStart(); _pushClipHere(); }, this);
_clipHereInitTask.schedule(900);

// =====================================================
// SELF-CHECK — confirme que les globals critiques sont initialisés.
// Visible dans device/max_console.log après (re)chargement.
// =====================================================
(function _selfCheck(){
	try {
		var okSt = (typeof _vl2_st !== 'undefined' && _vl2_st && _vl2_st.recall);
		// VOICING_NAMES doit avoir 29 entrées (classic..power, puis root ajouté EN FIN le 2026-08-05).
		// Si on en ajoute/retire sans mettre à jour l'UI (VOICINGS dans tuple_ui.html + VOICEKEYS dans
		// demo.html + le live.menu du .amxd), le mapping par index diverge — et comme voicingidx lit le
		// style par POSITION, tout décalage remappe SILENCIEUSEMENT les sets Live sauvegardés.
		// Toujours ajouter en fin. Procédure : docs/runbooks/amxd-parametre-voicing.md.
		// Ce compteur est une ALARME : ne le bouger qu'APRÈS avoir corrigé l'énumération du patch,
		// jamais avant — sinon on coupe l'alarme en laissant le feu.
		var vcOk = VOICING_NAMES.length === 29;
		// La table de migration est indexée PAR l'ancien voicingidx : il lui faut donc
		// exactement une entrée par VOICING_NAME. Un décalage ici enverrait un vieux set
		// sur un autre style, silencieusement — le défaut même que la migration existe
		// pour empêcher. Et chaque cible doit désigner un SPACING_NAME réel.
		var mgOk = (typeof VOICING_MIGRATION !== 'undefined') &&
		           VOICING_MIGRATION.length === VOICING_NAMES.length;
		if (mgOk) {
			for (var _mi = 0; _mi < VOICING_MIGRATION.length; _mi++) {
				var _t = VOICING_MIGRATION[_mi];
				if (!(_t >= 0 && _t < SPACING_NAMES.length)) { mgOk = false; break; }
			}
		}
		post("tuple selfcheck: Set=" + (typeof Set !== 'undefined') +
		     " Map=" + (typeof Map !== 'undefined') +
		     " _vl2_st=" + (okSt ? "ok" : "KO") +
		     " STRUCT=" + (typeof _vl2_STRUCT !== 'undefined') +
		     " VOICING_NAMES=" + VOICING_NAMES.length + (vcOk ? "" : " ⚠️ DESYNC UI") +
		     " MIGRATION=" + (mgOk ? "ok" : "⚠️ INCOHERENTE") + "\n");
	} catch(e) { post("tuple selfcheck ERROR: " + e + "\n"); }
})();

