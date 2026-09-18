// tuple_window_fit.js — la fenêtre pleine devient redimensionnable, et le jweb suit.
//
// POURQUOI CE FICHIER EXISTE. Retirer `nogrow` du `[thispatcher]` rend la fenêtre
// étirable, mais ça ne suffit pas : dans Max, un objet ne se redimensionne PAS avec sa
// fenêtre — il n'y a pas de mise en page automatique dans un patcher. Sans ce script,
// agrandir la fenêtre découvrirait du canevas vide autour d'un jweb resté à 1200×700.
//
// CE QU'IL FAIT. Il vit DANS `[p tuple_fullview]`, donc `this.patcher` est le
// sous-patcheur et `this.patcher.wind` est la fenêtre pleine. Il relève sa taille à
// intervalle régulier et, quand elle change, repose le rect du jweb dessus.
//
// ⚠️ POURQUOI UN SONDAGE ET PAS UN CALLBACK. Max n'expose pas de notification de
// redimensionnement de fenêtre à un `[js]` : `onresize()` concerne la boîte de l'objet
// (jsui), pas la fenêtre, et la boîte ne bouge justement pas toute seule — c'est le
// problème qu'on corrige ici. Le sondage est le seul chemin, et il est bon marché : une
// lecture de deux nombres toutes les 250 ms, et RIEN tant que la fenêtre est fermée.
//
// ⚠️ CE QUI A CRASHÉ ABLETON, ET POURQUOI CE CHEMIN EST DIFFÉRENT. Le dépôt porte un
// avertissement : `window flags …, window exec` déclenché depuis un callback de fenêtre a
// crashé Live par ré-entrance. Ici on ne touche JAMAIS aux flags ni à la fenêtre après le
// loadbang — on écrit seulement le rect d'une boîte, depuis un Task (thread basse
// priorité), et on sort immédiatement si la taille n'a pas bougé. Le garde `_enCours`
// interdit qu'une écriture en déclenche une autre.
//
// ⚠️ INSTRUMENT AUTO-DIAGNOSTIQUÉ. L'API Max de redimensionnement d'une boîte n'a pas pu
// être vérifiée hors de Max au moment d'écrire : trois routes sont tentées dans l'ordre,
// et la première qui prend est retenue puis ANNONCÉE dans la console. Un script qui échoue
// en silence ici ressemblerait exactement à « Max ne sait pas faire », ce qui est faux.

autowatch = 1;

// Mettre à 0 avant toute release — même règle que le moteur et le Push.
var DEBUG = 0;

// ── PLANCHER ──────────────────────────────────────────────────────────────────
// Mesuré le 2026-09-03 sur la mise en page ACTUELLE (rails visibles, tiroir ouvert),
// en rendant `device/ui/tuple_ui.html` à des largeurs décroissantes :
//
//   largeur fenêtre   900   880   840   800   760   700
//   cases tronquées     0     2     4    15    18    33
//
// Le pire libellé de C Major est `Dmadd9` (44 px de texte) ; sur les tonalités à dièses
// c'est `D#madd9` (51 px). D'où 980 et pas 900 : le plancher doit tenir dans TOUTES les
// tonalités, pas dans celle qui était affichée pendant la mesure.
// En hauteur, la boîte de grille doit rester ≥ 318 px (en-tête 38 + 8 cases de 30 +
// 8 écarts de 5) : mesuré, elle tombe à 322 pour une fenêtre de 583, et à 299 pour 560.
var PLANCHER_L = 980;
var PLANCHER_H = 583;

