// device/tuple_updater.js
// Node for Max auto-updater.
// Receives messages from the Max patch; reports progress via Max.outlet().
// Run in Max via: [node.script tuple_updater.js]
'use strict';

var https  = require('https');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var cp     = require('child_process');

// max-api is provided by Max's Node runtime. When running unit tests outside Max,
// require() fails — the catch provides a no-op stub so the module still loads.
var Max;
try { Max = require('max-api'); } catch(e) {
  Max = {
    outlet:      function() {},
    addHandler:  function() {},
    addHandlers: function() {}
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — fill in OWNER/REPO before first release
// ──────────────────────────────────────────────────────────────────────────────
var REPO      = 'OWNER/REPO';          // ← replace with real GitHub owner/repo slug
var API_URL   = 'https://api.github.com/repos/' + REPO + '/releases/latest';
var CHECK_TTL = 24 * 60 * 60 * 1000;  // 1 day in ms

// Install dir = the folder containing tuple_updater.js (= where tuple.amxd lives).
// __dirname in Node for Max resolves to the script's actual directory.
var INSTALL_DIR = __dirname + path.sep;

// State file: tracks lastCheck timestamp + dismissed versions.
var STATE_FILE = path.join(__dirname, '.tuple-update-state.json');

// ──────────────────────────────────────────────────────────────────────────────
// EXPORTED HELPERS (tested outside Max)
// ──────────────────────────────────────────────────────────────────────────────

// Compare semver strings. Returns -1 | 0 | 1.
// Malformed input (non-numeric parts) returns 0.
function _semver(a, b) {
  a = String(a).replace(/^v/, '');
  b = String(b).replace(/^v/, '');
  var pa = a.split('.').map(Number);
  var pb = b.split('.').map(Number);
  if (pa.some(isNaN) || pb.some(isNaN) || pa.length < 3 || pb.length < 3) return 0;
  for (var i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return  1;
  }
  return 0;
}

// Extract install directory from patcher.filepath string.
// Normalises backslashes; returns empty string for empty input.
function _installDir(fp) {
  if (!fp) return '';
  fp = fp.replace(/\\/g, '/');
  var slash = fp.lastIndexOf('/');
  return slash === -1 ? '' : fp.substring(0, slash + 1);
}

// Return unzip command descriptor for the given platform.
// { cmd: string, args: string[] }  — caller appends zip + dest to args.
function _unzipCmd(platform, zipPath, destDir) {
  zipPath  = zipPath  || 'tuple.zip';
  destDir  = destDir  || '.';
  if (platform === 'win32') {
    return { cmd: 'tar', args: ['-xf', zipPath, '-C', destDir] };
  }
  if (platform === 'darwin') {
    return { cmd: 'ditto', args: ['-xk', zipPath, destDir] };
  }
  return { cmd: 'tar', args: ['-xf', zipPath, '-C', destDir] };
}

// Synchronous zip sanity check: exists + size > 0 + PK magic bytes.
function _verifyZip(zipPath) {
  try {
    var stat = fs.statSync(zipPath);
    if (stat.size < 4) return false;
    var buf = Buffer.alloc(4);
    var fd = fs.openSync(zipPath, 'r');
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  } catch(e) { return false; }
}

// ──────────────────────────────────────────────────────────────────────────────
// STATE (persisted JSON next to the script)
// ──────────────────────────────────────────────────────────────────────────────

function _loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) { return {}; }
}
function _saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8'); } catch(e) {}
}

// ──────────────────────────────────────────────────────────────────────────────
// VERSION CHECK
// ──────────────────────────────────────────────────────────────────────────────

var _localVersion = '';
var _latestTag    = '';
var _latestAsset  = '';
var _latestNotes  = '';

function checkUpdate() {
  var state = _loadState();
  if (state.lastCheck && (Date.now() - state.lastCheck) < CHECK_TTL) {
    if (state.latestTag && _semver(_localVersion, state.latestTag) < 0) {
      if (!state.dismissed || state.dismissed.indexOf(state.latestTag) === -1) {
        Max.outlet('update_available', state.latestTag, state.latestNotes || '');
      }
    }
    return;
  }

  var options = {
    hostname: 'api.github.com',
    path:     '/repos/' + REPO + '/releases/latest',
    headers:  { 'User-Agent': 'Tuple-Updater/' + (_localVersion || 'dev') }
  };

  https.get(options, function(res) {
    if (res.statusCode !== 200) { res.resume(); return; }
    var body = '';
    res.on('data', function(chunk) { body += chunk; });
    res.on('end', function() {
      try {
        var data = JSON.parse(body);
        var tag  = String(data.tag_name || '').replace(/^v/, '');
        if (!tag) return;

        var asset = null;
        var assets = data.assets || [];
        for (var i = 0; i < assets.length; i++) {
          if (assets[i].name === 'tuple.zip') { asset = assets[i]; break; }
        }
        if (!asset) return;

        var notes = String(data.body || '').substring(0, 500);
        _latestTag   = tag;
        _latestAsset = asset.browser_download_url;
        _latestNotes = notes;

        var state2 = _loadState();
        state2.lastCheck   = Date.now();
        state2.latestTag   = tag;
        state2.latestNotes = notes;
        _saveState(state2);

        if (_semver(_localVersion, tag) < 0) {
          var dismissed = state2.dismissed || [];
          if (dismissed.indexOf(tag) === -1) {
            Max.outlet('update_available', tag, notes);
          }
        }
      } catch(e) {}
    });
  }).on('error', function() {});
}

// ──────────────────────────────────────────────────────────────────────────────
// MAX MESSAGE HANDLERS
// ──────────────────────────────────────────────────────────────────────────────

Max.addHandlers({
  localversion: function(v) {
    _localVersion = String(v);
    checkUpdate();
  },
  checkupdate: function() {
    var state = _loadState(); state.lastCheck = 0; _saveState(state);
    checkUpdate();
  },
  dismissupdate: function(tag) {
    var state = _loadState();
    state.dismissed = state.dismissed || [];
    if (state.dismissed.indexOf(String(tag)) === -1) state.dismissed.push(String(tag));
    _saveState(state);
  },
  triggerupdate: function() { doUpdate(); }
});

// ──────────────────────────────────────────────────────────────────────────────
// EXPORTS for unit tests
// ──────────────────────────────────────────────────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = { _semver: _semver, _installDir: _installDir, _unzipCmd: _unzipCmd, _verifyZip: _verifyZip };
}
