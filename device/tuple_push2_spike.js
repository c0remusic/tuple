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
// ⚠️ LE CHEMIN SE RÉSOUT, IL NE S'ÉCRIT PAS. Cette ligne a porté un chemin absolu de machine de
// dev — d'abord `…/Desktop/Tuple/…` (dossier disparu : DEBUG=1 écrivait dans le vide sans le
// dire), puis `C:/dev/tuple/…`, qui partait tel quel dans le zip public. Le moteur avait réglé le
// problème de son côté le 2026-08-13 ; ce module ne l'avait pas suivi. Même mécanique ici :
// résolution PARESSEUSE depuis `patcher.filepath`, vide tant que le patch n'est pas chargé.
// Sans patcher résolu, on n'écrit rien — plutôt que d'écrire ailleurs.
var PSPK_LOG = "";
var _plogThis = this;
var _plogFresh = false;
function _plogResolve() {
	if (PSPK_LOG) return PSPK_LOG;
	try {
		var pat = (_plogThis && _plogThis.patcher) ? _plogThis.patcher : null;
		var fp = pat ? pat.filepath : "";
		if (fp && fp.length) {
			// Chemin Max-style, comme le moteur : "C:/…" et "Macintosh HD:/…" passent tels quels.
			fp = String(fp).replace(/\\/g, '/');
			PSPK_LOG = fp.substring(0, fp.lastIndexOf('/') + 1) + "push_console.log";
		}
	} catch (e) {}
	return PSPK_LOG;
}
function _plog(s) {
	if (!DEBUG) return;
	var chemin = _plogResolve();
	if (!chemin) return;
	if (!_plogFresh) {
		// La remise à zéro attend elle aussi le patcher : au sommet du fichier il n'est pas là.
		_plogFresh = true;
		try { var t = new File(chemin, "write"); if (t.isopen) { t.writestring("=== push2_spike.js (re)charg\u00e9 ===\n"); t.close(); } } catch (e) {}
	}
	try { var f = new File(chemin, "readwrite"); if (f.isopen) { f.position = f.eof; f.writestring(s); f.close(); } } catch (e) {}
}

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
var CAP_ON_IDX = 42, CAP_OFF_IDX = 43;   // pad CAPTURE (ligne vide) : rouge vif (on) / blanc vif (off). Slots libres (smart = 18-41).
var MODE_IDX = 44, MODE_PRESS_IDX = 45;  // pad MODE-cycle (col 2) : BLANC (fonction, fixe) ; GRIS en feedback d'appui (cycle).
function _smartSlot(col, lvl){ var l = (lvl < 1) ? 1 : (lvl > 3 ? 3 : lvl); return 18 + col*3 + (l-1); }
function _scaleRGB(rgb, f){ return [Math.round(rgb[0]*f), Math.round(rgb[1]*f), Math.round(rgb[2]*f)]; }

// --- Layout PROGRESSION (compagnon harmonique Push) — reçu de l'outlet 7 du moteur ---
// Rangée 0 (bas) = étapes capturées ; rangées 1-7 = options de l'étape sélectionnée selon le mode
// (0=Substituts 1=Suite 2=Voicings). Voir docs/superpowers/specs/2026-06-22-push-progression-3modes-design.md.
var progLayout = false;                 // le layout progression est-il actif ? (reçoit 'progmode 1/0')
var progSteps  = [], progOpts = [];     // étapes (degrés, -1=emprunt) ; options ({deg,kind})
var progSelIdx = -1, progModeCur = 0;   // étape sélectionnée + mode actif
var progCapture = false;                // état CAPTURE (pad ligne vide)
var _pTmpSteps = null, _pTmpOpts = null;   // double-buffer (comme colTmp) pour un affichage atomique

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
			reconcileDeferred();
		}, "this_device");
		// ne pose l'observation QUE si "this_device" a résolu (sinon SendMessage error / get invalide).
		// Sinon on laisse deviceActiveApi=null → réessai au prochain bang (live.thisdevice) ou enable().
		if (!api.id || parseInt(api.id) === 0) return;
		deviceActiveApi = api;
		deviceActiveApi.property = "is_active";   // LOM : `is_active`, pas `active` (qui n'existe pas)
	} catch (e) { L("deviceActive observer ERR " + e); deviceActiveApi = null; }
}

