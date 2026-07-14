import { requestUrl } from 'obsidian';
import {
	ANKI_CONNECT_VERSION,
	AnkiConnectEnvelope,
	AnkiConnectResponse,
	AnkiConnectTransport,
	AnkiMultiAction,
	AnkiNoteInfo,
	DEFAULT_ANKI_ENDPOINT,
} from './types';

const DEFAULT_TIMEOUT_MS = 10000;

export class AnkiConnectError extends Error {
	constructor(message: string, readonly phase: string = 'AnkiConnect') {
		super(message);
		this.name = 'AnkiConnectError';
	}
}

export class AnkiConnectClient {
	constructor(
		private endpoint: string = DEFAULT_ANKI_ENDPOINT,
		private timeoutMs: number = DEFAULT_TIMEOUT_MS,
		private transport: AnkiConnectTransport = defaultTransport
	) {}

	async invoke<T>(action: string, params?: Record<string, unknown>): Promise<T> {
		const request: AnkiConnectEnvelope = { action, version: ANKI_CONNECT_VERSION };
		if (params) request.params = params;

		const raw = await withTimeout(
			this.transport(request, this.endpoint, this.timeoutMs),
			this.timeoutMs,
			() => new AnkiConnectError(`AnkiConnect 请求超时（${this.timeoutMs}ms）。`, action)
		);
		const response = parseResponse<T>(raw, action);
		if (response.error) {
			throw new AnkiConnectError(response.error, action);
		}
		return response.result;
	}

	async multi<T>(actions: AnkiMultiAction[]): Promise<T[]> {
		const rawResults = await this.invoke<unknown[]>('multi', { actions });
		if (!Array.isArray(rawResults)) {
			throw new AnkiConnectError('AnkiConnect multi 返回了无效结果。', 'multi');
		}
		if (rawResults.length !== actions.length) {
			throw new AnkiConnectError('AnkiConnect multi 返回数量与请求数量不一致。', 'multi');
		}
		return rawResults.map((raw, index) => {
			const response = parseResponse<T>(raw, actions[index]?.action || 'multi');
			if (response.error) {
				throw new AnkiConnectError(response.error, actions[index]?.action || 'multi');
			}
			return response.result;
		});
	}

	async testConnection(): Promise<number> {
		const version = await this.invoke<unknown>('version');
		if (typeof version !== 'number') {
			throw new AnkiConnectError('AnkiConnect 返回了无效的版本信息。', 'version');
		}
		if (version < ANKI_CONNECT_VERSION) {
			throw new AnkiConnectError(`AnkiConnect API 版本过低：${version}。`, 'version');
		}
		return version;
	}

	async deckNames(): Promise<string[]> {
		const names = await this.invoke<unknown>('deckNames');
		if (!Array.isArray(names) || !names.every(item => typeof item === 'string')) {
			throw new AnkiConnectError('AnkiConnect 返回了无效的牌组列表。', 'deckNames');
		}
		return names;
	}

	async findNotes(query: string): Promise<number[]> {
		const result = await this.invoke<unknown>('findNotes', { query });
		if (!Array.isArray(result) || !result.every(item => typeof item === 'number')) {
			throw new AnkiConnectError('AnkiConnect 返回了无效的笔记 ID 列表。', 'findNotes');
		}
		return result;
	}

	async notesInfo(noteIds: number[]): Promise<AnkiNoteInfo[]> {
		if (noteIds.length === 0) return [];
		const result = await this.invoke<unknown>('notesInfo', { notes: noteIds });
		if (!Array.isArray(result)) {
			throw new AnkiConnectError('AnkiConnect 返回了无效的笔记详情。', 'notesInfo');
		}
		return result.map(parseNoteInfo);
	}

	async modelNames(): Promise<string[]> {
		const result = await this.invoke<unknown>('modelNames');
		if (!Array.isArray(result) || !result.every(item => typeof item === 'string')) {
			throw new AnkiConnectError('AnkiConnect 返回了无效的模板列表。', 'modelNames');
		}
		return result;
	}

	async modelFieldNames(modelName: string): Promise<string[]> {
		const result = await this.invoke<unknown>('modelFieldNames', { modelName });
		if (!Array.isArray(result) || !result.every(item => typeof item === 'string')) {
			throw new AnkiConnectError('AnkiConnect 返回了无效的字段列表。', 'modelFieldNames');
		}
		return result;
	}

	async createDeck(deck: string): Promise<number> {
		const result = await this.invoke<unknown>('createDeck', { deck });
		if (typeof result !== 'number') {
			throw new AnkiConnectError('AnkiConnect 创建牌组时返回了无效结果。', 'createDeck');
		}
		return result;
	}

	async createModel(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const result = await this.invoke<unknown>('createModel', params);
		if (!result || typeof result !== 'object') {
			throw new AnkiConnectError('AnkiConnect 创建模板时返回了无效结果。', 'createModel');
		}
		return result as Record<string, unknown>;
	}

