import { App, TFile, TFolder, parseYaml } from 'obsidian';
import { LexiBridgeSettings } from './settings';
import { YoudaoService } from './youdao';
import { DictEntry } from './types';
import { getLemma } from './lemmatizer';
import { MarkdownGenerator } from './utils/markdown-generator';
import { BatchUpdateModal, BatchUpdateStats, BatchWritePreview, GenerationPreviewModal, ProgressNoticeWidget } from './modal';

export interface BatchUpdateResult {
	total: number;
	updated: number;
	skipped: number;
	failed: number;
}

interface LocalFrontmatter {
	tags?: string[];
	aliases?: string[];
	dict_source?: string;
	[key: string]: unknown;
}

export class BatchUpdateService {
	private app: App;
	private settings: LexiBridgeSettings;
	private isRunning: boolean = false;
	private shouldStop: boolean = false;
	private progressNotice: ProgressNoticeWidget | null = null;

	constructor(app: App, settings: LexiBridgeSettings) {
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
				this.getBatchWritePreview(),
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

	private getBatchWritePreview(): BatchWritePreview {
		const fields = ['tags', 'word', 'aliases', 'dict_source'];
		if (this.settings.includeExamProperties) {
			fields.push('exams');
		}
		if (this.settings.includePosProperties) {
			fields.push('pos');
		}
		return {
			fields,
			tags: ['vocabulary'],
		};
	}

	private async scanFiles(): Promise<BatchUpdateStats> {
		const folderPath = this.settings.folderPath;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);

		const stats: BatchUpdateStats = { total: 0, updated: 0, pending: 0 };

		if (!(folder instanceof TFolder)) {
			console.debug(`[LexiBridge] Folder not found: ${folderPath}`);
			return stats;
		}

		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				try {
					const content = await this.app.vault.read(child);
					const fm = this.parseFrontmatter(content);

					stats.total++;

					if (fm?.dict_source === 'youdao') {
						stats.updated++;
					} else if (fm?.dict_source === 'eudic' || content.includes('[!info] Eudic Sync')) {
						stats.pending++;
					}
				} catch (readErr) {
					console.warn(`[LexiBridge] Could not read ${child.path}:`, readErr);
				}
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
						const didUpdate = await this.updateFileSafely(file, false);
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

				await this.delay(this.settings.apiDelayMs);
			}

			this.progressNotice?.setComplete({ uploaded: result.updated, downloaded: 0, deletedFromCloud: 0, trashedLocally: 0, failed: result.failed });
			console.debug(`[LexiBridge] Complete. Updated: ${result.updated}, Failed: ${result.failed}`);
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			console.error('[LexiBridge] Fatal error:', errMsg);
			this.progressNotice?.setComplete({ uploaded: result.updated, downloaded: 0, deletedFromCloud: 0, trashedLocally: 0, failed: result.failed });
		} finally {
			this.isRunning = false;
			this.progressNotice = null;
		}

		onComplete(result);
	}

	async batchUpdate(): Promise<BatchUpdateResult> {
		return this.batchUpdateWithModal();
	}

	private async updateFileSafely(file: TFile, showPreview: boolean = true): Promise<boolean> {
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;

		const word = (fm?.word as string | undefined) || file.basename;

		const content = await this.app.vault.read(file);
		const parsedFm = this.parseFrontmatter(content);

		if (parsedFm?.dict_source === 'youdao') {
			return false;
		}

		const entry = await this.fetchDictionaryEntry(word);
		if (!entry) {
			return false;
		}

		const dictSource = this.settings.dictionarySource;
		const generatedContent = MarkdownGenerator.generate(word, entry, {
			dictSource: dictSource,
			frontmatterTemplate: this.settings.frontmatterTemplate,
			bodyTemplate: this.settings.bodyTemplate,
			includeExamProperties: this.settings.includeExamProperties,
			includePosProperties: this.settings.includePosProperties,
		});

		if (showPreview && !await this.confirmGeneratedContent(word, entry, dictSource)) {
			return false;
		}

		const newContent = MarkdownGenerator.mergeWithExisting(content, generatedContent);

		await this.app.vault.process(file, () => newContent);
		return true;
	}

	private async confirmGeneratedContent(word: string, entry: DictEntry, dictSource: 'youdao' | 'eudic'): Promise<boolean> {
		if (!this.settings.previewBeforeWrite) {
			return true;
		}

		const preview = MarkdownGenerator.preview(word, entry, {
			dictSource,
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

	private async fetchDictionaryEntry(word: string): Promise<DictEntry | null> {
		const source = this.settings.dictionarySource;
		const lemma = getLemma(word.toLowerCase().trim());

		if (source === 'youdao') {
			return await YoudaoService.lookup(lemma);
		}

		console.warn(`[LexiBridge] Dictionary source "${source}" not implemented, falling back to Youdao`);
		return await YoudaoService.lookup(lemma);
	}

	private parseFrontmatter(content: string): LocalFrontmatter | null {
		const match = content.match(/^---\n([\s\S]*?)\n---/);
		if (!match || !match[1]) {
			return null;
		}

		try {
			return parseYaml(match[1]) as LocalFrontmatter;
		} catch {
			return null;
		}
	}

	private async findFilesNeedingUpdate(): Promise<TFile[]> {
		const folderPath = this.settings.folderPath;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);

		if (!(folder instanceof TFolder)) {
			console.debug(`[LexiBridge] Folder not found: ${folderPath}`);
			return [];
		}

		const files: TFile[] = [];

		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				try {
					const content = await this.app.vault.read(child);
					const fm = this.parseFrontmatter(content);

					if (fm?.dict_source === 'youdao') {
						continue;
					}

					if (fm?.dict_source === 'eudic' || content.includes('[!info] Eudic Sync')) {
						files.push(child);
					}
				} catch (readErr) {
					console.warn(`[LexiBridge] Could not read ${child.path}:`, readErr);
				}
			}
		}

		return files;
	}

	async updateSingleWord(word: string): Promise<boolean> {
		try {
			const folderPath = this.settings.folderPath;
			
			const possibleFilenames = [
				`${word}.md`,
				`${word.toLowerCase()}.md`,
			];
			
			let file: TFile | null = null;
			for (const filename of possibleFilenames) {
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
					for (const child of folder.children) {
						if (child instanceof TFile && child.extension === 'md') {
							const cache = this.app.metadataCache.getFileCache(child);
							const fmWord = cache?.frontmatter?.word as string | undefined;
							if (fmWord && fmWord.toLowerCase() === word.toLowerCase()) {
								file = child;
								break;
							}
						}
					}
				}
			}

			if (!file) {
				console.debug(`[LexiBridge] File not found for word: ${word}`);
				return false;
			}

			return await this.updateFileSafely(file);
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			console.error(`[LexiBridge] Failed to update ${word}:`, errMsg);
			return false;
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
