import {App, TFolder} from 'obsidian';
import {LexiBridgeSettings} from './settings';
import {getLemma} from './lemmatizer';
import {getFenceMarker, isReferenceDefinition, splitProtectedMarkdown} from './utils/auto-link';
import {getMarkdownFilesRecursively} from './utils/vault-files';

const WORD_PATTERN = /\b[a-zA-Z]+(?:[-'][a-zA-Z]+)*\b/g;

export interface AutoLinkOccurrence {
	start: number;
	end: number;
	text: string;
	target: string;
	replacement: string;
}

export interface AutoLinkCandidate {
	target: string;
	count: number;
	examples: string[];
}

export interface AutoLinkPlan {
	content: string;
	occurrences: AutoLinkOccurrence[];
	candidates: AutoLinkCandidate[];
}

export type AutoLinkCleanupPlan = AutoLinkPlan;

export interface AutoLinkRange {
	from: number;
	to: number;
}

export class AutoLinkService {
	private localWordCache: Map<string, string> | null = null;

	constructor(private app: App, private settings: LexiBridgeSettings) {}

	invalidateCache(): void {
		this.localWordCache = null;
	}

	buildLocalWordCache(): Map<string, string> {
		if (this.localWordCache) return this.localWordCache;
		const words = new Map<string, string>();
		const folder = this.app.vault.getAbstractFileByPath(this.settings.folderPath);
		if (folder instanceof TFolder) {
			for (const file of getMarkdownFilesRecursively(folder)) {
				const target = file.path.replace(/\.md$/i, '');
				words.set(file.basename.toLowerCase(), target);
				const rawFrontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as unknown;
				const frontmatter = rawFrontmatter && typeof rawFrontmatter === 'object'
					? rawFrontmatter as Record<string, unknown>
					: undefined;
				const canonicalWord = frontmatter?.word;
				if (typeof canonicalWord === 'string' && canonicalWord.trim()) {
					words.set(canonicalWord.toLowerCase(), target);
				}
				const aliases = frontmatter?.aliases;
				if (Array.isArray(aliases)) {
					for (const alias of aliases) {
						if (typeof alias === 'string' && alias.trim()) words.set(alias.toLowerCase(), target);
					}
				}
			}
		}
		this.localWordCache = words;
		return words;
	}

	createPlan(
		content: string,
		range: AutoLinkRange = {from: 0, to: content.length},
		sourcePath?: string
	): AutoLinkPlan {
		const localWords = this.buildLocalWordCache();
		const ignored = new Set(this.settings.autoLinkIgnoredWords);
		const linkedTargets = new Set<string>();
		const occurrences: AutoLinkOccurrence[] = [];
		const frontmatterEnd = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0].length ?? 0;
		let activeFence: {character: '`' | '~'; length: number} | null = null;
		let inHtmlComment = false;
		let excludedHeadingLevel: number | null = null;
		const excludedHeadings = new Set(this.settings.autoLinkExcludedHeadings.map(title => title.toLowerCase()));
		let lineStart = 0;

		for (const line of content.split('\n')) {
			const lineEnd = lineStart + line.length;
			const fence = getFenceMarker(line);
			const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
			if (heading?.[1] && heading[2]) {
				const level = heading[1].length;
				if (excludedHeadingLevel !== null && level <= excludedHeadingLevel) excludedHeadingLevel = null;
				if (excludedHeadings.has(heading[2].trim().toLowerCase())) excludedHeadingLevel = level;
			}
			if (fence && !activeFence) activeFence = fence;
			else if (activeFence && fence && fence.character === activeFence.character && fence.length >= activeFence.length) activeFence = null;

			for (const target of findWikiLinkTargets(line)) {
				const normalizedTarget = normalizeTarget(target);
				linkedTargets.add(normalizeTarget(localWords.get(normalizedTarget) || target));
			}
			const intersectsRange = lineEnd >= range.from && lineStart <= range.to;
			const skipLine = lineStart < frontmatterEnd
				|| Boolean(activeFence) || Boolean(fence)
				|| inHtmlComment || line.includes('<!--')
				|| excludedHeadingLevel !== null
				|| /^(?:\t| {4})/.test(line) || isReferenceDefinition(line)
				|| (this.settings.autoLinkSkipHeadings && /^\s{0,3}#{1,6}\s/.test(line))
				|| (this.settings.autoLinkSkipBlockquotes && /^\s{0,3}>/.test(line));

			if (line.includes('<!--') || inHtmlComment) inHtmlComment = !line.includes('-->');
			if (intersectsRange && !skipLine) {
				let partOffset = 0;
				for (const part of splitProtectedMarkdown(line)) {
					if (!part.isProtected) {
						WORD_PATTERN.lastIndex = 0;
						let match: RegExpExecArray | null;
						while ((match = WORD_PATTERN.exec(part.text)) !== null) {
							const text = match[0];
							const lower = text.toLowerCase();
							const start = lineStart + partOffset + match.index;
							const end = start + text.length;
							if (start < range.from || end > range.to || text.length < this.settings.autoLinkMinWordLength || ignored.has(lower)) continue;
							const target = localWords.get(getLemma(lower)) || localWords.get(lower);
							if (!target) continue;
							const targetKey = normalizeTarget(target);
							if (this.settings.autoLinkFirstOnly && linkedTargets.has(targetKey)) continue;
							linkedTargets.add(targetKey);
							const basename = target.split('/').pop() || target;
							const linkTarget = this.getPreferredLinkTarget(target, sourcePath);
							occurrences.push({
								start, end, text, target,
								replacement: text === basename && linkTarget === basename
									? `[[${linkTarget}]]`
									: `[[${linkTarget}|${text}]]`,
							});
						}
					}
					partOffset += part.text.length;
				}
			}
			lineStart = lineEnd + 1;
		}

		const grouped = new Map<string, AutoLinkCandidate>();
		for (const occurrence of occurrences) {
			const candidate = grouped.get(occurrence.target) || {target: occurrence.target, count: 0, examples: []};
			candidate.count += 1;
			if (!candidate.examples.includes(occurrence.text) && candidate.examples.length < 3) candidate.examples.push(occurrence.text);
			grouped.set(occurrence.target, candidate);
		}
		return {content, occurrences, candidates: [...grouped.values()].sort((a, b) => a.target.localeCompare(b.target))};
	}

	applyPlan(plan: AutoLinkPlan, selectedTargets: Set<string>): string {
		let result = plan.content;
		for (const occurrence of [...plan.occurrences].reverse()) {
			if (!selectedTargets.has(occurrence.target)) continue;
			result = result.slice(0, occurrence.start) + occurrence.replacement + result.slice(occurrence.end);
		}
		return result;
	}

	createCleanupPlan(content: string): AutoLinkCleanupPlan {
		const canonicalTargets = new Map<string, string>();
		for (const target of new Set(this.buildLocalWordCache().values())) {
			canonicalTargets.set(normalizeTarget(target), target);
			canonicalTargets.set(normalizeTarget(target.split('/').pop() || target), target);
		}
		const occurrences: AutoLinkOccurrence[] = [];
		const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			if (match.index > 0 && content[match.index - 1] === '!') continue;
			const rawTarget = match[1];
			if (!rawTarget) continue;
			const target = canonicalTargets.get(normalizeTarget(rawTarget));
			if (!target) continue;
			const basename = target.split('/').pop() || target;
			const display = match[2] || basename;
			occurrences.push({
				start: match.index,
				end: match.index + match[0].length,
				text: display,
				target,
				replacement: display,
			});
		}
		const grouped = new Map<string, AutoLinkCandidate>();
		for (const occurrence of occurrences) {
			const candidate = grouped.get(occurrence.target) || {target: occurrence.target, count: 0, examples: []};
			candidate.count += 1;
			if (!candidate.examples.includes(occurrence.text) && candidate.examples.length < 3) candidate.examples.push(occurrence.text);
			grouped.set(occurrence.target, candidate);
		}
		return {content, occurrences, candidates: [...grouped.values()].sort((a, b) => a.target.localeCompare(b.target))};
	}

	findMissingCandidates(content: string): AutoLinkCandidate[] {
		const localWords = this.buildLocalWordCache();
		const ignored = new Set(this.settings.autoLinkIgnoredWords);
		const candidates = new Map<string, AutoLinkCandidate>();
		const frontmatterEnd = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)?.[0].length ?? 0;
		const excludedHeadings = new Set(this.settings.autoLinkExcludedHeadings.map(title => title.toLowerCase()));
		let excludedHeadingLevel: number | null = null;
		let activeFence: {character: '`' | '~'; length: number} | null = null;
		let inHtmlComment = false;
		let lineStart = 0;
		for (const line of content.split('\n')) {
			const fence = getFenceMarker(line);
			const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
			if (heading?.[1] && heading[2]) {
				const level = heading[1].length;
				if (excludedHeadingLevel !== null && level <= excludedHeadingLevel) excludedHeadingLevel = null;
				if (excludedHeadings.has(heading[2].trim().toLowerCase())) excludedHeadingLevel = level;
			}
			if (fence && !activeFence) activeFence = fence;
			else if (activeFence && fence && fence.character === activeFence.character && fence.length >= activeFence.length) activeFence = null;
			const skipLine = lineStart < frontmatterEnd || Boolean(activeFence) || Boolean(fence)
				|| inHtmlComment || line.includes('<!--') || excludedHeadingLevel !== null
				|| /^(?:\t| {4})/.test(line) || isReferenceDefinition(line)
				|| (this.settings.autoLinkSkipHeadings && /^\s{0,3}#{1,6}\s/.test(line))
				|| (this.settings.autoLinkSkipBlockquotes && /^\s{0,3}>/.test(line));
			if (line.includes('<!--') || inHtmlComment) inHtmlComment = !line.includes('-->');
			if (!skipLine) {
				for (const part of splitProtectedMarkdown(line)) {
					if (part.isProtected) continue;
					WORD_PATTERN.lastIndex = 0;
					let match: RegExpExecArray | null;
					while ((match = WORD_PATTERN.exec(part.text)) !== null) {
						const display = match[0];
						const word = display.toLowerCase();
						if (display.length < this.settings.autoLinkMinWordLength || ignored.has(word)
							|| localWords.has(word) || localWords.has(getLemma(word))) continue;
						const candidate = candidates.get(word) || {target: word, count: 0, examples: []};
						candidate.count += 1;
						if (!candidate.examples.includes(display) && candidate.examples.length < 3) candidate.examples.push(display);
						candidates.set(word, candidate);
					}
				}
			}
			lineStart += line.length + 1;
		}
		return [...candidates.values()].sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
	}

	findLocalWord(word: string): string | null {
		const localWords = this.buildLocalWordCache();
		const lowerWord = word.toLowerCase();
		return localWords.get(getLemma(lowerWord)) || localWords.get(lowerWord) || null;
	}

	private getPreferredLinkTarget(target: string, sourcePath?: string): string {
		const basename = target.split('/').pop() || target;
		if (!sourcePath) return basename;

		const resolved = this.app.metadataCache.getFirstLinkpathDest(basename, sourcePath);
		if (!resolved || normalizeTarget(resolved.path) === normalizeTarget(target)) return basename;
		return target;
	}
}

function findWikiLinkTargets(text: string): string[] {
	const targets: string[] = [];
	const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		const target = match[1];
		if (target) targets.push(target);
	}
	return targets;
}

function normalizeTarget(target: string): string {
	return target.replace(/\.md$/i, '').toLowerCase();
}
