import {App, Modal, Notice, Setting} from 'obsidian';
import {SyncHistoryEntry} from '../sync';

const TYPE_LABELS: Record<SyncHistoryEntry['type'], string> = {
	'local-add': '本地新增',
	'local-delete': '本地删除',
	'cloud-add': '云端新增',
	'cloud-delete': '云端删除',
	restore: '已恢复',
};

export class SyncHistoryModal extends Modal {
	constructor(
		app: App,
		private entries: SyncHistoryEntry[],
		private undo: (id: string) => Promise<boolean>
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl('h2', {text: '生词本增删记录'});
		const recent = [...this.entries].reverse().slice(0, 50);
		if (recent.length === 0) {
			this.contentEl.createEl('p', {text: '还没有增删记录。'});
			return;
		}
		for (const entry of recent) {
			const setting = new Setting(this.contentEl)
				.setName(`${TYPE_LABELS[entry.type]} · ${entry.word}`)
				.setDesc(`${new Date(entry.timestamp).toLocaleString()} · ${entry.path}`);
			if ((entry.type === 'local-delete' || entry.type === 'cloud-delete') && !entry.undone) {
				setting.addButton(button => button.setButtonText('撤销').onClick(async () => {
					button.setDisabled(true);
					const restored = await this.undo(entry.id);
					new Notice(restored ? `已恢复 ${entry.word}` : `无法恢复 ${entry.word}`);
					if (restored) {
						entry.undone = true;
						button.buttonEl.remove();
					} else {
						button.setDisabled(false);
					}
				}));
			}
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
