// push2_spike.js — Module Push 2 (toggle Push mode · recording 2-pistes)
// =====================================================================
// Piloté par le toggle UI : "pushmode 1" = ON, "pushmode 0" = OFF
// (l'UI jweb l'envoie au moteur, qui le relaie sur sa sortie 7 -> ici).
//
// ON  : grab CS1 → grille colorée par degré (cases valides) → pads = accords
//       (via midinote, le moteur gère le note-off).
// OFF : release_control → le Push revient à Live.
//
// RECORDING : 2-PISTES — les accords sortent par les noteout du moteur → piste →
// enregistrables sur une 2e piste (MIDI From: piste Tuple, Post FX). Aucun code ici.
// L'écriture-clip 1-piste est CONSERVÉE mais DORMANTE (REC=false) pour plus tard.
//
// NB recette Push (empirique, sur hardware) : voir docs/decisions.md § Push RÉSOLU.

autowatch = 1;
inlets  = 1;
outlets = 1;

// =====================================================================
// LOGGER FICHIER — tee des logs Push vers device/push_console.log,
// lisible hors Max (debug automatisé). Tronqué à chaque (re)chargement.
// Même mécanique que le logger du moteur (chord_engine.js), éprouvée.
// =====================================================================
// DEBUG = 1 : tee les logs Push vers device/push_console.log (outil dev).
// DEBUG = 0 (release) : _plog() est un no-op — aucune écriture disque, chemin jamais utilisé.
var DEBUG = 0;   // release : _plog() no-op (aucune écriture disque). Passer à 1 pour teer les logs Push vers push_console.log en dev.
var PSPK_LOG = "C:/Users/LEETJ/Desktop/Tuple/device/push_console.log";
function _plog(s) {
	if (!DEBUG) return;
	try { var f = new File(PSPK_LOG, "readwrite"); if (f.isopen) { f.position = f.eof; f.writestring(s); f.close(); } } catch(e) {}
}
if (DEBUG) { (function(){ try { var f = new File(PSPK_LOG, "write"); if (f.isopen) { f.writestring("=== push2_spike.js (re)chargé ===\n"); f.close(); } } catch(e){} })(); }

var USE_CS  = 1;                              // CS1 pilote le Push
var OFFIDX = 0;
// On reprogramme 8 entrées de palette (slots 1..8) avec les RGB EXACTS de l'UI,
// puis on allume les pads avec ces index → couleurs identiques à l'écran.
var DEGIDX = [1, 2, 3, 4, 5, 6, 7], BORIDX = 8;
// Slots "éclaircis" (feedback d'appui) : même teinte que le degré/emprunt, tintée vers le blanc.
var BRIGHTDEG = [10, 11, 12, 13, 14, 15, 16], BRIGHTBOR = 17;
// Éclaircit une couleur en la tintant vers le blanc (hue conservée, luminance ↑).
function brighten(c) {
	return [Math.round(c[0] + (255 - c[0]) * 0.5),
	        Math.round(c[1] + (255 - c[1]) * 0.5),
	        Math.round(c[2] + (255 - c[2]) * 0.5)];
}
var PUSH_RGB = [
	// 0 Spectre — arc-en-ciel, DÉMARRE AU BLEU (tonique) → magenta
	[[50,120,235],[0,180,210],[55,195,75],[235,215,0],[255,140,0],[230,50,50],[220,40,180]],
	// 1 Fonction — tonique=bleu : T(I,III,VI)=bleu · S(II,IV)=vert · D(V,VII)=rouge
	[[50,120,235],[55,195,75],[50,120,235],[55,195,75],[230,50,50],[50,120,235],[230,50,50]],
	// 2 Tension : I=bleu · iii,vi=vert · ii,IV=jaune · V=orange · vii°=rouge
	[[50,120,235],[235,215,0],[55,195,75],[235,215,0],[255,140,0],[55,195,75],[230,50,50]],
	// 3 Quintes — distance cercle des quintes : I=bleu (dist0) → rouge (dist5) ;
	//   IV,V=cyan (1) · II=vert (2) · VI=jaune (3) · III=orange (4) · VII=rouge (5)
	[[50,120,235],[55,195,75],[255,140,0],[0,180,210],[0,180,210],[235,215,0],[230,50,50]]
];
var scheme = 0;
var NSCHEMES = 5;   // Spectre, Fonction, Tension, Quintes, Qualité
// Qualité (chaud/froid) : 0 majeur=chaud · 1 mineur=froid · 2 dim · 3 aug. Reçu du moteur (sortie 7).
var QUAL_RGB = [[255,140,0],[40,130,230],[220,55,55],[230,200,0]];
var degQual = [0,0,0,0,0,0,0];

