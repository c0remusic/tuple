// device/tuple_updater.test.js
'use strict';
const assert = require('node:assert');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { _semver, _installDir, _unzipCmd, _verifyZip } = require('./tuple_updater.js');

// ── _semver(a, b) ─────────────────────────────────────────────────
// Returns: -1 if a < b, 0 if equal, 1 if a > b. Leading 'v' stripped.
// Malformed inputs return 0 (treated as "no update").
assert.equal(_semver('1.2.2', '1.3.0'), -1, '1.2.2 < 1.3.0');
assert.equal(_semver('1.2.2', '1.2.2'),  0, 'equal');
assert.equal(_semver('1.3.0', '1.2.2'),  1, '1.3.0 > 1.2.2');
assert.equal(_semver('1.2.10','1.2.9'),  1, 'patch: 10 > 9 (numeric, not lexicographic)');
assert.equal(_semver('v1.3.0','1.2.2'),  1, 'leading v stripped');
assert.equal(_semver('','1.2.2'),        0, 'malformed a → 0');
assert.equal(_semver('1.2.2',''),        0, 'malformed b → 0');
assert.equal(_semver('abc','1.2.2'),     0, 'non-numeric a → 0');

// ── _installDir(patcherFilepath) ──────────────────────────────────
// Returns the directory containing the .amxd file (with trailing slash),
// with backslashes normalised to forward slashes.
assert.equal(
  _installDir('C:/Users/foo/Tuple/tuple.amxd'),
  'C:/Users/foo/Tuple/',
  'Windows path'
);
assert.equal(
  _installDir('C:\\Users\\foo\\Tuple\\tuple.amxd'),
  'C:/Users/foo/Tuple/',
  'Windows backslashes normalised'
);
assert.equal(
  _installDir('/Users/foo/Music/Tuple/tuple.amxd'),
  '/Users/foo/Music/Tuple/',
  'macOS POSIX path'
);
assert.equal(
  _installDir(''),
  '',
  'empty string → empty string'
);

// ── _unzipCmd(platform, zipPath, destDir) ────────────────────────
// Returns { cmd: string, args: string[] } for the platform's best unzip tool.
const winCmd = _unzipCmd('win32', 'a.zip', 'out/');
assert.ok(typeof winCmd.cmd === 'string' && winCmd.cmd.length > 0, 'win32 returns a command');
assert.ok(Array.isArray(winCmd.args), 'win32 returns args array');

const macCmd = _unzipCmd('darwin', 'a.zip', 'out/');
assert.ok(typeof macCmd.cmd === 'string' && macCmd.cmd.length > 0, 'darwin returns a command');
assert.ok(Array.isArray(macCmd.args), 'darwin returns args array');

const linuxCmd = _unzipCmd('linux', 'a.zip', 'out/');
assert.ok(typeof linuxCmd.cmd === 'string', 'linux returns a command');

// ── _verifyZip(zipPath) ───────────────────────────────────────────
// Synchronous. Returns true if file exists, size > 0, and starts with PK magic.
const tmp = os.tmpdir();

const goodZip = path.join(tmp, 'tuple_test_good.zip');
fs.writeFileSync(goodZip, Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]));
assert.equal(_verifyZip(goodZip), true, 'valid PK magic → true');

const emptyZip = path.join(tmp, 'tuple_test_empty.zip');
fs.writeFileSync(emptyZip, Buffer.alloc(0));
assert.equal(_verifyZip(emptyZip), false, 'empty file → false');

const badZip = path.join(tmp, 'tuple_test_bad.zip');
fs.writeFileSync(badZip, Buffer.from([0x00, 0x01, 0x02, 0x03]));
assert.equal(_verifyZip(badZip), false, 'wrong magic → false');

assert.equal(_verifyZip(path.join(tmp, 'tuple_does_not_exist.zip')), false, 'missing file → false');

fs.unlinkSync(goodZip);
fs.unlinkSync(emptyZip);
fs.unlinkSync(badZip);

console.log('All tuple_updater tests passed.');