// =====================================================================
// GATE DE FOCUS PISTE — le grab suit la piste sélectionnée
// =====================================================================
// AVANT : le grab était gaté sur le SEUL toggle UI. Tuple gardait donc le Button_Matrix
// même en quittant sa piste → (a) collision avec les autres devices Push (Fors Dyad :
// « quitter la track de Dyad rend les boutons à Live, pas Tuple »), (b) les pads
// répondaient encore alors que le Push affichait une autre vue, d'où des appuis qui
// partent chez Live (lancement de clips en Session) au lieu de jouer un accord.
// MAINTENANT : le grab = intention utilisateur ET piste au focus ET device actif.
// Quitter la piste relâche, y revenir REPREND tout seul (plus de reset manuel).
// Modèle repris de Dyad (gate `---allow_push` couplé au focus), cf. docs/decisions.md L2819.
//
// LIMITE CONNUE : le LOM n'expose PAS le layout courant du Push (Session/Note/…). Le gate
// de focus ne peut donc pas empêcher le recouvrement quand on est EN Session view SUR la
// piste Tuple. Il supprime le cas de loin le plus fréquent (autre piste au focus) ; le
// résiduel demande l'API `push_control` officielle, pas `grab_control`.
var wantPush   = false;   // intention utilisateur (toggle PUSH de l'UI)
var viewApi    = null;    // observateur de live_set view -> selected_track

function ensureTrackFocusObserver() {
	if (viewApi) return;
	try {
		var api = new LiveAPI(function() { reconcileDeferred(); }, "live_set view");
		if (!api.id || parseInt(api.id) === 0) return;   // Live pas prêt → réessai au prochain bang
		viewApi = api;
		viewApi.property = "selected_track";
		L("observateur de focus piste armé");
	} catch (e) { L("trackFocus observer ERR " + e); viewApi = null; }
}

// id LiveAPI d'une piste, ou -1 si l'objet n'a pas résolu.
function _resolvedId(path) {
	try {
		var a = new LiveAPI(noop, path);
		var id = parseInt(a.id);
		return (isNaN(id) || id === 0) ? -1 : id;
	} catch (e) { return -1; }
}

// id de la piste qui héberge CE device, ou -1.
// Un device posé DANS UN RACK a pour canonical_parent la CHAÎNE, pas la piste — comparer
// ça à selected_track échouerait TOUJOURS et le Push ne se grabberait jamais. On remonte
// donc jusqu'à l'objet de type Track. On navigue par .id (patron déjà utilisé plus bas
// pour theMatrix) plutôt que par une forme de chemin "id N canonical_parent" non vérifiée.
var lastMyTrack = -1, lastSelTrack = -1;
function _myTrackId() {
	try {
		var a = new LiveAPI(noop, "this_device canonical_parent");
		for (var guard = 0; guard < 8; guard++) {
			if (!a || !a.id || parseInt(a.id) === 0) return -1;
			if (String(a.type) === "Track") return parseInt(a.id);
			var p = a.get("canonical_parent");
			var nid = (p instanceof Array) ? parseInt(p[p.length - 1]) : parseInt(p);
			if (isNaN(nid) || nid === 0) return -1;
			var b = new LiveAPI(noop); b.id = nid;
			a = b;
		}
		return -1;
	} catch (e) { return -1; }
}

