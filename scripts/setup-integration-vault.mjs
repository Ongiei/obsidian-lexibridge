import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vault = join(root, 'integration-vault');
const sourceDataPath = process.argv[2];
if (!sourceDataPath || !existsSync(sourceDataPath)) {
	throw new Error('Usage: node scripts/setup-integration-vault.mjs <existing-lexibridge-data.json>');
}

const sourceData = JSON.parse(readFileSync(sourceDataPath, 'utf8'));
const sourcePluginsRoot = dirname(dirname(sourceDataPath));
const token = String(sourceData.eudicToken || '').trim();
if (!token) throw new Error('The source settings file does not contain an Eudic token.');

rmSync(vault, {recursive: true, force: true});
mkdirSync(join(vault, '.obsidian', 'plugins'), {recursive: true});

const testCategoryName = `LexiBridge Integration ${new Date().toISOString().slice(0, 10)}`;
const category = await ensureTestCategory(token, testCategoryName);
const words = await loadCommonWords(token, category.id);
const uploadStarted = performance.now();
for (let offset = 0; offset < words.length; offset += 100) {
	await eudicRequest(token, 'POST', '/studylist/words', {
		id: category.id,
		category_id: category.id,
		language: 'en',
		words: words.slice(offset, offset + 100),
	});
}
const uploadMs = Math.round(performance.now() - uploadStarted);

const fetched = [];
const fetchStarted = performance.now();
for (let page = 0; page < 51; page += 1) {
	const result = await eudicRequest(token, 'GET', `/studylist/words?language=en&category_id=${encodeURIComponent(category.id)}&page=${page}&page_size=100`);
	const batch = Array.isArray(result.data) ? result.data : [];
	fetched.push(...batch.map(item => String(item.word || '').toLowerCase()));
	if (batch.length < 100) break;
}
const fetchMs = Math.round(performance.now() - fetchStarted);
const missing = words.filter(word => !fetched.includes(word));
if (missing.length > 0) throw new Error(`Eudic verification is missing ${missing.length} test words.`);

const wordRoot = join(vault, 'LexiBridge');
const categoryFolder = join(wordRoot, testCategoryName);
mkdirSync(categoryFolder, {recursive: true});
for (const word of words) {
	writeFileSync(join(categoryFolder, `${word}.md`), createWordNote(word, testCategoryName));
}
createReadingNotes(vault, words);

const pluginSource = join(root, 'vault', '.obsidian', 'plugins', 'lexibridge');
const pluginTarget = join(vault, '.obsidian', 'plugins', 'lexibridge');
mkdirSync(pluginTarget, {recursive: true});
for (const name of ['main.js', 'manifest.json', 'styles.css']) cpSync(join(pluginSource, name), join(pluginTarget, name));
writeFileSync(join(pluginTarget, 'data.json'), JSON.stringify({
	...sourceData,
	folderPath: 'LexiBridge',
	syncCategoryIds: [category.id],
	defaultUploadCategoryId: category.id,
	enableSync: true,
	autoSync: false,
	syncOnStartup: false,
	virtualLinksEnabled: true,
	syncManifest: {version: 2, lastSyncTime: Date.now(), categories: {
		[category.id]: {name: testCategoryName, folderName: testCategoryName, syncedWords: words},
	}},
}, null, 2));

for (const plugin of [
	{id: 'templater-obsidian'},
	{id: 'dataview'},
	{id: 'obsidian-linter'},
]) await installPlugin(plugin);

writeFileSync(join(vault, '.obsidian', 'community-plugins.json'), JSON.stringify([
	'lexibridge', 'templater-obsidian', 'dataview', 'obsidian-linter',
], null, 2));
writeFileSync(join(vault, '.obsidian', 'app.json'), JSON.stringify({promptDelete: false}, null, 2));
writeFileSync(join(vault, 'TEST-REPORT.json'), JSON.stringify({
	categoryId: category.id,
	categoryName: testCategoryName,
	wordCount: words.length,
	uploadMs,
	fetchMs,
	verifiedCloudWords: fetched.length,
}, null, 2));

