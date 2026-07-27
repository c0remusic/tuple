// tuple_dl.js — node.script: downloads Tuple update + installs.
// Platforms:
//   win          — download Tuple-Installer.exe → launch with UI (requires_reinstall=true)
//   win-inplace  — download tuple.zip → extract in-place (requires_reinstall=false)
//   mac          — download tuple.zip → extract in-place via shell (POSIX, always works)
// Called from tuple_chord_engine.js:
//   _patcher.getnamed('tuple_dl').message('dl', url, platform, amxdPath)

var maxApi = require('max-api');
var https  = require('https');
var http   = require('http');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var cp     = require('child_process');
var zlib   = require('zlib');
var crypto = require('crypto');

// ── feedback → outlet → obj-CE (engine handleprogress) → outlet 7 → jweb ──
// The engine retries 'dl' up to 6×, so the FIRST one sets _busy and the rest are
// ignored until the download finishes. done() emits 'progress done', which the
// engine turns into 'updatedone' for the jweb AND uses to stop its retry loop.
var _busy = false;
function done()      { _busy = false; maxApi.outlet('progress', 'done'); }
function fail(tok)   { _busy = false; maxApi.post('tuple_dl: FAIL ' + tok); maxApi.outlet('progress', 'error'); }

maxApi.addHandler('dl', function(url, platform, amxdPath, shaUrl) {
    if (_busy) { maxApi.post('tuple_dl: busy — ignoring duplicate dl (engine retry)'); return; }
    platform  = String(platform  || '');
    url       = String(url       || '');
    amxdPath  = String(amxdPath  || '');
    shaUrl    = String(shaUrl    || '');   // '' = release predates checksums, or asset missing — skip verification
    maxApi.post('tuple_dl: platform=' + platform + ' amxdPath=' + amxdPath + ' sha=' + (shaUrl ? 'yes' : 'no'));
    try {
        if      (platform === 'win')         { _busy = true; dlWin(url, shaUrl); }
        else if (platform === 'win-inplace') { _busy = true; dlWinInPlace(url, amxdPath, shaUrl); }
        else if (platform === 'mac')         { _busy = true; dlMac(url, amxdPath, shaUrl); }
        else { maxApi.post('tuple_dl: unknown platform ' + platform); }
    } catch (e) { maxApi.post('tuple_dl: dispatch error: ' + e.message); fail('dispatch'); }  // never leave _busy stuck
});

// ── checksum verification (SHA256) ──────────────────────────────────────────
// shaUrl points at a plain-text sidecar (just the hex digest, written by
// build_zip.py's write_sha256_sidecar()). Empty shaUrl = no sidecar on this
// release (older release, or asset omitted) → verification is skipped, not
// failed: this is a corruption/tamper check layered on top of HTTPS, not the
// only gate, so a missing sidecar degrades to "no extra check" rather than
// bricking updates from before this feature existed.
function fetchText(url, cb) {
    var mod = url.indexOf('https') === 0 ? https : http;
    mod.get(url, function(res) {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
            fetchText(res.headers.location, cb); return;
        }
        if (res.statusCode !== 200) { cb(new Error('HTTP ' + res.statusCode)); return; }
        var body = '';
        res.on('data', function(chunk) { body += chunk; });
        res.on('end', function() { cb(null, body); });
    }).on('error', cb);
}
function sha256File(filePath, cb) {
    var hash = crypto.createHash('sha256');
    var stream = fs.createReadStream(filePath);
    stream.on('data', function(chunk) { hash.update(chunk); });
    stream.on('error', cb);
    stream.on('end', function() { cb(null, hash.digest('hex')); });
}
// Downloads dest, verifies against shaUrl if given, THEN calls cb(err). On
// checksum mismatch the bad file is deleted before cb(err) — never left
// behind for a caller to accidentally use.
function downloadVerified(url, dest, shaUrl, cb) {
    download(url, dest, function(err) {
        if (err) { cb(err); return; }
        if (!shaUrl) { cb(null); return; }
        fetchText(shaUrl, function(shaErr, expected) {
            if (shaErr) { maxApi.post('tuple_dl: checksum fetch failed (' + shaErr.message + ') — aborting, not risking an unverified binary'); cb(shaErr); return; }
            expected = String(expected || '').trim().split(/\s+/)[0].toLowerCase();
            sha256File(dest, function(hashErr, actual) {
                if (hashErr) { cb(hashErr); return; }
                if (actual !== expected) {
                    maxApi.post('tuple_dl: CHECKSUM MISMATCH expected=' + expected + ' actual=' + actual);
                    try { fs.unlinkSync(dest); } catch (_) {}
                    cb(new Error('checksum mismatch')); return;
                }
                maxApi.post('tuple_dl: checksum OK (' + actual + ')');
                cb(null);
            });
        });
    });
}

