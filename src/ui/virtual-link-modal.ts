import {App, Modal, Setting} from 'obsidian';

export class VirtualLinkModal extends Modal {
	constructor(
		app: App,
		private word: string,
		private onLookup: () => void,
		private onCreate: () => void,
		private onLink: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.addClass('lexibridge-virtual-link-modal');
		this.contentEl.createEl('h2', {text: this.word});
		this.contentEl.createEl('p', {cls: 'lexibridge-modal-help', text: '这是词库中的虚拟链接，当前 Markdown 尚未被修改。'});
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText('查词').onClick(() => this.run(this.onLookup)))
			.addButton(button => button.setButtonText('创建或更新词元笔记').onClick(() => this.run(this.onCreate)))
			.addButton(button => button.setButtonText('写入真实链接').setCta().onClick(() => this.run(this.onLink)));
	}

	private run(action: () => void): void {
		this.close();
		action();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
