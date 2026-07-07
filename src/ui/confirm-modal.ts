import {App, Modal} from "obsidian";

export class ConfirmModal extends Modal {
	private isConfirmState = false;

	constructor(
		app: App,
		private message: string,
		private onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.addClass('lexibridge-confirm-modal');

		contentEl.createEl('p', {text: this.message});

		const btnContainer = contentEl.createEl('div', {cls: 'lexibridge-confirm-buttons'});

		const confirmBtn = btnContainer.createEl('button', {cls: 'mod-warning'});
		confirmBtn.textContent = '执行';
		confirmBtn.onclick = () => {
			if (!this.isConfirmState) {
				this.isConfirmState = true;
				confirmBtn.textContent = '再次确认执行';
				confirmBtn.addClass('mod-danger');
			} else {
				this.close();
				this.onConfirm();
			}
		};

		const cancelBtn = btnContainer.createEl('button');
		cancelBtn.textContent = '取消';
		cancelBtn.onclick = () => this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