// La piste qui héberge CE device est-elle celle sélectionnée dans Live ?
// Prudence : si l'un des deux objets ne résout pas (Live pas prêt, device en cours de
// chargement, type inattendu), on renvoie true — mieux vaut le comportement d'avant que
// refuser le grab pour une raison transitoire.
function trackFocused() {
	lastMyTrack  = _myTrackId();
	lastSelTrack = _resolvedId("live_set view selected_track");
	if (lastMyTrack < 0 || lastSelTrack < 0) return true;
	return lastMyTrack === lastSelTrack;
}

// --- Layout du Push (Session / Melodic / Drums / …) ---
// La ControlSurface expose `pad_layout` (LOM : « indicates the active layout on devices like
// Push … such as Melodic, Drums, or Session »). C'est le signal qui manquait pour le 2e
// symptôme signalé : en Session view, les pads lancent des clips, et Tuple qui les tient en
// même temps produit le recouvrement (« a key press will launch clips instead of a progression »).
//
// PRUDENCE DÉLIBÉRÉE : le LOM ne publie pas la liste exacte des valeurs. On ne bloque donc QUE
// sur un layout reconnu comme Session ; toute autre valeur — inconnue, illisible, propriété
// absente sur une vieille version de Live — autorise le grab, c'est-à-dire EXACTEMENT le
// comportement d'avant. Si l'hypothèse sur la chaîne est fausse, on n'est pas plus mal qu'aujourd'hui.
//
// ⚠️ PORTE FERMÉE PAR DÉFAUT (2026-08-05). Activée d'abord, elle a CASSÉ le mode Push sur le
// hardware d'Antoine : enable() prend le grab, le reconcile différé de fin d'enable() relit
// pad_layout, le juge « Session » et relâche dans la foulée → le toggle PUSH semblait ne rien
// déclencher. La chaîne exacte rendue par un vrai Push n'est PAS documentée dans le LOM, donc
// tant qu'elle n'est pas mesurée, cette porte ne doit pas pouvoir refuser un grab.
// PAD_LAYOUT_GATE = 0 : on LIT et on LOGGUE pad_layout, sans jamais bloquer.
// Passer à 1 UNIQUEMENT une fois SESSION_MATCH validé sur hardware (le log ci-dessous donne
// la valeur brute à chaque décision).
var PAD_LAYOUT_GATE = 0;
var SESSION_MATCH   = "session";   // sous-chaîne (minuscules) identifiant le layout Session
var pushCsIndex  = -1;     // index LOM de la ControlSurface Push retenue
var padLayoutApi = null;   // observateur de pad_layout
var lastPadLayout = "?";   // dernière valeur brute lue (diagnostic)

function ensurePadLayoutObserver() {
	if (padLayoutApi || pushCsIndex < 0) return;
	try {
		var api = new LiveAPI(function() { reconcileDeferred(); }, "control_surfaces " + pushCsIndex);
		if (!api.id || parseInt(api.id) === 0) return;
		api.property = "pad_layout";
		padLayoutApi = api;
		L("observateur pad_layout armé (control_surfaces " + pushCsIndex + ")");
	} catch (e) { L("padLayout observer ERR " + e); padLayoutApi = null; }
}

function padLayoutAllowsGrab() {
	if (pushCsIndex < 0) { lastPadLayout = "(Push pas encore localisé)"; return true; }
	var v;
	try {
		var a = padLayoutApi || new LiveAPI(noop, "control_surfaces " + pushCsIndex);
		v = a.get("pad_layout");
		if (v instanceof Array) v = v.join(" ");
	} catch (e) { lastPadLayout = "(ERR " + e + ")"; return true; }
	lastPadLayout = (v === undefined || v === null) ? "(absent)" : String(v);
	if (!PAD_LAYOUT_GATE) return true;                             // porte fermée : lecture seule
	if (v === undefined || v === null || v === "") return true;    // propriété absente → comme avant
	return String(v).toLowerCase().indexOf(SESSION_MATCH) < 0;
}

