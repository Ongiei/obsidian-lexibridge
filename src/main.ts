import {Editor, MarkdownPostProcessorContext, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf} from 'obsidian';
import {LexiBridgeSettings, LexiBridgeSettingTab} from "./settings";
import {DictionaryView} from "./view";
import {DictEntry} from "./types";
import {EudicService} from "./eudic";
import {SyncService} from "./sync";
import {AutoLinkRange, AutoLinkService} from "./auto-link";
import {BatchUpdateService} from "./batch-update";
import {ProgressNoticeWidget} from "./modal";
import {normalizeSettings} from "./settings-data";
import {isValidWord, sanitizeWord} from "./utils/word";
import {getEffectiveUploadCategoryIds} from "./utils/sync";
import {registerPluginCommands, registerPluginMenus} from "./plugin-registrations";
import {WordNoteService} from "./word-note-service";
import {ConfirmModal} from './ui/confirm-modal';
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
import {AnkiSyncService} from './anki/sync-service';
import {AnkiSyncPreviewModal} from './anki/sync-preview-modal';
import {AnkiProgressNotice} from './anki/progress-notice';
import {MissingSourceAction} from './anki/types';
import {AutoLinkPreviewModal} from './ui/auto-link-preview-modal';
import {VirtualLinkModal} from './ui/virtual-link-modal';
import {SyncHistoryModal} from './ui/sync-history-modal';
import {AutoLinkCleanupModal} from './ui/auto-link-cleanup-modal';
import {MissingWordModal} from './ui/missing-word-modal';
import {createLivePreviewVirtualLinks} from './reading/live-preview-virtual-links';

interface CrossWindowDom extends Window {
	NodeFilter: {SHOW_TEXT: number};
	Text: {new (): Text};
}

export const VIEW_TYPE_LEXIBRIDGE = 'lexibridge-view';

