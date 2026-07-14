import {App, Notice, TAbstractFile, TFile, TFolder} from 'obsidian';
import {EudicCategory, EudicService, EudicWord} from './eudic';
import {LexiBridgeSettings} from './settings';
import {DictEntry} from './types';
import {MarkdownGenerator} from './utils/markdown-generator';
import {getMarkdownFilesRecursively} from './utils/vault-files';
import {
	diffSyncSets,
	getSyncDeletionSafetyError,
	getValidFilename,
	parseEudicExpDefinitions,
	SyncOperationType,
	withTimeout,
} from './utils/sync';

const MANIFEST_KEY = 'syncManifest';
const HISTORY_KEY = 'syncHistory';
const API_TIMEOUT_MS = 30000;
const FILE_TIMEOUT_MS = 10000;
const MAX_CLOUD_PAGES_PER_CATEGORY = 51;
const CLOUD_UPLOAD_BATCH_SIZE = 100;
const CLOUD_DELETE_BATCH_SIZE = 100;
const HISTORY_LIMIT = 200;
const FILE_CACHE_LIMIT = 1000;
const FILE_CACHE_BATCH_SIZE = 25;

export interface SyncCategoryState {
	name: string;
	folderName: string;
	syncedWords: string[];
}

export interface SyncManifest {
	version: 2;
	lastSyncTime: number;
	categories: Record<string, SyncCategoryState>;
	// Kept for readers migrating data written before 0.3.17.
	syncedWords?: string[];
	categoryIds?: string[];
}

export interface SyncOperation {
	type: SyncOperationType;
	categoryId: string;
	categoryName: string;
	folderName: string;
	word: string;
}

export interface SyncDryRunResult {
	localAdded: string[];
	cloudAdded: string[];
	localDeleted: string[];
	cloudDeleted: string[];
	errors: string[];
	manifestMissing: boolean;
	resetManifest?: boolean;
	operations?: SyncOperation[];
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

export interface SyncHistoryEntry {
	id: string;
	timestamp: number;
	type: 'local-add' | 'local-delete' | 'cloud-add' | 'cloud-delete' | 'restore';
	word: string;
	path: string;
	categoryId?: string;
	content?: string;
	undone?: boolean;
}

interface CloudWordData {
	exp: string;
	categories: string[];
	originalWord: string;
}

interface CategoryContext {
	id: string;
	name: string;
	folderName: string;
	cloudWords: Map<string, EudicWord>;
	localFiles: Map<string, TFile>;
	manifestWords: Set<string>;
}

export class SyncService {
	private isSyncing = false;
	private internalMutation = false;
	private categoryIdToName = new Map<string, string>();
	private categoryContexts = new Map<string, CategoryContext>();
	private cloudWordsWithCategories = new Map<string, CloudWordData>();
	private localWordToFile = new Map<string, TFile>();
	private fileContentCache = new Map<string, string>();
	private dataWriteQueue: Promise<void> = Promise.resolve();
	private pendingDeleteEntryIds: string[] = [];
	private deleteNoticeTimer: number | null = null;

	constructor(
		private app: App,
		private settings: LexiBridgeSettings,
		private eudicService: EudicService,
		private loadData: () => Promise<unknown>,
		private saveData: (data: unknown) => Promise<void>
	) {
		void this.primeFileContentCache();
	}

	isSyncInProgress(): boolean {
		return this.isSyncing;
	}

	private getSyncCategoryIds(): string[] {
		return [...new Set(this.settings.syncCategoryIds.length > 0
			? this.settings.syncCategoryIds
			: [this.settings.defaultUploadCategoryId || '0'])].sort();
	}

	private async readData(): Promise<Record<string, unknown>> {
		const loaded = await this.loadData();
		return loaded && typeof loaded === 'object' ? loaded as Record<string, unknown> : {};
	}

