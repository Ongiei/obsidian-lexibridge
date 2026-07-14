import {Editor, Platform, setIcon, setTooltip} from 'obsidian';
import LexiBridgePlugin from './main';
import {DictEntry, EditorWithCM} from './types';
import {renderPhoneticButtons} from './ui/phonetic-renderer';
import {DictionaryProviderId} from './dictionary-provider';

export class DefinitionPopover {
	private overlay: HTMLElement | null = null;
	private entry: DictEntry | null = null;
	private source: DictionaryProviderId | null = null;
	private abortController: AbortController | null = null;
	private ownerDocument: Document | null = null;
	private ownerWindow: Window | null = null;

	constructor(
		private plugin: LexiBridgePlugin,
		private editor: Editor,
		private originalWord: string,
		entry?: DictEntry
	) {
		this.entry = entry ?? null;
		this.createPopover();
	}

	private createPopover(): void {
		const cursorFrom = this.editor.getCursor('from');
		const cm = (this.editor as unknown as EditorWithCM).cm;
		const pos = this.editor.posToOffset(cursorFrom);
		const coords = cm?.coordsAtPos(pos);
		this.ownerDocument = cm?.dom?.ownerDocument ?? activeDocument;
		this.ownerWindow = this.ownerDocument.defaultView ?? activeWindow;
		this.removeExistingPopover();

		if (!coords) {
			return;
		}

		const ownerDocument = this.getOwnerDocument();
		const ownerWindow = this.getOwnerWindow();
		this.overlay = ownerDocument.createElement('div');
		this.overlay.className = 'lexibridge-popover';
		ownerDocument.body.appendChild(this.overlay);

		if (this.shouldUseMobileLayout()) {
			this.overlay.classList.add('lexibridge-popover-mobile', 'popover-origin-bottom-left');
			this.renderContent();
			this.registerDismissHandlers();
			return;
		}

		const offset = 15;
		const estimatedWidth = 320;
		const estimatedHeight = 320;
		const spaceBelow = ownerWindow.innerHeight - coords.bottom;
		const spaceRight = ownerWindow.innerWidth - coords.right;

		let originV = 'top';
		let originH = 'left';
		this.overlay.setCssProps({top: '', bottom: '', left: '', right: ''});

		if (spaceBelow < estimatedHeight) {
			const distanceFromBottom = ownerWindow.innerHeight - coords.top + offset;
			this.overlay.setCssProps({bottom: `${distanceFromBottom}px`, top: 'auto'});
			originV = 'bottom';
		} else {
			this.overlay.setCssProps({top: `${coords.bottom + offset}px`, bottom: 'auto'});
		}

		if (spaceRight < estimatedWidth) {
			const distanceFromRight = ownerWindow.innerWidth - coords.left + offset;
			this.overlay.setCssProps({right: `${distanceFromRight}px`, left: 'auto'});
			originH = 'right';
		} else {
			this.overlay.setCssProps({left: `${coords.left + offset}px`, right: 'auto'});
		}

		this.overlay.classList.remove('popover-origin-top-left', 'popover-origin-top-right', 'popover-origin-bottom-left', 'popover-origin-bottom-right');
		this.overlay.classList.add(`popover-origin-${originV}-${originH}`);
		this.renderContent();
		this.registerDismissHandlers();
	}

	private getOwnerDocument(): Document {
		return this.overlay?.ownerDocument ?? this.ownerDocument ?? activeDocument;
	}

	private getOwnerWindow(): Window {
		return this.getOwnerDocument().defaultView ?? this.ownerWindow ?? activeWindow;
	}

	private shouldUseMobileLayout(): boolean {
		return Platform.isMobile || this.getOwnerWindow().innerWidth <= 640;
	}

	private registerDismissHandlers(): void {
		this.abortController = new AbortController();
		const abortController = this.abortController;
		const ownerWindow = this.getOwnerWindow();
		ownerWindow.setTimeout(() => {
			if (this.overlay && !abortController.signal.aborted) {
				this.overlay.classList.add('active');
				ownerWindow.addEventListener('pointerdown', this.onWindowPointerDown, {
					capture: true,
					signal: abortController.signal,
				});
				ownerWindow.addEventListener('keydown', this.onWindowKeyDown, {signal: abortController.signal});
			}
		}, 10);
	}

	public setEntry(entry: DictEntry, source?: DictionaryProviderId): void {
		this.entry = entry;
		this.source = source ?? null;
		this.renderContent();
	}

	private removeExistingPopover(): void {
		const existing = this.getOwnerDocument().querySelector('.lexibridge-popover');
		if (existing) {
			existing.remove();
		}
		this.cleanupListeners();
	}

