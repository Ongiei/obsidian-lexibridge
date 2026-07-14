import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-anki-utils-'));
const outfile = join(tmp, 'anki-utils-test.mjs');

const obsidianShim = {
	name: 'obsidian-shim',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-shim', namespace: 'obsidian-shim' }));
		build.onLoad({ filter: /.*/, namespace: 'obsidian-shim' }, () => ({
			loader: 'js',
			contents: `
				export function requestUrl() { throw new Error('requestUrl should be injected in tests'); }
				export function parseYaml(text) {
					const result = {};
					for (const line of text.split(/\\r?\\n/)) {
						const match = line.match(/^([A-Za-z_]+):\\s*(.*)$/);
						if (match) result[match[1]] = match[2];
					}
					return result;
				}
				export class TFile {
					constructor(path) {
						this.path = path;
						this.extension = path.split('.').pop();
						this.basename = path.split('/').pop().replace(/\\.[^.]+$/, '');
						this.stat = { mtime: 1 };
					}
				}
				export class TFolder {
					constructor(path, children = []) { this.path = path; this.children = children; }
				}
				export const Platform = { isDesktopApp: true };
			`,
		}));
	},
};

await esbuild.build({
	stdin: {
		contents: `
			import { AnkiConnectClient } from './src/anki/anki-connect-client.ts';
			import { AnkiCardMapper } from './src/anki/card-mapper.ts';
			import { AnkiSyncPlanner } from './src/anki/sync-planner.ts';
			import { AnkiSyncService } from './src/anki/sync-service.ts';
			import { markdownToHtml } from './src/anki/markdown-renderer.ts';
			import { scanHeadingSections } from './src/anki/word-note-repository.ts';
			import { TFile, TFolder } from 'obsidian';
			export { AnkiConnectClient, AnkiCardMapper, AnkiSyncPlanner, AnkiSyncService, TFile, TFolder, markdownToHtml, scanHeadingSections };
		`,
		resolveDir: process.cwd(),
		sourcefile: 'anki-utils-test.ts',
		loader: 'ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
	plugins: [obsidianShim],
});

const { AnkiConnectClient, AnkiCardMapper, AnkiSyncPlanner, AnkiSyncService, TFile, TFolder, markdownToHtml, scanHeadingSections } = await import(pathToFileURL(outfile).href);

const client = new AnkiConnectClient('http://127.0.0.1:8765', 100, async request => {
	assert.equal(request.action, 'version');
	return { result: 6, error: null };
});
assert.equal(await client.testConnection(), 6);
const modelActions = [];
const modelClient = new AnkiConnectClient('http://127.0.0.1:8765', 100, async request => {
	modelActions.push(request);
	return {result: null, error: null};
});
await modelClient.updateModelTemplates('LexiBridge Vocabulary', {Vocabulary: {Front: '{{Word}}', Back: '{{FrontSide}}'}});
await modelClient.updateModelStyling('LexiBridge Vocabulary', '.card {}');
assert.deepEqual(modelActions.map(request => request.action), ['updateModelTemplates', 'updateModelStyling']);
assert.equal(modelActions[0].params.model.name, 'LexiBridge Vocabulary');
assert.equal(markdownToHtml('A **bold** [link](obsidian://open?vault=V&file=A.md)'), '<p>A <strong>bold</strong> <a href="obsidian://open?vault=V&amp;file=A.md">link</a></p>');
const nestedMarkdown = '## 释义\nmain\n### 子项\nnested\n## 例句\nexample';
const nestedSections = scanHeadingSections(nestedMarkdown);
const definitionSection = nestedSections.find(section => section.title === '释义');
assert.ok(definitionSection);
assert.equal(nestedMarkdown.slice(definitionSection.contentStart, definitionSection.end).trim(), 'main\n### 子项\nnested');

const failingClient = new AnkiConnectClient('http://127.0.0.1:8765', 100, async () => ({ result: null, error: 'permission denied' }));
await assert.rejects(() => failingClient.testConnection(), /permission denied/);

const multiClient = new AnkiConnectClient('http://127.0.0.1:8765', 100, async request => {
	assert.equal(request.action, 'multi');
	return {
		result: [
			{ result: 1, error: null },
			{ result: 'ok', error: null },
		],
		error: null,
	};
});
assert.deepEqual(await multiClient.multi([{ action: 'one' }, { action: 'two' }]), [1, 'ok']);

const timeoutClient = new AnkiConnectClient('http://127.0.0.1:8765', 1, async () => new Promise(resolve => {
	setTimeout(() => resolve({ result: 6, error: null }), 20);
}));
await assert.rejects(() => timeoutClient.testConnection(), /超时/);

const mapper = new AnkiCardMapper({
	ankiSourceId: 'Source A',
	deckName: 'LexiBridge',
	includeProtectedSections: true,
});
const injectedRendererMapper = new AnkiCardMapper({
	ankiSourceId: 'Source A',
	deckName: 'LexiBridge',
	includeProtectedSections: false,
	markdownRenderer: {
		render: markdown => `<x>${markdown}</x>`,
	},
});

const snapshot = {
	filePath: 'LexiBridge/test.md',
	word: 'Test',
	aliases: [],
	dictSource: 'ecdict',
	tags: ['vocabulary'],
	phoneticsMarkdown: '- /test/',
	definitionsMarkdown: '- n. 测试',
	examplesMarkdown: 'A **test**.',
	formsMarkdown: '',
	protectedMarkdown: 'personal note',
	sourceMarkdown: '[Test](obsidian://open?vault=Vault&file=LexiBridge%2Ftest.md)',
	modifiedTime: 1,
};

const desired = mapper.map(snapshot);
const injectedDesired = injectedRendererMapper.map(snapshot);
assert.equal(desired.lexiBridgeId, 'Source A:test');
assert.equal(desired.fields.Word, 'Test');
assert.equal(desired.tags[0], 'lexibridge');
assert.equal(desired.tags[1], 'lexibridge::source::source-a');
assert.match(desired.fields.Definition, /<ul><li>n\. 测试<\/li><\/ul>/);
assert.equal(injectedDesired.fields.Definition, '<x>- n. 测试</x>');

const desiredAgain = mapper.map({ ...snapshot, modifiedTime: 2 });
assert.equal(desiredAgain.contentHash, desired.contentHash, 'mtime must not affect content hash');
const desiredChanged = mapper.map({ ...snapshot, definitionsMarkdown: '- n. 改动' });
assert.notEqual(desiredChanged.contentHash, desired.contentHash);

const planner = new AnkiSyncPlanner();
assert.equal(planner.plan([desired], []).adds.length, 1);

const existing = {
	noteId: 10,
	modelName: 'LexiBridge Vocabulary',
	tags: ['lexibridge'],
	cards: [1001],
	fields: {
		LexiBridgeId: { value: desired.lexiBridgeId },
		ContentHash: { value: desired.contentHash },
	},
};
assert.equal(planner.plan([desired], [existing]).unchanged.length, 1);
assert.equal(planner.plan([desiredChanged], [existing]).updates.length, 1);
assert.equal(planner.plan([], [existing]).missingSources.length, 1);

const duplicateDesired = planner.plan([desired, { ...desired, sourceFilePath: 'LexiBridge/other.md' }], []);
assert.equal(duplicateDesired.conflicts.length, 1);

const duplicateExisting = planner.plan([desired], [existing, { ...existing, noteId: 11 }]);
assert.equal(duplicateExisting.conflicts.length, 1);
assert.equal(duplicateExisting.updates.length, 0);

const wordFile = new TFile('LexiBridge/test.md');
const fakeVault = {
	getName: () => 'Vault',
	getAbstractFileByPath: path => {
		if (path === 'LexiBridge') return new TFolder('LexiBridge', [wordFile]);
		if (path === wordFile.path) return wordFile;
		return null;
	},
	read: async () => `---
word: Test
dict_source: ecdict
---

# Test

## 发音
- /test/

## 释义
- n. 测试

## 网络翻译
- web test

## 例句
A test.

> [!info] 欧路同步
> 从 ECDICT 本地更新 · 使用有道在线增强
`,
};

const settings = {
	folderPath: 'LexiBridge',
	protectedHeadings: ['笔记', 'Notes'],
	anki: {
		endpoint: 'http://127.0.0.1:8765',
		deckName: 'LexiBridge',
		modelName: 'LexiBridge Vocabulary',
		ankiSourceId: 'source-a',
		includeProtectedSections: false,
	},
};

const fakeClient = {
	addedPayloads: [],
	async testConnection() { return 6; },
	async findNotes() { return []; },
	async notesInfo(noteIds) {
		return noteIds.map((noteId, index) => ({
			noteId,
			modelName: 'LexiBridge Vocabulary',
			tags: ['lexibridge'],
			cards: [noteId + 1000],
			fields: Object.fromEntries(Object.entries(this.addedPayloads[index].fields).map(([key, value]) => [key, { value }])),
		}));
	},
	async createDeck(deck) { this.deck = deck; return 1; },
	async modelNames() { return []; },
	async createModel(params) { this.model = params; return {}; },
	async addNotes(notes) { this.addedPayloads.push(...notes); return [101]; },
	async updateNoteFields() { throw new Error('update should not be called for first sync'); },
	async addTags() { throw new Error('addTags should not be called without missing sources'); },
	async syncAnkiWeb() { this.synced = true; },
};

const service = new AnkiSyncService({ vault: fakeVault }, () => settings, () => fakeClient);
const execution = await service.executeFullSync();
assert.equal(execution.success, true);
assert.equal(execution.stats.added, 1);
assert.equal(execution.stats.verified, 1);
assert.equal(fakeClient.deck, 'LexiBridge');
assert.equal(fakeClient.model.modelName, 'LexiBridge Vocabulary');
assert.equal(fakeClient.addedPayloads[0].fields.LexiBridgeId, 'source-a:test');
assert.match(fakeClient.addedPayloads[0].fields.Definition, /web test/);
assert.doesNotMatch(fakeClient.addedPayloads[0].fields.Examples, /欧路同步|ECDICT 本地更新|有道在线增强/);

const decksClient = {
	createdDecks: [],
	async testConnection() { return 6; },
	async deckNames() { return ['Default', 'LexiBridge']; },
	async createDeck(deckName) { this.createdDecks.push(deckName); return 1; },
};
const decksService = new AnkiSyncService({ vault: fakeVault }, () => settings, () => decksClient);
assert.deepEqual(await decksService.loadDeckNames(), ['Default', 'LexiBridge']);
await assert.doesNotReject(() => decksService.createDeck('LexiBridge'));
await assert.rejects(() => decksService.createDeck('   '), /不能为空/);

function createStatefulClient() {
	const notes = new Map();
	let nextNoteId = 501;
	return {
		notes,
		addCalls: 0,
		updateCalls: [],
		removedTags: [],
		async testConnection() { return 6; },
		async findNotes() { return [...notes.keys()]; },
		async notesInfo(noteIds) {
			return noteIds.map(noteId => notes.get(noteId));
		},
		async createDeck() { return 1; },
		async modelNames() { return ['LexiBridge Vocabulary']; },
		async modelFieldNames() {
			return ['LexiBridgeId', 'Word', 'Phonetic', 'Definition', 'Examples', 'Forms', 'Notes', 'Source', 'ContentHash'];
		},
		async addNotes(payloads) {
			this.addCalls += 1;
			return payloads.map(payload => {
				const noteId = nextNoteId++;
				notes.set(noteId, {
					noteId,
					modelName: payload.modelName,
					tags: [...payload.tags],
					cards: [noteId + 1000],
					fields: Object.fromEntries(Object.entries(payload.fields).map(([key, value]) => [key, { value }])),
				});
				return noteId;
			});
		},
		async updateNoteFields(noteId, fields) {
			this.updateCalls.push({ noteId, fields });
			const note = notes.get(noteId);
			note.fields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }]));
		},
		async removeTags(noteIds, tags) {
			this.removedTags.push({ noteIds, tags });
			for (const noteId of noteIds) {
				const note = notes.get(noteId);
				note.tags = note.tags.filter(tag => tag !== tags);
			}
		},
	};
}

