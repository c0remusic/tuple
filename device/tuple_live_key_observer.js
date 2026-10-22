// live_key_observer.js
// Au chargement du device : attend que le LOM de live_set réponde, puis demande au moteur
// de se synchroniser sur la tonalité de Live.
//
// inlet 0  → bang = (re)lance l'attente
// outlet 0 → "load" (le patch le préfixe en `synclive load` vers le moteur)
//
// ⚠️ Jusqu'au 2026-10-21 ce script traduisait LUI-MÊME scale_name en index de gamme, avec
// une table de 12 noms. Le moteur en connaît 30 depuis ce jour, plus un repli par
// `scale_intervals` pour les noms qu'il ignore : la table d'ici était donc une seconde
// vérité, plus pauvre — sur une gamme Live hors des 12, il réessayait 30 fois puis
// abandonnait sans même synchroniser la tonique. Il ne traduit plus rien : il détecte que
// Live est prêt, et `synclive()` fait le reste avec la seule table qui fait foi.

autowatch = 1;
inlets  = 1;
outlets = 1;

// .get() peut renvoyer une valeur seule OU un tableau [valeur].
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
	var root     = parseInt(rawRoot);

	// Valeurs saines ? root entier 0-11 ET un nom de gamme non vide. Sinon l'API n'est pas
	// vraiment prête → on réessaie. Le NOM n'est plus jugé ici : c'est le travail du moteur.
	var rootOK  = (root >= 0 && root <= 11 && String(rawRoot).indexOf("e-") < 0);
	var scaleOK = (rawScale !== null && rawScale !== undefined && String(rawScale).replace(/^\s+|\s+$/g, "") !== "");

	if (!rootOK || !scaleOK) {
		retryOrGiveUp("valeurs invalides root=" + rawRoot + " scale=" + rawScale);
		return;
	}

	outlet(0, "load");
}

function bang() {
	retries = 0;
	retryTask.cancel();
	tryRead();
}

post("LIVE KEY OBSERVER LOADED\n");