	private async loadManifest(): Promise<SyncManifest | null> {
		const data = await this.readData();
		const raw = data[MANIFEST_KEY];
		if (!raw || typeof raw !== 'object') return null;
		const candidate = raw as Partial<SyncManifest>;
		if (candidate.version === 2 && candidate.categories && typeof candidate.categories === 'object') {
			const categories: Record<string, SyncCategoryState> = {};
			for (const [id, value] of Object.entries(candidate.categories)) {
				if (!value || typeof value !== 'object') continue;
				const state = value as Partial<SyncCategoryState>;
				if (typeof state.name !== 'string' || typeof state.folderName !== 'string') continue;
				categories[id] = {
					name: state.name,
					folderName: state.folderName,
					syncedWords: normalizeWords(state.syncedWords),
				};
			}
			return {version: 2, lastSyncTime: candidate.lastSyncTime || 0, categories};
		}
		return null;
	}

	private async writeManifest(manifest: SyncManifest): Promise<void> {
		await this.enqueueDataWrite(async () => {
			const data = await this.readData();
			await this.saveData({...data, [MANIFEST_KEY]: manifest});
		});
	}

	private async saveContextsAsManifest(base?: SyncManifest | null): Promise<void> {
		const categories: Record<string, SyncCategoryState> = {...(base?.categories || {})};
		for (const context of this.categoryContexts.values()) {
			categories[context.id] = {
				name: context.name,
				folderName: context.folderName,
				syncedWords: [...context.manifestWords].sort(),
			};
		}
		await this.writeManifest({version: 2, lastSyncTime: Date.now(), categories});
	}

	private async loadSelectedCategories(): Promise<EudicCategory[]> {
		const selected = new Set(this.getSyncCategoryIds());
		const categories = await withTimeout(
			this.eudicService.getCategories('en'),
			API_TIMEOUT_MS,
			'getCategories'
		);
		this.categoryIdToName = new Map(categories.map(category => [category.id, category.name]));
		return categories.filter(category => selected.has(category.id));
	}

	private allocateFolderNames(categories: EudicCategory[]): Map<string, string> {
		const result = new Map<string, string>();
		const used = new Set<string>();
		for (const category of categories) {
			const base = getValidFolderName(category.name) || `生词本-${category.id}`;
			let name = base;
			let suffix = 2;
			while (used.has(name.toLowerCase())) name = `${base} (${suffix++})`;
			used.add(name.toLowerCase());
			result.set(category.id, name);
		}
		return result;
	}

	private async reconcileCategoryFolders(categories: EudicCategory[], manifest: SyncManifest | null): Promise<Map<string, string>> {
		await this.ensureFolder(this.settings.folderPath);
		const allocated = this.allocateFolderNames(categories);
		for (const category of categories) {
			const desiredName = allocated.get(category.id)!;
			const previous = manifest?.categories[category.id];
			const previousPath = previous ? `${this.settings.folderPath}/${previous.folderName}` : '';
			const desiredPath = `${this.settings.folderPath}/${desiredName}`;
			if (previousPath && previousPath !== desiredPath) {
				const oldFolder = this.app.vault.getAbstractFileByPath(previousPath);
				if (oldFolder instanceof TFolder && !this.app.vault.getAbstractFileByPath(desiredPath)) {
					await this.withInternalMutation(() => this.app.fileManager.renameFile(oldFolder, desiredPath));
				}
			}
			await this.ensureFolder(desiredPath);
		}
		await this.migrateRootWordFiles(categories, allocated);
		return allocated;
	}

