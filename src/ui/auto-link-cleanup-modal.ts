import {App, Modal, Setting} from 'obsidian';
import {AutoLinkCleanupPlan} from '../auto-link';
import {markDestructive} from './destructive-button';

export class AutoLinkCleanupModal extends Modal {
	private selected = new Set<string>();

	constructor(app: App, private plan: AutoLinkCleanupPlan, private onConfirm: (targets: Set<string>) => void) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.addClass('lexibridge-auto-link-preview');
		this.contentEl.createEl('h2', {text: '检查词库链接'});
		this.contentEl.createEl('p', {
			cls: 'lexibridge-modal-help',
			text: `发现 ${this.plan.candidates.length} 个词条，共 ${this.plan.occurrences.length} 个指向单词文件夹的真实链接。选择需要还原为普通文本的词条。`,
		});
		const list = this.contentEl.createDiv({cls: 'lexibridge-auto-link-candidates'});
		for (const candidate of this.plan.candidates) {
			const label = list.createEl('label', {cls: 'lexibridge-auto-link-candidate'});
			const checkbox = label.createEl('input', {type: 'checkbox'});
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) this.selected.add(candidate.target);
				else this.selected.delete(candidate.target);
			});
			label.createSpan({text: `${candidate.target.split('/').pop() || candidate.target} · ${candidate.count} 处 · ${candidate.examples.join('、')}`});
		}
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText('取消').onClick(() => this.close()))
			.addButton(button => markDestructive(button.setButtonText('移除所选链接')).onClick(() => {
				const selected = new Set(this.selected);
				this.close();
				this.onConfirm(selected);
			}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