console.log(JSON.stringify({vault, categoryId: category.id, categoryName: testCategoryName, wordCount: words.length, uploadMs, fetchMs}, null, 2));

async function loadCommonWords(tokenValue, categoryId) {
	const existing = [];
	for (let page = 0; page < 5; page += 1) {
		const result = await eudicRequest(tokenValue, 'GET', `/studylist/words?language=en&category_id=${encodeURIComponent(categoryId)}&page=${page}&page_size=100`);
		const batch = Array.isArray(result.data) ? result.data : [];
		existing.push(...batch.map(item => String(item.word || '').trim().toLowerCase()).filter(word => /^[a-z]+$/.test(word)));
		if (batch.length < 100) break;
	}
	if (existing.length >= 500) return [...new Set(existing)].slice(0, 500);
	const response = await fetch('https://cdn.jsdelivr.net/gh/first20hours/google-10000-english@master/google-10000-english.txt');
	if (!response.ok) throw new Error(`Failed to download common-word list: HTTP ${response.status}`);
	const values = (await response.text()).split(/\r?\n/)
		.map(word => word.trim().toLowerCase())
		.filter(word => /^[a-z]+$/.test(word) && word.length > 1);
	return [...new Set(values)].slice(0, 500);
}

async function ensureTestCategory(tokenValue, name) {
	const categories = await eudicRequest(tokenValue, 'GET', '/studylist/category?language=en');
	const existing = (Array.isArray(categories.data) ? categories.data : []).find(item => item.name === name);
	if (existing) return existing;
	const created = await eudicRequest(tokenValue, 'POST', '/studylist/category', {language: 'en', name});
	if (!created.data?.id) throw new Error('Eudic did not return the new test category ID.');
	return created.data;
}

async function eudicRequest(tokenValue, method, path, body) {
	const response = await fetch(`https://api.frdic.com/api/open/v1${path}`, {
		method,
		headers: {Authorization: tokenValue, 'Content-Type': 'application/json'},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) throw new Error(`Eudic ${method} ${path} failed: HTTP ${response.status} ${await response.text()}`);
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

async function installPlugin({id}) {
	const target = join(vault, '.obsidian', 'plugins', id);
	const source = join(sourcePluginsRoot, id);
	if (!existsSync(join(source, 'main.js')) || !existsSync(join(source, 'manifest.json'))) {
		throw new Error(`Required test plugin is not installed locally: ${id}`);
	}
	cpSync(source, target, {recursive: true});
}

function createWordNote(word, categoryName) {
	return `---\nword: ${word}\ndict_source: eudic\ntags:\n  - vocabulary\neudic_lists:\n  - ${categoryName}\n---\n\n# ${word}\n\n## 释义\n- 测试释义：${word}\n\n## 例句\nThis is a test sentence for **${word}**.\n\n> [!info] 欧路同步\n> 从 ECDICT 本地更新 · 使用有道在线增强\n`;
}

function createReadingNotes(targetVault, commonWords) {
	const reading = join(targetVault, 'Reading Tests');
	mkdirSync(reading, {recursive: true});
	const titles = ['Everyday Decisions', 'Learning Systems', 'Technology and Work', 'A Short Journey', 'Shared Knowledge'];
	for (let index = 0; index < titles.length; index += 1) {
		const slice = commonWords.slice(index * 80, index * 80 + 120);
		const paragraphs = [];
		for (let cursor = 0; cursor < slice.length; cursor += 20) {
			paragraphs.push(slice.slice(cursor, cursor + 20).join(' ') + '.');
		}
		writeFileSync(join(reading, `${index + 1}-${titles[index]}.md`), `# ${titles[index]}\n\n${paragraphs.join('\n\n')}\n`);
	}
}
