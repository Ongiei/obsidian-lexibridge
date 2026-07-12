import { App, parseYaml, TFile, TFolder } from 'obsidian';
import { LexiBridgeSettings } from '../settings';
import { getMarkdownFilesRecursively } from '../utils/vault-files';
import { WordNoteSnapshot } from './types';

interface ParsedMarkdown {
	frontmatter: Record<string, unknown>;
	body: string;
}

interface HeadingSection {
	title: string;
	level: number;
	start: number;
	contentStart: number;
	end: number;
}

const DEFAULT_SECTION_TITLES = {
	phonetics: new Set(['发音', 'phonetics', 'pronunciation']),
	definitions: new Set(['释义', 'definitions', 'definition', '网络翻译', 'web translations', 'web translation']),
	examples: new Set(['例句', 'examples']),
	forms: new Set(['词形变化', 'forms', 'word forms']),
};

export class WordNoteRepository {
	constructor(
		private app: App,
		private getSettings: () => LexiBridgeSettings
	) {}

	async readAll(): Promise<WordNoteSnapshot[]> {
		const settings = this.getSettings();
		const root = this.app.vault.getAbstractFileByPath(settings.folderPath);
		if (!(root instanceof TFolder)) {
			return [];
		}

		const files = getMarkdownFilesRecursively(root);
		const snapshots: WordNoteSnapshot[] = [];
		for (const file of files) {
			const snapshot = await this.readFile(file);
			if (snapshot) snapshots.push(snapshot);
		}
		return snapshots;
	}

	async readPath(filePath: string): Promise<WordNoteSnapshot | null> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile) || file.extension !== 'md') {
			return null;
		}
		return this.readFile(file);
	}

	private async readFile(file: TFile): Promise<WordNoteSnapshot | null> {
		const content = await this.app.vault.read(file);
		const parsed = splitMarkdown(content);
		const canonicalWord = stringValue(parsed.frontmatter.word) || file.basename;
		const word = canonicalWord.trim();
		if (!word) return null;

		const sections = scanHeadingSections(parsed.body);
		const protectedSelectors = this.getSettings().protectedHeadings.map(parseHeadingSelector).filter(selector => selector.title);

		return {
			filePath: file.path,
			word,
			aliases: stringArray(parsed.frontmatter.aliases),
			dictSource: stringValue(parsed.frontmatter.dict_source),
			tags: stringArray(parsed.frontmatter.tags),
			phoneticsMarkdown: collectSections(parsed.body, sections, DEFAULT_SECTION_TITLES.phonetics),
			definitionsMarkdown: collectSections(parsed.body, sections, DEFAULT_SECTION_TITLES.definitions),
			examplesMarkdown: collectSections(parsed.body, sections, DEFAULT_SECTION_TITLES.examples),
			formsMarkdown: collectSections(parsed.body, sections, DEFAULT_SECTION_TITLES.forms),
			protectedMarkdown: collectProtectedSections(parsed.body, sections, protectedSelectors),
			sourceMarkdown: createObsidianOpenLink(this.app.vault.getName(), file.path, word),
			modifiedTime: file.stat.mtime,
		};
	}
}

export function splitMarkdown(content: string): ParsedMarkdown {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match || match[1] === undefined) {
		return { frontmatter: {}, body: content };
	}
	let frontmatter: Record<string, unknown> = {};
	try {
		const parsed: unknown = parseYaml(match[1]);
		if (parsed && typeof parsed === 'object') {
			frontmatter = parsed as Record<string, unknown>;
		}
	} catch (error) {
		console.warn('[LexiBridge] Failed to parse word-note frontmatter:', error);
	}
	return {
		frontmatter,
		body: content.slice(match[0].length),
	};
}

export function scanHeadingSections(markdown: string): HeadingSection[] {
	const headings: Omit<HeadingSection, 'end'>[] = [];
	const headingPattern = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
	let match: RegExpExecArray | null;

	while ((match = headingPattern.exec(markdown)) !== null) {
		const hashes = match[1];
		const title = match[2];
		if (!hashes || !title) continue;
		headings.push({
			title: normalizeHeadingTitle(title),
			level: hashes.length,
			start: match.index,
			contentStart: headingPattern.lastIndex,
		});
	}

	return headings.map((heading, index) => {
		let end = markdown.length;
		for (let cursor = index + 1; cursor < headings.length; cursor += 1) {
			const candidate = headings[cursor];
			if (candidate && candidate.level <= heading.level) {
				end = candidate.start;
				break;
			}
		}
		return { ...heading, end };
	});
}

function collectSections(markdown: string, sections: HeadingSection[], titles: Set<string>): string {
	return sections
		.filter(section => titles.has(section.title))
		.map(section => markdown.slice(section.contentStart, section.end).trim())
		.filter(Boolean)
		.join('\n\n');
}

function collectProtectedSections(
	markdown: string,
	sections: HeadingSection[],
	selectors: Array<{title: string; level: number | null}>
): string {
	const matches = sections
		.filter(section => selectors.some(selector =>
			selector.title === section.title && (selector.level === null || selector.level === section.level)
		));
	return matches
		.filter((section, index) => !matches.slice(0, index).some(parent =>
			parent.start < section.start && parent.end >= section.end
		))
		.map(section => markdown.slice(section.contentStart, section.end).trim())
		.filter(Boolean)
		.join('\n\n');
}

function parseHeadingSelector(value: string): {title: string; level: number | null} {
	const match = value.trim().match(/^(#{1,6})\s+(.+?)\s*#*$/);
	return match
		? {title: normalizeHeadingTitle(match[2] || ''), level: match[1]?.length || null}
		: {title: normalizeHeadingTitle(value), level: null};
}

function normalizeHeadingTitle(title: string): string {
	return title.replace(/^#+\s*/, '').trim().toLowerCase();
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

function createObsidianOpenLink(vaultName: string, filePath: string, label: string): string {
	const href = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
	return `[${label}](${href})`;
}
