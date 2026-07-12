import {Editor, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf} from 'obsidian';
import {LexiBridgeSettings, LexiBridgeSettingTab} from "./settings";
import {DictionaryView} from "./view";
import {DictEntry} from "./types";
import {EudicService} from "./eudic";
import {SyncService} from "./sync";
import {AutoLinkService} from "./auto-link";
import {BatchUpdateService} from "./batch-update";
import {ProgressNoticeWidget} from "./modal";
import {normalizeSettings} from "./settings-data";
import {isValidWord, sanitizeWord} from "./utils/word";
import {getEffectiveUploadCategoryIds} from "./utils/sync";
import {registerPluginCommands, registerPluginMenus} from "./plugin-registrations";
import {WordNoteService} from "./word-note-service";
import {DictionaryLookupResult, DictionaryProviderId, DictionaryService} from './dictionary-provider';
import {EcdictDatabase, EcdictInstallation} from './ecdict-database';
import {
	EcdictDownloadSourceId,
	EcdictManager,
	EcdictProgress,
	EcdictProvider,
	EcdictStatus,
} from './ecdict';
import {YoudaoProvider} from './youdao-provider';

export const VIEW_TYPE_LEXIBRIDGE = 'lexibridge-view';

export default class LexiBridgePlugin extends Plugin {
	settings!: LexiBridgeSettings;
	private eudicService: EudicService | null = null;
	private syncService: SyncService | null = null;
	private autoLinkService: AutoLinkService | null = null;
	private batchUpdateService: BatchUpdateService | null = null;
	private wordNoteService: WordNoteService | null = null;
	private dictionaryService: DictionaryService | null = null;
	private readonly ecdictDatabase = new EcdictDatabase();
	private readonly ecdictManager = new EcdictManager(this.ecdictDatabase);
	private syncTimer: number | null = null;
	private syncTimerRegistered: boolean = false;
	private startupSyncTimeout: number | null = null;
	private syncRibbonIcon: HTMLElement | null = null;
	private batchRibbonIcon: HTMLElement | null = null;
	private autoLinkRibbonIcon: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();
		this.initDictionaryServices();

		this.registerView(VIEW_TYPE_LEXIBRIDGE, (leaf) => new DictionaryView(leaf, this));

		this.addRibbonIcon('book-open', '打开词典视图', () => {
			void this.activateView();
		});

		this.autoLinkService = this.ensureAutoLinkService();
		this.batchUpdateService = this.ensureBatchUpdateService();

		this.initEudicServices();
		this.updateRibbonIcons();

		registerPluginCommands(this);
		registerPluginMenus(this);
		this.registerEventHandlers();
		this.registerProtocolHandler();
		this.addSettingTab(new LexiBridgeSettingTab(this.app, this));

