import { App, Modal, Setting } from 'obsidian';
import { AnkiPreviewResult } from './types';

export interface AnkiMissingSourceActions {
	onTag?: () => Promise<void>;
	onSuspend?: () => Promise<void>;
	onDelete?: () => Promise<void>;
}

export class AnkiSyncPreviewModal extends Modal {
	constructor(
		app: App,
		private result: AnkiPreviewResult,
		private onConfirm?: () => Promise<void>,
		private missingSourceActions: AnkiMissingSourceActions = {}
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('lexibridge-anki-preview');
		contentEl.createEl('h2', { text: 'Anki 同步预览' });
		contentEl.createEl('p', {
			text: '这是只读预检，不会创建、更新或删除 Anki 笔记。',
		});

		const { plan } = this.result;
		const summary = contentEl.createEl('div', { cls: 'lexibridge-anki-preview-summary' });
		addSummaryItem(summary, '待新增', plan.adds.length);
		addSummaryItem(summary, '待更新', plan.updates.length);
		addSummaryItem(summary, '无需变更', plan.unchanged.length);
		addSummaryItem(summary, '源文件缺失', plan.missingSources.length);
		addSummaryItem(summary, '冲突', plan.conflicts.length);
		addSummaryItem(summary, '错误', plan.errors.length);

		if (plan.conflicts.length > 0) {
			renderList(contentEl, '冲突', plan.conflicts.map(conflict => `${conflict.lexiBridgeId}: ${conflict.message}`));
		}
		if (plan.errors.length > 0) {
			renderList(contentEl, '错误', plan.errors.map(error => `${error.filePath ? `${error.filePath}: ` : ''}${error.message}`));
		}
		if (plan.adds.length > 0) {
			renderList(contentEl, '待新增词条', plan.adds.slice(0, 20).map(item => item.desired.word));
		}
		if (plan.updates.length > 0) {
			renderList(contentEl, '待更新词条', plan.updates.slice(0, 20).map(item => item.desired.word));
		}

		const actions = new Setting(contentEl);
		if (this.onConfirm) {
			actions.addButton(button => {
				const canWrite = plan.conflicts.length === 0 && plan.errors.length === 0 && (plan.adds.length + plan.updates.length) > 0;
				button
					.setButtonText('发送到 Anki')
					.setCta()
					.setDisabled(!canWrite)
					.onClick(async () => {
						button.setDisabled(true);
						this.close();
						await this.onConfirm?.();
					});
			});
		}
		if (plan.missingSources.length > 0) {
			const canLifecycle = plan.conflicts.length === 0 && plan.errors.length === 0;
			const canDestructive = canLifecycle && this.result.desiredCount > 0;
			if (this.missingSourceActions.onTag) {
				actions.addButton(button => {
					button
						.setButtonText('标记缺失源')
						.setDisabled(!canLifecycle)
						.onClick(async () => {
							button.setDisabled(true);
							this.close();
							await this.missingSourceActions.onTag?.();
						});
				});
			}
			if (this.missingSourceActions.onSuspend) {
				actions.addButton(button => {
					button
						.setButtonText('暂停缺失源卡片')
						.setDisabled(!canDestructive)
						.onClick(async () => {
							button.setDisabled(true);
							this.close();
							await this.missingSourceActions.onSuspend?.();
						});
				});
			}
			if (this.missingSourceActions.onDelete) {
				actions.addButton(button => {
					button
						.setButtonText('删除缺失源笔记')
						.setWarning()
						.setDisabled(!canDestructive)
						.onClick(async () => {
							button.setDisabled(true);
							this.close();
							await this.missingSourceActions.onDelete?.();
						});
				});
			}
		}
		actions.addButton(button => {
			button.setButtonText('关闭').setCta().onClick(() => this.close());
		});
	}
}

function addSummaryItem(container: HTMLElement, label: string, value: number): void {
	const item = container.createEl('div', { cls: 'lexibridge-anki-preview-summary-item' });
	item.createEl('strong', { text: String(value) });
	item.createEl('span', { text: label });
}

function renderList(container: HTMLElement, title: string, items: string[]): void {
	const details = container.createEl('details');
	details.createEl('summary', { text: `${title}（${items.length}）` });
	const list = details.createEl('ul');
	for (const item of items) {
		list.createEl('li', { text: item });
	}
}
