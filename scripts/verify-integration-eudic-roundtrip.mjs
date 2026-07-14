import {readFileSync} from 'node:fs';

const dataPath = process.argv[2];
if (!dataPath) throw new Error('Usage: node scripts/verify-integration-eudic-roundtrip.mjs <integration-data.json>');
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const token = data.eudicToken;
const categoryId = data.syncCategoryIds?.[0];
const state = data.syncManifest?.categories?.[categoryId];
if (!token || !categoryId || !state?.name) throw new Error('Missing integration category settings.');

const originalName = state.name;
const temporaryName = `${originalName} Rename Check`;
const marker = `lexibridgeroundtrip${Date.now().toString(36)}`;
const started = performance.now();

try {
	await request('POST', '/studylist/words', {
		id: categoryId, category_id: categoryId, language: 'en', words: [marker],
	});
	assertWord(await listWords(), marker, true, 'add');
	await request('PATCH', '/studylist/category', {id: categoryId, language: 'en', name: temporaryName});
	const renamed = await request('GET', '/studylist/category?language=en');
	if (!renamed.data?.some(category => category.id === categoryId && category.name === temporaryName)) {
		throw new Error('Category rename was not visible in the category list.');
	}
	await request('DELETE', '/studylist/words', {
		id: categoryId, category_id: categoryId, language: 'en', words: [marker],
	});
	assertWord(await listWords(), marker, false, 'delete');
} finally {
	await request('PATCH', '/studylist/category', {id: categoryId, language: 'en', name: originalName});
}

console.log(JSON.stringify({categoryId, marker, elapsedMs: Math.round(performance.now() - started), restoredName: originalName}, null, 2));

async function listWords() {
	const words = [];
	for (let page = 0; page < 51; page += 1) {
		const response = await request('GET', `/studylist/words?language=en&category_id=${encodeURIComponent(categoryId)}&page=${page}&page_size=100`);
		const batch = Array.isArray(response.data) ? response.data : [];
		words.push(...batch.map(item => String(item.word || '').toLowerCase()));
		if (batch.length < 100) break;
	}
	return words;
}

function assertWord(words, word, expected, phase) {
	if (words.includes(word) !== expected) throw new Error(`Eudic ${phase} verification failed for ${word}.`);
}

async function request(method, path, body) {
	const response = await fetch(`https://api.frdic.com/api/open/v1${path}`, {
		method,
		headers: {Authorization: token, 'Content-Type': 'application/json'},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${await response.text()}`);
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}