var enabled   = false;
var gridTask  = null;            // Task persistant (sinon GC -> ne fire pas)
var redrawTicks = 0;             // compteur de redraws différés (settle du grab)
var theCS = null, theMatrix = null, theMid = null;
var pressed = {}, pressedPitch = {};
var colLen = [0,0,0,0,0,0,0], borLen = 0, colTmp = null, borTmp = 0;
var colFns = [[],[],[],[],[],[],[]], colFnsTmp = null;   // ordre des types par colonne (mapper smartcell fn -> row)
// SMART : pads suggérés colorés par DEGRÉ (couleurs du layout), luminosité = lvl ; le reste = blanc/éteint.
var smartActive = false, smartPads = {};
// Layout Smart : TEINTE = degré (col 0..6) ou emprunt (col 7), 3 paliers de luminosité par cible.
// slot = 18 + col*3 + (lvl-1) → 8 cibles × 3 = slots 18..41.
var SMART_TIER = [0, 0.45, 0.72, 1.0];   // facteur de luminosité par lvl (1..3)
var WHITEIDX  = 9;   // accord DISPONIBLE mais non suggéré = allumé en BLANC (slot 9 libre)
function _smartSlot(col, lvl){ var l = (lvl < 1) ? 1 : (lvl > 3 ? 3 : lvl); return 18 + col*3 + (l-1); }
function _scaleRGB(rgb, f){ return [Math.round(rgb[0]*f), Math.round(rgb[1]*f), Math.round(rgb[2]*f)]; }

// Observe device active state — release grab si le device est désactivé.
// IMPORTANT : créé PARESSEUSEMENT (dans enable()), PAS au chargement du script.
// Créer un LiveAPI au top-level échoue ("Live API is not initialized" → objet null)
// car l'API Live de Max n'est pas encore prête quand le .js se charge.
// Max observe une propriété via .property (il n'existe pas de méthode .observe()).
var deviceActiveApi = null;
function ensureDeviceActiveObserver() {
	if (deviceActiveApi) return;
	try {
		var api = new LiveAPI(function() {
			// ne lit "active" que si l'objet est RÉSOLU (évite "get: no valid object set" —
			// surtout sur device frozen où "this_device" met plus de temps à résoudre)
			if (!deviceActiveApi || !deviceActiveApi.id || parseInt(deviceActiveApi.id) === 0) return;
			var active = parseInt(deviceActiveApi.get("active"));
			if (!active && enabled) { L("device désactivé → release"); disable(); }
		}, "this_device");
		// ne pose l'observation QUE si "this_device" a résolu (sinon SendMessage error / get invalide).
		// Sinon on laisse deviceActiveApi=null → réessai au prochain bang (live.thisdevice) ou enable().
		if (!api.id || parseInt(api.id) === 0) return;
		deviceActiveApi = api;
		deviceActiveApi.property = "active";
	} catch (e) { L("deviceActive observer ERR " + e); deviceActiveApi = null; }
}

// écriture-clip (option 1-piste) — DORMANTE
var REC = false, lastNotes = [], writePos = 0, entries = [], theClip = null;

function noop() {}

// ---- LOG (console Max uniquement ; le logger fichier a été retiré) ----
function L(s) { post("PSPK: " + s + "\n"); _plog("PSPK: " + s + "\n"); }
function flush() {}   // no-op conservé pour ne pas toucher tous les appels

// =====================================================================
// TOGGLE
// =====================================================================
function pushmode(v) { if (parseInt(v)) enable(); else disable(); }
// [live.thisdevice] (patch) → inlet 0 : bang émis QUAND l'API Live est prête.
// C'est le moment fiable pour créer l'observateur "active" (au chargement du .js,
// LiveAPI renvoie null → "Live API is not initialized"). Pas d'auto-grab ici.
function bang() { ensureDeviceActiveObserver(); }