const statefulClient = createStatefulClient();
const statefulService = new AnkiSyncService({ vault: fakeVault }, () => settings, () => statefulClient);
const firstStatefulSync = await statefulService.executeFullSync();
assert.equal(firstStatefulSync.stats.added, 1);
assert.equal(statefulClient.notes.size, 1);
const existingNoteId = [...statefulClient.notes.keys()][0];
const secondStatefulSync = await statefulService.executeFullSync();
assert.equal(secondStatefulSync.stats.added, 0);
assert.equal(secondStatefulSync.stats.unchanged, 1);
assert.equal(statefulClient.notes.size, 1, 'repeat sync must not duplicate cards');

const renamedFile = new TFile('LexiBridge/renamed-test.md');
const renamedVault = {
	...fakeVault,
	getAbstractFileByPath: path => path === 'LexiBridge' ? new TFolder('LexiBridge', [renamedFile]) : null,
	read: fakeVault.read,
};
const renamedService = new AnkiSyncService({ vault: renamedVault }, () => settings, () => statefulClient);
const renamedSync = await renamedService.executeFullSync();
assert.equal(renamedSync.stats.added, 0);
assert.equal(statefulClient.notes.size, 1, 'file rename with same frontmatter.word must not duplicate cards');

const updatedVault = {
	...fakeVault,
	read: async () => `---
word: Test
dict_source: ecdict
---

# Test

## 释义
- n. changed definition
`,
};
const updatedService = new AnkiSyncService({ vault: updatedVault }, () => settings, () => statefulClient);
const updatedSync = await updatedService.executeFullSync();
assert.equal(updatedSync.stats.updated, 1);
assert.equal(statefulClient.updateCalls[0].noteId, existingNoteId);
assert.equal(statefulClient.notes.size, 1, 'update must retain existing note identity');

