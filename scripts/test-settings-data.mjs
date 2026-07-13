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

assert.equal(normalizeSettings({}).enableYoudaoFallback, true);
assert.equal(normalizeSettings({}).youdaoMinIntervalMs, 2000);
assert.equal(normalizeSettings({ enableYoudaoFallback: false }).enableYoudaoFallback, false);
assert.equal(normalizeSettings({}).showYoudaoInSelectionMenu, false);
assert.equal(normalizeSettings({showYoudaoInSelectionMenu: true}).showYoudaoInSelectionMenu, true);
assert.equal(normalizeSettings({}).syncDeletionProtection, true);
assert.equal(normalizeSettings({syncDeletionProtection: false}).syncDeletionProtection, false);
assert.equal(normalizeSettings({syncMaxDeletionCount: 0}).syncMaxDeletionCount, 1);
assert.equal(normalizeSettings({ dictionarySource: 'youdao' }).enableYoudaoFallback, true);
assert.equal(normalizeSettings({}).ecdictDownloadSource, 'jsdelivr');
assert.deepEqual(normalizeSettings({}).protectedHeadings, ['笔记', 'Notes']);
assert.deepEqual(normalizeSettings({ protectedHeadings: ['## 笔记', '# Notes #'] }).protectedHeadings, ['## 笔记', '# Notes']);
assert.deepEqual(normalizeSettings({ syncCategoryIds: ['1', '1', '', 2] }).syncCategoryIds, ['1']);
const firstDefaults = normalizeSettings(undefined);
firstDefaults.anki.deckName = 'Changed';
firstDefaults.protectedHeadings.push('Changed');
assert.equal(normalizeSettings(undefined).anki.deckName, 'LexiBridge');
assert.deepEqual(normalizeSettings(undefined).protectedHeadings, ['笔记', 'Notes']);
assert.equal(normalizeSettings({ autoLinkMinWordLength: 0 }).autoLinkMinWordLength, 1);
assert.deepEqual(normalizeSettings({ autoLinkIgnoredWords: ['The', 'the', '', 1] }).autoLinkIgnoredWords, ['the']);
assert.equal(normalizeSettings({}).autoLinkSkipBlockquotes, true);
assert.equal(normalizeSettings({ virtualLinksEnabled: true }).virtualLinksEnabled, true);
assert.deepEqual(normalizeSettings({ autoLinkExcludedHeadings: ['## Code', 'Code', 1] }).autoLinkExcludedHeadings, ['Code']);
assert.equal(normalizeSettings({ ecdictDownloadSource: 'invalid' }).ecdictDownloadSource, 'jsdelivr');
assert.ok(!normalizeSettings({
	bodyTemplate: '<!-- lexibridge:managed:start -->\n{{definitions}}\n<!-- lexibridge:managed:end -->',
}).bodyTemplate.includes('lexibridge:managed'));

console.log('Settings data tests passed');
