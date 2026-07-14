import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-auto-link-utils-'));
const outfile = join(tmp, 'auto-link-utils.mjs');

await esbuild.build({
	entryPoints: ['src/utils/auto-link.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
});

const { getFenceMarker, isReferenceDefinition, splitProtectedMarkdown } = await import(pathToFileURL(outfile).href);

const line = 'word [label](https://example.com/word) ![[word]] `word` <span>word</span> #word';
const protectedParts = splitProtectedMarkdown(line).filter(part => part.isProtected).map(part => part.text);
assert.deepEqual(protectedParts, [
	'[label](https://example.com/word)',
	'![[word]]',
	'`word`',
	'<span>',
	'</span>',
	'#word',
]);
assert.deepEqual(getFenceMarker('```ts'), { character: '`', length: 3 });
assert.deepEqual(getFenceMarker('  ~~~~'), { character: '~', length: 4 });
assert.equal(getFenceMarker('plain text'), null);
assert.equal(isReferenceDefinition('[docs]: https://example.com/word'), true);
assert.equal(isReferenceDefinition('ordinary [docs] text'), false);

console.log('Auto-link utils tests passed');

const wordOutfile = join(tmp, 'word-utils.mjs');
await esbuild.build({
	entryPoints: ['src/utils/word.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: wordOutfile,
});
const {resolveDictionaryWordName} = await import(pathToFileURL(wordOutfile).href);
assert.equal(resolveDictionaryWordName('Most', 'most'), 'most');
assert.equal(resolveDictionaryWordName('Running', 'run'), 'run');
assert.equal(resolveDictionaryWordName('London', 'London'), 'London');
assert.equal(resolveDictionaryWordName('NASA', 'nasa'), 'NASA');
assert.equal(resolveDictionaryWordName('iPhone', 'iphone'), 'iPhone');
assert.equal(resolveDictionaryWordName('Apple', 'apple', {preserveTitleCase: true}), 'Apple');

console.log('Dictionary word-name tests passed');

const previewOutfile = join(tmp, 'virtual-link-preview.mjs');
await esbuild.build({
	entryPoints: ['src/utils/virtual-link-preview.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: previewOutfile,
});

const {getVirtualLinkPreviewMarkdown} = await import(pathToFileURL(previewOutfile).href);
const virtualLinkPreview = getVirtualLinkPreviewMarkdown(`---
word: network
tags:
  - vocabulary
---

# network

## 释义
- 网络

> [!info] 欧路同步
> 从 ECDICT 本地更新

## 例句
The network is available.
`);
assert.ok(!virtualLinkPreview.includes('word: network'));
assert.ok(!virtualLinkPreview.includes('欧路同步'));
assert.ok(virtualLinkPreview.includes('# network'));
assert.ok(virtualLinkPreview.includes('The network is available.'));

const legacyEnglishPreview = getVirtualLinkPreviewMarkdown('# network\n\n> [!info] Eudic Sync\n> Updated from ECDICT\n');
assert.ok(!legacyEnglishPreview.includes('Eudic Sync'));

console.log('Virtual-link preview tests passed');

const serviceOutfile = join(tmp, 'auto-link-service.mjs');
const obsidianShim = {
	name: 'obsidian-shim',
	setup(build) {
		build.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian-shim', namespace: 'obsidian-shim'}));
		build.onLoad({filter: /.*/, namespace: 'obsidian-shim'}, () => ({
			loader: 'js',
			contents: `
				export class TFolder { constructor(path, children = []) { this.path = path; this.children = children; } }
				export class TFile { constructor(path) { this.path = path; this.basename = path.split('/').pop().replace(/\\.md$/, ''); this.extension = 'md'; } }
			`,
		}));
	},
};
await esbuild.build({
	stdin: {
		contents: `
			import {AutoLinkService} from './src/auto-link.ts';
			import {TFile, TFolder} from 'obsidian';
			export {AutoLinkService, TFile, TFolder};
		`,
		resolveDir: process.cwd(),
		sourcefile: 'auto-link-service-test.ts',
		loader: 'ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: serviceOutfile,
	plugins: [obsidianShim],
});

const {AutoLinkService, TFile, TFolder} = await import(pathToFileURL(serviceOutfile).href);
const installFile = new TFile('LexiBridge/install.md');
const testFile = new TFile('LexiBridge/nested/test.md');
const threadFile = new TFile('LexiBridge/thread.md');
const colorFile = new TFile('LexiBridge/color.md');
const externalThreadFile = new TFile('Notes/thread.md');
const folder = new TFolder('LexiBridge', [installFile, threadFile, colorFile, new TFolder('LexiBridge/nested', [testFile])]);
const app = {
	vault: {getAbstractFileByPath: path => path === 'LexiBridge' ? folder : null},
	metadataCache: {
		getFileCache: file => {
			if (file === installFile) return {frontmatter: {word: 'install'}};
			if (file === colorFile) return {frontmatter: {word: 'color', aliases: ['colour']}};
			return null;
		},
		getFirstLinkpathDest: (linktext, sourcePath) => {
			if (sourcePath === 'Conflict.md' && linktext === 'thread') return externalThreadFile;
			return new Map([
				['install', installFile],
				['test', testFile],
				['thread', threadFile],
				['color', colorFile],
				['colour', colorFile],
			]).get(linktext) || null;
		},
	},
};
const settings = {
	folderPath: 'LexiBridge', autoLinkFirstOnly: true, autoLinkMinWordLength: 2,
	autoLinkIgnoredWords: ['the'], autoLinkSkipHeadings: true, autoLinkSkipBlockquotes: true,
	autoLinkExcludedHeadings: ['Skip'],
};
const service = new AutoLinkService(app, settings);
const source = '# install\n\nThe installed test is a Test. Thread thread colour.\n\n> install\n';
const plan = service.createPlan(source);
assert.equal(plan.occurrences.length, 4);
assert.deepEqual(plan.occurrences.map(item => item.target), ['LexiBridge/install', 'LexiBridge/nested/test', 'LexiBridge/thread', 'LexiBridge/color']);
const linked = service.applyPlan(plan, new Set(plan.candidates.map(item => item.target)));
assert.match(linked, /\[\[install\|installed\]\]/);
assert.match(linked, /\[\[test\]\]/);
assert.match(linked, /\[\[thread\|Thread\]\]/);
assert.match(linked, /\[\[color\|colour\]\]/);
assert.ok(!linked.includes('LexiBridge/'));
assert.match(linked, /^# install/m);
assert.match(linked, /^> install/m);

const prelinkedPlan = service.createPlan('[[install]] installed');
assert.equal(prelinkedPlan.occurrences.length, 0);

const sourcedPlan = service.createPlan('installed test Thread colour', undefined, 'Reading.md');
const sourcedLinked = service.applyPlan(sourcedPlan, new Set(sourcedPlan.candidates.map(item => item.target)));
assert.equal(sourcedLinked, '[[install|installed]] [[test]] [[thread|Thread]] [[color|colour]]');

const conflictPlan = service.createPlan('Thread', undefined, 'Conflict.md');
assert.equal(conflictPlan.occurrences[0]?.replacement, '[[LexiBridge/thread|Thread]]');

const selectionPlan = service.createPlan('install test', {from: 8, to: 12});
assert.deepEqual(selectionPlan.occurrences.map(item => item.text), ['test']);

const cleanup = service.createCleanupPlan('Keep [[Other]], ![[test]], [[LexiBridge/install|installed]], and [[test]].');
assert.equal(cleanup.occurrences.length, 2);
const cleaned = service.applyPlan(cleanup, new Set(cleanup.candidates.map(item => item.target)));
assert.equal(cleaned, 'Keep [[Other]], ![[test]], installed, and test.');

const excludedPlan = service.createPlan('## Skip\ninstall test\n## Keep\ninstall test');
assert.equal(excludedPlan.occurrences.length, 2);

const missing = service.findMissingCandidates('## Skip\nunknown hidden\n## Keep\nunknown unknown install');
assert.deepEqual(missing.map(item => [item.target, item.count]), [['unknown', 2]]);

console.log('Auto-link service tests passed');
