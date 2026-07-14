import { App, Modal, Notice, Setting } from 'obsidian';
import { MarkdownPreview } from './utils/markdown-generator';
import {EcdictProgress} from './ecdict';

export interface BatchUpdateStats {
	total: number;
	updated: number;
	pending: number;
}

export interface BatchWritePreview {
	fields: string[];
	tags: string[];
}

export class EcdictProgressNotice {
	readonly abortSignal = { aborted: false };
	private notice: Notice;
	private progressBar: HTMLElement;
	private statusEl: HTMLElement;
	private actionButton: HTMLButtonElement;
	private running = true;

	constructor() {
		this.notice = new Notice('', 0);
		this.notice.messageEl.parentElement?.addClass('lexibridge-progress-notice');
		this.notice.messageEl.empty();
		const headerEl = this.notice.messageEl.createEl('div', {cls: 'lexibridge-notice-header'});
		headerEl.createEl('div', {cls: 'lexibridge-notice-title', text: '正在安装 ECDICT'});
		this.statusEl = headerEl.createEl('div', {cls: 'lexibridge-notice-status', text: '准备开始'});
		const controlsEl = this.notice.messageEl.createEl('div', {cls: 'lexibridge-notice-controls'});
		const progressTrack = controlsEl.createEl('div', {
			cls: 'lexibridge-notice-progress',
			attr: {role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0'},
		});
		this.progressBar = progressTrack.createEl('div', {cls: 'lexibridge-notice-progress-value'});
		this.actionButton = controlsEl.createEl('button', {text: '停止'});
		this.actionButton.addEventListener('click', () => {
			if (!this.running) return;
			this.abortSignal.aborted = true;
			this.actionButton.setText('正在停止');
			this.actionButton.disabled = true;
		});
	}

	update(progress: EcdictProgress): void {
		if (!this.running) return;
		const percent = Math.round(Math.max(0, Math.min(1, progress.progress)) * 100);
		this.progressBar.setCssProps({'--lexibridge-notice-progress': `${percent}%`});
		this.progressBar.parentElement?.setAttribute('aria-valuenow', String(percent));
		this.statusEl.setText(`${String(percent).padStart(3, '0')}%`);
	}

	setComplete(message: string): void {
		this.running = false;
		this.progressBar.setCssProps({'--lexibridge-notice-progress': '100%'});
		this.statusEl.setText(message);
		this.actionButton.remove();
		window.setTimeout(() => this.notice.hide(), 5000);
	}

	setError(message: string): void {
		this.running = false;
		this.statusEl.setText(message);
		this.progressBar.parentElement?.remove();
		this.actionButton.setText('关闭');
		this.actionButton.onclick = () => this.notice.hide();
	}
}

export class ProgressNoticeWidget {
	private type: 'sync' | 'update';
	private notice: Notice;
	private statusEl: HTMLElement;
	private progressBar: HTMLElement;
	private abortButton: HTMLButtonElement;
	private isAborted = false;
	private onComplete: (() => void) | null = null;
	private totalDigits: number;

