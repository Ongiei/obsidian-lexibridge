import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-settings-data-'));
const outfile = join(tmp, 'settings-data.mjs');

const obsidianShim = {
	name: 'obsidian-shim',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({
			path: 'obsidian-shim',
			namespace: 'obsidian-shim',
		}));
		build.onLoad({ filter: /.*/, namespace: 'obsidian-shim' }, () => ({
			loader: 'js',
			contents: `
				export class AbstractInputSuggest {}
				export class Modal {}
				export class Notice {}
				export class PluginSettingTab {}
				export class Setting {}
				export class TAbstractFile {}
				export class TFolder {}
				export function parseYaml() { return {}; }
				export function stringifyYaml() { return ''; }
				export function requestUrl() { return {}; }
			`,
		}));
	},
};

await esbuild.build({
	entryPoints: ['src/settings-data.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
	plugins: [obsidianShim],
});

const { normalizeSettings } = await import(pathToFileURL(outfile).href);

assert.equal(normalizeSettings({}).dictionarySource, 'youdao');
assert.equal(normalizeSettings({ dictionarySource: 'youdao' }).dictionarySource, 'youdao');
assert.equal(normalizeSettings({ dictionarySource: 'eudic' }).dictionarySource, 'youdao');

console.log('Settings data tests passed');
