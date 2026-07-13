import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-eudic-api-'));
const outfile = join(tmp, 'eudic-api-test.mjs');

await esbuild.build({
	stdin: {
		contents: `
			import {EudicService} from './src/eudic.ts';
			export async function run() {
				const service = new EudicService('token');
				await service.getWords('category-a', 'en', 2, 50);
				await service.addWords('category-a', ['hello']);
				await service.deleteWords('category-a', ['hello']);
				return globalThis.requests;
			}
		`,
		resolveDir: process.cwd(),
		sourcefile: 'eudic-api-test.ts',
		loader: 'ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
	plugins: [{
		name: 'obsidian-shim',
		setup(build) {
			build.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian-shim', namespace: 'obsidian-shim'}));
			build.onLoad({filter: /.*/, namespace: 'obsidian-shim'}, () => ({
				loader: 'js',
				contents: `
					globalThis.requests = [];
					export async function requestUrl(options) {
						globalThis.requests.push(options);
						return {status: options.method === 'DELETE' ? 204 : 200, json: {data: [], message: 'ok'}, text: ''};
					}
				`,
			}));
		},
	}],
});

const {run} = await import(pathToFileURL(outfile).href);
const [getRequest, addRequest, deleteRequest] = await run();
const getUrl = new URL(getRequest.url);

assert.equal(getUrl.pathname, '/api/open/v1/studylist/words');
assert.equal(getUrl.searchParams.get('category_id'), 'category-a');
assert.equal(getUrl.searchParams.get('page'), '2');
assert.equal(getUrl.searchParams.get('page_size'), '50');
assert.deepEqual(JSON.parse(addRequest.body), {category_id: 'category-a', language: 'en', words: ['hello']});
assert.deepEqual(JSON.parse(deleteRequest.body), {category_id: 'category-a', language: 'en', words: ['hello']});

console.log('Eudic API tests passed');