	constructor(type: 'sync' | 'update', total: number, onAbort: () => void) {
		this.type = type;
		this.totalDigits = Math.max(1, String(total).length);
		this.notice = new Notice('', 0);
		this.notice.messageEl.parentElement?.addClass('lexibridge-progress-notice');
		this.notice.messageEl.empty();
		const headerEl = this.notice.messageEl.createEl('div', {cls: 'lexibridge-notice-header'});
		headerEl.createEl('div', {
			cls: 'lexibridge-notice-title',
			text: type === 'sync' ? '正在同步生词本' : '正在迁移词条',
		});
		this.statusEl = headerEl.createEl('div', {
			cls: 'lexibridge-notice-status',
			text: this.formatProgress(0, total),
		});
		const controlsEl = this.notice.messageEl.createEl('div', {cls: 'lexibridge-notice-controls'});
		const progressTrack = controlsEl.createEl('div', {
			cls: 'lexibridge-notice-progress',
			attr: {role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': '0'},
		});
		this.progressBar = progressTrack.createEl('div', {cls: 'lexibridge-notice-progress-value'});
		this.abortButton = controlsEl.createEl('button', {text: '停止'});
		this.abortButton.addEventListener('click', () => {
			if (this.isAborted) return;
			this.isAborted = true;
			this.abortButton.setText('正在停止');
			this.abortButton.disabled = true;
			onAbort();
		});
	}

	update(current: number, total: number, _word: string): void {
		const safeTotal = Math.max(1, total);
		const percent = Math.min(100, Math.max(0, current / safeTotal * 100));
		this.statusEl.setText(this.formatProgress(current, total));
		this.progressBar.setCssProps({'--lexibridge-notice-progress': `${percent}%`});
		this.progressBar.parentElement?.setAttrs({'aria-valuemax': String(total), 'aria-valuenow': String(current)});
	}

	isAbortedByUser(): boolean {
		return this.isAborted;
	}

	setAborted(count: number): void {
		this.setResult(`${this.type === 'sync' ? '同步' : '迁移'}已中止，已处理 ${count} 个词。`);
		setTimeout(() => this.hide(), 3000);
	}

	setComplete(stats: { uploaded: number; downloaded: number; deletedFromCloud: number; trashedLocally: number; failed: number; skipped?: number }): void {
		if (this.type === 'update') {
			this.setResult(`迁移完成：成功 ${stats.uploaded}，未收录 ${stats.skipped || 0}，失败 ${stats.failed}`);
			setTimeout(() => this.hide(), 3000);
			return;
		}
		const parts: string[] = [];
		if (stats.uploaded > 0) parts.push(`上传 ${stats.uploaded}`);
		if (stats.downloaded > 0) parts.push(`下载 ${stats.downloaded}`);
		if (stats.deletedFromCloud > 0) parts.push(`云端删除 ${stats.deletedFromCloud}`);
		if (stats.trashedLocally > 0) parts.push(`本地删除 ${stats.trashedLocally}`);
		if (stats.failed > 0) parts.push(`失败 ${stats.failed}`);
		this.setResult(parts.length > 0 ? `同步完成：${parts.join('，')}` : '同步完成，无变更。');
		setTimeout(() => this.hide(), 3000);
	}

	private formatProgress(current: number, total: number): string {
		return `${String(current).padStart(this.totalDigits, '0')} / ${total}`;
	}

	private setResult(message: string): void {
		this.statusEl.setText(message);
		this.progressBar.parentElement?.remove();
		this.abortButton.remove();
	}

	hide(): void {
		this.notice.hide();
		if (this.onComplete) {
			this.onComplete();
		}
	}

	setOnComplete(callback: () => void): void {
		this.onComplete = callback;
	}
}

export class BatchUpdateModal extends Modal {
	private stats: BatchUpdateStats;
	private writePreview: BatchWritePreview;
	private onStart: () => void;
	private handleClose: () => void;
	private hasStarted = false;

