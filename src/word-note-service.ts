import {App, Editor, Notice, TFile, TFolder} from 'obsidian';
import {LexiBridgeSettings} from './settings';
import {DictEntry} from './types';
import {getLemma} from './lemmatizer';
import {resolveDictionaryWordName, sanitizeWord} from './utils/word';
import {GenerationPreviewModal} from './modal';
import {MarkdownGenerator} from './utils/markdown-generator';
import {DictionaryLookupResult, DictionaryProviderId, DictionaryService} from './dictionary-provider';

export class WordNoteService {
	constructor(
		private app: App,
		private getSettings: () => LexiBridgeSettings,
		private dictionaryService: DictionaryService
	) {}

	async findEntry(word: string, useLemmatizerFlag: boolean = true): Promise<(DictionaryLookupResult & { word: string }) | null> {
		const searchWord = sanitizeWord(word).toLowerCase();

		if (!searchWord) {
			return null;
		}

		const lookupWord = useLemmatizerFlag ? getLemma(searchWord) : searchWord;
		const result = await this.dictionaryService.lookup(lookupWord);

		if (!result) {
			return null;
		}

		return { ...result, word: resolveDictionaryWordName(word, result.entry.word) };
	}

	async findEntryFromSource(word: string, source: DictionaryProviderId): Promise<(DictionaryLookupResult & { word: string }) | null> {
		const lookupWord = sanitizeWord(word).toLowerCase();
		if (!lookupWord) return null;
		const result = source === 'ecdict'
			? await this.dictionaryService.lookupLocal(lookupWord)
			: await this.dictionaryService.lookupOnline(lookupWord);
		return result ? { ...result, word: resolveDictionaryWordName(word, result.entry.word) } : null;
	}

	async searchAndGenerateNote(searchWord: string, editor?: Editor): Promise<void> {
		let result: (DictionaryLookupResult & { word: string }) | null;
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

		const { entry, source } = result;
		const noteWord = resolveDictionaryWordName(searchWord, entry.word, {
			preserveTitleCase: editor ? !this.isSentenceInitial(editor) : false,
		});

		await this.writeWordFile(noteWord, entry, searchWord, source);
		this.replaceSelectedTextWithLink(editor, noteWord);
	}

	generateMarkdown(
		word: string,
		entry: DictEntry,
		originalWord?: string,
		source: DictionaryProviderId = 'ecdict'
	): string {
		const settings = this.getSettings();
		return MarkdownGenerator.generate(word, entry, {
			originalWord,
			dictSource: source,
			frontmatterTemplate: settings.frontmatterTemplate,
			bodyTemplate: settings.bodyTemplate,
			includeExamProperties: settings.includeExamProperties,
			includePosProperties: settings.includePosProperties,
		});
	}

	async createWordFile(
		word: string,
		entry: DictEntry,
		originalWord?: string,
		source: DictionaryProviderId = 'ecdict'
	): Promise<void> {
		const noteWord = resolveDictionaryWordName(word, entry.word);
		await this.writeWordFile(noteWord, entry, originalWord, source);
	}

	private async writeWordFile(
		word: string,
		entry: DictEntry,
		originalWord?: string,
		source: DictionaryProviderId = 'ecdict'
	): Promise<void> {
		const noteWord = sanitizeWord(word);
		if (!noteWord) {
			new Notice('无法创建空白单词文件。');
			return;
		}
		const settings = this.getSettings();
		const folderPath = settings.folderPath;
		const fileName = `${noteWord}.md`;
		const filePath = `${folderPath}/${fileName}`;

		try {
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!folder) {
				await this.app.vault.createFolder(folderPath);
			} else if (!(folder instanceof TFolder)) {
				throw new Error(`单词笔记路径已被文件占用: ${folderPath}`);
			}

			const existingFile = this.app.vault.getAbstractFileByPath(filePath);
			const markdown = this.generateMarkdown(noteWord, entry, originalWord, source);

			if (!await this.confirmGeneratedContent(noteWord, entry, originalWord, source)) {
				new Notice('已取消写入单词文件');
				return;
			}

			if (existingFile instanceof TFile) {
				await this.app.vault.process(existingFile, currentContent =>
					MarkdownGenerator.mergeWithExisting(currentContent, markdown, settings.protectedHeadings)
				);
				new Notice(`已更新单词文件: ${fileName}`);
			} else if (existingFile) {
				throw new Error(`单词笔记路径已被文件夹占用: ${filePath}`);
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

	private isSentenceInitial(editor: Editor): boolean {
		const from = editor.getCursor('from');
		const prefix = editor.getLine(from.line).slice(0, from.ch);
		if (/^[\s>"'“‘([{]*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)?$/.test(prefix)) return true;

		const before = editor.getRange({line: 0, ch: 0}, from).replace(/\s+$/, '');
		return !before || /[.!?。！？]["'”’)}\]]*$/.test(before);
	}

	private async confirmGeneratedContent(
		word: string,
		entry: DictEntry,
		originalWord: string | undefined,
		source: DictionaryProviderId
	): Promise<boolean> {
		const settings = this.getSettings();
		if (!settings.previewBeforeWrite) {
			return true;
		}

		const preview = MarkdownGenerator.preview(word, entry, {
			originalWord,
			dictSource: source,
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
