import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { indexedDB } from 'fake-indexeddb';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';

globalThis.indexedDB = indexedDB;
const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-ecdict-service-'));
const outfile = join(tmp, 'ecdict-service.mjs');
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
		resolveDir: process.cwd(), sourcefile: 'ecdict-service-test.ts', loader: 'ts',
	},
	bundle: true, format: 'esm', platform: 'node', outfile, plugins: [obsidianShim],
});

const { EcdictDatabase, EcdictManager } = await import(pathToFileURL(outfile).href);
const validPackage = [
	['the', 'the', 'ðə', '', 'art. 这；那', 'zk', ''],
	['hello', 'hello', 'həˈləʊ', '', 'int. 你好', 'cet4', 's:hellos'],
].map(JSON.stringify).join('\n') + '\n';
const invalidPackage = JSON.stringify(['the', 'the', 'ðə', '', 'art. 这；那', 'zk', '']) + '\n';
let sha = 'a'.repeat(40);
let packageText = validPackage;

const request = async options => {
	const packageBytes = gzipSync(Buffer.from(packageText));
	const packageSha256 = createHash('sha256').update(packageBytes).digest('hex');
	if (options.url.includes('ecdict-manifest.json')) {
		return {
			status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), text: '',
			json: {
				schemaVersion: 1, datasetVersion: `test-${sha.slice(0, 7)}`, sourceSha: sha,
				sourceSize: 100, packageUrl: 'https://github.com/Ongiei/obsidian-lexibridge/releases/download/ecdict-data-v1/ecdict.jsonl.gz',
				packageSize: packageBytes.byteLength, packageSha256, entryCount: 2,
			},
		};
	}
	return {
		status: 200, headers: {},
		arrayBuffer: packageBytes.buffer.slice(packageBytes.byteOffset, packageBytes.byteOffset + packageBytes.byteLength),
		text: '', json: {},
	};
};

const database = new EcdictDatabase();
const manager = new EcdictManager(database, request, 2);
const progress = [];
const installation = await manager.install(item => progress.push(item));
assert.equal(installation.entryCount, 2);
assert.equal((await manager.getStatus()).valid, true);
assert.equal((await database.lookup('HELLO')).definitions[0].trans, '你好');
assert.equal((await manager.checkForUpdate()).available, false);
assert.equal(progress.at(-1).progress, 1);

sha = 'b'.repeat(40);
packageText = invalidPackage;
await assert.rejects(() => manager.install(undefined, { aborted: false }), /词条数量异常/);
assert.equal((await database.lookup('hello')).word, 'hello', 'failed update must preserve active dictionary');
assert.equal((await manager.checkForUpdate()).available, true);

await manager.remove();
assert.equal((await manager.getStatus()).installed, false);

console.log('ECDICT service tests passed');
