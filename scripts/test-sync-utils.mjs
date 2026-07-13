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
	getSyncDeletionSafetyError,
	getEffectiveUploadCategoryIds,
	getValidFilename,
	parseEudicExpDefinitions,
	updateManifestAfterSuccessfulOperation,
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

assert.match(getSyncDeletionSafetyError({localDeleted: ['a'], cloudDeleted: ['b']}, true, 1), /计划删除 2 个词条/);
assert.equal(getSyncDeletionSafetyError({localDeleted: ['a'], cloudDeleted: ['b']}, true, 2), null);
assert.equal(getSyncDeletionSafetyError({localDeleted: ['a'], cloudDeleted: ['b']}, false, 1), null);

assert.deepEqual(parseEudicExpDefinitions(''), [{ pos: '', trans: '释义待更新' }]);
assert.deepEqual(
	parseEudicExpDefinitions('<b>v.</b> install software; n. setup...'),
	[
		{ pos: 'v.', trans: 'install software' },
		{ pos: 'n.', trans: 'setup' },
	]
);

const manifest = new Set(['existing', 'delete-retry']);
updateManifestAfterSuccessfulOperation(manifest, 'download', 'Downloaded');
updateManifestAfterSuccessfulOperation(manifest, 'upload', 'Uploaded');
updateManifestAfterSuccessfulOperation(manifest, 'trash_local', 'existing');
assert.deepEqual([...manifest].sort(), ['delete-retry', 'downloaded', 'uploaded']);

assert.deepEqual(getEffectiveUploadCategoryIds(['a', 'b'], 'b'), ['b']);
assert.deepEqual(getEffectiveUploadCategoryIds(['a', 'b'], 'outside'), ['a']);
assert.deepEqual(getEffectiveUploadCategoryIds(['a', 'b'], 'a', ['b', 'b']), ['b']);
assert.deepEqual(getEffectiveUploadCategoryIds(['a'], 'a', ['outside']), ['a']);
assert.deepEqual(getEffectiveUploadCategoryIds([], 'default', ['first', 'second']), ['first', 'second']);

assert.equal(await withTimeout(Promise.resolve('ok'), 100, 'fast op'), 'ok');
await assert.rejects(
	() => withTimeout(new Promise(resolve => setTimeout(resolve, 20)), 1, 'slow op'),
	/操作超时：slow op/
);

console.log('Sync utils tests passed');
