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

// ── feedback → outlet → obj-CE (engine handleprogress) → outlet 7 → jweb ──
// The engine retries 'dl' up to 6×, so the FIRST one sets _busy and the rest are
// ignored until the download finishes. done() emits 'progress done', which the
// engine turns into 'updatedone' for the jweb AND uses to stop its retry loop.
var _busy = false;
function done()      { _busy = false; maxApi.outlet('progress', 'done'); }
function fail(tok)   { _busy = false; maxApi.post('tuple_dl: FAIL ' + tok); maxApi.outlet('progress', 'error'); }

maxApi.addHandler('dl', function(url, platform, amxdPath) {
    if (_busy) { maxApi.post('tuple_dl: busy — ignoring duplicate dl (engine retry)'); return; }
    platform  = String(platform  || '');
    url       = String(url       || '');
    amxdPath  = String(amxdPath  || '');
    maxApi.post('tuple_dl: platform=' + platform + ' amxdPath=' + amxdPath);
    if      (platform === 'win')         { _busy = true; dlWin(url); }
    else if (platform === 'win-inplace') { _busy = true; dlWinInPlace(url, amxdPath); }
    else if (platform === 'mac')         { _busy = true; dlMac(url, amxdPath); }
    else { maxApi.post('tuple_dl: unknown platform ' + platform); }
});

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

// ── Windows: launch branded installer (requires_reinstall=true) ───────────────
function dlWin(url) {
    var dest = path.join(os.tmpdir(), 'Tuple-Installer.exe');
    maxApi.post('tuple_dl: downloading → ' + dest);
    maxApi.post('tuple_dl: downloading');
    download(url, dest, function(err) {
        if (err) { maxApi.post('tuple_dl: download error: ' + err.message); fail('download'); return; }
        maxApi.post('tuple_dl: launching installer');
        var proc = cp.spawn(dest, [], { detached: true, stdio: 'ignore' });
        proc.unref();
        maxApi.post('tuple_dl: installer launched — restart Ableton when it finishes');
        done();   // installer launched
    });
}

// ── Windows: extract zip in-place (requires_reinstall=false, .amxd EBUSY skipped) ──
function dlWinInPlace(url, amxdPath) {
    var dest = path.join(os.tmpdir(), 'tuple-update.zip');
    maxApi.post('tuple_dl: downloading → ' + dest);
    maxApi.post('tuple_dl: downloading');
    download(url, dest, function(err) {
        if (err) { maxApi.post('tuple_dl: download error: ' + err.message); fail('download'); return; }
        var installDir = amxdPath ? path.dirname(path.dirname(amxdPath)) : '';
        if (!installDir) {
            maxApi.post('tuple_dl: no amxd path — cannot determine install dir');
            fail('nopath'); return;
        }
        maxApi.post('tuple_dl: extracting → ' + installDir);
        maxApi.post('tuple_dl: extracting');
        extractZip(dest, installDir, function(e) {
            if (e) { maxApi.post('tuple_dl: extract error: ' + e); fail('extract'); return; }
            maxApi.post('tuple_dl: done — reload device');
            done();
        });
    });
}

// ── macOS: extract zip in-place via shell (POSIX allows replacing open files) ─
function dlMac(url, amxdPath) {
    var tempZip = path.join(os.tmpdir(), 'tuple-update.zip');
    maxApi.post('tuple_dl: downloading → ' + tempZip);
    maxApi.post('tuple_dl: downloading');
    download(url, tempZip, function(err) {
        if (err) { maxApi.post('tuple_dl: download error: ' + err.message); fail('download'); return; }
        // Prefer amxdPath-derived dir; fall back to saved install path file
        var installDir = '';
        if (amxdPath) { installDir = path.dirname(path.dirname(amxdPath)); }
        if (!installDir) {
            try { installDir = fs.readFileSync(path.join(os.homedir(), '.tuple-install-path'), 'utf8').trim(); } catch(_) {}
        }
        if (!installDir) {
            maxApi.post('tuple_dl: no saved path — reinstall via .command');
            fail('nopath'); return;
        }
        maxApi.post('tuple_dl: extracting → ' + installDir);
        maxApi.post('tuple_dl: extracting');
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

            function write(data) {
                fs.writeFile(outPath, data, function(werr) {
                    if (werr && (werr.code === 'EBUSY' || werr.code === 'EPERM')) {
                        maxApi.post('tuple_dl: skip locked: ' + e.name);
                    } else if (werr) {
                        errors.push(e.name + ': ' + werr.message);
                    }
                    if (--pending === 0) cb(errors.length ? errors.join('; ') : null);
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