function enable() {
	if (enabled) return;
	ensureDeviceActiveObserver();   // crée l'observateur "active" maintenant (Live API prête)
	pressed = {}; pressedPitch = {};
	L("===== PUSH MODE ON =====");
	var found = [];
	for (var i = 0; i < 20; i++) {
		var cs = new LiveAPI(noop, "control_surfaces " + i);
		if (isNaN(parseInt(cs.id)) || parseInt(cs.id) === 0) continue;
		var nm = []; try { nm = cs.call("get_control_names"); } catch (e) {}
		var has = false; if (nm instanceof Array) for (var k = 0; k < nm.length; k++) if (String(nm[k]) === "Button_Matrix") has = true;
		if (has) found.push(cs);
	}
	if (found.length === 0) { L("aucun Push (Control Surface)"); flush(); return; }
	theCS = found[Math.min(USE_CS, found.length - 1)];
	// [DIAG écran Push] liste des contrôles dispo du CS (pour le futur mapping
	// encodeurs/boutons d'écran — voir docs/decisions.md § Push display)
	try { var allnm = theCS.call("get_control_names");
		L("CS controls: " + ((allnm instanceof Array) ? allnm.join(" ") : allnm)); } catch (e) {}
	var ret; try { ret = theCS.call("get_control", "Button_Matrix"); } catch (e) { L("get_control ERR " + e); flush(); return; }
	theMid = (ret instanceof Array) ? ret[ret.length - 1] : ret;
	theMatrix = new LiveAPI(onMatrix); theMatrix.id = theMid;
	try { theCS.call("release_control", "id", theMid); } catch (e) {}   // défensif : clear un grab fantôme (reload précédent)
	try { theCS.call("grab_control", "id", theMid); } catch (e) { L("grab ERR " + e); }
	try { theMatrix.property = "value"; } catch (e) {}
	enabled = true;
	applyPalette();   // reprogramme la palette aux RGB de l'UI
	L("grab envoyé (CS id=" + theCS.id + " matrix=" + theMid + ")."); flush();
	refreshGrid();    // tentative immédiate (souvent écrasée : grab pas encore actif)
	// Le grab n'est pas actif dans le tour courant -> redraw DIFFÉRÉ répété pour couvrir
	// le settle. On loggue chaque tick pour vérifier que le Task se déclenche vraiment.
	if (gridTask) { try { gridTask.cancel(); } catch (e) {} }
	redrawTicks = 0;
	gridTask = new Task(redrawDeferred, this);
	gridTask.interval = 150; gridTask.repeat(6);   // ~150..900ms
}
// applyPalette RE-fait ici (et pas seulement dans enable l.90) : au moment du grab la
// palette SysEx est perdue (contrôle pas encore actif) -> pads éteints jusqu'au 1er LAYOUT.
// À +300ms le grab est stabilisé, on (re)programme la palette AVANT d'allumer la grille.
function doInit() { L("doInit: applyPalette + requestgrid"); flush(); if (enabled) { applyPalette(); outlet(0, "requestgrid"); } }   // -> moteur rediffuse -> griddone -> refreshGrid

// Redraw différé répété : couvre le délai de "settle" du grab (la matrice n'est pas
// à nous dans le tour de enable()). On réapplique palette + grille à chaque tick.
function redrawDeferred() {
	redrawTicks++;
	if (!enabled) { if (gridTask) { try { gridTask.cancel(); } catch (e) {} } return; }
	L("redraw différé tick " + redrawTicks);
	applyPalette(); refreshGrid();
}

function disable() {
	if (!enabled) return;
	enabled = false;
	if (theCS && theMid != null) { try { theCS.call("release_control", "id", theMid); } catch (e) {} }
	theMatrix = null; theCS = null; pressed = {}; pressedPitch = {};
	L("===== PUSH MODE OFF (release) ====="); flush();
}