	private async migrateRootWordFiles(categories: EudicCategory[], folderNames: Map<string, string>): Promise<void> {
		const root = this.app.vault.getAbstractFileByPath(this.settings.folderPath);
		if (!(root instanceof TFolder)) return;
		const byName = new Map(categories.map(category => [category.name, category.id]));
		const fallback = this.settings.defaultUploadCategoryId || categories[0]?.id;
		if (!fallback) return;
		for (const child of [...root.children]) {
			if (!(child instanceof TFile) || child.extension !== 'md') continue;
			const frontmatter = this.app.metadataCache.getFileCache(child)?.frontmatter as Record<string, unknown> | undefined;
			const lists = frontmatter?.eudic_lists;
			const preferred = Array.isArray(lists)
				? lists.map(value => typeof value === 'string' ? byName.get(value) : undefined).find(Boolean)
				: undefined;
			const categoryId = preferred || fallback;
			const folderName = folderNames.get(categoryId);
			if (!folderName) continue;
			const targetPath = `${this.settings.folderPath}/${folderName}/${child.name}`;
			if (!this.app.vault.getAbstractFileByPath(targetPath)) {
				await this.withInternalMutation(() => this.app.fileManager.renameFile(child, targetPath));
			}
		}
	}

	private async fetchCategoryWords(category: EudicCategory): Promise<Map<string, EudicWord>> {
		const words = new Map<string, EudicWord>();
		let previousSignature = '';
		for (let page = 0; page < MAX_CLOUD_PAGES_PER_CATEGORY; page += 1) {
			const batch = await withTimeout(
				this.eudicService.getWords(category.id, 'en', page, 100),
				API_TIMEOUT_MS,
				`getWords ${category.name} page ${page}`
			);
			if (batch.length === 0) return words;
			const signature = batch.map(item => item.word?.trim().toLowerCase() || '').join('\u0000');
			if (page > 0 && signature === previousSignature) throw new Error(`生词本“${category.name}”返回了重复分页`);
			previousSignature = signature;
			for (const item of batch) {
				const word = item.word?.trim();
				if (word) words.set(word.toLowerCase(), {...item, word});
			}
			if (batch.length < 100) return words;
		}
		throw new Error(`生词本“${category.name}”分页超过安全上限`);
	}

	private scanLocalFolder(folderName: string): Map<string, TFile> {
		const files = new Map<string, TFile>();
		const folder = this.app.vault.getAbstractFileByPath(`${this.settings.folderPath}/${folderName}`);
		if (!(folder instanceof TFolder)) return files;
		for (const child of getMarkdownFilesRecursively(folder)) {
			const frontmatter = this.app.metadataCache.getFileCache(child)?.frontmatter as Record<string, unknown> | undefined;
			const tags = frontmatter?.tags;
			if (Array.isArray(tags) && (tags.includes('lexibridge/cloud-deleted') || tags.includes('eudicbridge/cloud-deleted'))) continue;
			const word = (typeof frontmatter?.word === 'string' ? frontmatter.word : child.basename).trim().toLowerCase();
			if (word) files.set(word, child);
		}
		return files;
	}

