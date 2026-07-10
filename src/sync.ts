import { App, TFile, TFolder } from 'obsidian';
import { EudicService, EudicWord } from './eudic';
import { LexiBridgeSettings } from './settings';
import { DictEntry } from './types';
import { MarkdownGenerator } from './utils/markdown-generator';
import {
	diffSyncSets,
	getEffectiveUploadCategoryIds,
	getValidFilename,
	parseEudicExpDefinitions,
	SyncOperationType,
	updateManifestAfterSuccessfulOperation,
	withTimeout,
} from './utils/sync';
import {getMarkdownFilesRecursively} from './utils/vault-files';

const MANIFEST_KEY = 'syncManifest';
const API_TIMEOUT_MS = 30000;
const FILE_TIMEOUT_MS = 10000;

export interface SyncManifest {
	lastSyncTime: number;
	syncedWords: string[];
}

export interface SyncDryRunResult {
	localAdded: string[];
	cloudAdded: string[];
	localDeleted: string[];
	cloudDeleted: string[];
	errors: string[];
	manifestMissing: boolean;
}

export interface SyncResult {
	success: boolean;
	aborted: boolean;
	stats: {
		uploaded: number;
		downloaded: number;
		deletedFromCloud: number;
		trashedLocally: number;
		failed: number;
	};
	errors: string[];
}

interface CloudWordData {
	exp: string;
	categories: string[];
	originalWord: string;
}

export class SyncService {
	private app: App;
	private settings: LexiBridgeSettings;
	private eudicService: EudicService;
	private loadData: () => Promise<unknown>;
	private saveData: (data: unknown) => Promise<void>;
	private isSyncing = false;
	private categoryIdToName: Map<string, string> = new Map();
	private cloudWordsWithCategories: Map<string, CloudWordData> = new Map();
	private localWordToFile: Map<string, TFile> = new Map();

	constructor(
		app: App,
		settings: LexiBridgeSettings,
		eudicService: EudicService,
		loadData: () => Promise<unknown>,
		saveData: (data: unknown) => Promise<void>
	) {
		this.app = app;
		this.settings = settings;
		this.eudicService = eudicService;
		this.loadData = loadData;
		this.saveData = saveData;
	}

	isSyncInProgress(): boolean {
		return this.isSyncing;
	}

	private async loadManifest(): Promise<SyncManifest | null> {
		try {
			const data = await this.loadData();
			if (data && typeof data === 'object' && MANIFEST_KEY in data) {
				const manifest = (data as Record<string, unknown>)[MANIFEST_KEY];
				if (!manifest || typeof manifest !== 'object') return null;
				const candidate = manifest as Partial<SyncManifest>;
				if (!Array.isArray(candidate.syncedWords)) return null;
				return {
					lastSyncTime: typeof candidate.lastSyncTime === 'number' ? candidate.lastSyncTime : 0,
					syncedWords: candidate.syncedWords.filter((word): word is string => typeof word === 'string'),
				};
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`读取同步记录失败：${message}`);
		}
		return null;
	}

	private async saveManifest(words: string[]): Promise<void> {
		const manifest: SyncManifest = {
			lastSyncTime: Date.now(),
			syncedWords: words.map(w => w.toLowerCase()),
		};
		
		await this.writeManifest(manifest);
	}

