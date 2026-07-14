import { App, Platform, TFile } from 'obsidian';
import { LexiBridgeSettings } from '../settings';
import { AnkiCardMapper, safeTagPart } from './card-mapper';
import { AnkiConnectClient } from './anki-connect-client';
import { AnkiModelManager } from './model-manager';
import { AnkiSyncPlanner } from './sync-planner';
import { WordNoteRepository } from './word-note-repository';
import {
	AnkiExecutionResult,
	AnkiPreviewResult,
	AnkiSyncPlan,
	DesiredAnkiNote,
	MissingSourceAction,
	WordNoteSnapshot,
} from './types';

const ADD_NOTES_BATCH_SIZE = 25;

interface ExecutePlanOptions {
	handleMissingSources: boolean;
}

export class AnkiSyncService {
	private readonly repository: WordNoteRepository;

	constructor(
		private app: App,
		private getSettings: () => LexiBridgeSettings,
		private createClient: () => AnkiConnectClient = () => new AnkiConnectClient(this.getSettings().anki.endpoint)
	) {
		this.repository = new WordNoteRepository(app, getSettings);
	}

	assertDesktopAvailable(): void {
		if (!Platform.isDesktopApp) {
			throw new Error('Anki 导出需要 Anki Desktop 与 AnkiConnect，因此仅支持 Obsidian 桌面端。');
		}
	}

	async testConnection(): Promise<number> {
		this.assertDesktopAvailable();
		return this.createClient().testConnection();
	}

	async loadDeckNames(): Promise<string[]> {
		this.assertDesktopAvailable();
		const client = this.createClient();
		await client.testConnection();
		return client.deckNames();
	}

	async createDeck(deckName: string): Promise<void> {
		this.assertDesktopAvailable();
		const name = deckName.trim();
		if (!name) throw new Error('Anki 牌组名不能为空。');
		const client = this.createClient();
		await client.testConnection();
		await client.createDeck(name);
	}

	async previewFullSync(): Promise<AnkiPreviewResult> {
		this.assertDesktopAvailable();
		const snapshots = await this.repository.readAll();
		return this.createPreview(snapshots);
	}

	async executeFullSync(onProgress?: (message: string) => void): Promise<AnkiExecutionResult> {
		this.assertDesktopAvailable();
		const snapshots = await this.repository.readAll();
		const preview = await this.createPreview(snapshots);
		return this.executePlan(preview.plan, { handleMissingSources: true }, onProgress);
	}

	async executeMissingSourceAction(
		action: MissingSourceAction,
		onProgress?: (message: string) => void
	): Promise<AnkiExecutionResult> {
		this.assertDesktopAvailable();
		const snapshots = await this.repository.readAll();
		const preview = await this.createPreview(snapshots);
		return this.executeMissingSourcePlan(preview, action, onProgress);
	}

	async previewCurrentFile(file: TFile): Promise<AnkiPreviewResult> {
		this.assertDesktopAvailable();
		const settings = this.getSettings();
		if (!file.path.startsWith(`${settings.folderPath}/`) && file.path !== settings.folderPath) {
			throw new Error(`当前文件不在单词笔记文件夹 ${settings.folderPath} 中。`);
		}
		const snapshot = await this.repository.readPath(file.path);
		return this.createPreview(snapshot ? [snapshot] : []);
	}

	async executeCurrentFile(file: TFile, onProgress?: (message: string) => void): Promise<AnkiExecutionResult> {
		this.assertDesktopAvailable();
		const preview = await this.previewCurrentFile(file);
		return this.executePlan(preview.plan, { handleMissingSources: false }, onProgress);
	}