var NOM_JWEB   = 'tuple_full_jweb';
// DEUX CADENCES, et l'écart entre elles est mesuré.
// Fenêtre OUVERTE : 25 ms (40 Hz). Mesuré le 2026-09-03 dans Live, sur un vrai glisser
// du coin bas-droit — 30 pas de souris, 28 relevés : le jweb suit le bord quasiment
// 1:1. À 250 ms il arrivait par paliers visibles. Le thread bas de Max tourne donc bien
// pendant la boucle modale de redimensionnement de Windows, ce qui n'allait pas de soi.
// Fenêtre FERMÉE : 250 ms. C'est l'état le plus courant du device, et sonder une
// fenêtre absente 40 fois par seconde serait payer pour rien.
var PERIODE_ACTIVE = 25;
var PERIODE_REPOS  = 250;

// ── QUAND ÉCRIRE : UNE SEULE FOIS, À LA FIN DU GESTE ──────────────────────────
// ⚠️ POSER LE RECT PENDANT LE GESTE DÉFORME LE GESTE. Mesuré en échantillonnant la
// FENÊTRE 60 fois pendant un glisser du coin, curseur avançant de 8 px par pas :
//
//   écriture toutes les  70 ms   31 tailles distinctes   saut max 32 px   29/59 figés
//   écriture toutes les 300 ms   52 tailles distinctes   saut max 16 px    8/59 figés
//   AUCUNE écriture pendant      59 tailles distinctes   saut max  9 px    1/59 figés
//
// Chaque `presentation_rect` posé sur le jweb coûte plusieurs images à la fenêtre :
// Max redimensionne la vue CEF de façon synchrone, et pire, la fenêtre se réajuste
// ensuite au contenu — vu en forçant le script à écrire une taille plus grande que sa
// fenêtre, qui a alors grandi toute seule, par bonds, sans que personne n'y touche.
// C'est cette boucle qu'on voit comme « des sauts entre plusieurs tailles ».
//
// Donc : RIEN pendant le mouvement, et une pose EXACTE dès que la taille ne bouge plus
// depuis REPOS_MS. Le contenu garde sa taille le temps du geste — c'est ce que font la
// plupart des hôtes — et rejoint sa fenêtre au relâché, au pixel près (vérifié :
// fenêtre 1696×920, pose 1680×881, soit la zone client exacte).
var REPOS_MS  = 600;   // taille inchangée depuis 600 ms = le geste est FINI
// ⚠️ 600 et non 140 : à 140 ms, une main qui marque un temps d'arrêt en plein glisser
// déclenche une pose, la pose fait réajuster la fenêtre par Max, et la fenêtre bouge
// SOUS la souris. C'est ce qu'Antoine décrivait comme « des sauts entre plusieurs
// tailles ». Une pause de 600 ms en plein geste n'arrive pas.
var MARGE_PX  = 2;     // le rect posé est plus PETIT que la fenêtre de cette marge

var _derniereL = 0, _derniereH = 0;
var _enCours   = false;
var _route     = null;      // 'rect' | 'presentation_rect' | 'script' — annoncée une fois
var _tache     = null;
var _cumul = 0, _ecritures = 0, _pire = 0;   // coût des écritures, en ms
var _vueL = 0, _vueH = 0;    // dernière taille VUE (pas forcément posée)
var _vueDate = 0;            // depuis quand cette taille est stable

// -- Journal -------------------------------------------------------------------
// Meme dispositif que le moteur : la console de Max ne se lit pas depuis un script,
// donc DEBUG ecrit AUSSI dans un fichier, a cote du patch. Le chemin est deduit de
// `patcher.filepath` -- jamais en dur : un chemin absolu gele ecrit dans le vide sur
// toute machine sauf une, et sans la moindre erreur (le moteur l'a vecu).
var _log = '';
var _neuf = false;