// LOM : la propriété du Device est `is_active` (Read-only/Observe). Il n'y a PAS de
// propriété `active` — `get("active")` rend 0, donc « device éteint », toujours.
//
// Ce mauvais nom était là depuis l'origine mais restait DORMANT : il n'était lu que dans un
// callback d'observateur, et seulement pour RELÂCHER. En faire une condition préalable au
// grab l'a réveillé, et le mode Push ne s'activait plus du tout (log hardware du 2026-08-05 :
// « want=true actif=false focus=true layout=true → RELEASE »).
//
// ÉCHEC OUVERT, délibérément : seul un 0 franc compte comme inactif. Illisible, absent, vide
// ou non numérique → on considère le device actif. Une lecture d'état ne doit jamais pouvoir
// refuser une action que l'utilisateur a explicitement demandée.
function deviceIsActive() {
	if (!deviceActiveApi || !deviceActiveApi.id || parseInt(deviceActiveApi.id) === 0) return true;
	try {
		var v = deviceActiveApi.get("is_active");
		if (v instanceof Array) v = v[0];
		if (v === undefined || v === null || v === "") return true;
		var n = parseInt(v);
		return isNaN(n) ? true : (n !== 0);
	} catch (e) { return true; }
}

// Source UNIQUE de la décision grab/release. Tout ce qui peut la changer (toggle, focus
// piste, activation du device) appelle ceci — jamais enable()/disable() directement.
// Les deux lectures LiveAPI sont faites UNE fois : les rappeler pour le log créerait
// 4 objets LiveAPI de plus par appel, et le log pourrait contredire la décision prise.
function reconcile() {
	var actif = deviceIsActive(), focus = trackFocused(), layout = padLayoutAllowsGrab();
	var should = wantPush && actif && focus && layout;
	// Loggué à CHAQUE appel, pas seulement au changement : quand le mode Push « ne se
	// déclenche pas », c'est précisément l'appel qui ne change rien qu'il faut pouvoir lire.
	L("reconcile: want=" + wantPush + " actif=" + actif +
	  " focus=" + focus + " (piste=" + lastMyTrack + " selection=" + lastSelTrack + ")" +
	  " layout=" + layout + " [pad_layout=" + lastPadLayout + " gate=" + PAD_LAYOUT_GATE + "]" +
	  " → " + (should ? "GRAB" : "RELEASE") + (should === enabled ? " (déjà dans cet état)" : ""));
	if (should === enabled) return;
	if (should) enable(); else disable();
}

// reconcile() DIFFÉRÉ — à utiliser depuis un callback d'observateur LiveAPI.
// enable() peut créer un observateur (ensureTrackFocusObserver) ; or créer un observateur
// LiveAPI DEPUIS le callback d'un autre observateur échoue SILENCIEUSEMENT (ré-entrance,
// cf. docs/decisions.md § gotchas LiveAPI). Un Task à 0 ms sort du callback avant d'agir.
// Référence retenue en global : Max peut annuler une Task one-shot dont la référence JS a
// été collectée avant qu'elle ne se déclenche.
var _reconcileTask = null;
function reconcileDeferred() {
	if (typeof Task === 'undefined') { reconcile(); return; }
	if (_reconcileTask) { try { _reconcileTask.cancel(); } catch (e) {} }
	_reconcileTask = new Task(reconcile, this);
	_reconcileTask.schedule(0);
}

function noop() {}

// ---- LOG (console Max uniquement ; le logger fichier a été retiré) ----
function L(s) { post("PSPK: " + s + "\n"); _plog("PSPK: " + s + "\n"); }
function flush() {}   // no-op conservé pour ne pas toucher tous les appels