// =====================================================================
// RÉCEPTION SORTIE 7 DU MOTEUR (grille + notes)
// =====================================================================
function notes() { var p = arrayfromargs(arguments); lastNotes = []; for (var i = 0; i < p.length; i++) { var n = parseInt(p[i]); if (!isNaN(n)) lastNotes.push(n); } }
function gridclear() { colTmp = [0,0,0,0,0,0,0]; borTmp = 0; colFnsTmp = [[],[],[],[],[],[],[]]; }
function gridcell(col, fn) { if (colTmp) { var c = parseInt(col); colTmp[c]++; if (colFnsTmp) colFnsTmp[c].push(String(fn)); } }
function gridbor() { borTmp++; }
function griddone() { if (colTmp) { colLen = colTmp; borLen = borTmp; colTmp = null; colFns = colFnsTmp || colFns; colFnsTmp = null; } L("griddone colLen=[" + colLen.join(",") + "] bor=" + borLen + " enabled=" + enabled); if (enabled) refreshGrid(); }
function anything() {}   // absorbe active/clearnotes/root/scale/octave/voicing/...
function colorscheme(v) { scheme = parseInt(v) % NSCHEMES; L("colorscheme=" + scheme); if (enabled) { applyPalette(); refreshGrid(); } flush(); }
// SMART : reçus de l'outlet 7 du moteur. smartcell/bor = accords suggérés (colorés) ; accord dispo non suggéré = blanc, pad vide = éteint.
function smart(v) { smartActive = (parseInt(v) === 1); L("smart=" + smartActive); if (enabled) { applyPalette(); refreshGrid(); } flush(); }
function smartclear() { smartPads = {}; }
function smartcell(d, fn, lvl, cat) { var col = parseInt(d), row = (colFns[col]) ? colFns[col].indexOf(String(fn)) : -1; if (row >= 0) { smartPads[col + "_" + row] = parseInt(lvl); } }
function smartbor(index, lvl, cat) { smartPads["7_" + parseInt(index)] = parseInt(lvl); }
function smartdone() {
	var n = 0, k; for (k in smartPads) if (smartPads.hasOwnProperty(k)) n++;
	L("smartdone: " + n + " pads cohérents (active=" + smartActive + " enabled=" + enabled + " colFns0=" + (colFns[0] ? colFns[0].length : -1) + ")");
	if (enabled && smartActive) refreshGrid();
}
function qualities() { var q = arrayfromargs(arguments); degQual = []; for (var i = 0; i < q.length; i++) degQual.push(parseInt(q[i])); if (scheme === 4 && enabled) { applyPalette(); refreshGrid(); } }

// Réécrit les RGB des slots de palette via SysEx Push 2 (cmd 0x03), puis on allume avec ces index.
function setPaletteRGB(idx, c) {
	if (!theCS) return;
	var r = c[0], g = c[1], b = c[2];
	try { theCS.call("send_midi", 240, 0, 33, 29, 1, 1, 3, idx, r & 127, (r >> 7) & 1, g & 127, (g >> 7) & 1, b & 127, (b >> 7) & 1, 0, 0, 247); }
	catch (e) { L("send_midi ERR " + e); }
}
function applyPalette() {
	if (!theCS) return;
	for (var i = 0; i < 7; i++) {
		var rgb = (scheme < 4) ? PUSH_RGB[scheme][i] : QUAL_RGB[degQual[i] || 0];
		setPaletteRGB(DEGIDX[i], rgb);
		setPaletteRGB(BRIGHTDEG[i], brighten(rgb));   // version claire = pad tenu
	}
	var bor = [170, 50, 230];                 // emprunt violet (toutes logiques)
	setPaletteRGB(BORIDX, bor);
	setPaletteRGB(BRIGHTBOR, brighten(bor));
	for (var sc = 0; sc < 7; sc++){
		var dcol = (scheme < 4) ? PUSH_RGB[scheme][sc] : QUAL_RGB[degQual[sc] || 0];   // couleur du degré dans le schéma courant
		for (var sl = 1; sl <= 3; sl++) setPaletteRGB(_smartSlot(sc, sl), _scaleRGB(dcol, SMART_TIER[sl]));   // 3 paliers de luminosité par degré
	}
	for (var sl2 = 1; sl2 <= 3; sl2++) setPaletteRGB(_smartSlot(7, sl2), _scaleRGB([170, 50, 230], SMART_TIER[sl2]));   // emprunt (col 7) violet
	setPaletteRGB(WHITEIDX, [200, 200, 205]);   // blanc doux : accord disponible (layout Smart)
	L("palette RGB appliquée (scheme " + scheme + ")"); flush();
}

// Un pad porte-t-il un accord ? (forme de la grille = longueurs de colonnes + emprunts) — source unique.
function hasChord(col, row) { return (col < 7) ? (row < colLen[col]) : (row < borLen); }
// Index palette "normal" (non pressé) d'un pad : couleur de degré/emprunt si valide, sinon éteint.
function normalIdx(col, row) {
	var on = hasChord(col, row);
	return on ? ((col < 7) ? DEGIDX[col] : BORIDX) : OFFIDX;
}

// Index palette "éclairci" d'un pad valide (feedback d'appui) : même teinte, plus clair.
function brightIdx(col, row) {
	var on = hasChord(col, row);
	return on ? ((col < 7) ? BRIGHTDEG[col] : BRIGHTBOR) : OFFIDX;
}

