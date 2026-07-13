import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-sync-service-'));
const outfile = join(tmp, 'sync-service-test.mjs');

const obsidianShim = {
	name: 'obsidian-shim',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-shim', namespace: 'obsidian-shim' }));
		build.onLoad({ filter: /.*/, namespace: 'obsidian-shim' }, () => ({
			loader: 'js',
			contents: `
				export class TFile {
					constructor(path) {
						this.path = path;
						this.extension = path.split('.').pop();
						this.basename = path.split('/').pop().replace(/\\.[^.]+$/, '');
					}
				}
				export class TFolder {
					constructor(path, children = []) { this.path = path; this.children = children; }
				}
				export function parseYaml() { return {}; }
				export function stringifyYaml(value) { return JSON.stringify(value) + '\\n'; }
				export async function requestUrl() { throw new Error('Unexpected request'); }
			`,
		}));
	},
};

await esbuild.build({
	stdin: {
		contents: `
			import { TFile, TFolder } from 'obsidian';
			import { SyncService } from './src/sync.ts';
			globalThis.window = globalThis;

			const settings = {
				folderPath: 'LexiBridge', frontmatterTemplate: '', bodyTemplate: '',
				includeExamProperties: false, includePosProperties: false, previewBeforeWrite: false,
				eudicToken: 'token', syncCategoryIds: ['a', 'b'], defaultUploadCategoryId: 'a',
				enableSync: true, autoSync: false, syncInterval: 30, syncOnStartup: false,
				startupDelay: 0, autoLinkFirstOnly: true, enableYoudaoFallback: true, youdaoMinIntervalMs: 2000,
			};

			function makeApp({ create, root, frontmatter = {} } = {}) {
				return {
					vault: {
						adapter: { exists: async path => path === 'LexiBridge' },
						getAbstractFileByPath: path => path === 'LexiBridge' ? root : null,
						createFolder: async () => {},
						create: create || (async path => new TFile(path)),
						read: async () => '',
						modify: async () => {},
					},
					metadataCache: { getFileCache: file => ({ frontmatter: frontmatter[file.path] || {} }) },
				fileManager: { trashFile: async () => {}, renameFile: async () => {} },
				};
			}

			export async function run() {
				let stored = { syncManifest: { lastSyncTime: 1, syncedWords: [] } };
				const failedDownload = new SyncService(
					makeApp({ create: async () => { throw new Error('disk full'); } }),
					settings,
					{},
					async () => stored,
					async data => { stored = data; }
				);
				const failedDownloadResult = await failedDownload.executeSync({
					localAdded: [], cloudAdded: ['cloud-only'], localDeleted: [], cloudDeleted: [],
					errors: [], manifestMissing: false,
				});

				let deleteStored = { syncManifest: { lastSyncTime: 1, syncedWords: ['delete-retry'] } };
				const failedDelete = new SyncService(
					makeApp(), settings,
					{ deleteWords: async () => { throw new Error('offline'); } },
					async () => deleteStored,
					async data => { deleteStored = data; }
				);
				const failedDeleteResult = await failedDelete.executeSync({
					localAdded: [], cloudAdded: [], localDeleted: ['delete-retry'], cloudDeleted: [],
					errors: [], manifestMissing: false,
				});

				const localFile = new TFile('LexiBridge/multi.md');
				const addCalls = [];
				let uploadStored = { syncManifest: { lastSyncTime: 1, syncedWords: [] } };
				const multiUpload = new SyncService(
					makeApp({ frontmatter: { [localFile.path]: { eudic_lists: ['A', 'B'] } } }),
					settings,
					{ addWords: async id => { addCalls.push(id); } },
					async () => uploadStored,
					async data => { uploadStored = data; }
				);
				multiUpload.categoryIdToName = new Map([['a', 'A'], ['b', 'B']]);
				multiUpload.localWordToFile = new Map([['multi', localFile]]);
				const multiUploadResult = await multiUpload.executeSync({
					localAdded: ['multi'], cloudAdded: [], localDeleted: [], cloudDeleted: [],
					errors: [], manifestMissing: false,
				});

				const nestedFile = new TFile('LexiBridge/nested/word.md');
				const nestedFolder = new TFolder('LexiBridge/nested', [nestedFile]);
				const root = new TFolder('LexiBridge', [nestedFolder]);
				const nestedService = new SyncService(
					makeApp({ root, frontmatter: { [nestedFile.path]: { word: 'word' } } }),
					{ ...settings, syncCategoryIds: ['a'] },
					{
						getCategories: async () => [{ id: 'a', name: 'A', language: 'en' }],
						getWords: async () => [{ word: 'word', exp: 'definition' }],
					},
					async () => ({ syncManifest: { lastSyncTime: 1, syncedWords: ['word'] } }),
					async () => {},
				);
				const nestedDryRun = await nestedService.dryRun();

				const failedSave = new SyncService(
					makeApp(), settings, {},
					async () => ({ syncManifest: { lastSyncTime: 1, syncedWords: [] } }),
					async () => { throw new Error('read only'); }
				);
				const failedSaveResult = await failedSave.executeSync({
					localAdded: [], cloudAdded: [], localDeleted: [], cloudDeleted: [],
					errors: [], manifestMissing: false,
				});

				const createPaths = [];
				const renamePaths = [];
				let downloadStored = { syncManifest: { lastSyncTime: 1, syncedWords: [] } };
				const downloadApp = makeApp({ create: async path => {
					createPaths.push(path);
					return new TFile(path);
				} });
				downloadApp.fileManager.renameFile = async (file, path) => { renamePaths.push([file.path, path]); };
				const compatibleDownload = new SyncService(
					downloadApp, settings, {},
					async () => downloadStored,
					async data => { downloadStored = data; }
				);
				compatibleDownload.cloudWordsWithCategories = new Map([['hello', {
					exp: 'int. 你好', categories: ['A'], originalWord: 'hello',
				}]]);
				const compatibleDownloadResult = await compatibleDownload.executeSync({
					localAdded: [], cloudAdded: ['hello'], localDeleted: [], cloudDeleted: [],
					errors: [], manifestMissing: false,
				});

				const abortSignal = { aborted: false };
				let abortedStored = { syncManifest: { lastSyncTime: 1, syncedWords: [] } };
				const abortedSync = new SyncService(
					makeApp(), {...settings, syncCategoryIds: ['a']},
					{ addWords: async () => { abortSignal.aborted = true; } },
					async () => abortedStored,
					async data => { abortedStored = data; }
				);
				const abortedResult = await abortedSync.executeSync({
					localAdded: ['first', 'second'], cloudAdded: [], localDeleted: [], cloudDeleted: [],
					errors: [], manifestMissing: false,
				}, undefined, abortSignal);

				let checkpointCalls = 0;
				const checkpointUploads = [];
				const failedCheckpointSync = new SyncService(
					makeApp(), {...settings, syncCategoryIds: ['a']},
					{ addWords: async (_id, words) => { checkpointUploads.push(words[0]); } },
					async () => ({syncManifest: {lastSyncTime: 1, syncedWords: []}}),
					async () => {
						checkpointCalls++;
						throw new Error('checkpoint unavailable');
					}
				);
				const failedCheckpointResult = await failedCheckpointSync.executeSync({
					localAdded: Array.from({length: 11}, (_, index) => 'word-' + index),
					cloudAdded: [], localDeleted: [], cloudDeleted: [], errors: [], manifestMissing: false,
				});

				return {
					failedDownloadResult,
					failedDownloadManifest: stored.syncManifest.syncedWords,
					failedDeleteResult,
					failedDeleteManifest: deleteStored.syncManifest.syncedWords,
					multiUploadResult,
					multiUploadManifest: uploadStored.syncManifest.syncedWords,
					addCalls,
					nestedDryRun,
					failedSaveResult,
					failedSaveStillUnlocked: !failedSave.isSyncInProgress(),
					compatibleDownloadResult,
					createPaths,
					renamePaths,
					abortedResult,
					abortedManifest: abortedStored.syncManifest.syncedWords,
					failedCheckpointResult,
					checkpointCalls,
					checkpointUploads,
				};
			}
		`,
		resolveDir: process.cwd(),
		sourcefile: 'sync-service-test.ts',
		loader: 'ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
	plugins: [obsidianShim],
});

const { run } = await import(pathToFileURL(outfile).href);
const result = await run();

assert.equal(result.failedDownloadResult.success, false);
assert.deepEqual(result.failedDownloadManifest, []);
assert.equal(result.failedDeleteResult.success, false);
assert.deepEqual(result.failedDeleteManifest, ['delete-retry']);
assert.equal(result.multiUploadResult.success, true);
assert.deepEqual(result.addCalls, ['a', 'b']);
assert.deepEqual(result.multiUploadManifest, ['multi']);
assert.deepEqual(result.nestedDryRun.localAdded, []);
assert.deepEqual(result.nestedDryRun.localDeleted, []);
assert.deepEqual(result.nestedDryRun.cloudAdded, []);
assert.deepEqual(result.nestedDryRun.cloudDeleted, []);
assert.equal(result.failedSaveResult.success, false);
assert.match(result.failedSaveResult.errors[0], /保存同步记录失败/);
assert.equal(result.failedSaveStillUnlocked, true);
assert.equal(result.compatibleDownloadResult.success, true);
assert.match(result.createPaths[0], /\.tmp$/);
assert.equal(result.renamePaths[0][1], 'LexiBridge/hello.md');
assert.ok(!result.createPaths.some(path => path.endsWith('.md')));
assert.equal(result.abortedResult.aborted, true);
assert.deepEqual(result.abortedManifest, ['first']);
assert.equal(result.failedCheckpointResult.success, false);
assert.match(result.failedCheckpointResult.errors.at(-1), /保存同步记录失败/);
assert.equal(result.checkpointCalls, 1);
assert.equal(result.checkpointUploads.length, 10);

console.log('Sync service tests passed');