function _chemin() {
  if (_log) return _log;
  try {
    // ⚠️ Un SOUS-PATCHEUR n'a pas de fichier : `filepath` y est vide, et la première
    // version de ce script n'écrivait donc jamais rien — mesuré dans Max le 2026-09-03,
    // aucun `window_fit.log` créé, ce qui ressemblait à « le script ne tourne pas ».
    // Il faut remonter jusqu'au patcher qui EST le fichier (le .amxd).
    var p = this.patcher, fp = '', garde = 0;
    while (p && garde++ < 12) {
      fp = p.filepath || '';
      if (fp) break;
      p = p.parentpatcher;
    }
    if (!fp) return '';
    fp = String(fp).split('\\').join('/');
    // ⚠️ `filepath` ne rend PAS la même chose selon l'hôte, mesuré le 2026-09-03 :
    // Max autonome rend le FICHIER (`…/device/tuple.amxd`), Live rend le DOSSIER
    // (`…/Tuple-dev-local`). Couper après le dernier « / » dans les deux cas écrivait
    // donc le journal un dossier trop haut sous Live — un fichier au mauvais endroit
    // ressemble à un fichier absent, et c'est ce qui a fait croire que le script ne
    // tournait pas alors qu'il tournait.
    var dossier = /\.(amxd|maxpat|maxhelp)$/i.test(fp)
      ? fp.substring(0, fp.lastIndexOf('/') + 1)
      : fp.replace(/\/+$/, '') + '/';
    _log = dossier + 'window_fit.log';
  } catch (e) {}
  return _log;
}

function journal(s) {
  if (!DEBUG) return;
  post('[fit] ' + s + '\n');
  try {
    var p = _chemin();
    if (!p) return;
    if (!_neuf) {
      var t = new File(p, 'write');
      if (t.isopen) { t.writestring('=== tuple_window_fit.js (re)charge ===\n'); t.close(); }
      _neuf = true;
    }
    var f = new File(p, 'readwrite');
    if (f.isopen) { f.position = f.eof; f.writestring('[fit] ' + s + '\n'); f.close(); }
  } catch (e) {}
}

// ── Écriture du rect, trois routes ────────────────────────────────────────────
// Les trois existent dans l'API Max ; laquelle s'applique à un jweb en mode
// présentation n'a pas pu être tranchée hors de Max. On essaie, on vérifie, on retient.
function poseRect(patcher, boite, L, H) {
  var routes = [
    ['presentation_rect', function () { boite.message('presentation_rect', 0, 0, L, H); }],
    ['rect',              function () { boite.rect = [0, 0, L, H]; }],
    ['script',            function () { patcher.message('script', 'sendbox', NOM_JWEB,
                                                        'presentation_rect', 0, 0, L, H); }]
  ];
  // Une route déjà retenue n'est pas re-testée : le coût d'un essai raté est un
  // message d'erreur dans la console de Max, et on ne va pas l'écrire 4 fois par seconde.
  var i, depart = 0;
  if (_route) {
    for (i = 0; i < routes.length; i++) if (routes[i][0] === _route) { depart = i; break; }
    try { routes[depart][1](); return true; } catch (e) { _route = null; }
  }
  for (i = 0; i < routes.length; i++) {
    try {
      routes[i][1]();
      if (!_route) { _route = routes[i][0]; journal('route retenue : ' + _route); }
      return true;
    } catch (e) { /* route suivante */ }
  }
  journal('AUCUNE route n\'a pris — le jweb ne suivra pas la fenêtre');
  return false;
}

// La cadence suit l'état de la fenêtre. `Task.interval` se règle en cours de route, et
// le test évite de réécrire la même valeur quarante fois par seconde.
function cadence(ms) { if (_tache && _tache.interval !== ms) _tache.interval = ms; }