statefulClient.notes.get(existingNoteId).tags.push('lexibridge::source-missing', 'user-tag');
const restoredSync = await statefulService.executeFullSync();
assert.equal(restoredSync.success, true);
assert.deepEqual(statefulClient.removedTags.at(-1), { noteIds: [existingNoteId], tags: 'lexibridge::source-missing' });
assert.ok(statefulClient.notes.get(existingNoteId).tags.includes('user-tag'), 'user Anki tags must be preserved');
assert.ok(!statefulClient.notes.get(existingNoteId).tags.includes('lexibridge::source-missing'));

const manyFiles = Array.from({ length: 26 }, (_, index) => new TFile(`LexiBridge/word-${index}.md`));
const manyVault = {
	getName: () => 'Vault',
	getAbstractFileByPath: path => path === 'LexiBridge' ? new TFolder('LexiBridge', manyFiles) : null,
	read: async file => `---
word: ${file.basename}
---

# ${file.basename}

## 释义
- n. ${file.basename}
`,
};
const batchClient = {
	batchSizes: [],
	addedPayloads: [],
	async testConnection() { return 6; },
	async findNotes() { return []; },
	async notesInfo(noteIds) {
		return noteIds.map((noteId, index) => {
			const payload = this.addedPayloads[index];
			return {
				noteId,
				modelName: 'LexiBridge Vocabulary',
				tags: ['lexibridge'],
				cards: [noteId + 1000],
				fields: Object.fromEntries(Object.entries(payload.fields).map(([key, value]) => [key, { value }])),
			};
		});
	},
	async createDeck() { return 1; },
	async modelNames() { return ['LexiBridge Vocabulary']; },
	async modelFieldNames() {
		return ['LexiBridgeId', 'Word', 'Phonetic', 'Definition', 'Examples', 'Forms', 'Notes', 'Source', 'ContentHash'];
	},
	async addNotes(notes) {
		this.batchSizes.push(notes.length);
		this.addedPayloads.push(...notes);
		const start = this.addedPayloads.length - notes.length;
		return notes.map((_note, index) => 300 + start + index);
	},
	async updateNoteFields() { throw new Error('update should not be called for batch test'); },
};
const batchService = new AnkiSyncService({ vault: manyVault }, () => settings, () => batchClient);
const batchExecution = await batchService.executeFullSync();
assert.equal(batchExecution.success, true);
assert.deepEqual(batchClient.batchSizes, [25, 1]);
assert.equal(batchExecution.stats.added, 26);

