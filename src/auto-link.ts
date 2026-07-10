import { App, Editor, TFolder } from 'obsidian';
import { LexiBridgeSettings } from './settings';
import { getLemma } from './lemmatizer';
import {getFenceMarker, isReferenceDefinition, splitProtectedMarkdown} from './utils/auto-link';
import {getMarkdownFilesRecursively} from './utils/vault-files';

const WORD_PATTERN = /\b[a-zA-Z]+(?:[-'][a-zA-Z]+)*\b/g;

interface WikiLinkMatch {
	full: string;
	word: string;
	index: number;
	length: number;
}

export class AutoLinkService {
	private app: App;
	private settings: LexiBridgeSettings;
	private localWordCache: Map<string, string> | null = null;

	constructor(app: App, settings: LexiBridgeSettings) {
		this.app = app;
		this.settings = settings;
	}

	invalidateCache(): void {
		this.localWordCache = null;
	}

	buildLocalWordCache(): Map<string, string> {
		if (this.localWordCache) {
			return this.localWordCache;
		}

		const words = new Map<string, string>();
		const folderPath = this.settings.folderPath;
		const folder = this.app.vault.getAbstractFileByPath(folderPath);

		if (folder instanceof TFolder) {
			for (const file of getMarkdownFilesRecursively(folder)) {
				const target = file.basename;
				words.set(target.toLowerCase(), target);
				const rawFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as unknown;
				const frontmatter = rawFrontmatter && typeof rawFrontmatter === 'object'
					? rawFrontmatter as Record<string, unknown>
					: undefined;
				const frontmatterWord = frontmatter?.word;
				if (typeof frontmatterWord === 'string' && frontmatterWord.trim()) {
					words.set(frontmatterWord.toLowerCase(), target);
				}
				const aliases = frontmatter?.aliases;
				if (Array.isArray(aliases)) {
					for (const alias of aliases) {
						if (typeof alias === 'string' && alias.trim()) {
							words.set(alias.toLowerCase(), target);
						}
					}
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
			const addedLinks = { count: 0 };

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
			let activeFence: { character: '`' | '~'; length: number } | null = null;
			let inHtmlComment = false;

			for (const line of lines) {
				const fence = getFenceMarker(line);
				if (fence && !activeFence) {
					activeFence = fence;
					newLines.push(line);
					continue;
				}

				if (activeFence) {
					newLines.push(line);
					if (fence && fence.character === activeFence.character && fence.length >= activeFence.length) {
						activeFence = null;
					}
					continue;
				}

				if (inHtmlComment || line.includes('<!--')) {
					inHtmlComment = !line.includes('-->');
					newLines.push(line);
					continue;
				}

				if (/^(?:\t| {4})/.test(line) || isReferenceDefinition(line)) {
					newLines.push(line);
					continue;
				}

				const processedLine = this.processLine(line, localWords, linkedWords, addedLinks);
				newLines.push(processedLine);
			}

			const newBody = newLines.join('\n');
			const newText = frontmatter + newBody;

			const from = { line: 0, ch: 0 };
			const to = editor.offsetToPos(content.length);
			editor.replaceRange(newText, from, to);

			return addedLinks.count;
		} catch (error) {
			console.error('[LexiBridge] Auto-link failed:', error);
			return 0;
		}
	}

	private processLine(
		line: string,
		localWords: Map<string, string>,
		linkedWords: Set<string>,
		addedLinks: { count: number }
	): string {
		const wikiLinks = this.findWikiLinks(line);

		for (const wl of wikiLinks) {
			linkedWords.add(wl.word.toLowerCase());
		}

		const processedParts = splitProtectedMarkdown(line).map((part) => {
			if (part.isProtected) {
				return part.text;
			}

			const firstOnly = this.settings.autoLinkFirstOnly;
			return this.linkWordsInText(part.text, localWords, linkedWords, firstOnly, addedLinks);
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

	private linkWordsInText(
		text: string,
		localWords: Map<string, string>,
		linkedWords: Set<string>,
		firstOnly: boolean,
		addedLinks: { count: number }
	): string {
		return text.replace(WORD_PATTERN, (match) => {
			const lowerMatch = match.toLowerCase();
			const lemma = getLemma(lowerMatch);
			const target = localWords.get(lemma) || localWords.get(lowerMatch);

			if (!target) {
				return match;
			}

			const targetKey = target.toLowerCase();
			if (firstOnly && linkedWords.has(targetKey)) {
				return match;
			}

			linkedWords.add(targetKey);
			addedLinks.count++;

			if (lowerMatch === targetKey) {
				return `[[${target}]]`;
			} else {
				return `[[${target}|${match}]]`;
			}
		});
	}

	findLocalWord(word: string): string | null {
		const localWords = this.buildLocalWordCache();
		const lowerWord = word.toLowerCase();
		const lemma = getLemma(lowerWord);

		if (localWords.has(lemma)) {
			return localWords.get(lemma) || lemma;
		}
		if (localWords.has(lowerWord)) {
			return localWords.get(lowerWord) || lowerWord;
		}
		return null;
	}
}