// ── download helper (follows 301/302/303 redirects) ──────────────────────────
function download(url, dest, cb) {
    var mod = url.indexOf('https') === 0 ? https : http;
    mod.get(url, function(res) {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
            download(res.headers.location, dest, cb); return;
        }
        if (res.statusCode !== 200) { cb(new Error('HTTP ' + res.statusCode)); return; }
        var f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on('finish', function() { f.close(function() { cb(null); }); });
        f.on('error', function(e) { try { fs.unlinkSync(dest); } catch(_) {} cb(e); });
    }).on('error', cb);
}

// ── Max path → POSIX (macOS) ─────────────────────────────────────────────────
// Max's patcher.filepath is "Volume:/path" on macOS (e.g. "Macintosh HD:/Users/…").
// The shell (cp/rm) needs a real POSIX path. Boot volume → files live at "/" (strip the
// volume); external volume → "/Volumes/<vol>/…". Disambiguate via fs.existsSync.
function maxToPosix(p) {
    p = String(p || '');
    if (!p || p.charAt(0) === '/') return p;            // already POSIX (or empty)
    var m = p.match(/^[^:\/]+:(\/.*)$/);                 // "Volume:/path" → "/path"
    if (!m) return p;
    var rest = m[1];
    if (fs.existsSync(rest)) return rest;               // boot volume (e.g. /Users/… exists)
    var vol = p.slice(0, p.indexOf(':'));
    var ext = '/Volumes/' + vol + rest;                 // external volume
    return fs.existsSync(ext) ? ext : rest;             // best effort
}

// ── Windows: launch branded installer (requires_reinstall=true) ───────────────
function dlWin(url, shaUrl) {
    var dest = path.join(os.tmpdir(), 'Tuple-Installer.exe');
    maxApi.post('tuple_dl: downloading → ' + dest);
    downloadVerified(url, dest, shaUrl, function(err) {
        if (err) { maxApi.post('tuple_dl: download error: ' + err.message); fail(/checksum/.test(err.message) ? 'checksum' : 'download'); return; }
        maxApi.post('tuple_dl: launching installer');
        var proc = cp.spawn(dest, [], { detached: true, stdio: 'ignore' });
        proc.unref();
        // The installer (separate process) completes the update + the user restarts
        // Ableton — so we do NOT emit 'done' (that would flip the jweb to "reopen the
        // device"). _busy stays true so the engine's retried 'dl' won't relaunch it.
        maxApi.post('tuple_dl: installer launched — restart Ableton when it finishes');
    });
}

// ── Windows: extract zip in-place (requires_reinstall=false, .amxd EBUSY skipped) ──
function dlWinInPlace(url, amxdPath, shaUrl) {
    var dest = path.join(os.tmpdir(), 'tuple-update.zip');
    maxApi.post('tuple_dl: downloading → ' + dest);
    downloadVerified(url, dest, shaUrl, function(err) {
        if (err) { maxApi.post('tuple_dl: download error: ' + err.message); fail(/checksum/.test(err.message) ? 'checksum' : 'download'); return; }
        var installDir = amxdPath ? path.dirname(path.dirname(amxdPath)) : '';
        if (!installDir) {
            maxApi.post('tuple_dl: no amxd path — cannot determine install dir');
            fail('nopath'); return;
        }
        maxApi.post('tuple_dl: extracting → ' + installDir);
        extractZip(dest, installDir, function(e) {
            if (e) { maxApi.post('tuple_dl: extract error: ' + e); fail('extract'); return; }
            maxApi.post('tuple_dl: done — reload device');
            done();
        });
    });
}