export default class LexiBridgePlugin extends Plugin {
	settings!: LexiBridgeSettings;
	private eudicService: EudicService | null = null;
	private syncService: SyncService | null = null;
	private autoLinkService: AutoLinkService | null = null;
	private batchUpdateService: BatchUpdateService | null = null;
	private ankiSyncService: AnkiSyncService | null = null;
	private wordNoteService: WordNoteService | null = null;
	private dictionaryService: DictionaryService | null = null;
	private readonly ecdictDatabase = new EcdictDatabase();
	private readonly ecdictManager = new EcdictManager(this.ecdictDatabase);
	private syncTimer: number | null = null;
	private syncTimerRegistered: boolean = false;
	private startupSyncTimeout: number | null = null;
	private syncRequestInProgress = false;
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
		this.registerVirtualLinks();
		this.registerEditorExtension(createLivePreviewVirtualLinks(this));
		this.registerProtocolHandler();
		this.addSettingTab(new LexiBridgeSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			this.registerEventHandlers();
			this.initSyncServices();
		});
	}

	onunload() {
		const activePopover = activeDocument.querySelector('.lexibridge-popover');
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
		this.ankiSyncService = null;
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

	private ensureAnkiSyncService(): AnkiSyncService {
		if (!this.ankiSyncService) {
			this.ankiSyncService = new AnkiSyncService(
				this.app,
				() => this.settings
			);
		}
		return this.ankiSyncService;
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
		this.registerEvent(this.app.vault.on('create', file => {
			if (file instanceof TFile && this.isWordNotePath(file.path)) {
				this.autoLinkService?.invalidateCache();
				void this.syncService?.handleFileCreated(file);
			}
		}));
		this.registerEvent(this.app.vault.on('modify', file => {
			if (file instanceof TFile && this.isWordNotePath(file.path)) {
				void this.syncService?.handleFileModified(file);
			}
		}));
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					if (this.isWordNotePath(file.path)) this.autoLinkService?.invalidateCache();
					void this.handleFileDeleted(file);
				}
			})
		);
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
			if (file instanceof TFile && (this.isWordNotePath(file.path) || this.isWordNotePath(oldPath))) {
				this.autoLinkService?.invalidateCache();
			}
			void this.syncService?.handleFileRenamed(file, oldPath);
		}));
	}

	private registerVirtualLinks(): void {
		this.registerMarkdownPostProcessor((element, context) => {
			if (!this.settings.virtualLinksEnabled
				|| (this.settings.autoLinkSkipWordFolder && this.isWordNotePath(context.sourcePath))) return;
			const service = this.ensureAutoLinkService();
			this.decorateVirtualLinks(element, context, service);
		});
	}

	refreshVirtualLinks(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			if (!(leaf.view instanceof MarkdownView)) continue;
			leaf.view.previewMode.rerender(true);
			const editorView = (leaf.view.editor as Editor & {cm?: {dispatch: (spec?: object) => void}}).cm;
			editorView?.dispatch({});
		}
	}

	resolveAutoLinkTarget(word: string): string | null {
		return this.ensureAutoLinkService().findLocalWord(word);
	}

	isWordNote(path: string): boolean {
		return this.isWordNotePath(path);
	}

	openLivePreviewVirtualLink(word: string, target: string, from: number, to: number): void {
		new VirtualLinkModal(
			this.app,
			word,
			target,
			() => void this.lookupWordInView(word),
			() => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (view) view.editor.setSelection(view.editor.offsetToPos(from), view.editor.offsetToPos(to));
				void this.searchAndGenerateNote(word, view?.editor);
			},
			() => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view) return;
				const basename = target.split('/').pop() || target;
				const replacement = word.toLowerCase() === basename.toLowerCase() ? `[[${target}]]` : `[[${target}|${word}]]`;
				view.editor.replaceRange(replacement, view.editor.offsetToPos(from), view.editor.offsetToPos(to));
				new Notice(`已将 "${word}" 写入为真实链接。`);
			}
		).open();
	}

	showVirtualLinkHover(event: MouseEvent, targetEl: HTMLElement, target: string, sourcePath?: string): void {
		this.app.workspace.trigger('hover-link', {
			event,
			source: 'lexibridge-virtual-link',
			hoverParent: targetEl,
			targetEl,
			linktext: target,
			sourcePath: sourcePath || this.app.workspace.getActiveFile()?.path || '',
		});
	}

	private decorateVirtualLinks(element: HTMLElement, context: MarkdownPostProcessorContext, service: AutoLinkService): void {
		const ignored = new Set(this.settings.autoLinkIgnoredWords);
		const ownerDocument = element.ownerDocument ?? activeDocument;
		const ownerWindow = (ownerDocument.defaultView ?? activeWindow) as CrossWindowDom;
		const walker = ownerDocument.createTreeWalker(element, ownerWindow.NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		let current: Node | null;
		while ((current = walker.nextNode())) {
			if (!current.instanceOf(ownerWindow.Text)) continue;
			const parent = current.parentElement;
			if (!parent || parent.closest('a, code, pre, .tag, .lexibridge-virtual-link')) continue;
			nodes.push(current);
		}
		for (const node of nodes) {
			const text = node.data;
			const pattern = /\b[a-zA-Z]+(?:[-'][a-zA-Z]+)*\b/g;
			let match: RegExpExecArray | null;
			let lastEnd = 0;
			let changed = false;
			const fragment = ownerDocument.createDocumentFragment();
			while ((match = pattern.exec(text)) !== null) {
				const word = match[0];
				if (word.length < this.settings.autoLinkMinWordLength || ignored.has(word.toLowerCase())) continue;
				const target = service.findLocalWord(word);
				if (!target) continue;
				fragment.append(text.slice(lastEnd, match.index));
				const virtualLink = ownerDocument.createElement('span');
				virtualLink.className = 'lexibridge-virtual-link';
				virtualLink.textContent = word;
				virtualLink.tabIndex = 0;
				virtualLink.setAttribute('role', 'link');
				virtualLink.setAttribute('aria-label', `${word}：词库虚拟链接`);
				const open = () => this.openVirtualLink(word, target, context, element);
				virtualLink.addEventListener('click', open);
				virtualLink.addEventListener('mouseenter', event => {
					this.showVirtualLinkHover(event, virtualLink, target, context.sourcePath);
				});
				virtualLink.addEventListener('keydown', event => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						open();
					}
				});
				fragment.append(virtualLink);
				lastEnd = match.index + word.length;
				changed = true;
			}
			if (changed) {
				fragment.append(text.slice(lastEnd));
				node.replaceWith(fragment);
			}
		}
	}

	private openVirtualLink(word: string, target: string, context: MarkdownPostProcessorContext, element: HTMLElement): void {
		new VirtualLinkModal(
			this.app,
			word,
			target,
			() => void this.lookupWordInView(word),
			() => void this.searchAndGenerateNote(word),
			() => void this.linkVirtualOccurrence(context, element, word, target)
		).open();
	}

	private async lookupWordInView(word: string): Promise<void> {
		await this.activateView();
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_LEXIBRIDGE)[0];
		if (leaf?.view instanceof DictionaryView) await leaf.view.lookup(word);
	}

	private async linkVirtualOccurrence(
		context: MarkdownPostProcessorContext,
		element: HTMLElement,
		word: string,
		target: string
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
		if (!(file instanceof TFile)) return;
		const section = context.getSectionInfo(element);
		let linked = false;
		await this.app.vault.process(file, content => {
			const lines = content.split('\n');
			const fromLine = section?.lineStart ?? 0;
			const toLine = section?.lineEnd ?? Math.max(0, lines.length - 1);
			const from = lines.slice(0, fromLine).reduce((total, line) => total + line.length + 1, 0);
			const to = lines.slice(0, toLine + 1).reduce((total, line) => total + line.length + 1, 0);
			const service = this.ensureAutoLinkService();
			const plan = service.createPlan(content, {from, to: Math.min(content.length, to)});
			const occurrence = plan.occurrences.find(item => item.target === target && item.text.toLowerCase() === word.toLowerCase());
			if (!occurrence) return content;
			linked = true;
			return service.applyPlan({...plan, occurrences: [occurrence]}, new Set([target]));
		});
		new Notice(linked
			? `已将 "${word}" 写入为真实链接。`
			: '当前区段已变化或该词已按链接规则处理，请重新查看文档。');
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
		if (this.syncRequestInProgress) {
			if (!isAutoSync) new Notice('同步正在进行中，请稍后再试');
			return;
		}
		this.syncRequestInProgress = true;

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

			if (
				this.settings.syncDeletionProtection
				&& dryRunResult.localDeleted.length > 0
				&& !await this.confirmCloudDeletion(dryRunResult.localDeleted.length)
			) {
				if (!isAutoSync) new Notice('已取消云端删除，本次同步未执行。');
				return;
			}

			await this.executeSync(dryRunResult);

		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			if (!isAutoSync) {
				new Notice(`同步失败：${errorMsg}`);
			}
			console.error('[LexiBridge] Sync failed:', errorMsg);
		} finally {
			this.syncRequestInProgress = false;
		}
	}

	private confirmCloudDeletion(count: number): Promise<boolean> {
		return new Promise(resolve => {
			let confirmed = false;
			const modal = new ConfirmModal(
				this.app,
				`检测到本地删除了 ${count} 个词条。继续同步会从对应欧路生词本中一并删除，删除记录可用于恢复本地文件。`,
				() => {
					confirmed = true;
					resolve(true);
				}
			);
			const originalClose = modal.onClose.bind(modal);
			modal.onClose = () => {
				originalClose();
				if (!confirmed) resolve(false);
			};
			modal.open();
		});
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

	async testAnkiConnection(): Promise<number> {
		return this.ensureAnkiSyncService().testConnection();
	}

	async loadAnkiDeckNames(): Promise<string[]> {
		return this.ensureAnkiSyncService().loadDeckNames();
	}

	async createAnkiDeck(deckName: string): Promise<void> {
		await this.ensureAnkiSyncService().createDeck(deckName);
	}

	async previewFullAnkiSync(): Promise<void> {
		if (!this.settings.anki.enabled) {
			new Notice('请先在设置中启用 Anki 导出。');
			return;
		}
		const result = await this.ensureAnkiSyncService().previewFullSync();
		new AnkiSyncPreviewModal(
			this.app,
			result,
			() => this.executeFullAnkiSync(),
			{
				onTag: () => this.executeMissingSourceAction('tag'),
				onSuspend: () => this.executeMissingSourceAction('suspend'),
				onDelete: () => this.confirmDeleteMissingAnkiSources(result.plan.missingSources.length),
			}
		).open();
	}

	async previewCurrentWordAnkiSync(): Promise<void> {
		if (!this.settings.anki.enabled) {
			new Notice('请先在设置中启用 Anki 导出。');
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		if (!file) {
			new Notice('请先打开一个单词笔记。');
			return;
		}
		const progress = new AnkiProgressNotice('正在发送当前单词笔记到 Anki...');
		try {
			const result = await this.ensureAnkiSyncService().executeCurrentFile(file, message => progress.update(message));
			progress.hide();
			this.showAnkiExecutionResult(result);
		} catch (error) {
			progress.hide();
			new Notice(`发送到 Anki 失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async executeFullAnkiSync(): Promise<void> {
		const progress = new AnkiProgressNotice('正在发送单词笔记到 Anki...');
		try {
			const result = await this.ensureAnkiSyncService().executeFullSync(message => progress.update(message));
			progress.hide();
			this.showAnkiExecutionResult(result);
		} catch (error) {
			progress.hide();
			new Notice(`发送到 Anki 失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async executeMissingSourceAction(action: MissingSourceAction): Promise<void> {
		const progress = new AnkiProgressNotice('正在处理缺失源 Anki 笔记...');
		try {
			const result = await this.ensureAnkiSyncService().executeMissingSourceAction(action, message => progress.update(message));
			progress.hide();
			this.showAnkiExecutionResult(result);
		} catch (error) {
			progress.hide();
			new Notice(`处理缺失源失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async confirmDeleteMissingAnkiSources(count: number): Promise<void> {
		new ConfirmModal(
			this.app,
			`永久删除 ${count} 条缺失源 Anki 笔记？该操作只会重新扫描后处理当前 LexiBridge 来源范围内的笔记，不会删除 Markdown 文件，但 Anki 复习历史也会随笔记删除。`,
			() => {
				void this.executeMissingSourceAction('delete');
			}
		).open();
	}

	private showAnkiExecutionResult(result: { success: boolean; stats: { added: number; updated: number; unchanged: number; failed: number; verified: number }; errors: string[] }): void {
		if (result.success) {
			new Notice(`Anki 同步完成：新增 ${result.stats.added}，更新 ${result.stats.updated}，已校验 ${result.stats.verified}，无变化 ${result.stats.unchanged}`);
			return;
		}
		new Notice(`Anki 同步部分失败：新增 ${result.stats.added}，更新 ${result.stats.updated}，失败 ${result.stats.failed}\n${result.errors[0] || ''}`, 12000);
	}

	async autoLinkDocument(editor: Editor, scope: 'document' | 'section' | 'selection' = 'document'): Promise<void> {
		const service = this.ensureAutoLinkService();
		service.invalidateCache();
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile && this.settings.autoLinkSkipWordFolder && this.isWordNotePath(activeFile.path)) {
			new Notice('当前文件位于单词笔记文件夹，已按设置跳过。');
			return;
		}
		const content = editor.getValue();
		const range = this.getAutoLinkRange(editor, content, scope);
		if (!range) {
			new Notice(scope === 'selection' ? '请先选择需要链接的文本。' : '无法确定链接范围。');
			return;
		}
		const plan = service.createPlan(content, range);
		if (plan.occurrences.length === 0) {
			new Notice('未找到可链接的单词，请先在 LexiBridge 文件夹中创建单词笔记');
			return;
		}
		const labels = {document: '整篇文档', section: '当前章节', selection: '当前选区'};
		new AutoLinkPreviewModal(this.app, plan, labels[scope], selectedTargets => {
			if (selectedTargets.size === 0) {
				new Notice('没有选择需要写入的链接。');
				return;
			}
			const latest = editor.getValue();
			if (latest !== plan.content) {
				new Notice('文档在预览期间已发生变化，请重新执行链接命令。');
				return;
			}
			const next = service.applyPlan(plan, selectedTargets);
			editor.replaceRange(next, {line: 0, ch: 0}, editor.offsetToPos(latest.length));
			const count = plan.occurrences.filter(item => selectedTargets.has(item.target)).length;
			new Notice(`已添加 ${count} 个链接，关联 ${selectedTargets.size} 个单词笔记。`);
		}).open();
	}

	async inspectAndRemoveWordLinks(editor: Editor): Promise<void> {
		const service = this.ensureAutoLinkService();
		service.invalidateCache();
		const plan = service.createCleanupPlan(editor.getValue());
		if (plan.occurrences.length === 0) {
			new Notice('当前文档没有指向单词文件夹的真实链接。');
			return;
		}
		new AutoLinkCleanupModal(this.app, plan, selectedTargets => {
			if (selectedTargets.size === 0) return;
			const latest = editor.getValue();
			if (latest !== plan.content) {
				new Notice('文档在预览期间已发生变化，请重新检查。');
				return;
			}
			const next = service.applyPlan(plan, selectedTargets);
			editor.replaceRange(next, {line: 0, ch: 0}, editor.offsetToPos(latest.length));
			const count = plan.occurrences.filter(item => selectedTargets.has(item.target)).length;
			new Notice(`已移除 ${count} 个词库链接，显示文本保持不变。`);
		}).open();
	}

	async discoverMissingWords(editor: Editor): Promise<void> {
		const service = this.ensureAutoLinkService();
		service.invalidateCache();
		const candidates = service.findMissingCandidates(editor.getValue());
		if (candidates.length === 0) {
			new Notice('当前文档没有发现未建词条。');
			return;
		}
		new MissingWordModal(this.app, candidates, words => {
			if (words.length === 0) return;
			void (async () => {
				for (const word of words) await this.searchAndGenerateNote(word);
				service.invalidateCache();
			})().catch(error => {
				new Notice(`创建词条失败：${error instanceof Error ? error.message : String(error)}`);
			});
		}).open();
	}

	private getAutoLinkRange(editor: Editor, content: string, scope: 'document' | 'section' | 'selection'): AutoLinkRange | null {
		if (scope === 'document') return {from: 0, to: content.length};
		if (scope === 'selection') {
			if (!editor.somethingSelected()) return null;
			return {from: editor.posToOffset(editor.getCursor('from')), to: editor.posToOffset(editor.getCursor('to'))};
		}
		const cursorLine = editor.getCursor().line;
		const currentHeading = this.findSectionHeadingLine(editor, cursorLine);
		if (currentHeading === null) return {from: 0, to: content.length};
		const headingMatch = editor.getLine(currentHeading).match(/^\s{0,3}(#{1,6})\s/);
		const level = headingMatch?.[1]?.length || 6;
		let endLine = editor.lineCount();
		for (let line = currentHeading + 1; line < editor.lineCount(); line++) {
			const match = editor.getLine(line).match(/^\s{0,3}(#{1,6})\s/);
			if (match?.[1] && match[1].length <= level) {
				endLine = line;
				break;
			}
		}
		return {
			from: editor.posToOffset({line: currentHeading, ch: 0}),
			to: endLine < editor.lineCount() ? editor.posToOffset({line: endLine, ch: 0}) : content.length,
		};
	}

	private findSectionHeadingLine(editor: Editor, fromLine: number): number | null {
		for (let line = fromLine; line >= 0; line--) {
			if (/^\s{0,3}#{1,6}\s/.test(editor.getLine(line))) return line;
		}
		return null;
	}

	private isWordNotePath(path: string): boolean {
		const folderPath = this.settings.folderPath.replace(/\/$/, '');
		return path === folderPath || path.startsWith(`${folderPath}/`);
	}

	private async handleFileDeleted(file: TFile): Promise<void> {
		if (!this.syncService) return;
		await this.syncService.handleFileDeleted(file);
	}

	async loadSettings(): Promise<void> {
		const loaded: unknown = await this.loadData();
		this.settings = normalizeSettings(loaded);
		if (!loaded || typeof loaded !== 'object' || !(loaded as { anki?: { ankiSourceId?: unknown } }).anki?.ankiSourceId) {
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		const loaded: unknown = await this.loadData();
		const data = loaded && typeof loaded === 'object' ? loaded as Record<string, unknown> : {};
		const normalized = normalizeSettings(this.settings);
		Object.assign(this.settings, normalized);
		await this.saveData({
			...data,
			...normalized,
		});
	}

	async clearSyncManifest(): Promise<void> {
		const loaded: unknown = await this.loadData();
		const data = loaded && typeof loaded === 'object' ? loaded as Record<string, unknown> : {};
		await this.saveData({
			...data,
			syncManifest: {version: 2, lastSyncTime: 0, categories: {}},
		});
	}

	async undoLastSyncDeletion(): Promise<boolean> {
		return this.syncService?.undoLastDeletion() || false;
	}

	async openSyncHistory(): Promise<void> {
		if (!this.syncService) {
			new Notice('请先配置欧路词典 API token');
			return;
		}
		const entries = await this.syncService.getHistory();
		new SyncHistoryModal(this.app, entries, id => this.syncService?.undoDeletion(id) || Promise.resolve(false)).open();
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

	public async findEntryFromSource(
		word: string,
		source: DictionaryProviderId
	): Promise<(DictionaryLookupResult & { word: string }) | null> {
		return this.ensureWordNoteService().findEntryFromSource(word, source);
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
