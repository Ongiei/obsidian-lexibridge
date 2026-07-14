import {App, MarkdownRenderChild, MarkdownRenderer, setIcon, setTooltip, TFile} from 'obsidian';
import {getVirtualLinkPreviewMarkdown} from '../utils/virtual-link-preview';

export class VirtualLinkPopover {
	private element: HTMLElement | null = null;
	private renderChild: MarkdownRenderChild | null = null;
	private anchor: HTMLElement | null = null;
	private ownerDocument: Document | null = null;
	private ownerWindow: Window | null = null;
	private abortController: AbortController | null = null;
	private closeTimer: number | null = null;
	private closed = false;

	constructor(
		private app: App,
		private word: string,
		private target: string,
		private sourcePath: string,
		private onConvertToRealLinks: () => void,
		private onClose: () => void,
	) {}

	open(anchor: HTMLElement): void {
		this.anchor = anchor;
		this.ownerDocument = anchor.ownerDocument ?? activeDocument;
		this.ownerWindow = this.ownerDocument.defaultView ?? activeWindow;
		this.closed = false;

		const ownerDocument = this.getOwnerDocument();
		const ownerWindow = this.getOwnerWindow();
		const element = ownerDocument.body.createDiv({cls: 'lexibridge-virtual-link-popover'});
		element.setAttribute('role', 'dialog');
		element.setAttribute('aria-label', `${this.word} 词条预览`);
		this.element = element;

		this.renderContent();
		this.position();
		this.registerDismissHandlers();
		ownerWindow.requestAnimationFrame(() => {
			if (!this.element || this.closed) return;
			this.position();
			this.element.classList.add('is-active');
		});
	}

	isFor(anchor: HTMLElement): boolean {
		return this.anchor === anchor && this.element !== null && !this.closed;
	}