// ── macOS: extract zip in-place via shell (POSIX allows replacing open files) ─
function dlMac(url, amxdPath, shaUrl) {
    var tempZip = path.join(os.tmpdir(), 'tuple-update.zip');
    maxApi.post('tuple_dl: downloading → ' + tempZip);
    downloadVerified(url, tempZip, shaUrl, function(err) {
        if (err) { maxApi.post('tuple_dl: download error: ' + err.message); fail(/checksum/.test(err.message) ? 'checksum' : 'download'); return; }
        // Prefer amxdPath-derived dir; fall back to saved install path file.
        // amxdPath is a Max path ("Macintosh HD:/Users/…") → convert to POSIX for the shell.
        var installDir = '';
        if (amxdPath) { installDir = path.dirname(path.dirname(maxToPosix(amxdPath))); }
        if (!installDir) {
            try { installDir = maxToPosix(fs.readFileSync(path.join(os.homedir(), '.tuple-install-path'), 'utf8').trim()); } catch(_) {}
        }
        if (!installDir) {
            maxApi.post('tuple_dl: no saved path — reinstall via .command');
            fail('nopath'); return;
        }
        maxApi.post('tuple_dl: extracting → ' + installDir);
        var tmp = os.tmpdir();
        var q   = function(s) { return '"' + s.replace(/"/g, '\\"') + '"'; };
        var cmd = [
            'unzip -o ' + q(tempZip) + ' "Tuple/*" -d ' + q(tmp),
            'rm -rf '   + q(path.join(installDir, 'Tuple')),
            'cp -R '    + q(path.join(tmp, 'Tuple')) + ' ' + q(installDir + '/'),
            'xattr -dr com.apple.quarantine ' + q(path.join(installDir, 'Tuple'))
        ].join(' && ');
        cp.exec(cmd, function(e) {
            if (e) { maxApi.post('tuple_dl: install error: ' + e.message); fail('extract'); return; }
            maxApi.post('tuple_dl: done — reload device');
            done();
        });
    });
}

// ── Pure Node.js ZIP extractor (method 0 = stored, method 8 = DEFLATE) ───────
// Extracts all entries from zipPath into destDir.
// EBUSY / EPERM (e.g. .amxd locked by Max on Windows) → silently skipped.
function extractZip(zipPath, destDir, cb) {
    fs.readFile(zipPath, function(err, buf) {
        if (err) return cb(err.message);

        // Find End of Central Directory (search from end, handle comment up to 65535 bytes)
        var eocd = -1;
        for (var i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
            if (buf[i]===0x50 && buf[i+1]===0x4b && buf[i+2]===0x05 && buf[i+3]===0x06) { eocd = i; break; }
        }
        if (eocd < 0) return cb('Not a valid ZIP');

        var cdCount = buf[eocd+10] | (buf[eocd+11]<<8);
        var cdOff   = (buf[eocd+16]|(buf[eocd+17]<<8)|(buf[eocd+18]<<16)|(buf[eocd+19]<<24))>>>0;

        if (cdCount === 0) return cb(null);

        // Parse Central Directory entries
        var entries = [];
        var pos = cdOff;
        for (var j = 0; j < cdCount; j++) {
            if (buf[pos]!==0x50||buf[pos+1]!==0x4b||buf[pos+2]!==0x01||buf[pos+3]!==0x02) break;
            var method   = buf[pos+10] | (buf[pos+11]<<8);
            var compSize = (buf[pos+20]|(buf[pos+21]<<8)|(buf[pos+22]<<16)|(buf[pos+23]<<24))>>>0;
            var fnLen    = buf[pos+28] | (buf[pos+29]<<8);
            var exLen    = buf[pos+30] | (buf[pos+31]<<8);
            var cmLen    = buf[pos+32] | (buf[pos+33]<<8);
            var lhOff    = (buf[pos+42]|(buf[pos+43]<<8)|(buf[pos+44]<<16)|(buf[pos+45]<<24))>>>0;
            var name     = buf.slice(pos+46, pos+46+fnLen).toString('utf8');
            pos += 46 + fnLen + exLen + cmLen;
            if (name[name.length-1] === '/') continue; // skip directory entries
            var lhExLen  = buf[lhOff+28] | (buf[lhOff+29]<<8);
            var lhFnLen  = buf[lhOff+26] | (buf[lhOff+27]<<8);
            var dataOff  = lhOff + 30 + lhFnLen + lhExLen;
            entries.push({ name:name, method:method, data:buf.slice(dataOff, dataOff+compSize) });
        }

        if (entries.length === 0) return cb(null);
        var pending = entries.length, errors = [];

        entries.forEach(function(e) {
            var outPath = path.join(destDir, e.name.split('/').join(path.sep));
            var outDir  = path.dirname(outPath);
            try { fs.mkdirSync(outDir, { recursive: true }); } catch(_) {}

            // Write to a sidecar .tmp then fs.rename() onto outPath (same-volume rename is atomic on
            // both Windows and POSIX) instead of writing outPath directly — a mid-write crash/EBUSY
            // used to leave the real target half-written; now it only ever leaves an orphan .tmp, the
            // real file stays whatever it was before (audit 2026-07-15, dlWinInPlace non-atomic).
            function write(data) {
                var tmpPath = outPath + '.tmp';
                function settle(err) {
                    if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
                        maxApi.post('tuple_dl: skip locked: ' + e.name);
                    } else if (err) {
                        errors.push(e.name + ': ' + err.message);
                    }
                    if (err) { try { fs.unlinkSync(tmpPath); } catch(_) {} }
                    if (--pending === 0) cb(errors.length ? errors.join('; ') : null);
                }
                fs.writeFile(tmpPath, data, function(werr) {
                    if (werr) { settle(werr); return; }
                    fs.rename(tmpPath, outPath, settle);
                });
            }

            if (e.method === 0) {
                write(e.data);
            } else if (e.method === 8) {
                zlib.inflateRaw(e.data, function(zerr, data) {
                    if (zerr) { errors.push(e.name + ': inflate: ' + zerr.message); if (--pending===0) cb(errors.join(';')); return; }
                    write(data);
                });
            } else {
                maxApi.post('tuple_dl: skip (unsupported method ' + e.method + '): ' + e.name);
                if (--pending === 0) cb(errors.length ? errors.join('; ') : null);
            }
        });
    });
}
