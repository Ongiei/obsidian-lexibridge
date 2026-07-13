import {App, MarkdownRenderChild, MarkdownRenderer, Modal, Setting, TFile} from 'obsidian';

export class VirtualLinkModal extends Modal {
	private renderChild: MarkdownRenderChild | null = null;
	private closed = false;
	constructor(
		app: App,
		private word: string,
		private target: string,
		private onLookup: () => void,
		private onCreate: () => void,
		private onLink: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		this.contentEl.addClass('lexibridge-virtual-link-modal');
		this.contentEl.createEl('h2', {text: this.word});
		this.contentEl.createEl('p', {cls: 'lexibridge-modal-help', text: '这是词库中的虚拟链接，当前 Markdown 尚未被修改。'});
		const preview = this.contentEl.createEl('div', {cls: 'lexibridge-virtual-link-preview'});
		preview.createEl('p', {cls: 'lexibridge-message', text: '正在加载单词笔记预览...'});
		void this.renderPreview(preview);
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText('查词').onClick(() => this.run(this.onLookup)))
			.addButton(button => button.setButtonText('创建或更新词元笔记').onClick(() => this.run(this.onCreate)))
			.addButton(button => button.setButtonText('写入真实链接').setCta().onClick(() => this.run(this.onLink)));
	}

	private async renderPreview(container: HTMLElement): Promise<void> {
		const path = this.target.endsWith('.md') ? this.target : `${this.target}.md`;
		const file = this.app.vault.getAbstractFileByPath(path);
		container.empty();
		if (!(file instanceof TFile)) {
			container.createEl('p', {cls: 'lexibridge-message', text: '找不到对应的单词笔记。'});
			return;
		}
		try {
			const content = await this.app.vault.cachedRead(file);
			if (this.closed) return;
			this.renderChild = new MarkdownRenderChild(container);
			this.renderChild.load();
			await MarkdownRenderer.render(this.app, content, container, file.path, this.renderChild);
		} catch (error) {
			container.createEl('p', {
				cls: 'lexibridge-message',
				text: `预览加载失败：${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	private run(action: () => void): void {
		this.close();
		action();
	}

	onClose(): void {
		this.closed = true;
		this.renderChild?.unload();
		this.renderChild = null;
		this.contentEl.empty();
	}
}
