import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
assert.equal(manifest.isDesktopOnly, false, 'manifest.json must keep isDesktopOnly=false for mobile support');

const forbiddenRuntimePatterns = [
	{ pattern: /\bfrom\s+['"]electron['"]/, label: 'Electron imports' },
	{ pattern: /\brequire\(['"]electron['"]\)/, label: 'Electron require' },
	{ pattern: /\bfrom\s+['"]node:/, label: 'Node built-in imports' },
	{ pattern: /\brequire\(['"](fs|path|child_process|os|crypto)['"]\)/, label: 'Node built-in require' },
	{ pattern: /\bPlatform\.isDesktop\b/, label: 'desktop-only platform branch' },
	{ pattern: /\bBrowserWindow\b|\bshell\./, label: 'Electron desktop APIs' },
];

const violations = [];
for (const file of listSourceFiles('src')) {
	const content = readFileSync(file, 'utf8');
	for (const { pattern, label } of forbiddenRuntimePatterns) {
		if (pattern.test(content)) {
			violations.push(`${file}: ${label}`);
		}
	}
}

assert.deepEqual(violations, []);
console.log('Mobile compatibility check passed');

function listSourceFiles(dir) {
	const result = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			result.push(...listSourceFiles(path));
		} else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
			result.push(path);
		}
	}
	return result;
}
