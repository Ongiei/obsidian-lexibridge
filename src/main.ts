import {Editor, MarkdownView, Menu, Notice, Plugin, TFile, WorkspaceLeaf} from 'obsidian';
import {DEFAULT_SETTINGS, EudicBridgeSettings, EudicBridgeSettingTab} from "./settings";
import {DictionaryView} from "./view";
import {DefinitionPopover} from "./popover";
import {YoudaoService} from "./youdao";
import {DictEntry} from "./types";
import {getLemma} from "./lemmatizer";
import {EudicService} from "./eudic";
import {SyncService} from "./sync";
import {AutoLinkService} from "./auto-link";
import {BatchUpdateService} from "./batch-update";
import {ProgressNoticeWidget} from "./modal";
import {MarkdownGenerator} from "./utils/markdown-generator";

export const VIEW_TYPE_EUDIC_BRIDGE = 'eudic-bridge-view';

const WORD_REGEX = /^[a-zA-Z\s'-]+$/;

function sanitizeWord(input: string): string {
	return input.trim().replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
}

function isValidWord(word: string): boolean {
	return word.length > 0 && word.length <= 50 && WORD_REGEX.test(word);
}

export default class EudicBridgePlugin extends Plugin {
	settings: EudicBridgeSettings;
	private eudicService: EudicService | null = null;
	private syncService: SyncService | null = null;
	private autoLinkService: AutoLinkService | null = null;
	private batchUpdateService: BatchUpdateService | null = null;
	private syncTimer: number | null = null;
	private syncTimerRegistered: boolean = false;
	private startupSyncTimeout: number | null = null;
	private syncRibbonIcon: HTMLElement | null = null;
	private batchRibbonIcon: HTMLElement | null = null;
	private autoLinkRibbonIcon: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_EUDIC_BRIDGE, (leaf) => new DictionaryView(leaf, this));

		this.addRibbonIcon('book-open', '打开词典视图', () => {
			void this.activateView();
		});

		this.autoLinkService = this.ensureAutoLinkService();
		this.batchUpdateService = this.ensureBatchUpdateService();

		this.initEudicServices();
		this.updateRibbonIcons();

		this.registerCommands();
		this.registerMenus();
		this.registerEventHandlers();
		this.registerProtocolHandler();
		this.addSettingTab(new EudicBridgeSettingTab(this.app, this));

		this.initSyncServices();
	}

	onunload() {
		const activePopover = document.querySelector('.eudic-bridge-popover');
		if (activePopover) {
			activePopover.remove();
		}
		this.clearSyncTimer();
		this.clearStartupSyncTimeout();
	}

	private initEudicServices(): void {
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

	private ensureAutoLinkService(): AutoLinkService {
		if (!this.autoLinkService) {
			this.autoLinkService = new AutoLinkService(this.app, this.settings);
		}
		return this.autoLinkService;
	}

	private ensureBatchUpdateService(): BatchUpdateService {
		if (!this.batchUpdateService) {
			this.batchUpdateService = new BatchUpdateService(this.app, this.settings);
		}
		return this.batchUpdateService;
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

		this.batchRibbonIcon = this.addRibbonIcon('layers', '批量更新缺失释义', () => {
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

	private registerCommands(): void {
		this.addCommand({
			id: 'open-dictionary-view',
			name: '打开词典视图',
			callback: () => {
				void this.activateView();
			}
		});

		this.addCommand({
			id: 'define-selected-word',
			name: '创建词元笔记',
			editorCallback: (editor: Editor, _view: MarkdownView) => {
				const selectedText = editor.getSelection();
				if (!selectedText || selectedText.trim() === '') {
					new Notice('请先选择一个单词。');
					return;
				}
				const word = sanitizeWord(selectedText);
				if (!isValidWord(word)) {
					new Notice('请选择一个有效的单词');
					return;
				}
				void this.searchAndGenerateNote(word, editor);
			}
		});

		this.addCommand({
			id: 'lookup-selection',
			name: '查询选中内容',
			editorCallback: async (editor: Editor, _view: MarkdownView) => {
				const selectedText = editor.getSelection();
				if (!selectedText || selectedText.trim() === '') {
					new Notice('请先选择一个单词。');
					return;
				}
				const word = sanitizeWord(selectedText);
				if (!isValidWord(word)) {
					new Notice('请选择一个有效的单词');
					return;
				}
				const popover = new DefinitionPopover(this, editor, word);
				try {
					const result = await this.findEntry(word, false);
					if (result) {
						popover.setEntry(result.entry);
					} else {
						popover.close();
						new Notice(`未找到定义： ${word}`);
					}
				} catch (error) {
					popover.close();
					const errorMsg = error instanceof Error ? error.message : 'Unknown error';
					new Notice(`同步失败：${errorMsg}`);
				}
			}
		});

		this.addCommand({
			id: 'sync-preview',
			name: '预检欧路同步',
			callback: () => {
				void this.performSync(false);
			}
		});

		this.addCommand({
			id: 'auto-link-document',
			name: '自动链接当前文档',
			editorCallback: (editor: Editor) => {
				void this.autoLinkDocument(editor);
			}
		});

		this.addCommand({
			id: 'batch-update-definitions',
			name: '批量更新缺失释义',
			callback: () => {
				void this.performBatchUpdate();
			}
		});
	}

	private registerMenus(): void {
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, _view: MarkdownView) => {
				const selection = editor.getSelection();

				if (!selection || selection.trim() === '') {
					return;
				}

				const word = sanitizeWord(selection);
				if (!isValidWord(word)) {
					return;
				}

				menu.addItem((item) => {
					item
						.setTitle('创建词元笔记')
						.setIcon('book-open')
						.onClick(() => {
							void this.searchAndGenerateNote(word, editor);
						});
				});

				menu.addItem((item) => {
					item
						.setTitle('查询选中内容')
						.setIcon('search')
						.onClick(async () => {
							const popover = new DefinitionPopover(this, editor, word);
							try {
								const result = await this.findEntry(word, false);
								if (result) {
									popover.setEntry(result.entry);
								} else {
									popover.close();
									new Notice(`未找到定义： ${word}`);
								}
							} catch (error) {
								popover.close();
								const errorMsg = error instanceof Error ? error.message : 'Unknown error';
								new Notice(`查询失败：${errorMsg}`);
							}
						});
				});
			})
		);
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
		this.registerObsidianProtocolHandler('eudic-bridge', async (params) => {
			const cmd = params.cmd;
			const rawWord = params.word || '';
			
			const word = sanitizeWord(rawWord);
			if (!isValidWord(word)) {
				console.warn('[EudicBridge] Invalid word in protocol handler:', rawWord);
				return;
			}

			if (cmd === 'update') {
				await this.updateWordFromProtocol(word);
			}
		});
	}

	private async updateWordFromProtocol(word: string): Promise<void> {
		const success = await this.ensureBatchUpdateService().updateSingleWord(word);
		if (success) {
			new Notice(`已更新 "${word}" 的释义`);
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

			const hasChanges = 
				dryRunResult.localAdded.length > 0 || 
				dryRunResult.cloudAdded.length > 0 || 
				dryRunResult.localDeleted.length > 0 || 
				dryRunResult.cloudDeleted.length > 0;

			if (!hasChanges) {
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
			console.error('[EudicBridge] Sync failed:', errorMsg);
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
		await this.ensureBatchUpdateService().batchUpdateWithModal();
	}

	async autoLinkDocument(editor: Editor): Promise<void> {
		const service = this.ensureAutoLinkService();
		service.invalidateCache();
		const notice = new Notice('正在分析文档...', 0);
		const count = await service.autoLinkCurrentDocument(editor);
		notice.hide();
		if (count === 0) {
			new Notice('未找到可链接的单词，请先在 EudicBridge 文件夹中创建单词笔记');
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded as Partial<EudicBridgeSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async addToEudic(word: string): Promise<boolean> {
		if (!this.eudicService) {
			new Notice('请在设置中配置欧路词典 API token');
			return false;
		}

		const listId = this.settings.defaultUploadCategoryId || '0';

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

	public async findEntry(word: string, useLemmatizerFlag: boolean = true): Promise<{ entry: DictEntry; word: string } | null> {
		const searchWord = word.toLowerCase().trim();

		if (!searchWord) {
			return null;
		}

		const lookupWord = useLemmatizerFlag ? getLemma(searchWord) : searchWord;

		const entry = await YoudaoService.lookup(lookupWord);

		if (!entry) {
			return null;
		}

		return { entry, word: lookupWord };
	}

	async searchAndGenerateNote(searchWord: string, editor?: Editor): Promise<void> {
		const result = await this.findEntry(searchWord, true);

		if (!result) {
			new Notice(`词典中未找到单词 "${searchWord}"`);
			return;
		}

		const { entry, word: lemma } = result;

		await this.createWordFile(lemma, entry, searchWord);

		if (editor) {
			const selectedText = editor.getSelection();
			if (selectedText && selectedText.trim() !== '') {
				const originalText = selectedText.trim();
				if (lemma === originalText) {
					editor.replaceSelection(`[[${lemma}]]`);
				} else {
					editor.replaceSelection(`[[${lemma}|${originalText}]]`);
				}
			}
		}
	}

	generateMarkdown(word: string, entry: DictEntry, originalWord?: string): string {
		return MarkdownGenerator.generate(word, entry, {
			saveTags: this.settings.saveTags,
			originalWord,
		});
	}

	async createWordFile(word: string, entry: DictEntry, originalWord?: string): Promise<void> {
		const folderPath = this.settings.folderPath;
		const fileName = `${word}.md`;
		const filePath = `${folderPath}/${fileName}`;

		try {
			const folderExists = await this.app.vault.adapter.exists(folderPath);
			if (!folderExists) {
				await this.app.vault.createFolder(folderPath);
			}

			const fileExists = await this.app.vault.adapter.exists(filePath);
			const markdown = this.generateMarkdown(word, entry, originalWord);

			if (fileExists) {
				const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
				if (abstractFile instanceof TFile) {
					await this.app.vault.modify(abstractFile, markdown);
					new Notice(`已更新单词文件: ${fileName}`);
				}
			} else {
				await this.app.vault.create(filePath, markdown);
				new Notice(`已创建单词文件: ${fileName}`);
			}

			await this.app.workspace.openLinkText(filePath, '', true);
		} catch (error) {
			new Notice(`创建单词文件失败: ${fileName}`);
			console.error('Error creating word file:', error);
		}
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_EUDIC_BRIDGE);

		let leaf: WorkspaceLeaf | null = leaves[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: VIEW_TYPE_EUDIC_BRIDGE, active: true });
			}
		}

		if (leaf) {
			void workspace.revealLeaf(leaf);
		}
	}
}