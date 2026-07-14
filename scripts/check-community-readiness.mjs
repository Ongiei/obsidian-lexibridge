import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

const manifest = readJson('manifest.json');
const packageJson = readJson('package.json');
const versions = readJson('versions.json');
const allowedKeys = new Set([
	'id', 'name', 'description', 'author', 'version', 'minAppVersion',
	'isDesktopOnly', 'authorUrl', 'fundingUrl', 'helpUrl',
]);

for (const key of ['id', 'name', 'description', 'author', 'version', 'minAppVersion', 'isDesktopOnly']) {
	assert.ok(Object.hasOwn(manifest, key), `manifest.json is missing ${key}`);
}
for (const key of Object.keys(manifest)) {
	assert.ok(allowedKeys.has(key), `manifest.json has unsupported key ${key}`);
}

assert.match(manifest.id, /^[a-z0-9-]+$/, 'plugin id must use lowercase letters, numbers, and hyphens');
assert.ok(!manifest.id.includes('obsidian') && !manifest.id.endsWith('plugin'), 'plugin id contains a reserved term');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'version must use x.y.z');
assert.equal(packageJson.version, manifest.version, 'package.json version does not match manifest.json');
assert.equal(versions[manifest.version], manifest.minAppVersion, 'versions.json does not map the current version');
assert.ok(manifest.description.length <= 250, 'description exceeds 250 characters');
assert.ok(/[.?!。？！)]$/.test(manifest.description), 'description must end with punctuation');
assert.ok(!manifest.description.toLowerCase().includes('obsidian'), 'description must not include Obsidian');
assert.notEqual(manifest.authorUrl, 'https://github.com/Ongiei/obsidian-lexibridge', 'authorUrl must not point to the plugin repository');

for (const file of ['README.md', 'LICENSE', 'dist/main.js', 'dist/manifest.json', 'dist/styles.css']) {
	assert.ok(existsSync(file), `${file} is required for community release preparation`);
}
assert.deepEqual(readJson('dist/manifest.json'), manifest, 'dist/manifest.json does not match the root manifest');

console.log(`Community release readiness check passed for ${manifest.id} ${manifest.version}`);

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}
