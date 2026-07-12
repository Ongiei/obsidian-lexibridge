import {syntaxTree} from '@codemirror/language';
import {RangeSetBuilder} from '@codemirror/state';
import {Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate} from '@codemirror/view';
import {editorLivePreviewField} from 'obsidian';
import type LexiBridgePlugin from '../main';

const WORD_PATTERN = /\b[a-zA-Z]+(?:[-'][a-zA-Z]+)*\b/g;
const EXCLUDED_SYNTAX = /code|link|url|frontmatter|html|comment|tag|formatting|escape/i;

export function createLivePreviewVirtualLinks(plugin: LexiBridgePlugin) {
	return ViewPlugin.fromClass(class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildDecorations(view, plugin);
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged || update.focusChanged || update.transactions.length > 0) {
				this.decorations = buildDecorations(update.view, plugin);
			}
		}
	}, {
		decorations: value => value.decorations,
		eventHandlers: {
			click(event, view) {
				const element = (event.target as HTMLElement).closest<HTMLElement>('.lexibridge-virtual-link-live');
				if (!element) return false;
				const word = element.dataset.word;
				const target = element.dataset.target;
				if (!word || !target) return false;
				const from = view.posAtDOM(element);
				plugin.openLivePreviewVirtualLink(word, target, from, from + word.length);
				return true;
			},
		},
	});
}

function buildDecorations(view: EditorView, plugin: LexiBridgePlugin): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	if (!plugin.settings.virtualLinksEnabled || !view.state.field(editorLivePreviewField, false)) return builder.finish();
	const activeFile = plugin.app.workspace.getActiveFile();
	if (!activeFile || (plugin.settings.autoLinkSkipWordFolder && plugin.isWordNote(activeFile.path))) return builder.finish();

	const ignored = new Set(plugin.settings.autoLinkIgnoredWords);
	const excludedLines = findExcludedLines(view.state.doc.toString(), plugin.settings.autoLinkExcludedHeadings);
	for (const {from, to} of view.visibleRanges) {
		const text = view.state.sliceDoc(from, to);
		WORD_PATTERN.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = WORD_PATTERN.exec(text)) !== null) {
			const word = match[0];
			const start = from + match.index;
			const end = start + word.length;
			if (word.length < plugin.settings.autoLinkMinWordLength || ignored.has(word.toLowerCase())) continue;
			const line = view.state.doc.lineAt(start);
			if (excludedLines.has(line.number)
				|| (plugin.settings.autoLinkSkipHeadings && /^\s{0,3}#{1,6}\s/.test(line.text))
				|| (plugin.settings.autoLinkSkipBlockquotes && /^\s{0,3}>/.test(line.text))
				|| isExcludedSyntax(view, start)) continue;
			const target = plugin.resolveAutoLinkTarget(word);
			if (!target) continue;
			builder.add(start, end, Decoration.mark({
				class: 'lexibridge-virtual-link lexibridge-virtual-link-live',
				attributes: {'data-word': word, 'data-target': target, 'aria-label': `${word}：词库虚拟链接`},
			}));
		}
	}
	return builder.finish();
}

function isExcludedSyntax(view: EditorView, position: number): boolean {
	let node = syntaxTree(view.state).resolveInner(position, -1);
	while (node) {
		if (EXCLUDED_SYNTAX.test(node.name)) return true;
		node = node.parent!;
	}
	return false;
}

function findExcludedLines(markdown: string, titles: string[]): Set<number> {
	const excluded = new Set<number>();
	const normalized = new Set(titles.map(title => title.toLowerCase()));
	let activeLevel: number | null = null;
	const lines = markdown.split('\n');
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] || '';
		const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (heading?.[1] && heading[2]) {
			const level = heading[1].length;
			if (activeLevel !== null && level <= activeLevel) activeLevel = null;
			if (normalized.has(heading[2].trim().toLowerCase())) activeLevel = level;
		}
		if (activeLevel !== null) excluded.add(index + 1);
	}
	return excluded;
}
