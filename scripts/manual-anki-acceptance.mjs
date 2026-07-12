import assert from 'node:assert/strict';

const endpoint = process.env.ANKI_CONNECT_ENDPOINT || 'http://127.0.0.1:8765';
const runId = `manual-${Date.now().toString(36)}`;
const deckName = `LexiBridge Manual Acceptance`;
const modelName = `LexiBridge Manual Acceptance`;
const sourceTag = `lexibridge::source::${runId}`;

async function invoke(action, params) {
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, version: 6, params }),
	});
	if (!response.ok) {
		throw new Error(`${action} HTTP ${response.status}`);
	}
	const data = await response.json();
	if (!data || typeof data !== 'object' || !('result' in data) || !('error' in data)) {
		throw new Error(`${action} returned an invalid AnkiConnect response`);
	}
	if (data.error) {
		throw new Error(`${action}: ${data.error}`);
	}
	return data.result;
}

async function ensureManualModel() {
	await invoke('createDeck', { deck: deckName });
	const modelNames = await invoke('modelNames');
	if (modelNames.includes(modelName)) {
		return;
	}
	await invoke('createModel', {
		modelName,
		inOrderFields: [
			'LexiBridgeId',
			'Word',
			'Phonetic',
			'Definition',
			'Examples',
			'Forms',
			'Notes',
			'Source',
			'ContentHash',
		],
		css: '.card { font-family: sans-serif; }',
		cardTemplates: [
			{
				Name: 'Vocabulary',
				Front: '{{Word}}',
				Back: '{{FrontSide}}<hr id="answer">{{Definition}}',
			},
		],
	});
}

function notePayload(word, hash, definition) {
	return {
		deckName,
		modelName,
		fields: {
			LexiBridgeId: `${runId}:${word.toLowerCase()}`,
			Word: word,
			Phonetic: '',
			Definition: definition,
			Examples: '',
			Forms: '',
			Notes: '',
			Source: 'manual acceptance',
			ContentHash: hash,
		},
		tags: ['lexibridge', sourceTag],
		options: {
			allowDuplicate: false,
			duplicateScope: 'deck',
		},
	};
}

async function main() {
	const version = await invoke('version');
	assert.equal(typeof version, 'number');
	await ensureManualModel();

	const added = await invoke('addNotes', {
		notes: [
			notePayload('AcceptanceOne', 'hash-one', '<p>first</p>'),
			notePayload('AcceptanceTwo', 'hash-two', '<p>second</p>'),
		],
	});
	assert.equal(added.length, 2);
	assert.ok(added.every(noteId => typeof noteId === 'number'));
	const [firstNoteId, secondNoteId] = added;

	const beforeUpdate = await invoke('notesInfo', { notes: [firstNoteId] });
	const beforeCardIds = beforeUpdate[0].cards;
	assert.ok(Array.isArray(beforeCardIds) && beforeCardIds.length > 0);

	await invoke('updateNoteFields', {
		note: {
			id: firstNoteId,
			fields: {
				Definition: '<p>updated</p>',
				ContentHash: 'hash-one-updated',
			},
		},
	});

	const afterUpdate = await invoke('notesInfo', { notes: [firstNoteId] });
	assert.deepEqual(afterUpdate[0].cards, beforeCardIds, 'card IDs changed after updateNoteFields');
	assert.equal(afterUpdate[0].fields.ContentHash.value, 'hash-one-updated');

	const found = await invoke('findNotes', { query: `tag:${sourceTag}` });
	assert.deepEqual(found.sort(), [firstNoteId, secondNoteId].sort());

	await invoke('deleteNotes', { notes: [firstNoteId, secondNoteId] });
	console.log(`Manual Anki acceptance passed via ${endpoint}`);
}

main().catch(error => {
	console.error(`Manual Anki acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
