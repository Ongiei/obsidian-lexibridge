import {
	DesiredAnkiNote,
	LEXIBRIDGE_ANKI_MODEL_NAME,
	WordNoteSnapshot,
} from './types';
import {
	AnkiMarkdownRenderer,
	BASIC_ANKI_MARKDOWN_RENDERER,
	escapeHtml,
} from './markdown-renderer';

export interface AnkiCardMapperOptions {
	ankiSourceId: string;
	deckName: string;
	modelName?: string;
	includeProtectedSections: boolean;
	markdownRenderer?: AnkiMarkdownRenderer;
}

export class AnkiCardMapper {
	constructor(private options: AnkiCardMapperOptions) {}

	map(snapshot: WordNoteSnapshot): DesiredAnkiNote {
		const renderer = this.options.markdownRenderer || BASIC_ANKI_MARKDOWN_RENDERER;
		const normalizedWord = normalizeWord(snapshot.word);
		const lexiBridgeId = `${this.options.ankiSourceId}:${normalizedWord}`;
		const sourceHtml = renderer.render(snapshot.sourceMarkdown);
		const notesHtml = this.options.includeProtectedSections ? renderer.render(snapshot.protectedMarkdown) : '';
		const fields: Record<string, string> = {
			LexiBridgeId: lexiBridgeId,
			Word: escapeHtml(snapshot.word),
			Phonetic: renderer.render(snapshot.phoneticsMarkdown),
			Definition: renderer.render(snapshot.definitionsMarkdown),
			Examples: renderer.render(snapshot.examplesMarkdown),
			Forms: renderer.render(snapshot.formsMarkdown),
			Notes: notesHtml,
			Source: sourceHtml,
			ContentHash: '',
		};
		const contentHash = stableHash(JSON.stringify(fields));
		fields.ContentHash = contentHash;

		return {
			lexiBridgeId,
			word: snapshot.word,
			deckName: this.options.deckName,
			modelName: this.options.modelName || LEXIBRIDGE_ANKI_MODEL_NAME,
			fields,
			tags: [
				'lexibridge',
				`lexibridge::source::${safeTagPart(this.options.ankiSourceId)}`,
			],
			contentHash,
			sourceFilePath: snapshot.filePath,
		};
	}
}

export function normalizeWord(word: string): string {
	return word.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function safeTagPart(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function stableHash(value: string): string {
	let hash: number = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	const unsignedHash: number = hash >>> 0;
	return unsignedHash.toString(16).padStart(8, '0');
}
