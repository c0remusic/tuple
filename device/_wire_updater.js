// Wires the auto-updater into the MAIN branch .amxd using targeted string injection.
// No JSON.parse/stringify — preserves original formatting exactly.
// Run from repo root: node device/_wire_updater.js
//
// ARCHITECTURE (v3 — final):
//
//  COMMAND FILTER (in Max, before node.script):
//    obj-8[1] ─ original ──────────────────────────► obj-CE (unchanged)
//    obj-8[1] ─ parallel ──► obj-URT (route triggerupdate dismissupdate checkupdate)
//                               outlet 0 (triggerupdate) ──► obj-UTRIG (msg "triggerupdate")
//                               outlet 1 (dismissupdate, stripped tag) ──► obj-UPRE (prepend dismissupdate)
//                               outlet 2 (checkupdate) ──► obj-UCHECK (msg "checkupdate")
//                               outlet 3 (dump/everything else) ──► NOTHING
//                             obj-UTRIG ──► obj-UPD (node.script)
//                             obj-UPRE  ──► obj-UPD
//                             obj-UCHECK ──► obj-UPD
//
//  node.script OUTPUT (all three destinations in parallel):
//    obj-UPD[0] ──► obj-6[0]   direct to strip jweb (update_available / progress / done / error)
//    obj-UPD[0] ──► obj-SUI[0] s tuple_ui → full-view jweb (same messages)
//    obj-UPD[0] ──► obj-USEL   sel reload_ui → bang ──► obj-RMSG ("reloadui") ──► obj-CE
//
//  Why direct obj-6 instead of route dump:
//    route's dump outlet changes the message path in ways that may prevent bindInlet
//    from firing; direct wiring matches how the chord engine already talks to the jweb.
'use strict';
var fs  = require('fs');
var cp  = require('child_process');

var AMXD = 'device/tuple.amxd';

// Start from main's clean .amxd (no updater objects)
var mainBuf = cp.execSync('git show main:device/tuple.amxd');
var hdr     = mainBuf.slice(0, 32);
var body    = mainBuf.slice(32, mainBuf.length - 1).toString('utf8');

if (mainBuf.length !== 55464) {
  console.error('Unexpected main .amxd size:', mainBuf.length, '(expected 55464)');
  process.exit(1);
}

var sp3 = '   ';
var sp4 = '    ';
var sp5 = '     ';
var sp6 = '      ';

function makeBox(id, maxclass, text, rect, ni, no, outletTypes) {
  var otLines   = outletTypes.map(function(t) { return sp6 + '"' + t + '"'; }).join(',\n');
  var rectLines = rect.map(function(v)        { return sp6 + v; }).join(',\n');
  return (
    sp3 + '{\n' +
    sp4 + '"box": {\n' +
    sp5 + '"id": "' + id + '",\n' +
    sp5 + '"maxclass": "' + maxclass + '",\n' +
    sp5 + '"numinlets": ' + ni + ',\n' +
    sp5 + '"numoutlets": ' + no + ',\n' +
    sp5 + '"outlettype": [\n' + otLines + '\n' + sp5 + '],\n' +
    sp5 + '"patching_rect": [\n' + rectLines + '\n' + sp5 + '],\n' +
    sp5 + '"text": "' + text + '"\n' +
    sp4 + '}\n' +
    sp3 + '}'
  );
}

function makeLine(srcId, srcOut, dstId, dstIn, order) {
  var orderStr = (order !== undefined) ? (sp5 + '"order": ' + order + ',\n') : '';
  return (
    sp3 + '{\n' +
    sp4 + '"patchline": {\n' +
    sp5 + '"destination": [\n' + sp6 + '"' + dstId + '",\n' + sp6 + dstIn + '\n' + sp5 + '],\n' +
    orderStr +
    sp5 + '"source": [\n' + sp6 + '"' + srcId + '",\n' + sp6 + srcOut + '\n' + sp5 + ']\n' +
    sp4 + '}\n' +
    sp3 + '}'
  );
}

// ── BOXES (7) ─────────────────────────────────────────────────────────────────
var newBoxes = [
  // Command filter: intercepts triggerupdate / dismissupdate / checkupdate only
  makeBox('obj-URT',   'newobj',  'route triggerupdate dismissupdate checkupdate', [200, 380, 230, 22], 2, 4, ['','','','']),
  // Message boxes that reconstruct named messages (route strips the selector)
  makeBox('obj-UTRIG', 'message', 'triggerupdate',                                 [200, 420,  90, 22], 2, 1, ['']),
  makeBox('obj-UCHECK','message', 'checkupdate',                                   [400, 420,  80, 22], 2, 1, ['']),
  // prepend reconstructs [dismissupdate, tag] from stripped tag
  makeBox('obj-UPRE',  'newobj',  'prepend dismissupdate',                         [300, 420, 120, 22], 2, 1, ['']),
  // Node for Max auto-updater
  makeBox('obj-UPD',   'newobj',  'node.script tuple_updater.js',                  [300, 460, 180, 22], 1, 1, ['']),
  // sel reload_ui: fires bang only on reload_ui; no dump (other messages just drop)
  makeBox('obj-USEL',  'newobj',  'sel reload_ui',                                 [300, 500,  80, 22], 2, 1, ['']),
  // Message box that sends "reloadui" selector to chord engine
  makeBox('obj-RMSG',  'message', 'reloadui',                                      [300, 540,  60, 22], 2, 1, ['']),
];

