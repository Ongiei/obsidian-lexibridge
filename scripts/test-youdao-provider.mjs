import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-youdao-provider-'));
const outfile = join(tmp, 'youdao-provider.mjs');
const obsidianShim = {
	name: 'obsidian-shim',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-shim', namespace: 'obsidian-shim' }));
		build.onLoad({ filter: /.*/, namespace: 'obsidian-shim' }, () => ({
			loader: 'js', contents: 'export async function requestUrl() { throw new Error("Unexpected request"); }',
		}));
	},
};
await esbuild.build({
	stdin: {
		contents: `export { YoudaoProvider } from './src/youdao-provider.ts'; export { YoudaoRequestError } from './src/youdao.ts';`,
		resolveDir: process.cwd(), sourcefile: 'youdao-provider-test.ts', loader: 'ts',
	},
	bundle: true, format: 'esm', platform: 'node', outfile, plugins: [obsidianShim],
});
const { YoudaoProvider, YoudaoRequestError } = await import(pathToFileURL(outfile).href);
const entry = { word: 'test', ph_uk: '', ph_us: '', audio_uk: '', audio_us: '', definitions: [], tags: [], exchange: [] };

let now = 0;
const waits = [];
const wait = async ms => { waits.push(ms); now += ms; };
const provider = new YoudaoProvider(() => 2000, async () => entry, wait, () => now, () => 0);
await provider.lookup('one');
await provider.lookup('two');
assert.deepEqual(waits, [2000]);

now = 0;
const retryWaits = [];
let attempts = 0;
const retryProvider = new YoudaoProvider(
	() => 2000,
	async () => { if (attempts++ === 0) throw new YoudaoRequestError('server', 503); return entry; },
	async ms => { retryWaits.push(ms); now += ms; },
	() => now,
	() => 0
);
assert.equal(await retryProvider.lookup('retry'), entry);
assert.deepEqual(retryWaits, [1000, 1000]);

now = 0;
const cooldownWaits = [];
let limited = true;
const cooldownProvider = new YoudaoProvider(
	() => 2000,
	async () => { if (limited) { limited = false; throw new YoudaoRequestError('limited', 429); } return entry; },
	async ms => { cooldownWaits.push(ms); now += ms; },
	() => now,
	() => 0
);
await assert.rejects(() => cooldownProvider.lookup('limited'), /暂停 5 分钟/);
await cooldownProvider.lookup('after');
assert.deepEqual(cooldownWaits, [300000]);

console.log('Youdao provider tests passed');