	private async createPreview(snapshots: WordNoteSnapshot[]): Promise<AnkiPreviewResult> {
		const settings = this.getSettings();
		const mapper = new AnkiCardMapper({
			ankiSourceId: settings.anki.ankiSourceId,
			deckName: settings.anki.deckName,
			modelName: settings.anki.modelName,
			includeProtectedSections: settings.anki.includeProtectedSections,
		});
		const desired = snapshots.map(snapshot => mapper.map(snapshot));
		const client = this.createClient();
		await client.testConnection();
		const sourceTag = `lexibridge::source::${safeTagPart(settings.anki.ankiSourceId)}`;
		const noteIds = await client.findNotes(`tag:${sourceTag}`);
		const existing = await client.notesInfo(noteIds);
		const plan = new AnkiSyncPlanner().plan(desired, existing);
		return {
			plan,
			desiredCount: desired.length,
			existingCount: existing.length,
		};
	}

	private async executePlan(
		plan: AnkiSyncPlan,
		options: ExecutePlanOptions,
		onProgress?: (message: string) => void
	): Promise<AnkiExecutionResult> {
		const settings = this.getSettings();
		const stats = {
			added: 0,
			updated: 0,
			unchanged: plan.unchanged.length,
			failed: 0,
			verified: 0,
		};
		const errors = [
			...plan.errors.map(error => error.message),
			...plan.conflicts.map(conflict => conflict.message),
		];
		if (errors.length > 0) {
			stats.failed = errors.length;
			return { success: false, stats, errors };
		}

		const client = this.createClient();
		onProgress?.('正在检查 Anki 牌组和模板...');
		await new AnkiModelManager(client).ensureDeckAndModel(settings.anki.deckName, settings.anki.modelName, settings.anki);

		const addedNoteIds: number[] = [];
		if (plan.adds.length > 0) {
			onProgress?.(`正在新增 ${plan.adds.length} 条 Anki 笔记...`);
			for (let offset = 0; offset < plan.adds.length; offset += ADD_NOTES_BATCH_SIZE) {
				const batch = plan.adds.slice(offset, offset + ADD_NOTES_BATCH_SIZE);
				onProgress?.(`正在新增 ${offset + 1}-${offset + batch.length} / ${plan.adds.length} 条 Anki 笔记...`);
				const addResults = await client.addNotes(batch.map(item => toAnkiAddPayload(item.desired)));
				addResults.forEach((noteId, index) => {
					const word = batch[index]?.desired.word || '未知词条';
					if (typeof noteId === 'number') {
						addedNoteIds.push(noteId);
						stats.added += 1;
					} else {
						stats.failed += 1;
						errors.push(`新增 ${word} 失败。`);
					}
				});
			}
		}

		const updatedNoteIds: number[] = [];
		for (const item of plan.updates) {
			onProgress?.(`正在更新 ${item.desired.word}...`);
			try {
				await client.updateNoteFields(item.existing.noteId, item.desired.fields);
				updatedNoteIds.push(item.existing.noteId);
				stats.updated += 1;
			} catch (error) {
				stats.failed += 1;
				errors.push(`更新 ${item.desired.word} 失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const expectedHashes = new Map<string, string>();
		for (const item of plan.adds) expectedHashes.set(item.desired.lexiBridgeId, item.desired.contentHash);
		for (const item of plan.updates) expectedHashes.set(item.desired.lexiBridgeId, item.desired.contentHash);

		const changedIds = [...addedNoteIds, ...updatedNoteIds];
		if (changedIds.length > 0) {
			onProgress?.('正在回读校验 Anki 笔记...');
			const notes = await client.notesInfo(changedIds);
			for (const note of notes) {
				const lexiBridgeId = note.fields.LexiBridgeId?.value || '';
				const expectedHash = expectedHashes.get(lexiBridgeId);
				if (expectedHash && note.fields.ContentHash?.value === expectedHash) {
					stats.verified += 1;
				} else {
					stats.failed += 1;
					errors.push(`Anki 笔记 ${note.noteId} 回读校验失败。`);
				}
			}
		}

		const restoredSourceNoteIds = [...plan.updates, ...plan.unchanged]
			.map(item => item.existing)
			.filter(note => note.tags.includes('lexibridge::source-missing'))
			.map(note => note.noteId);
		if (restoredSourceNoteIds.length > 0) {
			onProgress?.(`正在恢复 ${restoredSourceNoteIds.length} 条 Anki 笔记的缺失源标记...`);
			try {
				await client.removeTags(restoredSourceNoteIds, 'lexibridge::source-missing');
			} catch (error) {
				stats.failed += 1;
				errors.push(`移除缺失源标记失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const hasDesiredSources = plan.adds.length + plan.updates.length + plan.unchanged.length > 0;
		if (options.handleMissingSources && settings.anki.missingSourcePolicy === 'tag' && hasDesiredSources && plan.missingSources.length > 0) {
			onProgress?.(`正在标记 ${plan.missingSources.length} 条缺失源文件的 Anki 笔记...`);
			try {
				await client.addTags(plan.missingSources.map(item => item.existing.noteId), 'lexibridge::source-missing');
			} catch (error) {
				stats.failed += 1;
				errors.push(`标记缺失源文件失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (settings.anki.syncAnkiWebAfterPush && (stats.added + stats.updated) > 0 && errors.length === 0) {
			onProgress?.('正在请求 Anki 执行 AnkiWeb 同步...');
			try {
				await client.syncAnkiWeb();
			} catch (error) {
				stats.failed += 1;
				errors.push(`AnkiWeb 同步未确认：${error instanceof Error ? error.message : String(error)}`);
			}
		}

		return { success: errors.length === 0, stats, errors };
	}

	private async executeMissingSourcePlan(
		preview: AnkiPreviewResult,
		action: MissingSourceAction,
		onProgress?: (message: string) => void
	): Promise<AnkiExecutionResult> {
		const stats = {
			added: 0,
			updated: 0,
			unchanged: preview.plan.unchanged.length,
			failed: 0,
			verified: 0,
		};
		const errors = [
			...preview.plan.errors.map(error => error.message),
			...preview.plan.conflicts.map(conflict => conflict.message),
		];
		if (errors.length > 0) {
			stats.failed = errors.length;
			return { success: false, stats, errors };
		}
		if (preview.desiredCount === 0 && action !== 'tag') {
			stats.failed = 1;
			return {
				success: false,
				stats,
				errors: ['当前扫描没有任何单词源文件。为避免误删或误暂停，已拒绝执行该操作。'],
			};
		}
		if (preview.plan.missingSources.length === 0) {
			return { success: true, stats, errors: [] };
		}

		const client = this.createClient();
		const noteIds = preview.plan.missingSources.map(item => item.existing.noteId);
		try {
			if (action === 'tag') {
				onProgress?.(`正在标记 ${noteIds.length} 条缺失源文件的 Anki 笔记...`);
				await client.addTags(noteIds, 'lexibridge::source-missing');
				stats.updated = noteIds.length;
			} else if (action === 'suspend') {
				const cardIds = preview.plan.missingSources.flatMap(item => item.existing.cards);
				if (cardIds.length === 0) throw new Error('缺失源笔记没有可暂停的 card ID。');
				onProgress?.(`正在暂停 ${cardIds.length} 张缺失源卡片...`);
				await client.suspendCards(cardIds);
				stats.updated = preview.plan.missingSources.length;
			} else {
				onProgress?.(`正在删除 ${noteIds.length} 条缺失源 Anki 笔记...`);
				await client.deleteNotes(noteIds);
				stats.updated = noteIds.length;
			}
		} catch (error) {
			stats.failed += 1;
			errors.push(`缺失源操作失败：${error instanceof Error ? error.message : String(error)}`);
		}

		return { success: errors.length === 0, stats, errors };
	}
}

function toAnkiAddPayload(note: DesiredAnkiNote): Record<string, unknown> {
	return {
		deckName: note.deckName,
		modelName: note.modelName,
		fields: note.fields,
		options: {
			allowDuplicate: false,
			duplicateScope: 'deck',
		},
		tags: note.tags,
	};
}