	async dryRun(): Promise<SyncDryRunResult> {
		const result: SyncDryRunResult = {
			localAdded: [], cloudAdded: [], localDeleted: [], cloudDeleted: [],
			errors: [], manifestMissing: false, resetManifest: false, operations: [],
		};
		try {
			const manifest = await this.loadManifest();
			const categories = await this.loadSelectedCategories();
			if (categories.length === 0) throw new Error('未找到设置中选择的欧路生词本，请重新加载生词本列表');
			result.manifestMissing = !manifest;
			result.resetManifest = !manifest;
			const folderNames = await this.reconcileCategoryFolders(categories, manifest);
			const cloudMaps = await Promise.all(categories.map(category => this.fetchCategoryWords(category)));
			this.categoryContexts.clear();
			this.cloudWordsWithCategories.clear();
			this.localWordToFile.clear();

			for (let index = 0; index < categories.length; index += 1) {
				const category = categories[index]!;
				const folderName = folderNames.get(category.id)!;
				const cloudWords = cloudMaps[index]!;
				const localFiles = this.scanLocalFolder(folderName);
				const storedBaseline = manifest?.categories[category.id]?.syncedWords;
				const baseline = storedBaseline || [...localFiles.keys()].filter(word => cloudWords.has(word));
				const context: CategoryContext = {
					id: category.id, name: category.name, folderName, cloudWords, localFiles,
					manifestWords: new Set(baseline),
				};
				this.categoryContexts.set(category.id, context);
				for (const [word, file] of localFiles) this.localWordToFile.set(word, file);
				for (const [word, item] of cloudWords) {
					const existing = this.cloudWordsWithCategories.get(word);
					if (existing) existing.categories.push(category.name);
					else this.cloudWordsWithCategories.set(word, {exp: item.exp || '', categories: [category.name], originalWord: item.word});
				}
				const diff = diffSyncSets(baseline, new Set(localFiles.keys()), new Set(cloudWords.keys()));
				for (const type of ['localAdded', 'cloudAdded', 'localDeleted', 'cloudDeleted'] as const) {
					result[type].push(...diff[type]);
				}
				result.operations!.push(
					...diff.localDeleted.map(word => this.makeOperation('delete_cloud', context, word)),
					...diff.cloudAdded.map(word => this.makeOperation('download', context, word)),
					...diff.localAdded.map(word => this.makeOperation('upload', context, word)),
					...diff.cloudDeleted.map(word => this.makeOperation('trash_local', context, word)),
				);
			}
			const safetyError = getSyncDeletionSafetyError(result, this.settings.syncDeletionProtection, this.settings.syncMaxDeletionCount);
			if (safetyError) result.errors.push(safetyError);
		} catch (error) {
			result.errors.push(error instanceof Error ? error.message : String(error));
		}
		return result;
	}

	private makeOperation(type: SyncOperationType, context: CategoryContext, word: string): SyncOperation {
		return {type, categoryId: context.id, categoryName: context.name, folderName: context.folderName, word};
	}

	async refreshManifestBaseline(): Promise<void> {
		if (this.categoryContexts.size === 0) await this.dryRun();
		await this.saveContextsAsManifest();
	}