function refreshGrid() {
	if (!enabled || !theMatrix) { L("refreshGrid SKIP enabled=" + enabled + " matrix=" + (theMatrix != null)); flush(); return; }
	var n = 0, firstErr = "";
	var spotlight = smartActive;   // SMART actif → projecteur : accord suggéré = couleur, accord dispo = blanc, pad vide = éteint
	for (var c = 0; c < 8; c++) for (var r = 0; r < 8; r++) {
		// pad tenu = version claire (ne pas écraser le feedback d'appui lors d'un redraw)
		var key = c + "_" + r;
		var idx;
		if (spotlight) {
			var has = hasChord(c, r);   // ce pad porte-t-il un accord ?
			if (!has) idx = OFFIDX;                                 // pas d'accord → éteint
			else { var sp = smartPads[key]; idx = sp ? _smartSlot(c, sp) : WHITEIDX; }   // suggéré = couleur du degré + palier de luminosité ; sinon BLANC
		}
		else idx = pressed[key] ? brightIdx(c, r) : normalIdx(c, r);
		try { theMatrix.call("send_value", c, r, idx); if (idx !== OFFIDX) n++; } catch (e) { if (!firstErr) firstErr = String(e); }
	}
	L("refreshGrid: " + n + " cases allumées" + (spotlight ? " [SPOTLIGHT smart]" : "") + (firstErr ? " ERR:" + firstErr : "")); flush();
}

// =====================================================================
// APPUIS PADS  [value, vel, col, row, 1]  -> midinote (note-off géré par le moteur)
// =====================================================================
function padIndex(col, row) { var idx = 0, last = (col < 7) ? col : 7; for (var c = 0; c < last; c++) idx += colLen[c]; return idx + row; }

function onMatrix(args) {
	if (!enabled || !args) return;
	var a = (args.length !== undefined) ? args : [args];
	if (String(a[0]) !== "value" || a.length < 4) return;
	var vel = parseInt(a[1]), col = parseInt(a[2]), row = parseInt(a[3]);
	var valid = (col < 7) ? (row < colLen[col]) : (col === 7 && row < borLen);
	if (!valid) return;
	var key = col + "_" + row;
	if (vel > 0) {
		if (pressed[key]) return; pressed[key] = true;
		var pitch = 48 + padIndex(col, row); pressedPitch[key] = pitch;
		L("PRESS col=" + col + " row=" + row + " vel=" + vel + " -> midinote " + pitch); flush();
		outlet(0, "midinote", pitch, vel);
		try { theMatrix.call("send_value", col, row, brightIdx(col, row)); } catch (e) {}   // feedback : pad tenu = version claire
		if (REC) writeChord();
	} else {
		if (!pressed[key]) return; pressed[key] = false;
		var p = pressedPitch[key]; if (p !== undefined) outlet(0, "midinote", p, 0);
		try { theMatrix.call("send_value", col, row, normalIdx(col, row)); } catch (e) {}   // restaure la couleur de degré
	}
}

// =====================================================================
// ÉCRITURE-CLIP 1-PISTE — DORMANT (REC=false). À reprendre plus tard
// (passer à add_new_notes incrémental ; set_notes REMPLACE d'où l'accumulation).
// =====================================================================
function getClip() {
	if (theClip) return theClip;
	var slot = new LiveAPI(noop, "live_set view highlighted_clip_slot");
	if (!slot || !slot.id || parseInt(slot.id) === 0) { L("pas de clip slot"); return null; }
	var has = slot.get("has_clip"); has = (has instanceof Array) ? has[0] : has;
	if (parseInt(has) === 0) { try { slot.call("create_clip", 16.0); } catch (e) { return null; } }
	theClip = new LiveAPI(noop, "live_set view highlighted_clip_slot clip");
	return theClip;
}
function writeChord() {
	if (!lastNotes.length) return;
	var clip = getClip(); if (!clip) return;
	for (var i = 0; i < lastNotes.length; i++) entries.push({ p: lastNotes[i], beat: writePos });
	writePos += 1;
	try { clip.call("set_notes"); clip.call("notes", entries.length); for (var j = 0; j < entries.length; j++) clip.call("note", entries[j].p, entries[j].beat, 0.9, 100, 0); clip.call("done"); } catch (e) {}
}
function rec() { REC = true; writePos = 0; entries = []; theClip = null; L("clip-write ON"); flush(); }
function norec() { REC = false; L("clip-write OFF"); flush(); }

post("PUSH2 module (toggle) LOADED\n");