	keepOpen = (): void => {
		this.clearCloseTimer();
	};

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.clearCloseTimer();
		this.abortController?.abort();
		this.abortController = null;
		this.renderChild?.unload();
		this.renderChild = null;
		this.element?.remove();
		this.element = null;
		this.anchor = null;
		this.ownerDocument = null;
		this.ownerWindow = null;
		this.onClose();
	}

	private getOwnerDocument(): Document {
		return this.element?.ownerDocument ?? this.ownerDocument ?? activeDocument;
	}

	private getOwnerWindow(): Window {
		return this.getOwnerDocument().defaultView ?? this.ownerWindow ?? activeWindow;
	}

	private useMobileLayout(): boolean {
		return this.getOwnerWindow().innerWidth <= 640;
	}

	private renderContent(): void {
		if (!this.element) return;
		this.element.empty();

		const header = this.element.createDiv({cls: 'lexibridge-virtual-link-popover__header'});
		const title = header.createEl('strong', {cls: 'lexibridge-virtual-link-popover__title'});
		title.setText(this.word);

		const actions = header.createDiv({cls: 'lexibridge-virtual-link-popover__actions'});
		const openButton = actions.createEl('button', {
			cls: 'lexibridge-virtual-link-popover__action',
			attr: {type: 'button'},
		});
		setIcon(openButton, 'file-text');
		setTooltip(openButton, '打开词条笔记');
		openButton.addEventListener('click', () => {
			this.close();
			void this.app.workspace.openLinkText(this.target, this.sourcePath, true);
		});

		const convertButton = actions.createEl('button', {
			cls: 'lexibridge-virtual-link-popover__action',
			attr: {type: 'button'},
		});
		setIcon(convertButton, 'link-2');
		setTooltip(convertButton, `将本文中的“${this.word}”转换为真实链接`);
		convertButton.addEventListener('click', () => {
			this.close();
			this.onConvertToRealLinks();
		});

		const closeButton = actions.createEl('button', {
			cls: 'lexibridge-virtual-link-popover__action',
			attr: {type: 'button'},
		});
		setIcon(closeButton, 'x');
		setTooltip(closeButton, '关闭预览');
		closeButton.addEventListener('click', () => this.close());

		const preview = this.element.createDiv({cls: 'lexibridge-virtual-link-popover__content'});
		preview.createSpan({cls: 'lexibridge-message', text: '加载词条预览...'});
		void this.renderPreview(preview);
	}

	private async renderPreview(container: HTMLElement): Promise<void> {
		const path = this.target.endsWith('.md') ? this.target : `${this.target}.md`;
		const file = this.app.vault.getAbstractFileByPath(path);
		container.empty();
		if (!(file instanceof TFile)) {
			container.createSpan({cls: 'lexibridge-message', text: '找不到对应的单词笔记。'});
			return;
		}

		try {
			const markdown = getVirtualLinkPreviewMarkdown(await this.app.vault.cachedRead(file));
			if (this.closed) return;
			if (!markdown) {
				container.createSpan({cls: 'lexibridge-message', text: '词条笔记暂无可预览正文。'});
				return;
			}
			this.renderChild = new MarkdownRenderChild(container);
			this.renderChild.load();
			await MarkdownRenderer.render(this.app, markdown, container, file.path, this.renderChild);
			if (!this.closed) this.position();
		} catch (error) {
			if (this.closed) return;
			container.createSpan({
				cls: 'lexibridge-message',
				text: `预览加载失败：${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	private position(): void {
		if (!this.element || !this.anchor) return;
		const ownerWindow = this.getOwnerWindow();
		if (this.useMobileLayout()) {
			this.element.classList.add('is-mobile');
			this.element.setCssProps({left: '', right: '', top: '', bottom: ''});
			return;
		}

		this.element.classList.remove('is-mobile');
		const margin = 12;
		const gap = 8;
		const anchorRect = this.anchor.getBoundingClientRect();
		const popoverRect = this.element.getBoundingClientRect();
		const maxLeft = Math.max(margin, ownerWindow.innerWidth - popoverRect.width - margin);
		const left = Math.min(Math.max(margin, anchorRect.left), maxLeft);
		const below = anchorRect.bottom + gap;
		const above = anchorRect.top - popoverRect.height - gap;
		const top = below + popoverRect.height <= ownerWindow.innerHeight - margin || above < margin
			? Math.min(below, Math.max(margin, ownerWindow.innerHeight - popoverRect.height - margin))
			: above;
		this.element.setCssProps({left: `${left}px`, right: 'auto', top: `${top}px`, bottom: 'auto'});
	}

	private registerDismissHandlers(): void {
		if (!this.element || !this.anchor) return;
		this.abortController = new AbortController();
		const {signal} = this.abortController;
		const ownerDocument = this.getOwnerDocument();
		const ownerWindow = this.getOwnerWindow();
		this.anchor.addEventListener('pointerenter', () => this.keepOpen(), {signal});
		this.anchor.addEventListener('pointerleave', () => this.scheduleClose(), {signal});
		this.element.addEventListener('pointerenter', () => this.keepOpen(), {signal});
		this.element.addEventListener('pointerleave', () => this.scheduleClose(), {signal});
		ownerDocument.addEventListener('pointerdown', this.onPointerDown, {capture: true, signal});
		ownerWindow.addEventListener('keydown', this.onKeyDown, {signal});
	}

	private scheduleClose = (): void => {
		this.clearCloseTimer();
		this.closeTimer = this.getOwnerWindow().setTimeout(() => this.close(), 160);
	};

	private clearCloseTimer(): void {
		if (this.closeTimer === null) return;
		this.getOwnerWindow().clearTimeout(this.closeTimer);
		this.closeTimer = null;
	}

	private onPointerDown = (event: PointerEvent): void => {
		if (!this.element || !this.anchor) return;
		const target = event.target as Node | null;
		if (target && (this.element.contains(target) || this.anchor.contains(target))) return;
		this.close();
	};

	private onKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') this.close();
	};
}
