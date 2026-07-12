import { AnkiConnectClient } from './anki-connect-client';
import { LEXIBRIDGE_ANKI_MODEL_FIELDS, LEXIBRIDGE_ANKI_MODEL_NAME } from './types';

export const ANKI_MODEL_IDENTITY = 'lexibridge-vocabulary-v1';
export const ANKI_MODEL_NAME = LEXIBRIDGE_ANKI_MODEL_NAME;
export const ANKI_MODEL_FIELDS = LEXIBRIDGE_ANKI_MODEL_FIELDS;

export class AnkiModelManager {
	constructor(private client: AnkiConnectClient) {}

	async ensureDeckAndModel(deckName: string, modelName: string): Promise<void> {
		await this.client.createDeck(deckName);
		const modelNames = await this.client.modelNames();
		if (modelNames.includes(modelName)) {
			const fields = await this.client.modelFieldNames(modelName);
			if (!sameFields(fields, [...ANKI_MODEL_FIELDS])) {
				throw new Error(`Anki 中已存在名为 ${modelName} 的模板，但字段不兼容。请重命名旧模板或手动处理后再同步。`);
			}
			return;
		}

		await this.client.createModel({
			modelName,
			inOrderFields: [...ANKI_MODEL_FIELDS],
			css: MODEL_CSS,
			cardTemplates: [
				{
					Name: 'Vocabulary',
					Front: FRONT_TEMPLATE,
					Back: BACK_TEMPLATE,
				},
			],
		});
	}
}

function sameFields(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && expected.every((field, index) => actual[index] === field);
}

const FRONT_TEMPLATE = `
<div class="lexibridge-card">
	<div class="lexibridge-word">{{Word}}</div>
	{{#Phonetic}}<div class="lexibridge-phonetic">{{Phonetic}}</div>{{/Phonetic}}
</div>
`.trim();

const BACK_TEMPLATE = `
{{FrontSide}}
<hr id="answer">
<div class="lexibridge-card lexibridge-back">
	<div class="lexibridge-section">{{Definition}}</div>
	{{#Examples}}<div class="lexibridge-section">{{Examples}}</div>{{/Examples}}
	{{#Forms}}<div class="lexibridge-section">{{Forms}}</div>{{/Forms}}
	{{#Notes}}<div class="lexibridge-section lexibridge-notes">{{Notes}}</div>{{/Notes}}
	{{#Source}}<div class="lexibridge-source">{{Source}}</div>{{/Source}}
</div>
`.trim();

const MODEL_CSS = `
.card {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	font-size: 18px;
	line-height: 1.55;
	color: #222;
	background: #fafafa;
}
.lexibridge-word {
	font-size: 32px;
	font-weight: 700;
	margin-bottom: 8px;
}
.lexibridge-phonetic,
.lexibridge-source {
	color: #666;
	font-size: 14px;
}
.lexibridge-section {
	margin: 12px 0;
}
.lexibridge-section ul,
.lexibridge-section ol {
	padding-left: 1.4em;
}
.lexibridge-notes {
	border-top: 1px solid #ddd;
	padding-top: 12px;
}
@media (prefers-color-scheme: dark) {
	.card {
		color: #eee;
		background: #1f1f1f;
	}
	.lexibridge-phonetic,
	.lexibridge-source {
		color: #aaa;
	}
	.lexibridge-notes {
		border-top-color: #444;
	}
}
`.trim();
