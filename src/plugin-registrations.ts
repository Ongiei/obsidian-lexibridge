import {Editor, MarkdownFileInfo, MarkdownView, Menu, Notice, Plugin, TFile} from 'obsidian';
import type LexiBridgePlugin from './main';
import {DefinitionPopover} from './popover';
import {isValidWord, sanitizeWord} from './utils/word';

type RegistrationHost = Plugin & Pick<
	LexiBridgePlugin,
	'activateView' | 'autoLinkDocument' | 'inspectAndRemoveWordLinks' | 'discoverMissingWords' | 'enhanceWordOnline' | 'findEntry' | 'findEntryFromSource' | 'performBatchUpdate' | 'performSync' | 'searchAndGenerateNote'
	| 'createAnkiDeck' | 'loadAnkiDeckNames' | 'previewCurrentWordAnkiSync' | 'previewFullAnkiSync' | 'testAnkiConnection' | 'settings'
>;

export function registerPluginCommands(plugin: RegistrationHost): void {
	plugin.addCommand({
		id: 'open-dictionary-view',
		name: '打开词典视图',
		callback: () => {
			void plugin.activateView();
		}
	});

	plugin.addCommand({
		id: 'auto-link-current-section',
		name: '链接当前章节中的词库单词',
		editorCallback: (editor: Editor) => {
			void plugin.autoLinkDocument(editor, 'section');
		}
	});

	plugin.addCommand({
		id: 'auto-link-selection',
		name: '链接选区中的词库单词',
		editorCallback: (editor: Editor) => {
			void plugin.autoLinkDocument(editor, 'selection');
		}
	});

	plugin.addCommand({
		id: 'inspect-remove-word-links',
		name: '检查并移除当前文档中的词库链接',
		editorCallback: (editor: Editor) => {
			void plugin.inspectAndRemoveWordLinks(editor);
		}
	});

	plugin.addCommand({
		id: 'discover-missing-word-notes',
		name: '发现当前文档中尚未创建的词条',
		editorCallback: (editor: Editor) => {
			void plugin.discoverMissingWords(editor);
		}
	});

	plugin.addCommand({
		id: 'define-selected-word',
		name: '创建选中或光标处单词的词元笔记',
		editorCallback: (editor: Editor, _view: MarkdownView | MarkdownFileInfo) => {
			const word = getEditorWord(editor, true);
			if (!word) return;
			void plugin.searchAndGenerateNote(word, editor);
		}
	});

	plugin.addCommand({
		id: 'lookup-selection',
		name: '查询选中或光标处单词',
		editorCallback: async (editor: Editor, _view: MarkdownView | MarkdownFileInfo) => {
			const word = getEditorWord(editor, false);
			if (!word) return;
			await showDefinitionPopover(plugin, editor, word, plugin.settings.selectionLookupSource);
		}
	});

	plugin.addCommand({
		id: 'mobile-lookup-word',
		name: '查询选中或光标处单词（旧版移动端入口）',
		mobileOnly: true,
		editorCallback: async (editor: Editor) => {
			const word = getEditorWord(editor, false);
			if (word) await showDefinitionPopover(plugin, editor, word, plugin.settings.selectionLookupSource);
		}
	});

	plugin.addCommand({
		id: 'mobile-create-word-note',
		name: '创建选中或光标处单词笔记（旧版移动端入口）',
		mobileOnly: true,
		editorCallback: (editor: Editor) => {
			const word = getEditorWord(editor, true);
			if (word) void plugin.searchAndGenerateNote(word, editor);
		}
	});

	plugin.addCommand({
		id: 'sync-preview',
		name: '同步欧路生词本',
		callback: () => {
			void plugin.performSync(false);
		}
	});

	plugin.addCommand({
		id: 'auto-link-document',
		name: '自动链接当前文档',
		editorCallback: (editor: Editor) => {
			void plugin.autoLinkDocument(editor);
		}
	});

	plugin.addCommand({
		id: 'batch-update-definitions',
		name: '使用 ECDICT 批量迁移欧路词条',
		callback: () => {
			void plugin.performBatchUpdate();
		}
	});

	plugin.addCommand({
		id: 'enhance-selection-with-youdao',
		name: '使用有道在线增强选中词条',
		editorCallback: (editor: Editor) => {
			const word = sanitizeWord(editor.getSelection());
			if (!isValidWord(word)) {
				new Notice('请先选择一个有效的单词');
				return;
			}
			void plugin.enhanceWordOnline(word);
		}
	});

	plugin.addCommand({
		id: 'anki-test-connection',
		name: '测试 AnkiConnect 连接',
		callback: async () => {
			try {
				const version = await plugin.testAnkiConnection();
				new Notice(`AnkiConnect 连接正常，API v${version}`);
			} catch (error) {
				new Notice(`AnkiConnect 连接失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});

	plugin.addCommand({
		id: 'anki-preview-full-sync',
		name: '同步单词笔记到 Anki',
		callback: () => {
			void plugin.previewFullAnkiSync();
		}
	});

	plugin.addCommand({
		id: 'anki-sync-current-word',
		name: '同步当前单词笔记到 Anki',
		callback: () => {
			void plugin.previewCurrentWordAnkiSync();
		}
	});
}

export function registerPluginMenus(plugin: RegistrationHost): void {
	plugin.registerEvent(
		plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, _view: MarkdownView | MarkdownFileInfo) => {
			const selection = editor.getSelection();
			if (!selection || selection.trim() === '') return;

			const word = sanitizeWord(selection);
			if (!isValidWord(word)) return;

			menu.addItem((item) => {
				item
					.setTitle('LexiBridge：创建词元笔记')
					.setIcon('book-open')
					.onClick(() => {
						void plugin.searchAndGenerateNote(word, editor);
					});
			});

			menu.addItem((item) => {
				item
					.setTitle('LexiBridge：查询选中内容')
					.setIcon('search')
					.onClick(() => {
						void showDefinitionPopover(plugin, editor, word, plugin.settings.selectionLookupSource);
					});
			});

		})
	);

	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu: Menu, file) => {
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			const folderPath = plugin.settings.folderPath.replace(/\/$/, '');
			if (file.path !== folderPath && !file.path.startsWith(`${folderPath}/`)) return;
			const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter as unknown;
			const frontmatterWord = frontmatter && typeof frontmatter === 'object'
				? (frontmatter as Record<string, unknown>).word
				: undefined;
			const word = sanitizeWord(typeof frontmatterWord === 'string' ? frontmatterWord : file.basename);
			if (!isValidWord(word)) return;
			menu.addItem(item => item
					.setTitle('LexiBridge：使用有道在线增强')
				.setIcon('sparkles')
				.onClick(() => void plugin.enhanceWordOnline(word)));
		})
	);
}

async function showDefinitionPopover(plugin: RegistrationHost, editor: Editor, word: string, source: 'ecdict' | 'youdao'): Promise<void> {
	const popover = new DefinitionPopover(plugin as LexiBridgePlugin, editor, word);
	try {
		const result = await plugin.findEntryFromSource(word, source);
		if (result) {
			popover.setEntry(result.entry, result.source);
		} else {
			popover.close();
			new Notice(`未找到定义： ${word}`);
		}
	} catch (error) {
		popover.close();
		const errorMsg = error instanceof Error ? error.message : 'Unknown error';
		new Notice(`查询失败：${errorMsg}`);
	}
}

function getEditorWord(editor: Editor, selectCursorWord: boolean): string | null {
	const selected = sanitizeWord(editor.getSelection());
	if (isValidWord(selected)) return selected;
	const cursor = editor.getCursor();
	const line = editor.getLine(cursor.line);
	const pattern = /[a-zA-Z]+(?:[-'][a-zA-Z]+)*/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(line)) !== null) {
		const start = match.index;
		const end = start + match[0].length;
		if (cursor.ch < start || cursor.ch > end) continue;
		const word = sanitizeWord(match[0]);
		if (!isValidWord(word)) break;
		if (selectCursorWord) {
			editor.setSelection({line: cursor.line, ch: start}, {line: cursor.line, ch: end});
		}
		return word;
	}
	new Notice('请先选择一个有效的单词，或将光标放在单词中。');
	return null;
}