	private async writeManifest(manifest: SyncManifest): Promise<void> {
		try {
			const loaded = await this.loadData();
			const data = loaded && typeof loaded === 'object' ? loaded as Record<string, unknown> : {};
			await this.saveData({ ...data, [MANIFEST_KEY]: manifest });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`保存同步记录失败：${message}`);
		}
	}

	private async loadCategoryMapping(): Promise<void> {
		if (this.categoryIdToName.size > 0) return;

		const categories = await this.eudicService.getCategories('en');
		for (const cat of categories) {
			this.categoryIdToName.set(cat.id, cat.name);
		}
	}

	private async fetchCloudWords(): Promise<Map<string, CloudWordData>> {
		const data = new Map<string, CloudWordData>();
		
		await this.loadCategoryMapping();

		const categoryIds = this.settings.syncCategoryIds.length > 0 
			? this.settings.syncCategoryIds 
			: [this.settings.defaultUploadCategoryId || '0'];

		const pageSize = 100;

		for (const categoryId of categoryIds) {
			const categoryName = this.categoryIdToName.get(categoryId) || categoryId;
			let page = 0;

			while (true) {
				const batch: EudicWord[] = await withTimeout(
					this.eudicService.getWords(categoryId, 'en', page, pageSize),
					API_TIMEOUT_MS,
					`getWords ${categoryName} page ${page}`
				);

				if (!batch || batch.length === 0) break;

				for (const w of batch) {
					const originalWord = w.word?.trim();
					if (!originalWord) continue;

					const wordLower = originalWord.toLowerCase();
					
					const existing = data.get(wordLower);
					if (existing) {
						if (!existing.categories.includes(categoryName)) {
							existing.categories.push(categoryName);
						}
					} else {
						data.set(wordLower, {
							exp: w.exp || '',
							categories: [categoryName],
							originalWord: originalWord,
						});
					}
				}

				if (batch.length < pageSize) break;
				page++;
			}
		}

		this.cloudWordsWithCategories = data;
		console.debug(`[LexiBridge] Fetched ${data.size} unique words from ${categoryIds.length} categories`);
		return data;
	}

	private async fetchLocalWords(): Promise<Set<string>> {
		const words = new Set<string>();
		this.localWordToFile.clear();

		const folderPath = this.settings.folderPath;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);

		if (!(folder instanceof TFolder)) return words;

		for (const child of getMarkdownFilesRecursively(folder)) {
			const cache = this.app.metadataCache.getFileCache(child);
			const fm = cache?.frontmatter;

			const tags = fm?.tags as string[] | undefined;
			if (Array.isArray(tags) && (tags.includes('lexibridge/cloud-deleted') || tags.includes('eudicbridge/cloud-deleted'))) {
				continue;
			}

			const realWord = (fm?.word as string | undefined) || child.basename;

			const wordLower = realWord.toLowerCase();
			words.add(wordLower);
			this.localWordToFile.set(wordLower, child);
		}

		console.debug(`[LexiBridge] Found ${words.size} local words`);
		return words;
	}

	private getLocalFileByWord(word: string): TFile | undefined {
		return this.localWordToFile.get(word.toLowerCase());
	}

	async dryRun(): Promise<SyncDryRunResult> {
		const result: SyncDryRunResult = {
			localAdded: [],
			cloudAdded: [],
			localDeleted: [],
			cloudDeleted: [],
			errors: [],
			manifestMissing: false,
		};

		try {
			const manifest = await this.loadManifest();
			result.manifestMissing = !manifest;
			
			const L = await this.fetchLocalWords();
			const C = await this.fetchCloudWords();
			const diff = diffSyncSets(manifest?.syncedWords || [], L, new Set(C.keys()));
			Object.assign(result, diff);

		} catch (error) {
			result.errors.push(error instanceof Error ? error.message : 'Unknown error');
		}

		return result;
	}

	async refreshManifestBaseline(): Promise<void> {
		const cloudWords = await this.fetchCloudWords();
		await this.saveManifest(Array.from(cloudWords.keys()));
	}

	async executeSync(
		dryRunResult: SyncDryRunResult,
		progressCallback?: (current: number, total: number, word: string) => void,
		abortSignal?: { aborted: boolean }
	): Promise<SyncResult> {
		if (this.isSyncing) {
			return {
				success: false,
				aborted: false,
				stats: { uploaded: 0, downloaded: 0, deletedFromCloud: 0, trashedLocally: 0, failed: 0 },
				errors: ['同步正在进行中，请稍后再试'],
			};
		}

		this.isSyncing = true;

		const stats = {
			uploaded: 0,
			downloaded: 0,
			deletedFromCloud: 0,
			trashedLocally: 0,
			failed: 0,
		};

		const errors: string[] = [...dryRunResult.errors];

		const allOps: { type: SyncOperationType; word: string }[] = [
			...dryRunResult.localDeleted.map(w => ({ type: 'delete_cloud' as const, word: w })),
			...dryRunResult.cloudAdded.map(w => ({ type: 'download' as const, word: w })),
			...dryRunResult.localAdded.map(w => ({ type: 'upload' as const, word: w })),
			...dryRunResult.cloudDeleted.map(w => ({ type: 'trash_local' as const, word: w })),
		];

		const total = allOps.length;
		let current = 0;

		try {
			const manifest = await this.loadManifest();
			const nextManifestWords = new Set((manifest?.syncedWords || []).map(word => word.toLowerCase()));

			for (const op of allOps) {
				if (abortSignal?.aborted) break;

				current++;
				progressCallback?.(current, total, op.word);

				try {
					switch (op.type) {
						case 'delete_cloud':
							await this.deleteFromCloud(op.word);
							stats.deletedFromCloud++;
							break;

						case 'download':
							await this.downloadWord(op.word);
							stats.downloaded++;
							break;

						case 'upload':
							await this.uploadToCloud(op.word);
							stats.uploaded++;
							break;

						case 'trash_local':
							await this.trashLocalFile(op.word);
							stats.trashedLocally++;
							break;
					}
					updateManifestAfterSuccessfulOperation(nextManifestWords, op.type, op.word);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					console.error(`[LexiBridge] ${op.type} "${op.word}" failed:`, msg);
					errors.push(`${op.type} "${op.word}": ${msg}`);
					stats.failed++;
				}
			}

			if (!abortSignal?.aborted) {
				await this.saveManifest(Array.from(nextManifestWords));
			}

		} catch (error) {
			errors.push(error instanceof Error ? error.message : 'Unknown error');
		} finally {
			this.isSyncing = false;
		}

		return {
			success: !abortSignal?.aborted && errors.length === 0,
			aborted: abortSignal?.aborted || false,
			stats,
			errors,
		};
	}

	private async deleteFromCloud(word: string): Promise<void> {
		const categoryIds = this.settings.syncCategoryIds.length > 0
			? this.settings.syncCategoryIds
			: [this.settings.defaultUploadCategoryId || '0'];

		for (const categoryId of categoryIds) {
			await withTimeout(
				this.eudicService.deleteWords(categoryId, [word]),
				API_TIMEOUT_MS,
				`deleteWords(${word})`
			);
		}
	}

	private async uploadToCloud(word: string): Promise<void> {
		const file = this.getLocalFileByWord(word);

		const frontmatterCategoryIds: string[] = [];

		if (file) {
			const cache = this.app.metadataCache.getFileCache(file);
			const eudicLists = cache?.frontmatter?.eudic_lists as string[] | undefined;

			if (Array.isArray(eudicLists) && eudicLists.length > 0) {
				await this.loadCategoryMapping();
				
				for (const listName of eudicLists) {
					for (const [id, name] of this.categoryIdToName) {
						if (name === listName) {
							frontmatterCategoryIds.push(id);
						}
					}
				}
			}
		}

		const targetCategoryIds = getEffectiveUploadCategoryIds(
			this.settings.syncCategoryIds,
			this.settings.defaultUploadCategoryId,
			frontmatterCategoryIds
		);
		for (const categoryId of targetCategoryIds) {
			await withTimeout(
				this.eudicService.addWords(categoryId, [word]),
				API_TIMEOUT_MS,
				`addWords(${word}, ${categoryId})`
			);
		}
	}

	private async downloadWord(word: string): Promise<void> {
		const folderPath = this.settings.folderPath;
		const validFilename = getValidFilename(word);
		const filePath = `${folderPath}/${validFilename}.md`;

		const wordData = this.cloudWordsWithCategories.get(word);
		const exp = wordData?.exp || '';
		const categories = wordData?.categories || [];
		const originalWord = wordData?.originalWord || word;

		if (await this.app.vault.adapter.exists(filePath)) {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				const existingContent = await this.app.vault.read(file);
				const generatedContent = this.generateMarkdown(originalWord, exp, categories);
				await this.app.vault.modify(file, MarkdownGenerator.mergeWithExisting(existingContent, generatedContent));
				return;
			}
			throw new Error(`目标路径不是 Markdown 文件：${filePath}`);
		}

		await this.ensureFolder(folderPath);

		const content = this.generateMarkdown(originalWord, exp, categories);
		await withTimeout(
			this.app.vault.create(filePath, content),
			FILE_TIMEOUT_MS,
			`create(${word})`
		);
	}

	private async trashLocalFile(word: string): Promise<void> {
		const file = this.getLocalFileByWord(word);

		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		} else {
			throw new Error(`找不到需要移入回收站的本地词条：${word}`);
		}
	}

	private generateMarkdown(originalWord: string, exp: string, categories: string[]): string {
		const entry: DictEntry = {
			word: originalWord,
			ph_uk: '',
			ph_us: '',
			audio_uk: '',
			audio_us: '',
			definitions: parseEudicExpDefinitions(exp),
			tags: categories,
			exchange: [],
		};

		const content = MarkdownGenerator.generate(originalWord, entry, {
			dictSource: 'eudic',
			frontmatterTemplate: this.settings.frontmatterTemplate,
			bodyTemplate: this.settings.bodyTemplate,
			includeExamProperties: this.settings.includeExamProperties,
			includePosProperties: this.settings.includePosProperties,
			eudicLists: categories,
		});

		return `${content.trimEnd()}\n\n> [!info] 欧路同步\n> [🔄 点击从在线词典更新释义](obsidian://lexibridge?cmd=update&word=${encodeURIComponent(originalWord)})\n`;
	}

	private async ensureFolder(path: string): Promise<void> {
		if (!await this.app.vault.adapter.exists(path)) {
			await this.app.vault.createFolder(path);
		}
	}

	async handleFileDeleted(file: TFile): Promise<void> {
		if (this.isSyncing) return;
		if (file.extension !== 'md') return;
		if (!file.path.startsWith(`${this.settings.folderPath}/`)) return;

		console.debug(`[LexiBridge] Local file deleted, preserving manifest until next sync: ${file.path}`);
	}
}