function ajuste() {
  if (_enCours) return;
  var patcher = this.patcher;
  if (!patcher) return;

  var fen = patcher.wind;
  if (!fen) { journal('patcher.wind absent'); return; }
  // Fenêtre fermée : ne rien faire, ne rien écrire. C'est l'état le plus courant.
  if (fen.visible === 0 || fen.visible === false) { cadence(PERIODE_REPOS); return; }
  cadence(PERIODE_ACTIVE);

  var taille = fen.size;
  if (!taille || taille.length < 2) return;
  var L = Math.round(taille[0]), H = Math.round(taille[1]);
  if (L === _derniereL && H === _derniereH) return;

  // Suivi de la stabilité : une taille qui ne bouge plus depuis REPOS_MS signe la fin
  // du geste, et c'est le moment où la pose doit être EXACTE quoi qu'il arrive.
  var maintenant = Date.now();
  if (L !== _vueL || H !== _vueH) { _vueL = L; _vueH = H; _vueDate = maintenant; }
  var stable = (maintenant - _vueDate) >= REPOS_MS;

  // Le geste est en cours : on ne touche à rien. C'est la mesure ci-dessus qui commande.
  if (!stable) return;

  var boite = patcher.getnamed(NOM_JWEB);
  if (!boite) { journal('jweb « ' + NOM_JWEB + ' » introuvable'); return; }

  // Le jweb ne descend pas sous le plancher : sous cette taille la grille tronque ses
  // libellés. On préfère une marge vide autour du jweb à des noms d'accords coupés —
  // et surtout on ne repousse PAS la fenêtre, ce qui rentrerait dans la ré-entrance.
  // ⚠️ ON POSE PLUS PETIT QUE LA FENÊTRE, exprès. Max réajuste la fenêtre au contenu :
  // un rect posé à la taille exacte de la zone client suffit à faire regrandir la
  // fenêtre, et cette repousse est visible (mesuré : en forçant un rect plus grand que
  // sa fenêtre, celle-ci a grandi seule de 1200 à 2146 px de large, par bonds). Deux
  // pixels de moins ne se voient pas et ne demandent rien à Max.
  var pL = Math.max(PLANCHER_L, L - MARGE_PX), pH = Math.max(PLANCHER_H, H - MARGE_PX);

  _enCours = true;
  try {
    // Chronomètre l'écriture elle-même. Un redimensionnement saccadé peut venir de deux
    // endroits — la cadence du sondage, ou le COÛT d'un rect posé sur un jweb (Max
    // redessine, CEF refait sa mise en page). Sans ce nombre on règle la cadence à
    // l'aveugle, et c'est exactement ce qui a produit une première mesure rassurante
    // (« 28 relevés pour 30 pas ») pendant que l'écran, lui, saccadait.
    var _t0 = Date.now();
    if (poseRect(patcher, boite, pL, pH)) {
      var _ms = Date.now() - _t0;
      _cumul += _ms; _ecritures++;
      if (_ms > _pire) _pire = _ms;
      _derniereL = L; _derniereH = H;
      journal('fenêtre ' + L + '×' + H + ' -> jweb ' + pL + '×' + pH +
              '  [' + _ms + ' ms, moy ' + Math.round(_cumul / _ecritures) +
              ', pire ' + _pire + ']' +
              (pL > L || pH > H ? '  (plancher atteint)' : ''));
    }
  } finally {
    _enCours = false;
  }
}

// ── Démarrage ─────────────────────────────────────────────────────────────────
// Pas de connexion dans le patch : le script démarre son Task tout seul à
// l'instanciation. Une boîte sans fil est plus facile à relire qu'un fil de plus.
function demarre() {
  if (_tache) return;
  _tache = new Task(ajuste, this);
  _tache.interval = PERIODE_REPOS;
  _tache.repeat();
  journal('démarré — sondage ' + PERIODE_REPOS + '/' + PERIODE_ACTIVE +
          ' ms (repos/actif), plancher ' + PLANCHER_L + '×' + PLANCHER_H);
}

function stop() {
  if (_tache) { _tache.cancel(); _tache = null; journal('arrêté'); }
}

// `notifydeleted` est appelé par Max quand l'objet disparaît (device retiré, patch
// rechargé). Sans ça le Task survivrait au device et continuerait de sonder un
// patcher mort.
function notifydeleted() { stop(); }

demarre();
