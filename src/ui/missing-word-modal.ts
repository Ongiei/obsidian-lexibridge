import {App, Modal, Notice, Setting} from 'obsidian';
import {AutoLinkCandidate} from '../auto-link';

const MAX_SELECTION = 20;

export class MissingWordModal extends Modal {
	private selected = new Set<string>();

	constructor(app: App, private candidates: AutoLinkCandidate[], private onConfirm: (words: string[]) => void) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.addClass('lexibridge-auto-link-preview');
		this.contentEl.createEl('h2', {text: '发现未建词条'});
		this.contentEl.createEl('p', {
			cls: 'lexibridge-modal-help',
			text: `发现 ${this.candidates.length} 个尚未出现在单词文件夹中的英文单词。默认不选择；每次最多创建 ${MAX_SELECTION} 个，并逐个显示现有写入预览。`,
		});
		const list = this.contentEl.createDiv({cls: 'lexibridge-auto-link-candidates'});
		for (const candidate of this.candidates) {
			const label = list.createEl('label', {cls: 'lexibridge-auto-link-candidate'});
			const checkbox = label.createEl('input', {type: 'checkbox'});
			checkbox.addEventListener('change', () => {
				if (checkbox.checked && this.selected.size >= MAX_SELECTION) {
					checkbox.checked = false;
					new Notice(`每次最多选择 ${MAX_SELECTION} 个单词。`);
					return;
				}
				if (checkbox.checked) this.selected.add(candidate.target);
				else this.selected.delete(candidate.target);
			});
			label.createSpan({text: `${candidate.target} · 出现 ${candidate.count} 次`});
		}
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText('取消').onClick(() => this.close()))
			.addButton(button => button.setButtonText('创建所选词条').setCta().onClick(() => {
				const words = [...this.selected];
				this.close();
				this.onConfirm(words);
			}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
