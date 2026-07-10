import {App, Editor, Notice, TFile} from 'obsidian';
import {LexiBridgeSettings} from './settings';
import {DictEntry} from './types';
import {YoudaoService} from './youdao';
import {getLemma} from './lemmatizer';
import {GenerationPreviewModal} from './modal';
import {MarkdownGenerator} from './utils/markdown-generator';

export class WordNoteService {
	constructor(
		private app: App,
		private getSettings: () => LexiBridgeSettings
	) {}

	async findEntry(word: string, useLemmatizerFlag: boolean = true): Promise<{ entry: DictEntry; word: string } | null> {
		const searchWord = word.toLowerCase().trim();

		if (!searchWord) {
			return null;
		}

		const lookupWord = useLemmatizerFlag ? getLemma(searchWord) : searchWord;
		const entry = await YoudaoService.lookup(lookupWord);

		if (!entry) {
			return null;
		}

		return { entry, word: lookupWord };
	}

	async searchAndGenerateNote(searchWord: string, editor?: Editor): Promise<void> {
		let result: { entry: DictEntry; word: string } | null;
		try {
			result = await this.findEntry(searchWord, true);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`查询失败：${message}`);
			console.error('[LexiBridge] Dictionary lookup failed:', error);
			return;
		}

		if (!result) {
			new Notice(`词典中未找到单词 "${searchWord}"`);
			return;
		}

		const { entry, word: lemma } = result;

		await this.createWordFile(lemma, entry, searchWord);
		this.replaceSelectedTextWithLink(editor, lemma);
	}

	generateMarkdown(word: string, entry: DictEntry, originalWord?: string): string {
		const settings = this.getSettings();
		return MarkdownGenerator.generate(word, entry, {
			originalWord,
			dictSource: 'youdao',
			frontmatterTemplate: settings.frontmatterTemplate,
			bodyTemplate: settings.bodyTemplate,
			includeExamProperties: settings.includeExamProperties,
			includePosProperties: settings.includePosProperties,
		});
	}

	async createWordFile(word: string, entry: DictEntry, originalWord?: string): Promise<void> {
		const settings = this.getSettings();
		const folderPath = settings.folderPath;
		const fileName = `${word}.md`;
		const filePath = `${folderPath}/${fileName}`;

		try {
			const folderExists = await this.app.vault.adapter.exists(folderPath);
			if (!folderExists) {
				await this.app.vault.createFolder(folderPath);
			}

			const fileExists = await this.app.vault.adapter.exists(filePath);
			const markdown = this.generateMarkdown(word, entry, originalWord);

			if (!await this.confirmGeneratedContent(word, entry, originalWord)) {
				new Notice('已取消写入单词文件');
				return;
			}

			if (fileExists) {
				const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
				if (abstractFile instanceof TFile) {
					const existingContent = await this.app.vault.read(abstractFile);
					await this.app.vault.modify(abstractFile, MarkdownGenerator.mergeWithExisting(existingContent, markdown));
					new Notice(`已更新单词文件: ${fileName}`);
				}
			} else {
				await this.app.vault.create(filePath, markdown);
				new Notice(`已创建单词文件: ${fileName}`);
			}

			await this.app.workspace.openLinkText(filePath, '', true);
		} catch (error) {
			new Notice(`创建单词文件失败: ${fileName}`);
			console.error('Error creating word file:', error);
		}
	}

	private async confirmGeneratedContent(word: string, entry: DictEntry, originalWord?: string): Promise<boolean> {
		const settings = this.getSettings();
		if (!settings.previewBeforeWrite) {
			return true;
		}

		const preview = MarkdownGenerator.preview(word, entry, {
			originalWord,
			dictSource: 'youdao',
			frontmatterTemplate: settings.frontmatterTemplate,
			bodyTemplate: settings.bodyTemplate,
			includeExamProperties: settings.includeExamProperties,
			includePosProperties: settings.includePosProperties,
		});

		return new Promise((resolve) => {
			new GenerationPreviewModal(
				this.app,
				preview,
				() => resolve(true),
				() => resolve(false)
			).open();
		});
	}

	private replaceSelectedTextWithLink(editor: Editor | undefined, lemma: string): void {
		if (!editor) {
			return;
		}

		const selectedText = editor.getSelection();
		if (!selectedText || selectedText.trim() === '') {
			return;
		}

		const originalText = selectedText.trim();
		if (lemma === originalText) {
			editor.replaceSelection(`[[${lemma}]]`);
		} else {
			editor.replaceSelection(`[[${lemma}|${originalText}]]`);
		}
	}
}