	async updateModelTemplates(modelName: string, templates: Record<string, {Front: string; Back: string}>): Promise<void> {
		await this.invoke<unknown>('updateModelTemplates', {model: {name: modelName, templates}});
	}

	async updateModelStyling(modelName: string, css: string): Promise<void> {
		await this.invoke<unknown>('updateModelStyling', {model: {name: modelName, css}});
	}

	async addNotes(notes: Record<string, unknown>[]): Promise<(number | null)[]> {
		const result = await this.invoke<unknown>('addNotes', { notes });
		if (!Array.isArray(result) || !result.every(item => item === null || typeof item === 'number')) {
			throw new AnkiConnectError('AnkiConnect 新增笔记时返回了无效结果。', 'addNotes');
		}
		return result.map(item => item === null ? null : Number(item));
	}

	async updateNoteFields(noteId: number, fields: Record<string, string>): Promise<void> {
		await this.invoke<unknown>('updateNoteFields', {
			note: {
				id: noteId,
				fields,
			},
		});
	}

	async addTags(noteIds: number[], tags: string): Promise<void> {
		if (noteIds.length === 0) return;
		await this.invoke<unknown>('addTags', {
			notes: noteIds,
			tags,
		});
	}

	async removeTags(noteIds: number[], tags: string): Promise<void> {
		if (noteIds.length === 0) return;
		await this.invoke<unknown>('removeTags', {
			notes: noteIds,
			tags,
		});
	}

	async suspendCards(cardIds: number[]): Promise<void> {
		if (cardIds.length === 0) return;
		await this.invoke<unknown>('suspend', {
			cards: cardIds,
		});
	}

	async deleteNotes(noteIds: number[]): Promise<void> {
		if (noteIds.length === 0) return;
		await this.invoke<unknown>('deleteNotes', {
			notes: noteIds,
		});
	}

	async syncAnkiWeb(): Promise<void> {
		await this.invoke<unknown>('sync');
	}
}

async function defaultTransport(
	request: AnkiConnectEnvelope,
	endpoint: string,
	_timeoutMs: number
): Promise<unknown> {
	const response = await requestUrl({
		url: endpoint,
		method: 'POST',
		contentType: 'application/json',
		body: JSON.stringify(request),
		throw: false,
	});
	if (response.status < 200 || response.status >= 300) {
		throw new AnkiConnectError(`HTTP ${response.status}：无法连接到 AnkiConnect。`, request.action);
	}
	return response.json;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, createError: () => Error): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeout = window.setTimeout(() => reject(createError()), timeoutMs);
		promise.then(
			value => {
				window.clearTimeout(timeout);
				resolve(value);
			},
			error => {
				window.clearTimeout(timeout);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		);
	});
}

function parseResponse<T>(raw: unknown, action: string): AnkiConnectResponse<T> {
	if (!raw || typeof raw !== 'object') {
		throw new AnkiConnectError('AnkiConnect 返回了空响应或非 JSON 响应。', action);
	}
	const data = raw as Partial<AnkiConnectResponse<T>>;
	if (!('result' in data) || !('error' in data)) {
		throw new AnkiConnectError('AnkiConnect 响应缺少 result 或 error 字段。', action);
	}
	if (data.error !== null && typeof data.error !== 'string') {
		throw new AnkiConnectError('AnkiConnect error 字段格式无效。', action);
	}
	return data as AnkiConnectResponse<T>;
}

function parseNoteInfo(raw: unknown): AnkiNoteInfo {
	if (!isRecord(raw)) {
		throw new AnkiConnectError('AnkiConnect 返回了无效的笔记对象。', 'notesInfo');
	}
	const {noteId, modelName, tags, fields, cards} = raw;
	if (typeof noteId !== 'number' || typeof modelName !== 'string') {
		throw new AnkiConnectError('Anki 笔记缺少 noteId 或 modelName。', 'notesInfo');
	}
	if (!Array.isArray(tags) || !tags.every(item => typeof item === 'string')) {
		throw new AnkiConnectError('Anki 笔记 tags 字段格式无效。', 'notesInfo');
	}
	if (cards !== undefined && (!Array.isArray(cards) || !cards.every(item => typeof item === 'number'))) {
		throw new AnkiConnectError('Anki 笔记 cards 字段格式无效。', 'notesInfo');
	}
	return {
		noteId,
		modelName,
		tags,
		fields: parseAnkiFields(fields),
		cards: Array.isArray(cards) ? cards : [],
	};
}

function parseAnkiFields(raw: unknown): Record<string, {value: string; order?: number}> {
	if (!isRecord(raw)) {
		throw new AnkiConnectError('Anki 笔记 fields 字段格式无效。', 'notesInfo');
	}

	const fields: Record<string, {value: string; order?: number}> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (!isRecord(value) || typeof value.value !== 'string'
			|| (value.order !== undefined && typeof value.order !== 'number')) {
			throw new AnkiConnectError('Anki 笔记字段值格式无效。', 'notesInfo');
		}
		fields[name] = value.order === undefined
			? {value: value.value}
			: {value: value.value, order: value.order};
	}
	return fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
