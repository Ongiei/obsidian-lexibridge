import { AnkiConnectClient } from './anki-connect-client';
import {
	AnkiSettings,
	DEFAULT_ANKI_BACK_TEMPLATE,
	DEFAULT_ANKI_CARD_CSS,
	DEFAULT_ANKI_FRONT_TEMPLATE,
	LEXIBRIDGE_ANKI_MODEL_FIELDS,
	LEXIBRIDGE_ANKI_MODEL_NAME,
} from './types';

export const ANKI_MODEL_IDENTITY = 'lexibridge-vocabulary-v1';
export const ANKI_MODEL_NAME = LEXIBRIDGE_ANKI_MODEL_NAME;
export const ANKI_MODEL_FIELDS = LEXIBRIDGE_ANKI_MODEL_FIELDS;

export class AnkiModelManager {
	constructor(private client: AnkiConnectClient) {}

	async ensureDeckAndModel(deckName: string, modelName: string, templates: Pick<AnkiSettings, 'frontTemplate' | 'backTemplate' | 'cardCss'>): Promise<void> {
		const frontTemplate = templates.frontTemplate || DEFAULT_ANKI_FRONT_TEMPLATE;
		const backTemplate = templates.backTemplate || DEFAULT_ANKI_BACK_TEMPLATE;
		const cardCss = templates.cardCss || DEFAULT_ANKI_CARD_CSS;
		if (!frontTemplate.includes('{{Word}}')) {
			throw new Error('Anki 卡片正面模板必须包含 {{Word}} 字段。');
		}
		if (!backTemplate.trim() || !cardCss.trim()) {
			throw new Error('Anki 卡片背面模板和 CSS 不能为空。');
		}
		await this.client.createDeck(deckName);
		const modelNames = await this.client.modelNames();
		if (modelNames.includes(modelName)) {
			const fields = await this.client.modelFieldNames(modelName);
			if (!sameFields(fields, [...ANKI_MODEL_FIELDS])) {
				throw new Error(`Anki 中已存在名为 ${modelName} 的模板，但字段不兼容。请重命名旧模板或手动处理后再同步。`);
			}
			if (typeof this.client.updateModelTemplates === 'function') {
				await this.client.updateModelTemplates(modelName, {
					Vocabulary: {Front: frontTemplate, Back: backTemplate},
				});
			}
			if (typeof this.client.updateModelStyling === 'function') {
				await this.client.updateModelStyling(modelName, cardCss);
			}
			return;
		}

		await this.client.createModel({
			modelName,
			inOrderFields: [...ANKI_MODEL_FIELDS],
			css: cardCss,
			cardTemplates: [
				{
					Name: 'Vocabulary',
					Front: frontTemplate,
					Back: backTemplate,
				},
			],
		});
	}
}

function sameFields(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && expected.every((field, index) => actual[index] === field);
}