// =====================================================================
// TOGGLE
// =====================================================================
// Le toggle ne grabbe plus lui-même : il pose l'INTENTION, reconcile() décide (le focus
// piste pèse autant que le toggle). Sinon on reprend les pads d'une piste qu'on ne
// regarde plus.
function pushmode(v) {
	wantPush = !!parseInt(v);
	ensureDeviceActiveObserver();
	ensureTrackFocusObserver();
	reconcile();
}
// [live.thisdevice] (patch) → inlet 0 : bang émis QUAND l'API Live est prête.
// C'est le moment fiable pour créer les observateurs (au chargement du .js,
// LiveAPI renvoie null → "Live API is not initialized"). Pas d'auto-grab ici.
function bang() { ensureDeviceActiveObserver(); ensureTrackFocusObserver(); }

function enable() {
	if (enabled) return;
	ensureDeviceActiveObserver();   // crée l'observateur "active" maintenant (Live API prête)
	ensureTrackFocusObserver();     // idem pour le focus piste (regrab auto au retour)
	pressed = {}; pressedPitch = {};
	L("===== PUSH MODE ON =====");
	var found = [], foundIdx = [];
	for (var i = 0; i < 20; i++) {
		var cs = new LiveAPI(noop, "control_surfaces " + i);
		if (isNaN(parseInt(cs.id)) || parseInt(cs.id) === 0) continue;
		var nm = []; try { nm = cs.call("get_control_names"); } catch (e) {}
		var has = false; if (nm instanceof Array) for (var k = 0; k < nm.length; k++) if (String(nm[k]) === "Button_Matrix") has = true;
		if (has) { found.push(cs); foundIdx.push(i); }
	}
	if (found.length === 0) { L("aucun Push (Control Surface)"); flush(); return; }
	var pick = Math.min(USE_CS, found.length - 1);
	theCS = found[pick];
	pushCsIndex = foundIdx[pick];   // retenu : sert à observer pad_layout (chemin "control_surfaces N")
	ensurePadLayoutObserver();      // relâche/reprend quand le Push change de layout (Session…)
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
	// pushCsIndex n'est connu QU'ICI (c'est le scan ci-dessus qui le pose), donc le tout
	// premier reconcile() n'a pas pu consulter pad_layout. On re-arbitre une fois le Push
	// localisé : sans ça, activer PUSH alors qu'on est DÉJÀ en Session view grabbe puis ne
	// se réévalue plus jamais. Différé → pas de récursion dans enable().
	reconcileDeferred();
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
	// ⚠️ Note-off des pads tenus AVANT de vider l'état. Sans ça, un pad tenu au moment
	// d'un changement de piste (reconcile → disable) sonnait indéfiniment : le release
	// physique arrive après, et le garde `if (!enabled)` d'onMatrix l'avale — le pitch
	// était irrécupérable (audit 2026-08-18). Garantie du dépôt : chaque note-on a son
	// note-off, y compris sur changement d'état.
	for (var k in pressedPitch) {
		if (pressedPitch.hasOwnProperty(k) && pressedPitch[k] !== undefined) {
			outlet(0, "midinote", pressedPitch[k], 0);
		}
	}
	if (theCS && theMid != null) { try { theCS.call("release_control", "id", theMid); } catch (e) {} }
	theMatrix = null; theCS = null; pressed = {}; pressedPitch = {};
	L("===== PUSH MODE OFF (release) ====="); flush();
}

// =====================================================================
// RÉCEPTION SORTIE 7 DU MOTEUR (grille + notes)
// =====================================================================
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

