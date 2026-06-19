// tuple_dl.js — node.script: downloads Tuple update + installs silently.
// Windows: Tuple-Installer.exe /VERYSILENT (AppId remembers install path)
// macOS:   tuple.zip → extract Tuple/ → copy to ~/.tuple-install-path → xattr
// Called from tuple_chord_engine.js: _patcher.getnamed('tuple_dl').message('dl', url, platform)

var maxApi = require('max-api');
var https = require('https');
var http = require('http');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

maxApi.addHandler('dl', function(url, platform) {
    platform = String(platform);
    maxApi.post('tuple_dl: platform=' + platform + ' url=' + url);
    if (platform === 'win') { dlWin(String(url)); }
    else if (platform === 'mac') { dlMac(String(url)); }
    else { maxApi.post('tuple_dl: unknown platform ' + platform); }
});

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

function dlWin(url) {
    var dest = path.join(os.tmpdir(), 'Tuple-Installer.exe');
    maxApi.post('tuple_dl: downloading → ' + dest);
    download(url, dest, function(err) {
        if (err) { maxApi.post('tuple_dl: download error: ' + err.message); return; }
        maxApi.post('tuple_dl: launching /VERYSILENT');
        var proc = cp.spawn(dest, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], {
            detached: true, stdio: 'ignore'
        });
        proc.unref();
        maxApi.post('tuple_dl: done — restart Ableton when installer finishes');
        maxApi.outlet('progress', 'done');
    });
}

function dlMac(url) {
    var tempZip = path.join(os.tmpdir(), 'tuple-update.zip');
    maxApi.post('tuple_dl: downloading → ' + tempZip);
    download(url, tempZip, function(err) {
        if (err) { maxApi.post('tuple_dl: download error: ' + err.message); return; }
        var savedPath = '';
        try { savedPath = fs.readFileSync(path.join(os.homedir(), '.tuple-install-path'), 'utf8').trim(); } catch(_) {}
        if (!savedPath) { maxApi.post('tuple_dl: no saved path — reinstall via .command'); maxApi.outlet('progress', 'no-path'); return; }
        maxApi.post('tuple_dl: extracting → ' + savedPath);
        var tmp = os.tmpdir();
        var q = function(s) { return '"' + s.replace(/"/g, '\\"') + '"'; };
        var cmd = [
            'unzip -o ' + q(tempZip) + ' "Tuple/*" -d ' + q(tmp),
            'rm -rf ' + q(path.join(savedPath, 'Tuple')),
            'cp -R ' + q(path.join(tmp, 'Tuple')) + ' ' + q(savedPath + '/'),
            'xattr -dr com.apple.quarantine ' + q(path.join(savedPath, 'Tuple'))
        ].join(' && ');
        cp.exec(cmd, function(e) {
            if (e) { maxApi.post('tuple_dl: install error: ' + e.message); return; }
            maxApi.post('tuple_dl: done — restart Ableton');
            maxApi.outlet('progress', 'done');
        });
    });
}