const lifecycleSettings = {
	...settings,
	anki: {
		...settings.anki,
		missingSourcePolicy: 'tag',
		syncAnkiWebAfterPush: true,
	},
};
const lifecycleClient = {
	addedPayloads: [],
	tagged: [],
	synced: false,
	async testConnection() { return 6; },
	async findNotes() { return [201]; },
	async notesInfo(noteIds) {
		return noteIds.map(noteId => {
			if (noteId === 201) {
				return {
					noteId,
					modelName: 'LexiBridge Vocabulary',
					tags: ['lexibridge'],
					cards: [1201],
					fields: {
						LexiBridgeId: { value: 'source-a:orphan' },
						ContentHash: { value: 'old' },
					},
				};
			}
			const payload = this.addedPayloads[0];
			return {
				noteId,
				modelName: 'LexiBridge Vocabulary',
				tags: ['lexibridge'],
				cards: [noteId + 1000],
				fields: Object.fromEntries(Object.entries(payload.fields).map(([key, value]) => [key, { value }])),
			};
		});
	},
	async createDeck() { return 1; },
	async modelNames() { return ['LexiBridge Vocabulary']; },
	async modelFieldNames() {
		return ['LexiBridgeId', 'Word', 'Phonetic', 'Definition', 'Examples', 'Forms', 'Notes', 'Source', 'ContentHash'];
	},
	async addNotes(notes) { this.addedPayloads.push(...notes); return [101]; },
	async updateNoteFields() { throw new Error('update should not be called for lifecycle test'); },
	async addTags(noteIds, tags) { this.tagged.push({ noteIds, tags }); },
	async syncAnkiWeb() { this.synced = true; },
};
const lifecycleService = new AnkiSyncService({ vault: fakeVault }, () => lifecycleSettings, () => lifecycleClient);
const lifecycleExecution = await lifecycleService.executeFullSync();
assert.equal(lifecycleExecution.success, true);
assert.deepEqual(lifecycleClient.tagged, [{ noteIds: [201], tags: 'lexibridge::source-missing' }]);
assert.equal(lifecycleClient.synced, true);

