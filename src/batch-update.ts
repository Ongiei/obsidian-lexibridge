import { App, TFile, TFolder } from 'obsidian';
import { LexiBridgeSettings } from './settings';
import { DictEntry } from './types';
import { getLemma } from './lemmatizer';
import { MarkdownGenerator } from './utils/markdown-generator';
import { BatchUpdateModal, BatchUpdateStats, GenerationPreviewModal, ProgressNoticeWidget } from './modal';
import {getBatchFileStatus, getBatchWritePreview, getCandidateFilenames, parseFrontmatter} from './utils/batch-update';
import {getMarkdownFilesRecursively} from './utils/vault-files';
import {DictionaryProviderId, DictionaryService} from './dictionary-provider';

export interface BatchUpdateResult {
	total: number;
	updated: number;
	skipped: number;
	failed: number;
}

export class BatchUpdateService {
	private app: App;
	private settings: LexiBridgeSettings;
	private isRunning: boolean = false;
	private shouldStop: boolean = false;
	private progressNotice: ProgressNoticeWidget | null = null;

	constructor(app: App, settings: LexiBridgeSettings, private dictionaryService: DictionaryService) {
		this.app = app;
		this.settings = settings;
	}

	stop(): void {
		this.shouldStop = true;
	}

	isInProgress(): boolean {
		return this.isRunning;
	}

	async batchUpdateWithModal(): Promise<BatchUpdateResult> {
		if (this.isRunning) {
			return { total: 0, updated: 0, skipped: 0, failed: 0 };
		}

		this.isRunning = true;
		this.shouldStop = false;

		const stats = await this.scanFiles();

		return new Promise((resolve) => {
			const modal = new BatchUpdateModal(
				this.app,
				stats,
				getBatchWritePreview(this.settings),
				() => {
					void this.executeBatchUpdate(stats.pending, resolve);
				},
				() => {
					this.isRunning = false;
					resolve({ total: stats.total, updated: 0, skipped: 0, failed: 0 });
				}
			);
			modal.open();
		});
	}

	private async scanFiles(): Promise<BatchUpdateStats> {
		const folderPath = this.settings.folderPath;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);

		const stats: BatchUpdateStats = { total: 0, updated: 0, pending: 0 };

		if (!(folder instanceof TFolder)) {
			console.debug(`[LexiBridge] Folder not found: ${folderPath}`);
			return stats;
		}

		for (const child of getMarkdownFilesRecursively(folder)) {
				try {
					const content = await this.app.vault.read(child);
					const fm = parseFrontmatter(content);

					stats.total++;

					const status = getBatchFileStatus(content, fm);
					if (status === 'updated') {
						stats.updated++;
					} else if (status === 'pending') {
						stats.pending++;
					}
				} catch (readErr) {
					console.warn(`[LexiBridge] Could not read ${child.path}:`, readErr);
				}
		}

