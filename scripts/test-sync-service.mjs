import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-sync-service-'));
const outfile = join(tmp, 'sync-service-test.mjs');

const obsidianShim = {
	name: 'obsidian-shim',
	setup(build) {
		build.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian-shim', namespace: 'obsidian-shim'}));
		build.onLoad({filter: /.*/, namespace: 'obsidian-shim'}, () => ({
			loader: 'js',
			contents: `
				export class TAbstractFile {}
				export class TFile extends TAbstractFile {
					constructor(path) { super(); this.path = path; this.name = path.split('/').pop(); this.extension = 'md'; this.basename = this.name.replace(/\\.md$/, ''); this.stat = {mtime: 1}; }
				}
				export class TFolder extends TAbstractFile {
					constructor(path, children = []) { super(); this.path = path; this.name = path.split('/').pop(); this.children = children; }
				}
				export class Notice {
					constructor() { this.messageEl = {empty() {}, createSpan() {}, createEl() { return {addEventListener() {}}; }}; }
					hide() {}
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
			import {TFile, TFolder} from 'obsidian';
			import {SyncService} from './src/sync.ts';
			globalThis.window = globalThis;

			const settings = {
				folderPath: 'LexiBridge', frontmatterTemplate: '', bodyTemplate: '', protectedHeadings: [],
				includeExamProperties: false, includePosProperties: false,
				syncCategoryIds: ['a', 'b'], defaultUploadCategoryId: 'a',
				syncDeletionProtection: true, syncMaxDeletionCount: 50,
			};

			function createApp(initialFiles = {}) {
				const nodes = new Map();
				const contents = new Map(Object.entries(initialFiles));
				const root = new TFolder('LexiBridge', []);
				nodes.set('LexiBridge', root);
				function ensureFolder(path) {
					if (nodes.has(path)) return nodes.get(path);
					const folder = new TFolder(path, []);
					nodes.set(path, folder);
					const parent = nodes.get(path.split('/').slice(0, -1).join('/'));
					if (parent) parent.children.push(folder);
					return folder;
				}
				for (const [path] of contents) {
					const parentPath = path.split('/').slice(0, -1).join('/');
					const parent = ensureFolder(parentPath);
					const file = new TFile(path);
					nodes.set(path, file);
					parent.children.push(file);
				}
				return {
					nodes, contents,
					vault: {
						adapter: {exists: async path => nodes.has(path)},
						getAbstractFileByPath: path => nodes.get(path) || null,
						createFolder: async path => ensureFolder(path),
						create: async (path, content) => {
							const parent = ensureFolder(path.split('/').slice(0, -1).join('/'));
							const file = new TFile(path); nodes.set(path, file); contents.set(path, content); parent.children.push(file); return file;
						},
						read: async file => contents.get(file.path) || '',
						process: async (file, fn) => contents.set(file.path, fn(contents.get(file.path) || '')),
					},
					metadataCache: {getFileCache: file => ({frontmatter: {word: file.basename}})},
					fileManager: {
						renameFile: async (file, target) => { nodes.delete(file.path); file.path = target; file.name = target.split('/').pop(); nodes.set(target, file); },
						trashFile: async file => { nodes.delete(file.path); },
					},
				};
			}

			export async function run() {
				let stored = {};
				const app = createApp({'LexiBridge/Alpha/local.md': '# local'});
				const getWordsCalls = [];
				const service = new SyncService(app, settings, {
					getCategories: async () => [{id: 'a', name: 'Alpha'}, {id: 'b', name: 'Beta'}],
					getWords: async id => { getWordsCalls.push(id); return id === 'a' ? [{word: 'cloud', exp: 'n. cloud'}] : [{word: 'shared', exp: 'adj. shared'}]; },
				}, async () => stored, async data => { stored = data; });
				const dryRun = await service.dryRun();

				const uploadApp = createApp();
				let uploadStored = {};
				const uploadBatches = [];
				const uploadService = new SyncService(uploadApp, {...settings, syncCategoryIds: ['a']}, {
					addWords: async (id, words) => uploadBatches.push([id, words.length]),
					deleteWords: async () => {},
				}, async () => uploadStored, async data => { uploadStored = data; });
				const uploadOps = Array.from({length: 101}, (_, index) => ({
					type: 'upload', categoryId: 'a', categoryName: 'Alpha', folderName: 'Alpha', word: 'word-' + index,
				}));
				const uploadResult = await uploadService.executeSync({
					localAdded: uploadOps.map(op => op.word), cloudAdded: [], localDeleted: [], cloudDeleted: [],
					errors: [], manifestMissing: false, operations: uploadOps,
				});

				const retryApp = createApp();
				let retryStored = {};
				const retryService = new SyncService(retryApp, {...settings, syncCategoryIds: ['a']}, {
					getCategories: async () => [{id: 'a', name: 'Alpha'}],
					getWords: async () => [{word: 'retryme', exp: 'n. retry'}],
				}, async () => retryStored, async data => { retryStored = data; });
				const retryPlan = await retryService.dryRun();
				retryApp.vault.create = async () => { throw new Error('disk full'); };
				const retryResult = await retryService.executeSync(retryPlan);

				const deletePath = 'LexiBridge/Alpha/deleted.md';
				const deleteApp = createApp({[deletePath]: '# preserved'});
				let deleteStored = {syncManifest: {version: 2, lastSyncTime: 1, categories: {a: {name: 'Alpha', folderName: 'Alpha', syncedWords: ['deleted']}}}};
				const deleteService = new SyncService(deleteApp, {...settings, syncCategoryIds: ['a']}, {}, async () => deleteStored, async data => { deleteStored = data; });
				const deleteFile = deleteApp.nodes.get(deletePath);
				await deleteService.handleFileModified(deleteFile);
				deleteApp.nodes.delete(deletePath);
				await deleteService.handleFileDeleted(deleteFile);
				const restored = await deleteService.undoLastDeletion();

				const renameApp = createApp();
				const alphaFolder = new TFolder('LexiBridge/Renamed', []);
				let renamedTo = null;
				let renameStored = {syncManifest: {version: 2, lastSyncTime: 1, categories: {a: {name: 'Alpha', folderName: 'Alpha', syncedWords: []}}}};
				const renameService = new SyncService(renameApp, {...settings, syncCategoryIds: ['a']}, {
					renameCategory: async (id, name) => { renamedTo = [id, name]; },
				}, async () => renameStored, async data => { renameStored = data; });
				await renameService.handleFileRenamed(alphaFolder, 'LexiBridge/Alpha');

				return {dryRun, getWordsCalls, folders: [...app.nodes.keys()], uploadBatches, uploadResult, retryResult, retryStored, restored, restoredContent: deleteApp.contents.get(deletePath), renamedTo, renameStored};
			}
		`,
		resolveDir: process.cwd(), sourcefile: 'sync-service-test.ts', loader: 'ts',
	},
	bundle: true, format: 'esm', platform: 'node', outfile, plugins: [obsidianShim],
});

const {run} = await import(pathToFileURL(outfile).href);
const result = await run();

assert.deepEqual(result.getWordsCalls.sort(), ['a', 'b']);
assert.ok(result.folders.includes('LexiBridge/Alpha'));
assert.ok(result.folders.includes('LexiBridge/Beta'));
assert.ok(result.dryRun.operations.some(op => op.type === 'upload' && op.categoryId === 'a' && op.word === 'local'));
assert.ok(result.dryRun.operations.some(op => op.type === 'download' && op.categoryId === 'a' && op.word === 'cloud'));
assert.ok(result.dryRun.operations.some(op => op.type === 'download' && op.categoryId === 'b' && op.word === 'shared'));
assert.equal(result.uploadResult.success, true);
assert.deepEqual(result.uploadBatches, [['a', 100], ['a', 1]]);
assert.equal(result.retryResult.success, false);
assert.ok(!result.retryStored.syncManifest.categories.a.syncedWords.includes('retryme'), 'failed download must remain retryable');
assert.equal(result.restored, true);
assert.equal(result.restoredContent, '# preserved');
assert.deepEqual(result.renamedTo, ['a', 'Renamed']);
assert.equal(result.renameStored.syncManifest.categories.a.name, 'Renamed');

console.log('Sync service tests passed');
