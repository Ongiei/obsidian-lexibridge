import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-sync-utils-'));
const outfile = join(tmp, 'sync-utils.mjs');

await esbuild.build({
	entryPoints: ['src/utils/sync.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
});

const {
	diffSyncSets,
	getValidFilename,
	parseEudicExpDefinitions,
	withTimeout,
} = await import(pathToFileURL(outfile).href);

assert.equal(getValidFilename('Install'), 'install');
assert.equal(getValidFilename('../A:B*C?'), '_a_b_c_');
assert.equal(getValidFilename('...'), 'unnamed');

assert.deepEqual(
	diffSyncSets(
		['old-local-delete', 'old-cloud-delete', 'unchanged'],
		new Set(['new-local', 'old-cloud-delete', 'unchanged']),
		new Set(['new-cloud', 'old-local-delete', 'unchanged'])
	),
	{
		localAdded: ['new-local'],
		cloudAdded: ['new-cloud'],
		localDeleted: ['old-local-delete'],
		cloudDeleted: ['old-cloud-delete'],
	}
);

assert.deepEqual(parseEudicExpDefinitions(''), [{ pos: '', trans: '释义待更新' }]);
assert.deepEqual(
	parseEudicExpDefinitions('<b>v.</b> install software; n. setup...'),
	[
		{ pos: 'v.', trans: 'install software' },
		{ pos: 'n.', trans: 'setup' },
	]
);

assert.equal(await withTimeout(Promise.resolve('ok'), 100, 'fast op'), 'ok');
await assert.rejects(
	() => withTimeout(new Promise(resolve => setTimeout(resolve, 20)), 1, 'slow op'),
	/操作超时：slow op/
);

console.log('Sync utils tests passed');
