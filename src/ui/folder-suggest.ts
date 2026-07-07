import {AbstractInputSuggest, App, TAbstractFile, TFolder} from "obsidian";

export class FolderSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, private inputEl: HTMLInputElement) {
		super(app, inputEl);
	}

	getSuggestions(inputStr: string): string[] {
		const lowerCaseInputStr = inputStr.toLowerCase();
		const folders: string[] = [];

		this.app.vault.getAllLoadedFiles().forEach((folder: TAbstractFile) => {
			if (folder instanceof TFolder) {
				folders.push(folder.path);
			}
		});

		return folders.filter((folder: string) =>
			folder.toLowerCase().includes(lowerCaseInputStr)
		);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.inputEl.value = value;
		this.inputEl.trigger('input');
		this.close();
	}
}
