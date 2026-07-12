import { Notice } from 'obsidian';

export class AnkiProgressNotice {
	private notice: Notice;

	constructor(message: string) {
		this.notice = new Notice(message, 0);
	}

	update(message: string): void {
		this.notice.setMessage(message);
	}

	hide(): void {
		this.notice.hide();
	}
}
