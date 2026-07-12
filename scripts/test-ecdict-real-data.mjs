import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { indexedDB } from 'fake-indexeddb';

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Usage: npm run test:ecdict-real -- /path/to/ecdict.csv');

globalThis.indexedDB = indexedDB;
globalThis.window = globalThis;
const sourceBytes = readFileSync(sourcePath);
const sourceText = sourceBytes.toString('utf8');
const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-ecdict-real-'));
const outfile = join(tmp, 'ecdict-real.mjs');

const obsidianShim = {
	name: 'obsidian-shim',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-shim', namespace: 'obsidian-shim' }));
		build.onLoad({ filter: /.*/, namespace: 'obsidian-shim' }, () => ({
			loader: 'js',
			contents: 'export async function requestUrl() { throw new Error("Unexpected request"); }',
		}));
	},
};

await esbuild.build({
	stdin: {
		contents: `export { EcdictManager } from './src/ecdict.ts'; export { EcdictDatabase } from './src/ecdict-database.ts';`,
		resolveDir: process.cwd(), sourcefile: 'ecdict-real-test.ts', loader: 'ts',
	},
	bundle: true, format: 'esm', platform: 'node', outfile, plugins: [obsidianShim],
});

const { EcdictDatabase, EcdictManager } = await import(pathToFileURL(outfile).href);
const sha = 'bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b';
const request = async options => options.url.includes('/commits?')
	? { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '', json: [{ sha }] }
	: {
		status: 200,
		headers: {},
		arrayBuffer: sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength),
		text: sourceText,
		json: {},
	};

const database = new EcdictDatabase();
const manager = new EcdictManager(database, request);
const installation = await manager.install('github');
assert.ok(installation.entryCount >= 500_000);
assert.equal((await manager.getStatus()).valid, true);
assert.equal((await database.lookup('HELLO')).word.toLowerCase(), 'hello');
assert.ok((await database.lookup('the')).definitions.length > 0);

console.log(`ECDICT real-data import passed: ${installation.entryCount.toLocaleString()} entries`);