// PROGRESSION : reçus de l'outlet 7. 'progmode' bascule le layout ; progclear/progstep/progopt/progsel/
// progdone construisent l'affichage (double-buffer, comme la grille). Le moteur ré-émet à chaque change.
function progmode(v) { progLayout = (parseInt(v) === 1); L("progLayout=" + progLayout); if (enabled) { applyPalette(); refreshGrid(); } flush(); }
function progclear() { _pTmpSteps = []; _pTmpOpts = []; }
function progstep(col, deg) { if (_pTmpSteps) _pTmpSteps.push(parseInt(deg)); }
function progopt(flat, deg, kind) { if (_pTmpOpts) _pTmpOpts.push({ idx: parseInt(flat), deg: parseInt(deg), kind: String(kind) }); }   // liste à plat (étape sélectionnée)
function capture(v) { progCapture = (parseInt(v) === 1); if (enabled && progLayout) refreshGrid(); }   // état CAPTURE → feedback pad
function progsel(idx, mode) { progSelIdx = parseInt(idx); progModeCur = parseInt(mode); }
function progdone() { if (_pTmpSteps) { progSteps = _pTmpSteps; progOpts = _pTmpOpts; _pTmpSteps = null; _pTmpOpts = null; } L("progdone steps=" + progSteps.length + " opts=" + progOpts.length + " sel=" + progSelIdx + " mode=" + progModeCur); if (enabled && progLayout) refreshGrid(); }

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
	setPaletteRGB(CAP_ON_IDX, [255, 25, 25]);   // CAPTURE on = rouge vif
	setPaletteRGB(CAP_OFF_IDX, [255, 255, 255]); // CAPTURE off = blanc vif
	setPaletteRGB(MODE_IDX, [255, 255, 255]);    // MODE = blanc (fonction, fixe)
	setPaletteRGB(MODE_PRESS_IDX, [120, 120, 120]); // MODE pressé = gris (feedback de cycle)
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
	if (progLayout) { refreshProg(); return; }   // layout progression : rangée 0 = étapes, 1-7 = options
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

// --- Rendu du layout progression ---
// Étape (rangée 0) : couleur de degré (emprunt = violet), version claire si sélectionnée.
function _progStepIdx(deg, sel) {
	if (deg < 0) return sel ? BRIGHTBOR : BORIDX;
	return (deg < 7) ? (sel ? BRIGHTDEG[deg] : DEGIDX[deg]) : OFFIDX;
}
// Option : couleur du DEGRÉ de l'accord proposé (emprunt = violet) ; appui = version claire (feedback).
// En Voic, opt.deg = le degré de l'étape SÉLECTIONNÉE → toutes les variantes prennent la couleur de CET accord.
function _progOptIdx(opt, pressed) {
	if (opt.deg < 0) return pressed ? BRIGHTBOR : BORIDX;         // emprunt
	if (opt.deg >= 0 && opt.deg < 7) return pressed ? BRIGHTDEG[opt.deg] : DEGIDX[opt.deg];
	return WHITEIDX;
}
function refreshProg() {
	// Push : rangée 0 EN HAUT. Layout : physique 7 = étapes (bas) ; physique 6 = ligne vide + pad CAPTURE (col 0) ;
	// physique 5..0 = options de l'étape SÉLECTIONNÉE, BOTTOM-UP (idx 0 en physique 5, près des étapes).
	// gridRow physique = 5 - floor(idx/8) ; col = idx%8.
	var c, phys, k, grid = [], n = 0, firstErr = "";
	for (c = 0; c < 8; c++) { grid[c] = []; for (phys = 0; phys < 8; phys++) grid[c][phys] = OFFIDX; }
	for (c = 0; c < progSteps.length && c < 8; c++) grid[c][7] = _progStepIdx(progSteps[c], c === progSelIdx);   // étapes (bas)
	grid[0][6] = progCapture ? CAP_ON_IDX : CAP_OFF_IDX;                                                          // CAPTURE (ligne vide, col 0)
	grid[2][6] = MODE_IDX;                                                                                        // MODE-cycle (col 2 ; col 1 = espacement vide) — couleur fixe de fonction
	for (k = 0; k < progOpts.length; k++) {                                                                       // options de l'étape sélectionnée, bottom-up
		var o = progOpts[k];
		if (o.idx < 0 || o.idx >= 48) continue;
		var gr = 5 - Math.floor(o.idx / 8), gc = o.idx % 8;
		grid[gc][gr] = _progOptIdx(o, false);
	}
	for (c = 0; c < 8; c++) for (phys = 0; phys < 8; phys++) {
		var v = grid[c][phys];
		try { theMatrix.call("send_value", c, phys, v); if (v !== OFFIDX) n++; } catch (e) { if (!firstErr) firstErr = String(e); }
	}
	L("refreshProg: steps=" + progSteps.length + " opts=" + progOpts.length + " sel=" + progSelIdx + " cap=" + progCapture + " mode=" + progModeCur + " lit=" + n + (firstErr ? " ERR:" + firstErr : "")); flush();
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
	if (progLayout) { onMatrixProg(vel, col, row); return; }   // layout progression : routage dédié
	var valid = (col < 7) ? (row < colLen[col]) : (col === 7 && row < borLen);
	if (!valid) return;
	var key = col + "_" + row;
	if (vel > 0) {
		if (pressed[key]) return; pressed[key] = true;
		var pitch = 48 + padIndex(col, row); pressedPitch[key] = pitch;
		L("PRESS col=" + col + " row=" + row + " vel=" + vel + " -> midinote " + pitch); flush();
		outlet(0, "midinote", pitch, vel);
		try { theMatrix.call("send_value", col, row, brightIdx(col, row)); } catch (e) {}   // feedback : pad tenu = version claire
	} else {
		if (!pressed[key]) return; pressed[key] = false;
		var p = pressedPitch[key]; if (p !== undefined) outlet(0, "midinote", p, 0);
		try { theMatrix.call("send_value", col, row, normalIdx(col, row)); } catch (e) {}   // restaure la couleur de degré
	}
}

