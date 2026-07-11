import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-batch-utils-'));
const outfile = join(tmp, 'batch-update-utils.mjs');

const obsidianShim = {
	name: 'obsidian-shim',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({
			path: 'obsidian-shim',
			namespace: 'obsidian-shim',
		}));
		build.onLoad({ filter: /.*/, namespace: 'obsidian-shim' }, () => ({
			loader: 'js',
			contents: `
				export function parseYaml(text) {
					const result = {};
					for (const raw of text.split(/\\r?\\n/)) {
						const match = raw.match(/^([^:]+):(.*)$/);
						if (!match) continue;
						result[match[1].trim()] = match[2].trim();
					}
					return result;
				}
			`,
		}));
	},
};

await esbuild.build({
	entryPoints: ['src/utils/batch-update.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
	plugins: [obsidianShim],
	external: ['../settings', '../modal'],
});

const {
	getBatchFileStatus,
	getBatchWritePreview,
	getCandidateFilenames,
	parseFrontmatter,
} = await import(pathToFileURL(outfile).href);

const youdaoContent = `---\ndict_source: youdao\nword: install\n---\n# install\n`;
const ecdictContent = `---\ndict_source: ecdict\nword: install\n---\n# install\n`;
const eudicContent = `---\ndict_source: eudic\nword: install\n---\n# install\n`;
const legacyChineseSync = `# install\n\n> [!info] 欧路同步\n`;

assert.deepEqual(parseFrontmatter(youdaoContent), { dict_source: 'youdao', word: 'install' });
assert.equal(parseFrontmatter('# no frontmatter'), null);
assert.equal(getBatchFileStatus(youdaoContent, parseFrontmatter(youdaoContent)), 'updated');
assert.equal(getBatchFileStatus(ecdictContent, parseFrontmatter(ecdictContent)), 'updated');
assert.equal(getBatchFileStatus(eudicContent, parseFrontmatter(eudicContent)), 'pending');
assert.equal(getBatchFileStatus(legacyChineseSync, null), 'pending');
assert.equal(getBatchFileStatus('# ordinary note', null), 'ignored');
assert.deepEqual(getCandidateFilenames('Install'), ['Install.md', 'install.md']);
assert.deepEqual(
	getBatchWritePreview({ includeExamProperties: true, includePosProperties: true }),
	{ fields: ['tags', 'word', 'aliases', 'dict_source', 'exams', 'pos'], tags: ['vocabulary'] }
);

console.log('Batch update utils tests passed');
