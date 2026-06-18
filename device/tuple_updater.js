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
var REPO      = 'c0remusic/tuple';     // GitHub owner/repo slug
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
  if (pa.some(isNaN) || pb.some(isNaN) || pa.length !== 3 || pb.length !== 3) return 0;
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
// UPDATE HELPERS
// ──────────────────────────────────────────────────────────────────────────────

// Recursive sync directory copy.
function _copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  var entries = fs.readdirSync(src, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var s = path.join(src, e.name);
    var d = path.join(dest, e.name);
    if (e.isDirectory()) { _copyDir(s, d); } else { fs.copyFileSync(s, d); }
  }
}

// Recursively delete a directory (silently ignores errors).
function _rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch(e) {}
}

// Copy installDir to a sibling folder named <installDir>-backup-<timestamp>.
// Returns the backup path, or throws on error.
function _backup(installDir) {
  var dest = installDir.replace(/[/\\]$/, '') + '-backup-' + Date.now();
  _copyDir(installDir.replace(/[/\\]$/, ''), dest);
  return dest;
}

// Download url to destPath. Calls onProgress(pct) during download.
// Follows redirects recursively (GitHub asset CDN uses 302 → CDN). Returns a Promise.
function _download(url, destPath, onProgress) {
  return new Promise(function(resolve, reject) {
    var file = fs.createWriteStream(destPath);
    var request = https.get(url, function(res) {
      if (res.statusCode === 301 || res.statusCode === 302) {
        var location = res.headers.location;
        res.resume();
        // close() is async — wait for it before unlinking (Windows holds the handle until close)
        file.close(function() {
          try { fs.unlinkSync(destPath); } catch(e) {}
          _download(location, destPath, onProgress).then(resolve).catch(reject);
        });
        return;
      }
      if (res.statusCode !== 200) {
        file.close(); reject(new Error('HTTP ' + res.statusCode)); return;
      }
      var total    = parseInt(res.headers['content-length'] || '0', 10);
      var received = 0;
      res.on('data', function(chunk) {
        received += chunk.length;
        if (total > 0 && onProgress) onProgress(Math.round(received / total * 100));
      });
      res.pipe(file);
      file.on('finish', function() { file.close(resolve); });
      file.on('error', function(e) { file.close(); reject(e); });
    });
    request.on('error', function(e) { file.close(); reject(e); });
    request.setTimeout(60000, function() { request.destroy(); reject(new Error('Download timeout')); });
  });
}

// Extract zipPath to destDir using the best available system tool.
// Falls back on failure: Windows → PowerShell, macOS → unzip.
function _extract(zipPath, destDir) {
  return new Promise(function(resolve, reject) {
    var desc = _unzipCmd(process.platform, zipPath, destDir);
    var proc = cp.spawn(desc.cmd, desc.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('close', function(code) {
      if (code === 0) { resolve(); return; }
      if (process.platform === 'win32') {
        var ps = cp.spawn('powershell', [
          '-NoProfile', '-Command',
          'Expand-Archive -Force -Path "' + zipPath + '" -DestinationPath "' + destDir + '"'
        ], { stdio: 'inherit' });
        ps.on('close', function(c2) {
          if (c2 === 0) resolve(); else reject(new Error('Extract failed (PowerShell): exit ' + c2));
        });
      } else {
        var uz = cp.spawn('unzip', ['-o', zipPath, '-d', destDir], { stdio: 'inherit' });
        uz.on('close', function(c2) {
          if (c2 === 0) resolve(); else reject(new Error('Extract failed (unzip): exit ' + c2));
        });
      }
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// MAIN UPDATE FLOW
// ──────────────────────────────────────────────────────────────────────────────

var _updating = false;

function doUpdate() {
  if (_updating) return;
  if (!_latestAsset) { Max.outlet('update_error', 'No asset URL — run check first.'); return; }
  _updating = true;

  var installDir = INSTALL_DIR.replace(/[/\\]$/, '');
  var tmpZip     = path.join(os.tmpdir(), 'tuple-update-' + Date.now() + '.zip');
  var tmpExtract = path.join(os.tmpdir(), 'tuple-update-extract-' + Date.now());
  var backup     = null;
  var oldAmxdBuf = null;

  var amxdPath = path.join(installDir, 'tuple.amxd');
  try { oldAmxdBuf = fs.readFileSync(amxdPath); } catch(e) {}

  function fail(msg) {
    _updating = false;
    if (backup) {
      try {
        _copyDir(backup, installDir);
        _rmDir(backup);
      } catch(e) {
        // Restore failed — leave backup on disk so user can recover manually
        msg = msg + ' (restore failed — backup at: ' + backup + ')';
      }
    }
    try { if (fs.existsSync(tmpZip))     fs.unlinkSync(tmpZip);  } catch(e) {}
    try { if (fs.existsSync(tmpExtract)) _rmDir(tmpExtract);     } catch(e) {}
    Max.outlet('update_error', msg);
  }

  Max.outlet('update_progress', 0);

  _download(_latestAsset, tmpZip, function(pct) {
    Max.outlet('update_progress', Math.round(pct * 0.7));
  })
  .then(function() {
    if (!_verifyZip(tmpZip)) { fail('Downloaded file is not a valid zip.'); return Promise.reject('handled'); }
    Max.outlet('update_progress', 72);
    try { backup = _backup(installDir); } catch(e) { fail('Backup failed: ' + e.message); return Promise.reject('handled'); }
    Max.outlet('update_progress', 75);
    fs.mkdirSync(tmpExtract, { recursive: true });
    return _extract(tmpZip, tmpExtract);
  })
  .then(function() {
    if (!backup) return Promise.reject('handled');
    Max.outlet('update_progress', 85);

    var extractRoot = tmpExtract;
    var entries = fs.readdirSync(tmpExtract, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) {
      extractRoot = path.join(tmpExtract, entries[0].name);
    }

    _copyDir(extractRoot, installDir);
    Max.outlet('update_progress', 98);

    var changedAmxd = false;
    try {
      var newAmxdBuf = fs.readFileSync(amxdPath);
      changedAmxd = oldAmxdBuf ? !oldAmxdBuf.equals(newAmxdBuf) : true;
    } catch(e) { changedAmxd = true; }

    try { fs.unlinkSync(tmpZip); }  catch(e) {}
    try { _rmDir(tmpExtract); }     catch(e) {}

    var state = _loadState();
    if (state.lastBackup) { try { _rmDir(state.lastBackup); } catch(e) {} }
    state.lastBackup = backup;
    _saveState(state);

    _updating = false;
    Max.outlet('update_progress', 100);
    Max.outlet('update_done', changedAmxd ? 1 : 0);
    Max.outlet('reload_ui');
  })
  .catch(function(e) {
    if (e !== 'handled') fail(String(e && e.message ? e.message : e));
  });
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
