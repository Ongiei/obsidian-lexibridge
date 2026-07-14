import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-generator-'));
const outfile = join(tmp, 'markdown-generator.mjs');

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
				export function stringifyYaml(obj) {
					const lines = [];
					for (const [key, value] of Object.entries(obj)) {
						if (Array.isArray(value)) {
							lines.push(key + ':');
							for (const item of value) lines.push('  - ' + item);
						} else {
							lines.push(key + ': ' + value);
						}
					}
					return lines.join('\\n') + '\\n';
				}
				export function parseYaml(text) {
					const result = {};
					let currentKey = null;
					for (const raw of text.split(/\\r?\\n/)) {
						const line = raw.trimEnd();
						if (!line.trim()) continue;
						if (/^\\s+-\\s+/.test(raw) && currentKey) {
							result[currentKey].push(raw.replace(/^\\s+-\\s+/, ''));
							continue;
						}
						const match = line.match(/^([^:]+):(.*)$/);
						if (!match) continue;
						currentKey = match[1].trim();
						const value = match[2].trim();
						if (value === '') result[currentKey] = [];
						else result[currentKey] = value;
					}
					return result;
				}
			`,
		}));
	},
};

await esbuild.build({
	entryPoints: ['src/utils/markdown-generator.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
	plugins: [obsidianShim],
});

const { MarkdownGenerator } = await import(pathToFileURL(outfile).href);

const entry = {
	word: 'install',
	ph_uk: 'ɪnˈstɔːl',
	ph_us: 'ɪnˈstɔːl',
	audio_uk: 'https://dict.youdao.com/uk.mp3',
	audio_us: '',
	definitions: [{ pos: 'v.', trans: '安装，设置' }],
	tags: ['CET4', 'CET6', 'IELTS'],
	exchange: [
		{ name: '第三人称单数', value: 'installs' },
		{ name: '现在分词', value: 'installing' },
		{ name: '过去式', value: 'installed' },
	],
	webTrans: [{ key: 'install', value: ['安装', '安置'] }],
	bilingualExamples: [{ eng: 'The shower is easy to install.', chn: '淋浴器易于安装。' }],
};

const preview = MarkdownGenerator.preview('install', entry, {});
assert.deepEqual(preview.frontmatter.tags, ['vocabulary']);
assert.equal(preview.frontmatter.exams, undefined);
assert.equal(preview.frontmatter.pos, undefined);
assert.ok(!preview.content.includes('exam/CET4'));
assert.ok(!preview.content.includes('pos/v'));
assert.ok(preview.content.includes('{{') === false);
assert.ok(!preview.content.includes('lexibridge:managed'));

const propertyPreview = MarkdownGenerator.preview('install', entry, {
	includeExamProperties: true,
	includePosProperties: true,
	eudicLists: ['Default', 'Default'],
});
assert.deepEqual(propertyPreview.frontmatter.exams, ['CET4', 'CET6', 'IELTS']);
assert.deepEqual(propertyPreview.frontmatter.pos, ['v']);
assert.deepEqual(propertyPreview.frontmatter.eudic_lists, ['Default']);
assert.ok(!propertyPreview.content.includes('exam/CET4'));
assert.ok(!propertyPreview.content.includes('pos/v'));

const customPreview = MarkdownGenerator.preview('install', entry, {
	bodyTemplate: '# {{word}}\\n\\n{{phonetic_uk}}\\n{{audio_uk}}\\n{{definitions}}\\n{{examples}}\\n{{forms}}',
});
assert.ok(customPreview.content.includes('ɪnˈstɔːl'));
assert.ok(customPreview.content.includes('https://dict.youdao.com/uk.mp3'));
assert.ok(customPreview.content.includes('The shower is easy to install.'));
assert.ok(customPreview.content.includes('第三人称单数: installs'));

const existing = `---
tags:
  - personal
  - exam/CET4
  - pos/v
aliases:
  - my-install-note
rating: 5
---

# install

My handwritten note.

<!-- lexibridge:managed:start -->
old generated text
<!-- lexibridge:managed:end -->

## 笔记

Another handwritten note.

### 联想

Nested handwritten note.
`;

const merged = MarkdownGenerator.mergeWithExisting(existing, propertyPreview.content, ['笔记']);
assert.ok(merged.includes('rating: 5'));
assert.ok(merged.includes('- vocabulary'));
assert.ok(merged.includes('- personal'));
assert.ok(merged.includes('- my-install-note'));
assert.ok(!merged.includes('exam/CET4'));
assert.ok(!merged.includes('pos/v'));
assert.ok(!merged.includes('My handwritten note.'));
assert.ok(merged.includes('Another handwritten note.'));
assert.ok(merged.includes('Nested handwritten note.'));
assert.ok(!merged.includes('old generated text'));
assert.ok(merged.includes('安装，设置'));
assert.ok(!merged.includes('lexibridge:managed'));

const layeredExisting = `# install\n\n## 笔记\n\nKeep level two.\n\n### 联想\n\nKeep nested content.\n`;
const layeredMerged = MarkdownGenerator.mergeWithExisting(layeredExisting, propertyPreview.content, ['## 笔记']);
assert.ok(layeredMerged.includes('Keep level two.'));
assert.ok(layeredMerged.includes('Keep nested content.'));

const wrongLevelExisting = `# install\n\n### 笔记\n\nDo not keep wrong level.\n`;
const wrongLevelMerged = MarkdownGenerator.mergeWithExisting(wrongLevelExisting, propertyPreview.content, ['## 笔记']);
assert.ok(!wrongLevelMerged.includes('Do not keep wrong level.'));

const legacyLayeredMerged = MarkdownGenerator.mergeWithExisting(layeredExisting, propertyPreview.content, ['笔记']);
assert.ok(legacyLayeredMerged.includes('Keep level two.'));

const nestedSameTitle = `# install\n\n## 笔记\n\nParent note.\n\n### 笔记\n\nNested note.\n`;
const nestedSameTitleMerged = MarkdownGenerator.mergeWithExisting(nestedSameTitle, propertyPreview.content, ['笔记']);
assert.equal((nestedSameTitleMerged.match(/Nested note\./g) || []).length, 1);

const legacySyncCallout = `# install\n\n> [!info] 欧路同步\n> 从 ECDICT 本地更新 · 使用有道在线增强\n\n## 笔记\n\nKeep this.\n`;
const legacySyncCalloutMerged = MarkdownGenerator.mergeWithExisting(legacySyncCallout, propertyPreview.content, ['笔记']);
assert.ok(!legacySyncCalloutMerged.includes('[!info] 欧路同步'));
assert.ok(!legacySyncCalloutMerged.includes('从 ECDICT 本地更新'));
assert.ok(legacySyncCalloutMerged.includes('Keep this.'));

writeFileSync(join(tmp, 'merged.md'), merged);
readFileSync(join(tmp, 'merged.md'), 'utf8');

console.log('MarkdownGenerator tests passed');
