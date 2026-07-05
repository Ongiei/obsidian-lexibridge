import { App, Editor, TFile, TFolder } from 'obsidian';
import { LexiBridgeSettings } from './settings';
import { getLemma } from './lemmatizer';

const WORD_PATTERN = /\b[a-zA-Z]+(?:[-'][a-zA-Z]+)*\b/g;

interface WikiLinkMatch {
	full: string;
	word: string;
	index: number;
	length: number;
}

interface TextPart {
	text: string;
	isProtected: boolean;
}

export class AutoLinkService {
	private app: App;
	private settings: LexiBridgeSettings;
	private localWordCache: Set<string> | null = null;

	constructor(app: App, settings: LexiBridgeSettings) {
		this.app = app;
		this.settings = settings;
	}

	invalidateCache(): void {
		this.localWordCache = null;
	}

	buildLocalWordCache(): Set<string> {
		if (this.localWordCache) {
			return this.localWordCache;
		}

		const words = new Set<string>();
		const folderPath = this.settings.folderPath;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);

		if (folder instanceof TFolder) {
			for (const file of folder.children) {
				if (file instanceof TFile && file.extension === 'md') {
					words.add(file.basename.toLowerCase());
				}
			}
		}

		this.localWordCache = words;
		return words;
	}

	async autoLinkCurrentDocument(editor: Editor): Promise<number> {
		try {
			const localWords = this.buildLocalWordCache();
			const linkedWords = new Set<string>();

			const content = editor.getValue();

			const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
			let frontmatter = '';
			let body = content;

			const fmMatch = content.match(frontmatterRegex);
			if (fmMatch) {
				frontmatter = fmMatch[0];
				body = content.slice(frontmatter.length);
			}

			const lines = body.split('\n');
			const newLines: string[] = [];
			let inCodeBlock = false;

			for (const line of lines) {
				if (line.trim().startsWith('```')) {
					inCodeBlock = !inCodeBlock;
					newLines.push(line);
					continue;
				}

				if (inCodeBlock) {
					newLines.push(line);
					continue;
				}

				const processedLine = this.processLine(line, localWords, linkedWords);
				newLines.push(processedLine);
			}

			const newBody = newLines.join('\n');
			const newText = frontmatter + newBody;

			const from = { line: 0, ch: 0 };
			const to = editor.offsetToPos(content.length);
			editor.replaceRange(newText, from, to);

			return linkedWords.size;
		} catch (error) {
			console.error('[LexiBridge] Auto-link failed:', error);
			return 0;
		}
	}

	private processLine(line: string, localWords: Set<string>, linkedWords: Set<string>): string {
		const wikiLinks = this.findWikiLinks(line);

		for (const wl of wikiLinks) {
			linkedWords.add(wl.word.toLowerCase());
		}

		const parts = this.splitByWikiLinks(line, wikiLinks);

		const processedParts = parts.map((part) => {
			if (part.isProtected) {
				return part.text;
			}

			const firstOnly = this.settings.autoLinkFirstOnly;
			return this.splitByInlineCode(part.text)
				.map(inlinePart => {
					if (inlinePart.isProtected) {
						return inlinePart.text;
					}
					return this.linkWordsInText(inlinePart.text, localWords, linkedWords, firstOnly);
				})
				.join('');
		});

		return processedParts.join('');
	}

	private findWikiLinks(text: string): WikiLinkMatch[] {
		const links: WikiLinkMatch[] = [];
		const pattern = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(text)) !== null) {
			const word = match[1];
			if (word) {
				links.push({
					full: match[0],
					word,
					index: match.index,
					length: match[0].length,
				});
			}
		}

		return links;
	}

	private splitByWikiLinks(text: string, wikiLinks: WikiLinkMatch[]): TextPart[] {
		if (wikiLinks.length === 0) {
			return [{ text, isProtected: false }];
		}

		const parts: TextPart[] = [];
		let lastEnd = 0;

		for (const wl of wikiLinks) {
			if (wl.index > lastEnd) {
				parts.push({ text: text.slice(lastEnd, wl.index), isProtected: false });
			}
			parts.push({ text: wl.full, isProtected: true });
			lastEnd = wl.index + wl.length;
		}

		if (lastEnd < text.length) {
			parts.push({ text: text.slice(lastEnd), isProtected: false });
		}

		return parts;
	}

	private splitByInlineCode(text: string): TextPart[] {
		const parts: TextPart[] = [];
		const pattern = /`[^`\n]+`/g;
		let match: RegExpExecArray | null;
		let lastEnd = 0;

		while ((match = pattern.exec(text)) !== null) {
			if (match.index > lastEnd) {
				parts.push({ text: text.slice(lastEnd, match.index), isProtected: false });
			}
			parts.push({ text: match[0], isProtected: true });
			lastEnd = match.index + match[0].length;
		}

		if (lastEnd < text.length) {
			parts.push({ text: text.slice(lastEnd), isProtected: false });
		}

		return parts.length > 0 ? parts : [{ text, isProtected: false }];
	}

	private linkWordsInText(text: string, localWords: Set<string>, linkedWords: Set<string>, firstOnly: boolean): string {
		return text.replace(WORD_PATTERN, (match) => {
			const lowerMatch = match.toLowerCase();
			const lemma = getLemma(lowerMatch);

			if (!localWords.has(lemma)) {
				return match;
			}

			if (firstOnly && linkedWords.has(lemma)) {
				return match;
			}

			linkedWords.add(lemma);

			if (lowerMatch === lemma) {
				return `[[${lemma}]]`;
			} else {
				return `[[${lemma}|${match}]]`;
			}
		});
	}

	findLocalWord(word: string): string | null {
		const localWords = this.buildLocalWordCache();
		const lowerWord = word.toLowerCase();
		const lemma = getLemma(lowerWord);

		if (localWords.has(lemma)) {
			return lemma;
		}
		if (localWords.has(lowerWord)) {
			return lowerWord;
		}
		return null;
	}
}
