import {readFileSync} from 'node:fs';

const dataPath = process.argv[2];
if (!dataPath) throw new Error('Usage: node scripts/cleanup-integration-test-data.mjs <integration-data.json>');
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const token = data.eudicToken;
const categoryId = data.syncCategoryIds?.[0];
if (!token || !categoryId) throw new Error('Missing integration token or category ID.');

const prefixes = ['integrationdelta', 'progresssample', 'progressvisual', 'noticecheck', 'lexibridgetestword', 'lexibridgeroundtrip'];
const words = [];
for (let page = 0; page < 51; page += 1) {
	const result = await request('GET', `/studylist/words?language=en&category_id=${encodeURIComponent(categoryId)}&page=${page}&page_size=100`);
	const batch = Array.isArray(result.data) ? result.data : [];
	words.push(...batch.map(item => String(item.word || '').toLowerCase()));
	if (batch.length < 100) break;
}
const removable = words.filter(word => prefixes.some(prefix => word.startsWith(prefix)));
for (let offset = 0; offset < removable.length; offset += 100) {
	await request('DELETE', '/studylist/words', {
		id: categoryId,
		category_id: categoryId,
		language: 'en',
		words: removable.slice(offset, offset + 100),
	});
}
console.log(JSON.stringify({categoryId, removed: removable.length, remaining: words.length - removable.length}, null, 2));

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