// ── LINES (12) ────────────────────────────────────────────────────────────────
// obj-8[1] → obj-CE is NOT removed (original kept intact)
var newLines = [
  // Parallel filter (fires after chord engine at order:1, so engine init is unaffected)
  makeLine('obj-8',    1, 'obj-URT',    0, 2),
  // Filter outlets → message reconstruction
  makeLine('obj-URT',  0, 'obj-UTRIG',  0),
  makeLine('obj-URT',  1, 'obj-UPRE',   0),
  makeLine('obj-URT',  2, 'obj-UCHECK', 0),
  // Reconstructed messages → node.script
  makeLine('obj-UTRIG',0, 'obj-UPD',    0),
  makeLine('obj-UPRE', 0, 'obj-UPD',    0),
  makeLine('obj-UCHECK',0,'obj-UPD',    0),
  // node.script output → strip jweb (direct, same path as chord engine)
  makeLine('obj-UPD',  0, 'obj-6',      0),
  // node.script output → s tuple_ui → full-view jweb
  makeLine('obj-UPD',  0, 'obj-SUI',    0),
  // node.script output → sel reload_ui (only reload_ui passes; others silently drop)
  makeLine('obj-UPD',  0, 'obj-USEL',   0),
  // reload_ui match → reloadui message → chord engine
  makeLine('obj-USEL', 0, 'obj-RMSG',   0),
  makeLine('obj-RMSG', 0, 'obj-CE',     0),
];

// ── INSERT BOXES ──────────────────────────────────────────────────────────────
var boxBoundary = '  ],\n  "lines": [';
var boxesEnd = body.indexOf(boxBoundary);
if (boxesEnd === -1) { console.error('ERROR: cannot find outer boxes/lines boundary'); process.exit(1); }
body = body.slice(0, boxesEnd) + ',\n' + newBoxes.join(',\n') + body.slice(boxesEnd);
console.log('Inserted', newBoxes.length, 'boxes');

// ── INSERT LINES ──────────────────────────────────────────────────────────────
var linesCloseAnchor = '\n  ],\n  "dependency_';
var linesCloseIdx = body.indexOf(linesCloseAnchor);
if (linesCloseIdx === -1) { console.error('ERROR: cannot find outer lines array close'); process.exit(1); }
body = body.slice(0, linesCloseIdx) + ',\n' + newLines.join(',\n') + body.slice(linesCloseIdx);
console.log('Inserted', newLines.length, 'lines');

// ── WRITE ─────────────────────────────────────────────────────────────────────
var bodyBuf = Buffer.from(body + '\0', 'utf8');
var newHdr  = Buffer.from(hdr);
newHdr.writeUInt32LE(bodyBuf.length, 28);
fs.writeFileSync(AMXD, Buffer.concat([newHdr, bodyBuf]));
console.log('Written:', AMXD, '—', bodyBuf.length, 'bytes body');

// ── VERIFY ────────────────────────────────────────────────────────────────────
var checkBuf = fs.readFileSync(AMXD);
try {
  var j = JSON.parse(checkBuf.slice(32, checkBuf.length - 1).toString('utf8'));
  var p = j.patcher;
  console.log('Parse OK — boxes:', p.boxes.length, '(expect 94)  lines:', p.lines.length, '(expect 118)');

  var ids = {};
  p.boxes.forEach(function(b) { if (b.box) ids[b.box.id] = b.box.text || b.box.maxclass; });
  ['obj-URT','obj-UTRIG','obj-UPRE','obj-UCHECK','obj-UPD','obj-USEL','obj-RMSG'].forEach(function(id) {
    console.log(id, ':', ids[id] || 'MISSING');
  });

  var b8ce  = p.lines.filter(function(l){ var s=l.patchline.source,d=l.patchline.destination; return s[0]==='obj-8'&&s[1]===1&&d[0]==='obj-CE'; });
  var b8urt = p.lines.filter(function(l){ var s=l.patchline.source,d=l.patchline.destination; return s[0]==='obj-8'&&s[1]===1&&d[0]==='obj-URT'; });
  var upd6  = p.lines.filter(function(l){ var s=l.patchline.source,d=l.patchline.destination; return s[0]==='obj-UPD'&&d[0]==='obj-6'; });
  var updSUI= p.lines.filter(function(l){ var s=l.patchline.source,d=l.patchline.destination; return s[0]==='obj-UPD'&&d[0]==='obj-SUI'; });
  console.log('obj-8[1]->obj-CE :', b8ce.length,  '(expect 1) — original kept');
  console.log('obj-8[1]->obj-URT:', b8urt.length, '(expect 1) — filter parallel');
  console.log('obj-UPD->obj-6   :', upd6.length,  '(expect 1) — direct strip jweb');
  console.log('obj-UPD->obj-SUI :', updSUI.length,'(expect 1) — full-view jweb');
} catch(e) {
  console.error('PARSE ERROR:', e.message);
  process.exit(1);
}