	async executeSync(
		dryRunResult: SyncDryRunResult,
		progressCallback?: (current: number, total: number, word: string) => void,
		abortSignal?: {aborted: boolean}
	): Promise<SyncResult> {
		const stats = {uploaded: 0, downloaded: 0, deletedFromCloud: 0, trashedLocally: 0, failed: 0};
		if (dryRunResult.errors.length > 0 || this.isSyncing) {
			return {success: false, aborted: false, stats, errors: dryRunResult.errors.length ? [...dryRunResult.errors] : ['同步正在进行中']};
		}
		this.isSyncing = true;
		const errors: string[] = [];
		const operations = dryRunResult.operations?.length
			? dryRunResult.operations
			: this.createLegacyOperations(dryRunResult);
		let current = 0;
		let successfulSinceCheckpoint = 0;
		const pendingHistory: Array<Omit<SyncHistoryEntry, 'id' | 'timestamp'>> = [];
		try {
			for (const type of ['delete_cloud', 'upload'] as const) {
				const batchSize = type === 'upload' ? CLOUD_UPLOAD_BATCH_SIZE : CLOUD_DELETE_BATCH_SIZE;
				const grouped = groupOperations(operations.filter(operation => operation.type === type));
				for (const group of grouped) {
					for (let offset = 0; offset < group.operations.length; offset += batchSize) {
						if (abortSignal?.aborted) break;
						const batch = group.operations.slice(offset, offset + batchSize);
						progressCallback?.(current + 1, operations.length, batch[0]?.word || '');
						try {
							const words = batch.map(operation => operation.word);
							if (type === 'upload') await withTimeout(this.eudicService.addWords(group.categoryId, words), API_TIMEOUT_MS, `addWords ${group.categoryId}`);
							else await withTimeout(this.eudicService.deleteWords(group.categoryId, words), API_TIMEOUT_MS, `deleteWords ${group.categoryId}`);
							for (const operation of batch) this.applySuccessfulOperation(operation);
							successfulSinceCheckpoint += batch.length;
							if (type === 'upload') stats.uploaded += batch.length;
							else stats.deletedFromCloud += batch.length;
							current += batch.length;
							progressCallback?.(current, operations.length, batch[batch.length - 1]?.word || '');
							if (successfulSinceCheckpoint >= 100) {
								await this.saveContextsAsManifest(await this.loadManifest());
								successfulSinceCheckpoint = 0;
							}
						} catch (error) {
							stats.failed += batch.length;
							errors.push(`${type} ${batch[0]?.categoryName}: ${error instanceof Error ? error.message : String(error)}`);
							current += batch.length;
						}
					}
				}
			}

			for (const operation of operations.filter(item => item.type === 'download' || item.type === 'trash_local')) {
				if (abortSignal?.aborted) break;
				progressCallback?.(++current, operations.length, operation.word);
				try {
					if (operation.type === 'download') {
						await this.downloadWord(operation);
						stats.downloaded += 1;
					} else {
						pendingHistory.push(await this.trashLocalFile(operation));
						stats.trashedLocally += 1;
					}
					this.applySuccessfulOperation(operation);
					successfulSinceCheckpoint += 1;
					if (successfulSinceCheckpoint >= 100) {
						await this.saveContextsAsManifest(await this.loadManifest());
						successfulSinceCheckpoint = 0;
					}
				} catch (error) {
					stats.failed += 1;
					errors.push(`${operation.type} “${operation.word}”: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (pendingHistory.length > 0) await this.appendHistoryBatch(pendingHistory);
			await this.saveContextsAsManifest(await this.loadManifest());
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		} finally {
			this.isSyncing = false;
		}
		return {success: !abortSignal?.aborted && errors.length === 0, aborted: abortSignal?.aborted || false, stats, errors};
	}

	private createLegacyOperations(result: SyncDryRunResult): SyncOperation[] {
		const categoryId = this.getSyncCategoryIds()[0] || '0';
		const categoryName = this.categoryIdToName.get(categoryId) || categoryId;
		const folderName = getValidFolderName(categoryName);
		return [
			...result.localDeleted.map(word => ({type: 'delete_cloud' as const, categoryId, categoryName, folderName, word})),
			...result.cloudAdded.map(word => ({type: 'download' as const, categoryId, categoryName, folderName, word})),
			...result.localAdded.map(word => ({type: 'upload' as const, categoryId, categoryName, folderName, word})),
			...result.cloudDeleted.map(word => ({type: 'trash_local' as const, categoryId, categoryName, folderName, word})),
		];
	}

	private applySuccessfulOperation(operation: SyncOperation): void {
		const context = this.categoryContexts.get(operation.categoryId);
		if (!context) return;
		if (operation.type === 'upload') context.cloudWords.set(operation.word, {word: operation.word, exp: ''});
		else if (operation.type === 'delete_cloud') context.cloudWords.delete(operation.word);
		else if (operation.type === 'trash_local') context.localFiles.delete(operation.word);
		if (operation.type === 'download' || operation.type === 'upload') context.manifestWords.add(operation.word);
		else context.manifestWords.delete(operation.word);
	}

	private async downloadWord(operation: SyncOperation): Promise<void> {
		const context = this.categoryContexts.get(operation.categoryId);
		const item = context?.cloudWords.get(operation.word);
		const originalWord = item?.word || operation.word;
		const path = `${this.settings.folderPath}/${operation.folderName}/${getValidFilename(originalWord)}.md`;
		const content = this.generateMarkdown(originalWord, item?.exp || '', [operation.categoryName]);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.withInternalMutation(() => this.app.vault.process(existing, current =>
				MarkdownGenerator.mergeWithExisting(current, content, this.settings.protectedHeadings)));
			context?.localFiles.set(operation.word, existing);
			return;
		}
		await this.ensureFolder(`${this.settings.folderPath}/${operation.folderName}`);
		const created = await withTimeout(
			this.withInternalMutation(() => this.app.vault.create(path, content)),
			FILE_TIMEOUT_MS,
			`create ${operation.word}`
		);
		context?.localFiles.set(operation.word, created);
	}

	private async trashLocalFile(operation: SyncOperation): Promise<Omit<SyncHistoryEntry, 'id' | 'timestamp'>> {
		const context = this.categoryContexts.get(operation.categoryId);
		const file = context?.localFiles.get(operation.word)
			|| this.app.vault.getAbstractFileByPath(`${this.settings.folderPath}/${operation.folderName}/${getValidFilename(operation.word)}.md`);
		if (!(file instanceof TFile)) throw new Error('找不到本地词条');
		const content = await this.app.vault.read(file);
		await this.withInternalMutation(() => this.app.fileManager.trashFile(file));
		return {type: 'cloud-delete', word: operation.word, path: file.path, categoryId: operation.categoryId, content};
	}

	private generateMarkdown(word: string, exp: string, categories: string[]): string {
		const entry: DictEntry = {
			word, ph_uk: '', ph_us: '', audio_uk: '', audio_us: '',
			definitions: parseEudicExpDefinitions(exp), tags: categories, exchange: [],
		};
		const content = MarkdownGenerator.generate(word, entry, {
			dictSource: 'eudic',
			frontmatterTemplate: this.settings.frontmatterTemplate,
			bodyTemplate: this.settings.bodyTemplate,
			includeExamProperties: this.settings.includeExamProperties,
			includePosProperties: this.settings.includePosProperties,
			eudicLists: categories,
		});
		return `${content.trimEnd()}\n\n> [!info] 欧路同步\n> [从 ECDICT 本地更新](obsidian://lexibridge?cmd=update&word=${encodeURIComponent(word)}) · [使用有道在线增强](obsidian://lexibridge?cmd=enhance&word=${encodeURIComponent(word)})\n`;
	}

	private async ensureFolder(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (!existing) {
			await this.withInternalMutation(() => this.app.vault.createFolder(path));
		} else if (!(existing instanceof TFolder)) {
			throw new Error(`同步文件夹路径已被文件占用：${path}`);
		}
	}

	private async withInternalMutation<T>(operation: () => Promise<T>): Promise<T> {
		this.internalMutation = true;
		try {
			return await operation();
		} finally {
			this.internalMutation = false;
		}
	}

	async handleFileCreated(file: TFile): Promise<void> {
		if (this.internalMutation || this.isSyncing || !this.isWordFile(file.path)) return;
		const content = await this.app.vault.read(file).catch(() => '');
		this.fileContentCache.set(file.path, content);
		await this.appendHistory({type: 'local-add', word: file.basename, path: file.path});
	}

	async handleFileModified(file: TFile): Promise<void> {
		if (!this.isWordFile(file.path)) return;
		const content = await this.app.vault.read(file).catch(() => '');
		if (content) this.fileContentCache.set(file.path, content);
	}

	async handleFileDeleted(file: TFile): Promise<void> {
		if (this.internalMutation || this.isSyncing || !this.isWordFile(file.path)) return;
		const manifest = await this.loadManifest();
		const category = this.findCategoryForPath(file.path, manifest);
		const entry = await this.appendHistory({
			type: 'local-delete', word: file.basename, path: file.path,
			categoryId: category?.id, content: this.fileContentCache.get(file.path),
		});
		this.fileContentCache.delete(file.path);
		this.pendingDeleteEntryIds.push(entry.id);
		if (this.deleteNoticeTimer !== null) window.clearTimeout(this.deleteNoticeTimer);
		this.deleteNoticeTimer = window.setTimeout(() => this.showDeleteNotice(), 350);
	}

	private showDeleteNotice(): void {
		this.deleteNoticeTimer = null;
		const ids = this.pendingDeleteEntryIds.splice(0);
		if (ids.length === 0) return;
		const notice = new Notice('', 12000);
		notice.messageEl.empty();
		notice.messageEl.createSpan({text: `已删除 ${ids.length} 个单词文件；下次同步会从对应欧路生词本一并删除。`});
		const button = notice.messageEl.createEl('button', {text: '撤销'});
		button.addEventListener('click', () => {
			void (async () => {
				let restored = 0;
				for (const id of [...ids].reverse()) {
					if (await this.undoHistoryEntry(id)) restored += 1;
				}
				notice.hide();
				new Notice(restored > 0 ? `已恢复 ${restored} 个单词文件` : '无法恢复：没有可用的文件快照');
			})();
		});
	}

	async handleFileRenamed(file: TAbstractFile, oldPath: string): Promise<void> {
		if (this.internalMutation || this.isSyncing || !(file instanceof TFolder)) return;
		const root = this.settings.folderPath.replace(/\/$/, '');
		if (!oldPath.startsWith(`${root}/`) || oldPath.slice(root.length + 1).includes('/')) return;
		if (!file.path.startsWith(`${root}/`) || file.path.slice(root.length + 1).includes('/')) return;
		const manifest = await this.loadManifest();
		const oldName = oldPath.slice(root.length + 1);
		const state = Object.entries(manifest?.categories || {}).find(([, value]) => value.folderName === oldName);
		if (!state) return;
		const [categoryId] = state;
		const newName = file.name.trim();
		if (!newName) return;
		try {
			await this.eudicService.renameCategory(categoryId, newName, 'en');
			if (manifest) {
				manifest.categories[categoryId] = {...manifest.categories[categoryId]!, name: newName, folderName: newName};
				await this.writeManifest(manifest);
			}
			new Notice(`已将欧路生词本重命名为“${newName}”`);
		} catch (error) {
			new Notice(`欧路生词本重命名失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async getHistory(): Promise<SyncHistoryEntry[]> {
		const data = await this.readData();
		return Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] as SyncHistoryEntry[] : [];
	}

	async undoLastDeletion(): Promise<boolean> {
		const history = await this.getHistory();
		const entry = [...history].reverse().find(item =>
			(item.type === 'local-delete' || item.type === 'cloud-delete') && !item.undone);
		return entry ? this.undoHistoryEntry(entry.id) : false;
	}

	async undoDeletion(id: string): Promise<boolean> {
		return this.undoHistoryEntry(id);
	}

	private async undoHistoryEntry(id: string): Promise<boolean> {
		await this.dataWriteQueue.catch(() => undefined);
		const data = await this.readData();
		const history = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] as SyncHistoryEntry[] : [];
		const entry = history.find(item => item.id === id);
		if (!entry || entry.undone) return false;
		const content = typeof entry.content === 'string'
			? entry.content
			: await this.rebuildDeletedWord(entry);
		if (!content) return false;
		await this.ensureFolder(entry.path.split('/').slice(0, -1).join('/'));
		if (!this.app.vault.getAbstractFileByPath(entry.path)) {
			await this.withInternalMutation(() => this.app.vault.create(entry.path, content));
		}
		await this.enqueueDataWrite(async () => {
			const latestData = await this.readData();
			const latestHistory = Array.isArray(latestData[HISTORY_KEY]) ? latestData[HISTORY_KEY] as SyncHistoryEntry[] : [];
			const latestEntry = latestHistory.find(item => item.id === id);
			if (latestEntry) latestEntry.undone = true;
			latestHistory.push({id: createId(), timestamp: Date.now(), type: 'restore', word: entry.word, path: entry.path, categoryId: entry.categoryId});
			await this.saveData({...latestData, [HISTORY_KEY]: latestHistory.slice(-HISTORY_LIMIT)});
		});
		return true;
	}

	private async rebuildDeletedWord(entry: SyncHistoryEntry): Promise<string | null> {
		if (!entry.categoryId) return null;
		const manifest = await this.loadManifest();
		const state = manifest?.categories[entry.categoryId];
		if (!state) return null;
		const cloudWords = await this.fetchCategoryWords({id: entry.categoryId, name: state.name, language: 'en'});
		const cloudWord = cloudWords.get(entry.word.toLowerCase());
		return cloudWord ? this.generateMarkdown(cloudWord.word, cloudWord.exp || '', [state.name]) : null;
	}

	private async appendHistory(entry: Omit<SyncHistoryEntry, 'id' | 'timestamp'>): Promise<SyncHistoryEntry> {
		const complete = {id: createId(), timestamp: Date.now(), ...entry};
		await this.enqueueDataWrite(async () => {
			const data = await this.readData();
			const history = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] as SyncHistoryEntry[] : [];
			await this.saveData({...data, [HISTORY_KEY]: [...history, complete].slice(-HISTORY_LIMIT)});
		});
		return complete;
	}

	private async appendHistoryBatch(entries: Array<Omit<SyncHistoryEntry, 'id' | 'timestamp'>>): Promise<void> {
		if (entries.length === 0) return;
		await this.enqueueDataWrite(async () => {
			const data = await this.readData();
			const history = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] as SyncHistoryEntry[] : [];
			const timestamp = Date.now();
			const complete = entries.map((entry, index) => ({id: createId(), timestamp: timestamp + index, ...entry}));
			await this.saveData({...data, [HISTORY_KEY]: [...history, ...complete].slice(-HISTORY_LIMIT)});
		});
	}

	private async enqueueDataWrite(operation: () => Promise<void>): Promise<void> {
		const next = this.dataWriteQueue.catch(() => undefined).then(operation);
		this.dataWriteQueue = next;
		await next;
	}

	private async primeFileContentCache(): Promise<void> {
		const root = this.app.vault.getAbstractFileByPath(this.settings.folderPath);
		if (!(root instanceof TFolder)) return;
		const pending: TAbstractFile[] = [...root.children];
		const files: TFile[] = [];
		while (pending.length > 0) {
			const item = pending.pop();
			if (item instanceof TFolder) pending.push(...item.children);
			else if (item instanceof TFile && item.extension === 'md') files.push(item);
		}
		files.sort((left, right) => right.stat.mtime - left.stat.mtime);
		const selected = files.slice(0, FILE_CACHE_LIMIT);
		for (let offset = 0; offset < selected.length; offset += FILE_CACHE_BATCH_SIZE) {
			const batch = selected.slice(offset, offset + FILE_CACHE_BATCH_SIZE);
			const contents = await Promise.all(batch.map(file => this.app.vault.read(file).catch(() => '')));
			batch.forEach((file, index) => {
				const content = contents[index];
				if (content) this.fileContentCache.set(file.path, content);
			});
			await new Promise<void>(resolve => window.setTimeout(resolve, 0));
		}
	}

	private findCategoryForPath(path: string, manifest: SyncManifest | null): {id: string; state: SyncCategoryState} | null {
		for (const [id, state] of Object.entries(manifest?.categories || {})) {
			if (path.startsWith(`${this.settings.folderPath}/${state.folderName}/`)) return {id, state};
		}
		return null;
	}

	private isWordFile(path: string): boolean {
		return path.endsWith('.md') && path.startsWith(`${this.settings.folderPath.replace(/\/$/, '')}/`);
	}
}

function normalizeWords(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim().toLowerCase()).filter(Boolean))].sort()
		: [];
}

function getValidFolderName(name: string): string {
	return name.trim().replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+|\.+$/g, '').trim() || '未命名生词本';
}

function groupOperations(operations: SyncOperation[]): Array<{categoryId: string; operations: SyncOperation[]}> {
	const groups = new Map<string, SyncOperation[]>();
	for (const operation of operations) {
		const group = groups.get(operation.categoryId) || [];
		group.push(operation);
		groups.set(operation.categoryId, group);
	}
	return [...groups].map(([categoryId, items]) => ({categoryId, operations: items}));
}

function createId(): string {
	return window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