	private cleanupListeners(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	private renderContent(): void {
		if (!this.overlay) return;
		const ownerDocument = this.getOwnerDocument();
		this.overlay.empty();

		if (!this.entry) {
			const loading = ownerDocument.createElement('div');
			loading.className = 'popover-loading';
			loading.textContent = '加载中...';
			this.overlay.appendChild(loading);
			return;
		}

		const header = ownerDocument.createElement('div');
		header.className = 'popover-header';
		const headerContainer = ownerDocument.createElement('div');
		headerContainer.className = 'dict-header-container';
		const headerLeft = ownerDocument.createElement('div');
		headerLeft.className = 'dict-header-left';
		const title = ownerDocument.createElement('h1');
		title.className = 'dict-title';
		title.textContent = this.originalWord;
		headerLeft.appendChild(title);

		if (this.source) {
			const sourceLabel = ownerDocument.createElement('span');
			sourceLabel.className = 'lexibridge-source-label';
			sourceLabel.textContent = this.source === 'ecdict' ? 'ECDICT 本地' : '有道在线';
			headerLeft.appendChild(sourceLabel);
		}

		renderPhoneticButtons(headerLeft, this.entry);
		headerContainer.appendChild(headerLeft);

		const actionContainer = ownerDocument.createElement('div');
		actionContainer.className = 'popover-actions';
		const createNoteBtn = ownerDocument.createElement('button');
		createNoteBtn.className = 'dict-action-btn';
		setIcon(createNoteBtn, 'file-plus');
		setTooltip(createNoteBtn, '创建词元笔记');
		createNoteBtn.addEventListener('click', () => {
			void (async () => {
				await this.plugin.searchAndGenerateNote(this.originalWord);
				this.close();
			})();
		});
		actionContainer.appendChild(createNoteBtn);

		const closeBtn = ownerDocument.createElement('button');
		closeBtn.className = 'dict-action-btn';
		setIcon(closeBtn, 'x');
		setTooltip(closeBtn, '关闭');
		closeBtn.addEventListener('click', () => this.close());
		actionContainer.appendChild(closeBtn);
		headerContainer.appendChild(actionContainer);
		header.appendChild(headerContainer);
		this.overlay.appendChild(header);

		if (this.entry.definitions.length > 0) {
			const definitionsList = ownerDocument.createElement('div');
			definitionsList.className = 'popover-definitions-list';
			for (const definition of this.entry.definitions) {
				const definitionRow = ownerDocument.createElement('div');
				definitionRow.className = 'popover-def-row';
				if (definition.pos) {
					const posEl = ownerDocument.createElement('span');
					posEl.className = 'popover-pos-label';
					posEl.textContent = definition.pos;
					definitionRow.appendChild(posEl);
				}
				const translationEl = ownerDocument.createElement('span');
				translationEl.className = 'popover-def-text';
				translationEl.textContent = definition.trans.replace(/\[/g, '\\[');
				definitionRow.appendChild(translationEl);
				definitionsList.appendChild(definitionRow);
			}
			this.overlay.appendChild(definitionsList);
		}

		if (this.entry.tags.length > 0 || this.entry.exchange.length > 0) {
			const footer = ownerDocument.createElement('div');
			footer.className = 'popover-footer';

			if (this.entry.tags.length > 0) {
				const tagsContainer = ownerDocument.createElement('div');
				tagsContainer.className = 'popover-tags-container';
				for (const tag of this.entry.tags) {
					const tagEl = ownerDocument.createElement('span');
					tagEl.className = 'popover-tag-exam';
					tagEl.textContent = tag;
					tagsContainer.appendChild(tagEl);
				}
				footer.appendChild(tagsContainer);
			}

			if (this.entry.exchange.length > 0) {
				const formsList = ownerDocument.createElement('div');
				formsList.className = 'popover-exchange-list';
				for (const item of this.entry.exchange) {
					const formItem = ownerDocument.createElement('span');
					formItem.className = 'popover-tag-form';
					const label = ownerDocument.createElement('span');
					label.className = 'popover-form-label';
					label.textContent = `${item.name}:`;
					const value = ownerDocument.createElement('span');
					value.className = 'popover-form-value';
					value.textContent = item.value;
					formItem.append(label, value);
					formsList.appendChild(formItem);
				}
				footer.appendChild(formsList);
			}

			this.overlay.appendChild(footer);
		}
	}

	private onWindowPointerDown = (event: PointerEvent): void => {
		if (this.overlay && !this.overlay.contains(event.target as Node)) {
			this.close();
		}
	};

	private onWindowKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			this.close();
		}
	};

	public close(): void {
		this.cleanupListeners();
		this.overlay?.remove();
		this.overlay = null;
		this.ownerDocument = null;
		this.ownerWindow = null;
	}
}
