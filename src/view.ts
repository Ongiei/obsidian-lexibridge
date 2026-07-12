import {ItemView, WorkspaceLeaf, setIcon, setTooltip} from 'obsidian';
import LexiBridgePlugin from './main';
import {DictEntry} from './types';
import {renderPhoneticButtons} from './ui/phonetic-renderer';
import {DictionaryProviderId} from './dictionary-provider';

export class DictionaryView extends ItemView {
	plugin: LexiBridgePlugin;
	searchInput!: HTMLInputElement;
	resultContainer!: HTMLElement;
	private currentWord: string = '';
	private currentEntry: DictEntry | null = null;
	private currentSource: DictionaryProviderId | null = null;
	private selectedSource: DictionaryProviderId | null = null;
	private searchRequestId = 0;

	constructor(leaf: WorkspaceLeaf, plugin: LexiBridgePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return 'lexibridge-view';
	}

	getDisplayText() {
		return 'LexiBridge';
	}

	getIcon() {
		return 'book-open';
	}

	async onOpen() {
		this.containerEl.empty();

		const contentEl = this.containerEl.createEl('div', { cls: 'dict-view-content' });
		contentEl.classList.add('lexibridge-sidebar-view');
		contentEl.classList.remove('lexibridge-popover');

		const searchBarEl = contentEl.createEl('div', { cls: 'lexibridge-search-box' });

		const inputWrapper = searchBarEl.createEl('div', { cls: 'lexibridge-input-wrapper' });

		this.searchInput = inputWrapper.createEl('input', {
			type: 'text',
			cls: 'lexibridge-search-input',
			attr: { placeholder: '输入单词...' }
		});

		const searchButton = inputWrapper.createEl('button', {
			cls: 'lexibridge-search-btn-inside'
		});
		setIcon(searchButton, 'search');
		setTooltip(searchButton, '搜索');
		searchButton.addEventListener('click', () => {
			void this.performSearch();
		});

		const createNoteButton = searchBarEl.createEl('button', {
			cls: 'lexibridge-action-btn',
			attr: { 'aria-label': '创建词元笔记' }
		});
		setIcon(createNoteButton, 'file-plus');
		setTooltip(createNoteButton, '创建词元笔记');
			createNoteButton.addEventListener('click', () => {
			const word = this.searchInput.value.trim();
				if (word) {
					void this.plugin.searchAndGenerateNote(word);
				}
		});

		this.resultContainer = contentEl.createEl('div', { cls: 'dict-result-container' });

		const placeholder = this.resultContainer.createEl('div', { cls: 'lexibridge-message' });
		placeholder.createEl('span', { text: '输入一个单词开始查询' });

		this.searchInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				void this.performSearch();
			}
		});
	}

	async onClose() {
	}

	async lookup(word: string): Promise<void> {
		this.searchInput.value = word;
		this.selectedSource = null;
		await this.performSearch();
	}

	async performSearch() {
		const word = this.searchInput.value.trim();
		const requestId = ++this.searchRequestId;
		if (this.currentWord && word.toLowerCase() !== this.currentWord.toLowerCase()) {
			this.selectedSource = null;
		}
		
		if (!word) {
			this.resultContainer.empty();
			const message = this.resultContainer.createEl('p');
			message.addClass('lexibridge-message');
			message.setText('请输入要查询的单词。');
			return;
		}

		try {
			const result = this.selectedSource
				? await this.plugin.findEntryFromSource(word, this.selectedSource)
				: await this.plugin.findEntry(word, false);
			if (requestId !== this.searchRequestId) return;

			if (!result) {
				this.resultContainer.empty();
				this.currentSource = this.selectedSource;
				const switcher = this.resultContainer.createEl('div', {cls: 'lexibridge-source-switcher'});
				this.renderSourceButton(switcher, 'ecdict', 'ECDICT');
				this.renderSourceButton(switcher, 'youdao', '有道');
				const message = this.resultContainer.createEl('p');
				message.addClass('lexibridge-message');
				const textSpan = message.createEl('span');
				textSpan.setText('未找到定义： ');
				const strongSpan = message.createEl('strong');
				strongSpan.setText(word);
				return;
			}

			const { entry, word: lemma, source } = result;
			this.currentWord = lemma;
			this.currentEntry = entry;
			this.currentSource = source;
			this.selectedSource = source;

			this.resultContainer.empty();
			this.renderEntry(entry, lemma, source);
		} catch (error) {
			if (requestId !== this.searchRequestId) return;
			this.resultContainer.empty();
			this.currentSource = this.selectedSource;
			const switcher = this.resultContainer.createEl('div', {cls: 'lexibridge-source-switcher'});
			this.renderSourceButton(switcher, 'ecdict', 'ECDICT');
			this.renderSourceButton(switcher, 'youdao', '有道');
			const message = this.resultContainer.createEl('p');
			message.addClass('lexibridge-message');
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			message.setText(`Error: ${errorMsg}`);
		}
	}

	private renderEntry(entry: DictEntry, word: string, source: DictionaryProviderId) {
		const container = this.resultContainer.createEl('div', { cls: 'dict-entry' });

		const headerContainer = container.createEl('div', { cls: 'dict-header-container' });

		const headerLeft = headerContainer.createEl('div', { cls: 'dict-header-left' });

		const title = headerLeft.createEl('h1', { cls: 'dict-title' });
		title.textContent = word;
		const sourceSwitcher = headerLeft.createEl('div', {cls: 'lexibridge-source-switcher'});
		this.renderSourceButton(sourceSwitcher, 'ecdict', 'ECDICT');
		this.renderSourceButton(sourceSwitcher, 'youdao', '有道');

		renderPhoneticButtons(headerLeft, entry);

		if (entry.definitions.length > 0) {
			const definitionsList = container.createEl('div', { cls: 'dict-definitions-list' });
			entry.definitions.forEach((def) => {
				const defRow = definitionsList.createEl('div', { cls: 'dict-def-row' });
				if (def.pos) {
					const posEl = defRow.createEl('span', { cls: 'dict-pos-label' });
					posEl.textContent = def.pos;
				}
				const transEl = defRow.createEl('span', { cls: 'dict-def-text' });
				transEl.textContent = def.trans.replace(/\[/g, '\\[');
			});
		}

		if (entry.tags.length > 0 || entry.exchange.length > 0) {
			const footer = container.createEl('div', { cls: 'dict-footer' });

			if (entry.tags.length > 0) {
				const tagsContainer = footer.createEl('div', { cls: 'dict-tags-container' });
				entry.tags.forEach((tag) => {
					const tagEl = tagsContainer.createEl('span', { cls: 'dict-tag-exam' });
					tagEl.textContent = tag;
				});
			}

			if (entry.exchange.length > 0) {
				const formsList = footer.createEl('div', { cls: 'dict-exchange-list' });
				entry.exchange.forEach((item) => {
					const formItem = formsList.createEl('span', { cls: 'dict-tag-form' });
					const label = formItem.createEl('span', { cls: 'dict-form-label' });
					label.textContent = `${item.name}:`;
					const value = formItem.createEl('span', { cls: 'dict-form-value' });
					value.textContent = item.value;
				});
			}
		}

		this.renderExtendedData(container, entry);
	}

	private renderSourceButton(container: HTMLElement, source: DictionaryProviderId, label: string): void {
		const button = container.createEl('button', {
			cls: `lexibridge-source-option${this.currentSource === source ? ' is-active' : ''}`,
			text: label,
			attr: {'aria-pressed': String(this.currentSource === source)},
		});
		button.addEventListener('click', () => {
			if (source === this.currentSource) return;
			this.selectedSource = source;
			void this.performSearch();
		});
	}

	private renderExtendedData(container: HTMLElement, entry: DictEntry) {
		if (entry.webTrans && entry.webTrans.length > 0) {
			this.renderSection(container, '网络翻译', 'dict-web-trans', entry.webTrans, (section) => {
				const webList = section.createEl('ul', { cls: 'dict-web-list' });
				entry.webTrans!.forEach(item => {
					const li = webList.createEl('li', { cls: 'dict-web-item' });
					const keyEl = li.createEl('span', { cls: 'dict-web-key' });
					keyEl.textContent = `${item.key}: `;
					const valueEl = li.createEl('span', { cls: 'dict-web-value' });
					valueEl.textContent = item.value.map((v, i) => `${i + 1}. ${v}`).join(' ');
				});
			});
		}

		if (entry.bilingualExamples && entry.bilingualExamples.length > 0) {
			this.renderSection(container, '例句', 'dict-examples', entry.bilingualExamples, (section) => {
				const examplesList = section.createEl('div', { cls: 'dict-examples-list' });
				entry.bilingualExamples!.forEach(example => {
					const exampleRow = examplesList.createEl('div', { cls: 'dict-example-row' });
					const enEl = exampleRow.createEl('p', { cls: 'dict-example-en' });
					enEl.textContent = example.eng;
					const cnEl = exampleRow.createEl('p', { cls: 'dict-example-cn' });
					cnEl.textContent = example.chn;
				});
			});
		}
	}

	private renderSection<T>(
		container: HTMLElement,
		title: string,
		className: string,
		data: T | undefined,
		renderContentFn: (section: HTMLElement) => void
	): void {
		if (!data) {
			return;
		}

		const section = container.createEl('div', { cls: `dict-section ${className}` });
		const titleEl = section.createEl('h3', { cls: 'dict-section-title' });
		titleEl.textContent = title;
		renderContentFn(section);
	}
}