		return stats;
	}

	private async executeBatchUpdate(
		totalPending: number,
		onComplete: (result: BatchUpdateResult) => void
	): Promise<void> {
		const filesNeedingUpdate = await this.findFilesNeedingUpdate();
		const total = filesNeedingUpdate.length;
		const result: BatchUpdateResult = { total, updated: 0, skipped: 0, failed: 0 };

		this.progressNotice = new ProgressNoticeWidget(
			'update',
			total,
			() => {
				this.shouldStop = true;
			}
		);

		try {
			let current = 0;
			for (const file of filesNeedingUpdate) {
				if (this.shouldStop || this.progressNotice?.isAbortedByUser()) {
					this.progressNotice?.setAborted(result.updated);
					console.debug(`[LexiBridge] Aborted. Updated: ${result.updated}`);
					this.isRunning = false;
					this.progressNotice = null;
					onComplete(result);
					return;
				}

				current++;
				const cache = this.app.metadataCache.getFileCache(file);
				const word = (cache?.frontmatter?.word as string | undefined) || file.basename;
				this.progressNotice?.update(current, total, word);

				try {
					const didUpdate = await this.updateFileSafely(file, false, 'ecdict', true);
					if (didUpdate) {
						result.updated++;
						console.debug(`[LexiBridge] Updated "${word}" (${current}/${totalPending})`);
					} else {
						result.skipped++;
					}
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.error(`[LexiBridge] Failed "${word}":`, errMsg);
					result.failed++;
				}

			}

			this.progressNotice?.setComplete({ uploaded: result.updated, downloaded: 0, deletedFromCloud: 0, trashedLocally: 0, failed: result.failed, skipped: result.skipped });
			console.debug(`[LexiBridge] Complete. Updated: ${result.updated}, Failed: ${result.failed}`);
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			console.error('[LexiBridge] Fatal error:', errMsg);
			this.progressNotice?.setComplete({ uploaded: result.updated, downloaded: 0, deletedFromCloud: 0, trashedLocally: 0, failed: result.failed, skipped: result.skipped });
		} finally {
			this.isRunning = false;
			this.progressNotice = null;
		}

		onComplete(result);
	}

	async batchUpdate(): Promise<BatchUpdateResult> {
		return this.batchUpdateWithModal();
	}

	private async updateFileSafely(
		file: TFile,
		showPreview: boolean = true,
		source: DictionaryProviderId = 'ecdict',
		skipIfAlreadyUpdated: boolean = false
	): Promise<boolean> {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;

		const word = (fm?.word as string | undefined) || file.basename;

		const content = await this.app.vault.read(file);
		const parsedFm = parseFrontmatter(content);

		if (skipIfAlreadyUpdated && getBatchFileStatus(content, parsedFm) === 'updated') {
			return false;
		}

		const lookupResult = source === 'ecdict'
			? await this.dictionaryService.lookupLocal(getLemma(word.toLowerCase().trim()))
			: await this.dictionaryService.lookupOnline(getLemma(word.toLowerCase().trim()));
		if (!lookupResult) {
			return false;
		}
		const {entry} = lookupResult;

		const generatedContent = MarkdownGenerator.generate(word, entry, {
			dictSource: lookupResult.source,
			frontmatterTemplate: this.settings.frontmatterTemplate,
			bodyTemplate: this.settings.bodyTemplate,
			includeExamProperties: this.settings.includeExamProperties,
			includePosProperties: this.settings.includePosProperties,
		});

		if (showPreview && !await this.confirmGeneratedContent(word, entry, lookupResult.source)) {
			return false;
		}

		const newContent = MarkdownGenerator.mergeWithExisting(content, generatedContent);

		await this.app.vault.process(file, () => newContent);
		return true;
	}

	private async confirmGeneratedContent(word: string, entry: DictEntry, source: DictionaryProviderId): Promise<boolean> {
		if (!this.settings.previewBeforeWrite) {
			return true;
		}

		const preview = MarkdownGenerator.preview(word, entry, {
			dictSource: source,
			frontmatterTemplate: this.settings.frontmatterTemplate,
			bodyTemplate: this.settings.bodyTemplate,
			includeExamProperties: this.settings.includeExamProperties,
			includePosProperties: this.settings.includePosProperties,
		});

		return new Promise((resolve) => {
			new GenerationPreviewModal(
				this.app,
				preview,
				() => resolve(true),
				() => resolve(false)
			).open();
		});
	}

	private async findFilesNeedingUpdate(): Promise<TFile[]> {
		const folderPath = this.settings.folderPath;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);

		if (!(folder instanceof TFolder)) {
			console.debug(`[LexiBridge] Folder not found: ${folderPath}`);
			return [];
		}

		const files: TFile[] = [];

		for (const child of getMarkdownFilesRecursively(folder)) {
				try {
					const content = await this.app.vault.read(child);
					const fm = parseFrontmatter(content);

					if (getBatchFileStatus(content, fm) === 'pending') {
						files.push(child);
					}
				} catch (readErr) {
					console.warn(`[LexiBridge] Could not read ${child.path}:`, readErr);
				}
		}

		return files;
	}

	async updateSingleWord(word: string, source: DictionaryProviderId = 'ecdict'): Promise<boolean> {
		try {
			const folderPath = this.settings.folderPath;
			
			let file: TFile | null = null;
			for (const filename of getCandidateFilenames(word)) {
				const filePath = `${folderPath}/${filename}`;
				const found = this.app.vault.getAbstractFileByPath(filePath);
				if (found instanceof TFile) {
					file = found;
					break;
				}
			}

			if (!file) {
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (folder instanceof TFolder) {
					for (const child of getMarkdownFilesRecursively(folder)) {
							const cache = this.app.metadataCache.getFileCache(child);
							const fmWord = cache?.frontmatter?.word as string | undefined;
							if (fmWord && fmWord.toLowerCase() === word.toLowerCase()) {
								file = child;
								break;
							}
					}
				}
			}

			if (!file) {
				console.debug(`[LexiBridge] File not found for word: ${word}`);
				return false;
			}

			return await this.updateFileSafely(file, true, source);
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			console.error(`[LexiBridge] Failed to update ${word}:`, errMsg);
			return false;
		}
	}

}