// Appuis en layout progression : physique 7 -> selprog <col> (sélectionne+écoute l'étape) ; physique 6 =
// séparateur (rien) ; physique 5..0 -> selopt <col> <optrow> (écoute si CAPTURE off, édite si on, côté
// moteur). Relâchement -> 'release' (note-off).
function onMatrixProg(vel, col, row) {
	if (row === 7) {                                          // étape (rangée du bas)
		if (col >= progSteps.length) return;
		if (vel > 0) {
			L("PROG press step col=" + col + " -> selprog"); flush();
			outlet(0, "selprog", col);
			try { theMatrix.call("send_value", col, 7, _progStepIdx(progSteps[col], true)); } catch (e) {}
		} else {
			outlet(0, "release");
			try { theMatrix.call("send_value", col, 7, _progStepIdx(progSteps[col], col === progSelIdx)); } catch (e) {}
		}
		return;
	}
	if (row === 6) {                                          // ligne vide : CAPTURE (col 0) · espacement (col 1) · MODE-cycle (col 2)
		if (col === 0 && vel > 0) { L("PROG capturetoggle"); flush(); outlet(0, "capturetoggle"); }
		else if (col === 2) {                                 // MODE : cycle + feedback gris tenu (blanc au relâché)
			if (vel > 0) { L("PROG progmodecycle"); flush(); outlet(0, "progmodecycle"); try { theMatrix.call("send_value", 2, 6, MODE_PRESS_IDX); } catch (e) {} }
			else { try { theMatrix.call("send_value", 2, 6, MODE_IDX); } catch (e) {} }
		}
		return;
	}
	var flat = (5 - row) * 8 + col;                           // physique 5..0 -> idx à plat (bottom-up)
	var o = _findOptFlat(flat);
	if (!o) return;
	if (vel > 0) {
		L("PROG press opt flat=" + flat + " -> selopt"); flush();
		outlet(0, "selopt", flat);
		try { theMatrix.call("send_value", col, row, _progOptIdx(o, true)); } catch (e) {}
	} else {
		outlet(0, "release");
		try { theMatrix.call("send_value", col, row, _progOptIdx(o, false)); } catch (e) {}
	}
}
// Retrouve l'option d'index à plat dans le buffer diffusé.
function _findOptFlat(flat) { for (var k = 0; k < progOpts.length; k++) { if (progOpts[k].idx === flat) return progOpts[k]; } return null; }

post("PUSH2 module (toggle) LOADED\n");