	constructor(
		app: App,
		stats: BatchUpdateStats,
		writePreview: BatchWritePreview,
		onStart: () => void,
		handleClose: () => void
	) {
		super(app);
		this.stats = stats;
		this.writePreview = writePreview;
		this.onStart = onStart;
		this.handleClose = handleClose;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lexibridge-modal-container', 'lexibridge-batch-update-modal');

		contentEl.createEl('h2', { text: '使用 ECDICT 迁移欧路词条' });
		contentEl.createEl('p', {
			cls: 'lexibridge-modal-help',
			text: '只处理欧路同步生成的基础词条，全程使用本机 ECDICT，不发起在线词典请求。普通手写笔记不会被纳入。'
		});

		const statsGrid = contentEl.createEl('div', { cls: 'lexibridge-stats-grid' });

		const totalCard = statsGrid.createEl('div', { cls: 'lexibridge-stat-card' });
		totalCard.createEl('div', { cls: 'lexibridge-stat-value', text: String(this.stats.total) });
		totalCard.createEl('div', { cls: 'lexibridge-stat-label', text: '总单词数' });

		const updatedCard = statsGrid.createEl('div', { cls: 'lexibridge-stat-card lexibridge-stat-success' });
		updatedCard.createEl('div', { cls: 'lexibridge-stat-value', text: String(this.stats.updated) });
		updatedCard.createEl('div', { cls: 'lexibridge-stat-label', text: '已完成迁移' });

		const pendingCard = statsGrid.createEl('div', { cls: 'lexibridge-stat-card lexibridge-stat-warning' });
		pendingCard.createEl('div', { cls: 'lexibridge-stat-value', text: String(this.stats.pending) });
		pendingCard.createEl('div', { cls: 'lexibridge-stat-label', text: '待从 ECDICT 迁移' });

		if (this.stats.pending > 0) {
			const previewEl = contentEl.createEl('div', { cls: 'lexibridge-batch-preview' });
			previewEl.createEl('p', { text: `将写入字段：${this.writePreview.fields.join('、') || '无'}` });
			previewEl.createEl('p', { text: `将写入标签：${this.writePreview.tags.join('、') || '无'}` });
			previewEl.createEl('p', { text: '迁移时会刷新词典正文，并保留设置中指定标题下的内容。词条来源会改为 ecdict。' });
		}

		if (this.stats.pending === 0) {
			contentEl.createEl('p', { text: '没有需要更新的单词', cls: 'lexibridge-no-pending' });
			new Setting(contentEl)
				.addButton((btn) => {
					btn
						.setButtonText('关闭')
						.onClick(() => this.close());
				});
		} else {
			new Setting(contentEl)
				.addButton((btn) => {
					btn
						.setButtonText('开始迁移')
						.setCta()
						.onClick(() => {
							this.hasStarted = true;
							this.close();
							this.onStart();
						});
				})
				.addButton((btn) => {
					btn
						.setButtonText('取消')
						.onClick(() => this.close());
				});
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (!this.hasStarted) {
			this.handleClose();
		}
	}
}

export class GenerationPreviewModal extends Modal {
	private preview: MarkdownPreview;
	private onConfirm: () => void;
	private onCancel: () => void;
	private decided = false;

	constructor(app: App, preview: MarkdownPreview, onConfirm: () => void, onCancel: () => void) {
		super(app);
		this.preview = preview;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lexibridge-modal-container');

		contentEl.createEl('h2', { text: '预览写入内容' });

		const fields = Object.keys(this.preview.frontmatter).sort();
		contentEl.createEl('p', { text: `将写入字段：${fields.join('、') || '无'}` });
		contentEl.createEl('p', { text: `将写入标签：${this.preview.tags.join('、') || '无'}` });

		const fmTitle = contentEl.createEl('h3', { text: 'Frontmatter' });
		fmTitle.addClass('lexibridge-preview-heading');
		const fmPreview = contentEl.createEl('pre', { cls: 'lexibridge-preview-block' });
		fmPreview.textContent = JSON.stringify(this.preview.frontmatter, null, 2);

		const bodyTitle = contentEl.createEl('h3', { text: '将写入的正文' });
		bodyTitle.addClass('lexibridge-preview-heading');
		const bodyPreview = contentEl.createEl('pre', { cls: 'lexibridge-preview-block' });
		bodyPreview.textContent = this.preview.managedBlock;

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText('确认写入')
					.setCta()
					.onClick(() => {
						this.decided = true;
						this.close();
						this.onConfirm();
					});
			})
			.addButton((button) => {
				button
					.setButtonText('取消')
					.onClick(() => {
						this.decided = true;
						this.close();
						this.onCancel();
					});
			});
	}

	onClose() {
		if (!this.decided) {
			this.onCancel();
		}
		this.contentEl.empty();
	}
}