const currentFileClient = {
	addedPayloads: [],
	tagged: [],
	async testConnection() { return 6; },
	async findNotes() { return [201]; },
	async notesInfo(noteIds) {
		return noteIds.map(noteId => {
			if (noteId === 101) {
				const payload = this.addedPayloads[0];
				return {
					noteId,
					modelName: 'LexiBridge Vocabulary',
					tags: ['lexibridge'],
					cards: [noteId + 1000],
					fields: Object.fromEntries(Object.entries(payload.fields).map(([key, value]) => [key, { value }])),
				};
			}
			return {
				noteId,
				modelName: 'LexiBridge Vocabulary',
				tags: ['lexibridge'],
				cards: [noteId + 1000],
				fields: {
					LexiBridgeId: { value: 'source-a:orphan' },
					ContentHash: { value: 'old' },
				},
			};
		});
	},
	async createDeck() { return 1; },
	async modelNames() { return ['LexiBridge Vocabulary']; },
	async modelFieldNames() {
		return ['LexiBridgeId', 'Word', 'Phonetic', 'Definition', 'Examples', 'Forms', 'Notes', 'Source', 'ContentHash'];
	},
	async addNotes(notes) { this.addedPayloads.push(...notes); return [101]; },
	async updateNoteFields() { throw new Error('update should not be called for current-file isolation test'); },
	async addTags(noteIds, tags) { this.tagged.push({ noteIds, tags }); },
	async syncAnkiWeb() { this.synced = true; },
};
const currentFileService = new AnkiSyncService({ vault: fakeVault }, () => lifecycleSettings, () => currentFileClient);
const currentFileExecution = await currentFileService.executeCurrentFile(wordFile);
assert.equal(currentFileExecution.success, true);
assert.equal(currentFileExecution.stats.added, 1);
assert.deepEqual(currentFileClient.tagged, [], 'current-file sync must not lifecycle-tag other managed notes');

const suspendClient = {
	...lifecycleClient,
	suspended: [],
	async addNotes() { return []; },
	async syncAnkiWeb() { this.synced = true; },
	async suspendCards(cardIds) { this.suspended.push(...cardIds); },
};
const suspendService = new AnkiSyncService({ vault: fakeVault }, () => lifecycleSettings, () => suspendClient);
const suspendExecution = await suspendService.executeMissingSourceAction('suspend');
assert.equal(suspendExecution.success, true);
assert.deepEqual(suspendClient.suspended, [1201]);

const deleteClient = {
	...lifecycleClient,
	deleted: [],
	async addNotes() { return []; },
	async syncAnkiWeb() { this.synced = true; },
	async deleteNotes(noteIds) { this.deleted.push(...noteIds); },
};
const deleteService = new AnkiSyncService({ vault: fakeVault }, () => lifecycleSettings, () => deleteClient);
const deleteExecution = await deleteService.executeMissingSourceAction('delete');
assert.equal(deleteExecution.success, true);
assert.deepEqual(deleteClient.deleted, [201]);

const emptyVault = {
	...fakeVault,
	getAbstractFileByPath: path => path === 'LexiBridge' ? new TFolder('LexiBridge', []) : null,
};
const zeroSourceDeleteService = new AnkiSyncService({ vault: emptyVault }, () => lifecycleSettings, () => deleteClient);
await assert.doesNotReject(async () => {
	const result = await zeroSourceDeleteService.executeMissingSourceAction('tag');
	assert.equal(result.success, true);
});
const zeroSourceSuspend = await zeroSourceDeleteService.executeMissingSourceAction('suspend');
assert.equal(zeroSourceSuspend.success, false);
assert.match(zeroSourceSuspend.errors[0], /没有任何单词源文件/);

const incompatibleClient = {
	...fakeClient,
	addedPayloads: [],
	async modelNames() { return ['LexiBridge Vocabulary']; },
	async modelFieldNames() { return ['Word']; },
};
const incompatibleService = new AnkiSyncService({ vault: fakeVault }, () => settings, () => incompatibleClient);
await assert.rejects(() => incompatibleService.executeFullSync(), /字段不兼容/);

console.log('Anki utility tests passed');
