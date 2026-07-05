import { App, Modal, Setting } from 'obsidian';
import { Notice } from 'obsidian';

export interface BatchUpdateStats {
	total: number;
	updated: number;
	pending: number;
}

export class ProgressNoticeWidget {
	private notice: Notice;
	private titleEl: HTMLElement;
	private wordEl: HTMLElement;
	private progressBar: HTMLProgressElement;
	private abortBtn: HTMLButtonElement;
	private isAborted = false;
	private onComplete: (() => void) | null = null;

	constructor(type: 'sync' | 'update', total: number, onAbort: () => void) {
		this.notice = new Notice('', 0);
		this.notice.messageEl.addClass('lexibridge-progress-notice');
		this.notice.messageEl.empty();

		this.titleEl = this.notice.messageEl.createEl('div', { cls: 'lexibridge-notice-title' });
		this.titleEl.textContent = type === 'sync' ? 'LexiBridge 正在同步...' : 'LexiBridge 正在更新...';

		this.wordEl = this.notice.messageEl.createEl('div', { cls: 'lexibridge-notice-word' });

		this.progressBar = this.notice.messageEl.createEl('progress', { cls: 'lexibridge-notice-progress' });
		this.progressBar.value = 0;
		this.progressBar.max = total;

		this.abortBtn = this.notice.messageEl.createEl('button', { cls: 'lexibridge-notice-abort mod-warning' });
		this.abortBtn.textContent = '停止';
		this.abortBtn.onclick = () => {
			this.isAborted = true;
			this.abortBtn.textContent = '正在停止...';
			this.abortBtn.disabled = true;
			onAbort();
		};
	}

	update(current: number, total: number, word: string): void {
		this.progressBar.value = current;
		this.progressBar.max = total;
		this.wordEl.textContent = `${word} (${current}/${total})`;
	}

	isAbortedByUser(): boolean {
		return this.isAborted;
	}

	setAborted(count: number): void {
		this.notice.messageEl.empty();
		this.notice.messageEl.addClass('lexibridge-notice-complete');
		this.notice.messageEl.createEl('div', { cls: 'lexibridge-notice-result' })
			.textContent = `同步已中止，已处理 ${count} 个词。`;
		setTimeout(() => this.hide(), 3000);
	}

	setComplete(stats: { uploaded: number; downloaded: number; deletedFromCloud: number; trashedLocally: number; failed: number }): void {
		this.notice.messageEl.empty();
		this.notice.messageEl.addClass('lexibridge-notice-complete');
		const resultEl = this.notice.messageEl.createEl('div', { cls: 'lexibridge-notice-result' });
		const parts: string[] = [];
		if (stats.uploaded > 0) parts.push(`上传 ${stats.uploaded}`);
		if (stats.downloaded > 0) parts.push(`下载 ${stats.downloaded}`);
		if (stats.deletedFromCloud > 0) parts.push(`云端删除 ${stats.deletedFromCloud}`);
		if (stats.trashedLocally > 0) parts.push(`本地删除 ${stats.trashedLocally}`);
		if (stats.failed > 0) parts.push(`失败 ${stats.failed}`);
		resultEl.textContent = parts.length > 0 ? `同步完成：${parts.join('，')}` : '同步完成，无变更。';
		setTimeout(() => this.hide(), 3000);
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
	private onStart: () => void;
	private handleClose: () => void;
	private hasStarted = false;

	constructor(
		app: App,
		stats: BatchUpdateStats,
		onStart: () => void,
		handleClose: () => void
	) {
		super(app);
		this.stats = stats;
		this.onStart = onStart;
		this.handleClose = handleClose;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lexibridge-modal-container', 'lexibridge-batch-update-modal');

		contentEl.createEl('h2', { text: '批量更新释义' });

		const statsGrid = contentEl.createEl('div', { cls: 'lexibridge-stats-grid' });

		const totalCard = statsGrid.createEl('div', { cls: 'lexibridge-stat-card' });
		totalCard.createEl('div', { cls: 'lexibridge-stat-value', text: String(this.stats.total) });
		totalCard.createEl('div', { cls: 'lexibridge-stat-label', text: '总单词数' });

		const updatedCard = statsGrid.createEl('div', { cls: 'lexibridge-stat-card lexibridge-stat-success' });
		updatedCard.createEl('div', { cls: 'lexibridge-stat-value', text: String(this.stats.updated) });
		updatedCard.createEl('div', { cls: 'lexibridge-stat-label', text: '已更新详尽释义' });

		const pendingCard = statsGrid.createEl('div', { cls: 'lexibridge-stat-card lexibridge-stat-warning' });
		pendingCard.createEl('div', { cls: 'lexibridge-stat-value', text: String(this.stats.pending) });
		pendingCard.createEl('div', { cls: 'lexibridge-stat-label', text: '待更新基础释义' });

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
						.setButtonText('开始批量更新')
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
