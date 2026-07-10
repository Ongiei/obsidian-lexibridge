import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-vault-files-'));
const outfile = join(tmp, 'vault-files-test.mjs');

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
			`,
		}));
	},
};

await esbuild.build({
	stdin: {
		contents: `
			import { TFile, TFolder } from 'obsidian';
			import { getMarkdownFilesRecursively } from './src/utils/vault-files.ts';
			export function run() {
				const nested = new TFolder('LexiBridge/nested', [
					new TFile('LexiBridge/nested/deep.md'),
					new TFile('LexiBridge/nested/ignore.txt'),
				]);
				const root = new TFolder('LexiBridge', [new TFile('LexiBridge/root.md'), nested]);
				return getMarkdownFilesRecursively(root).map(file => file.path).sort();
			}
		`,
		resolveDir: process.cwd(),
		sourcefile: 'vault-files-test.ts',
		loader: 'ts',
	},
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
	plugins: [obsidianShim],
});

const { run } = await import(pathToFileURL(outfile).href);
assert.deepEqual(run(), ['LexiBridge/nested/deep.md', 'LexiBridge/root.md']);

console.log('Vault file recursion tests passed');
