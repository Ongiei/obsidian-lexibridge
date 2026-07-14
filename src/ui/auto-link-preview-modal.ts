import {App, Modal, Setting} from 'obsidian';
import {AutoLinkPlan} from '../auto-link';

export class AutoLinkPreviewModal extends Modal {
	private selected = new Set<string>();

	constructor(
		app: App,
		private plan: AutoLinkPlan,
		private scopeLabel: string,
		private onConfirm: (selectedTargets: Set<string>) => void
	) {
		super(app);
		for (const candidate of plan.candidates) this.selected.add(candidate.target);
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass('lexibridge-auto-link-preview');
		contentEl.createEl('h2', {text: '链接预览'});
		contentEl.createEl('p', {
			cls: 'lexibridge-modal-help',
			text: `${this.scopeLabel}发现 ${this.plan.candidates.length} 个词条，共 ${this.plan.occurrences.length} 处可链接内容。`,
		});

		const controls = new Setting(contentEl)
			.addButton(button => button.setButtonText('全选').onClick(() => {
				for (const candidate of this.plan.candidates) this.selected.add(candidate.target);
				this.renderCandidates(list);
			}))
			.addButton(button => button.setButtonText('清空').onClick(() => {
				this.selected.clear();
				this.renderCandidates(list);
			}));
		controls.settingEl.addClass('lexibridge-auto-link-preview-controls');

		const list = contentEl.createDiv({cls: 'lexibridge-auto-link-candidates'});
		this.renderCandidates(list);

		const actions = new Setting(contentEl)
			.addButton(button => button.setButtonText('取消').onClick(() => this.close()))
			.addButton(button => button.setButtonText('写入链接').setCta().onClick(() => {
				const selected = new Set(this.selected);
				this.close();
				this.onConfirm(selected);
			}));
		actions.settingEl.addClass('lexibridge-modal-actions');
	}

	private renderCandidates(container: HTMLElement): void {
		container.empty();
		for (const candidate of this.plan.candidates) {
			const label = container.createEl('label', {cls: 'lexibridge-auto-link-candidate'});
			const checkbox = label.createEl('input', {type: 'checkbox'});
			checkbox.checked = this.selected.has(candidate.target);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) this.selected.add(candidate.target);
				else this.selected.delete(candidate.target);
			});
			const text = label.createSpan();
			text.createEl('strong', {text: candidate.target.split('/').pop() || candidate.target});
			text.createSpan({text: ` · ${candidate.count} 处 · ${candidate.examples.join('、')}`});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