		this.initSyncServices();
	}

	onunload() {
		const activePopover = document.querySelector('.lexibridge-popover');
		if (activePopover) {
			activePopover.remove();
		}
		this.clearSyncTimer();
		this.clearStartupSyncTimeout();
	}

	private initEudicServices(): void {
		this.eudicService = null;
		this.syncService = null;

		if (!this.settings.eudicToken) return;

		this.eudicService = new EudicService(this.settings.eudicToken);
		this.syncService = new SyncService(
			this.app,
			this.settings,
			this.eudicService,
			() => this.loadData(),
			(data) => this.saveData(data)
		);
	}

	private initDictionaryServices(): void {
		this.dictionaryService = new DictionaryService(
			new EcdictProvider(this.ecdictDatabase),
			new YoudaoProvider(() => this.settings.youdaoMinIntervalMs),
			() => this.settings.enableYoudaoFallback
		);
		this.wordNoteService = null;
	}

	reconfigureServices(): void {
		this.clearSyncTimer();
		this.clearStartupSyncTimeout();
		this.initDictionaryServices();
		this.autoLinkService = new AutoLinkService(this.app, this.settings);
		this.batchUpdateService = new BatchUpdateService(this.app, this.settings, this.ensureDictionaryService());
		this.initEudicServices();
		this.updateRibbonIcons();
		this.initSyncServices();
	}

	private ensureAutoLinkService(): AutoLinkService {
		if (!this.autoLinkService) {
			this.autoLinkService = new AutoLinkService(this.app, this.settings);
		}
		return this.autoLinkService;
	}

	private ensureBatchUpdateService(): BatchUpdateService {
		if (!this.batchUpdateService) {
			this.batchUpdateService = new BatchUpdateService(this.app, this.settings, this.ensureDictionaryService());
		}
		return this.batchUpdateService;
	}

	private ensureWordNoteService(): WordNoteService {
		if (!this.wordNoteService) {
			this.wordNoteService = new WordNoteService(
				this.app,
				() => this.settings,
				this.ensureDictionaryService()
			);
		}
		return this.wordNoteService;
	}

	private ensureDictionaryService(): DictionaryService {
		if (!this.dictionaryService) this.initDictionaryServices();
		return this.dictionaryService!;
	}

	updateRibbonIcons(): void {
		if (this.syncRibbonIcon) {
			this.syncRibbonIcon.remove();
			this.syncRibbonIcon = null;
		}
		if (this.batchRibbonIcon) {
			this.batchRibbonIcon.remove();
			this.batchRibbonIcon = null;
		}
		if (this.autoLinkRibbonIcon) {
			this.autoLinkRibbonIcon.remove();
			this.autoLinkRibbonIcon = null;
		}

		if (this.settings.eudicToken && this.settings.enableSync) {
			this.syncRibbonIcon = this.addRibbonIcon('refresh-cw', '欧路同步', () => {
				void this.performSync(false);
			});
		}

		this.batchRibbonIcon = this.addRibbonIcon('layers', '使用 ECDICT 批量迁移', () => {
			void this.performBatchUpdate();
		});

		this.autoLinkRibbonIcon = this.addRibbonIcon('link', '自动链接当前文档', () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) {
				const editor = view.editor;
				void this.autoLinkDocument(editor);
			} else {
				new Notice('请先打开一个 Markdown 文档。');
			}
		});
	}

	private registerEventHandlers(): void {
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					void this.handleFileDeleted(file);
				}
			})
		);
	}

	private registerProtocolHandler(): void {
		const handleUpdateProtocol = async (params: Record<string, string>) => {
			const cmd = params.cmd;
			const rawWord = params.word || '';
			
			const word = sanitizeWord(rawWord);
			if (!isValidWord(word)) {
				console.warn('[LexiBridge] Invalid word in protocol handler:', rawWord);
				return;
			}

			if (cmd === 'update') {
				await this.updateWordFromProtocol(word, 'ecdict');
			} else if (cmd === 'enhance') {
				await this.updateWordFromProtocol(word, 'youdao');
			}
		};

		this.registerObsidianProtocolHandler('lexibridge', handleUpdateProtocol);
		this.registerObsidianProtocolHandler('eudic-bridge', handleUpdateProtocol);
	}

	private async updateWordFromProtocol(word: string, source: DictionaryProviderId): Promise<void> {
		const success = await this.ensureBatchUpdateService().updateSingleWord(word, source);
		if (success) {
			new Notice(source === 'ecdict' ? `已从 ECDICT 更新 "${word}"` : `已使用有道增强 "${word}"`);
		} else {
			new Notice(`更新 "${word}" 失败`);
		}
	}

	private initSyncServices(): void {
		if (!this.settings.eudicToken || !this.settings.enableSync) return;

		if (this.settings.syncOnStartup) {
			this.scheduleStartupSync();
		}

		if (this.settings.autoSync) {
			this.startSyncTimer();
		}
	}

	private scheduleStartupSync(): void {
		this.clearStartupSyncTimeout();
		const delayMs = Math.max(0, this.settings.startupDelay) * 1000;
		this.startupSyncTimeout = window.setTimeout(() => {
			void this.performSync(true);
		}, delayMs);
	}

	private clearStartupSyncTimeout(): void {
		if (this.startupSyncTimeout !== null) {
			window.clearTimeout(this.startupSyncTimeout);
			this.startupSyncTimeout = null;
		}
	}

	restartSyncTimer(): void {
		this.clearSyncTimer();
		this.updateRibbonIcons();
		if (this.settings.enableSync && this.settings.autoSync) {
			this.startSyncTimer();
		}
	}

	private startSyncTimer(): void {
		const intervalMs = Math.max(5, this.settings.syncInterval) * 60 * 1000;
		this.syncTimer = window.setInterval(() => {
			void this.performSync(true);
		}, intervalMs);
		if (!this.syncTimerRegistered) {
			this.registerInterval(this.syncTimer);
			this.syncTimerRegistered = true;
		}
	}

	private clearSyncTimer(): void {
		if (this.syncTimer !== null) {
			window.clearInterval(this.syncTimer);
			this.syncTimer = null;
		}
		this.syncTimerRegistered = false;
	}

	async performSync(isAutoSync = false): Promise<void> {
		if (!this.syncService || !this.eudicService) {
			if (!isAutoSync) {
				new Notice('请先配置欧路词典 API token');
			}
			return;
		}

		try {
			const dryRunResult = await this.syncService.dryRun();

			if (dryRunResult.errors.length > 0) {
				throw new Error(dryRunResult.errors[0] ?? 'Unknown error');
			}

			const hasChanges = 
				dryRunResult.localAdded.length > 0 || 
				dryRunResult.cloudAdded.length > 0 || 
				dryRunResult.localDeleted.length > 0 || 
				dryRunResult.cloudDeleted.length > 0;

			if (!hasChanges) {
				if (dryRunResult.manifestMissing) {
					await this.syncService.refreshManifestBaseline();
				}
				if (!isAutoSync) {
					new Notice('未检测到变更。本地与云端已同步。', 2000);
				}
				return;
			}

			await this.executeSync(dryRunResult);

		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			if (!isAutoSync) {
				new Notice(`同步失败：${errorMsg}`);
			}
			console.error('[LexiBridge] Sync failed:', errorMsg);
		}
	}

	private async executeSync(dryRunResult: import('./sync').SyncDryRunResult): Promise<void> {
		if (!this.syncService) return;

		const totalOps = dryRunResult.localDeleted.length + 
			dryRunResult.cloudAdded.length + 
			dryRunResult.localAdded.length + 
			dryRunResult.cloudDeleted.length;

		if (totalOps === 0) {
			new Notice('未检测到变更。本地与云端已同步。');
			return;
		}

		const abortSignal = { aborted: false };

		const progressNotice = new ProgressNoticeWidget(
			'sync',
			totalOps,
			() => {
				abortSignal.aborted = true;
			}
		);

		const result = await this.syncService.executeSync(dryRunResult, (current, total, word) => {
			progressNotice.update(current, total, word);
		}, abortSignal);

		if (result.aborted) {
			progressNotice.setAborted(result.stats.uploaded + result.stats.downloaded);

		} else if (result.success) {
			progressNotice.setComplete(result.stats);
		} else if (result.errors.length > 0) {
			progressNotice.hide();
			new Notice(`同步失败：${result.errors[0] ?? 'Unknown error'}`);
		}
	}

	async performBatchUpdate(): Promise<void> {
		const status = await this.ecdictManager.getStatus();
		if (!status.installed || !status.valid) {
			new Notice('请先在设置中下载并安装 ECDICT 本地词典');
			return;
		}
		await this.ensureBatchUpdateService().batchUpdateWithModal();
	}

	async enhanceWordOnline(word: string): Promise<void> {
		await this.updateWordFromProtocol(word, 'youdao');
	}

	async autoLinkDocument(editor: Editor): Promise<void> {
		const service = this.ensureAutoLinkService();
		service.invalidateCache();
		const notice = new Notice('正在分析文档...', 0);
		const count = await service.autoLinkCurrentDocument(editor);
		notice.hide();
		if (count === 0) {
			new Notice('未找到可链接的单词，请先在 LexiBridge 文件夹中创建单词笔记');
		} else {
			new Notice(`自动链接完成，添加了 ${count} 个链接`);
		}
	}

	private async handleFileDeleted(file: TFile): Promise<void> {
		if (!this.syncService) return;
		await this.syncService.handleFileDeleted(file);
	}

	async loadSettings(): Promise<void> {
		const loaded: unknown = await this.loadData();
		this.settings = normalizeSettings(loaded);
	}

	async saveSettings(): Promise<void> {
		const loaded: unknown = await this.loadData();
		const data = loaded && typeof loaded === 'object' ? loaded as Record<string, unknown> : {};
		await this.saveData({
			...data,
			...normalizeSettings(this.settings),
		});
	}

	async clearSyncManifest(): Promise<void> {
		const loaded: unknown = await this.loadData();
		const data = loaded && typeof loaded === 'object' ? loaded as Record<string, unknown> : {};
		await this.saveData({
			...data,
			syncManifest: { lastSyncTime: 0, syncedWords: [] },
		});
	}

	async addToEudic(word: string): Promise<boolean> {
		if (!this.eudicService) {
			new Notice('请在设置中配置欧路词典 API token');
			return false;
		}

		const listId = getEffectiveUploadCategoryIds(
			this.settings.syncCategoryIds,
			this.settings.defaultUploadCategoryId
		)[0] || '0';

		try {
			await this.eudicService.addWords(listId, [word]);
			new Notice(`已将 "${word}" 添加到欧路生词本。`);
			return true;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			new Notice(`添加到欧路失败：${errorMessage}`);
			return false;
		}
	}

	public async findEntry(
		word: string,
		useLemmatizerFlag: boolean = true
	): Promise<(DictionaryLookupResult & { word: string }) | null> {
		return this.ensureWordNoteService().findEntry(word, useLemmatizerFlag);
	}

	async searchAndGenerateNote(searchWord: string, editor?: Editor): Promise<void> {
		await this.ensureWordNoteService().searchAndGenerateNote(searchWord, editor);
	}

	generateMarkdown(
		word: string,
		entry: DictEntry,
		originalWord?: string,
		source: DictionaryProviderId = 'ecdict'
	): string {
		return this.ensureWordNoteService().generateMarkdown(word, entry, originalWord, source);
	}

	async createWordFile(
		word: string,
		entry: DictEntry,
		originalWord?: string,
		source: DictionaryProviderId = 'ecdict'
	): Promise<void> {
		await this.ensureWordNoteService().createWordFile(word, entry, originalWord, source);
	}

	getEcdictStatus(): Promise<EcdictStatus> {
		return this.ecdictManager.getStatus();
	}

	checkEcdictUpdate(sourceId: EcdictDownloadSourceId) {
		return this.ecdictManager.checkForUpdate(sourceId);
	}

	testEcdictDownloadSources() {
		return this.ecdictManager.testDownloadSources();
	}

	installEcdict(
		sourceId: EcdictDownloadSourceId,
		onProgress?: (progress: EcdictProgress) => void,
		abortSignal?: { aborted: boolean }
	): Promise<EcdictInstallation> {
		return this.ecdictManager.install(sourceId, onProgress, abortSignal);
	}

	removeEcdict(): Promise<void> {
		return this.ecdictManager.remove();
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_LEXIBRIDGE);

		let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_LEXIBRIDGE, active: true });
			}
		}

		if (leaf) {
			void workspace.revealLeaf(leaf);
		}
	}
}
