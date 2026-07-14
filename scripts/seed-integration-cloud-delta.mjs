import {readFileSync} from 'node:fs';

const dataPath = process.argv[2];
if (!dataPath) throw new Error('Usage: node scripts/seed-integration-cloud-delta.mjs <integration-data.json>');
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const categoryId = data.syncCategoryIds?.[0];
if (!data.eudicToken || !categoryId) throw new Error('Integration settings are missing token or category ID.');
const count = Math.min(2000, Math.max(1, Number.parseInt(process.argv[3] || '100', 10)));
const prefix = process.argv[4] || `integrationdelta${Date.now().toString(36)}`;
const words = Array.from({length: count}, (_, index) => `${prefix}${String(index).padStart(4, '0')}`);
const response = await fetch('https://api.frdic.com/api/open/v1/studylist/words', {
	method: 'POST',
	headers: {Authorization: data.eudicToken, 'Content-Type': 'application/json'},
	body: JSON.stringify({id: categoryId, category_id: categoryId, language: 'en', words}),
});
if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
console.log(`Seeded ${words.length} cloud-only test words in category ${categoryId}.`);
