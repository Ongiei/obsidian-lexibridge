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
const folder = new TFolder('LexiBridge', [installFile, new TFolder('LexiBridge/nested', [testFile])]);
const app = {
	vault: {getAbstractFileByPath: path => path === 'LexiBridge' ? folder : null},
	metadataCache: {getFileCache: file => file === installFile ? {frontmatter: {word: 'install', aliases: ['installed']}} : null},
};
const settings = {
	folderPath: 'LexiBridge', autoLinkFirstOnly: true, autoLinkMinWordLength: 2,
	autoLinkIgnoredWords: ['the'], autoLinkSkipHeadings: true, autoLinkSkipBlockquotes: true,
	autoLinkExcludedHeadings: ['Skip'],
};
const service = new AutoLinkService(app, settings);
const source = '# install\n\nThe installed test is a test.\n\n> install\n';
const plan = service.createPlan(source);
assert.equal(plan.occurrences.length, 2);
assert.deepEqual(plan.occurrences.map(item => item.target), ['LexiBridge/install', 'LexiBridge/nested/test']);
const linked = service.applyPlan(plan, new Set(plan.candidates.map(item => item.target)));
assert.match(linked, /\[\[LexiBridge\/install\|installed\]\]/);
assert.match(linked, /\[\[LexiBridge\/nested\/test\]\]/);
assert.match(linked, /^# install/m);
assert.match(linked, /^> install/m);

const selectionPlan = service.createPlan('install test', {from: 8, to: 12});
assert.deepEqual(selectionPlan.occurrences.map(item => item.text), ['test']);

const cleanup = service.createCleanupPlan('Keep [[Other]] and [[LexiBridge/install|installed]] plus [[test]].');
assert.equal(cleanup.occurrences.length, 2);
const cleaned = service.applyPlan(cleanup, new Set(cleanup.candidates.map(item => item.target)));
assert.equal(cleaned, 'Keep [[Other]] and installed plus test.');

const excludedPlan = service.createPlan('## Skip\ninstall test\n## Keep\ninstall test');
assert.equal(excludedPlan.occurrences.length, 2);

const missing = service.findMissingCandidates('## Skip\nunknown hidden\n## Keep\nunknown unknown install');
assert.deepEqual(missing.map(item => [item.target, item.count]), [['unknown', 2]]);

console.log('Auto-link service tests passed');
