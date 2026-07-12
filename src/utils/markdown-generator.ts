import { parseYaml, stringifyYaml } from 'obsidian';
import { DictEntry } from '../types';

const LEGACY_MANAGED_BLOCK_START = '<!-- lexibridge:managed:start -->';
const LEGACY_MANAGED_BLOCK_END = '<!-- lexibridge:managed:end -->';

export const DEFAULT_FRONTMATTER_TEMPLATE = `tags:
  - vocabulary
word: {{word}}
{{aliases_yaml}}{{dict_source_yaml}}{{eudic_lists_yaml}}{{exams_yaml}}{{pos_yaml}}`;

export const DEFAULT_BODY_TEMPLATE = `# {{word}}

{{phonetics}}
{{definitions}}
{{web_translations}}
{{examples}}
{{forms}}
`;

export interface MarkdownGenerateOptions {
	dictSource?: 'ecdict' | 'youdao' | 'eudic';
	originalWord?: string;
	frontmatterTemplate?: string;
	bodyTemplate?: string;
	includeExamProperties?: boolean;
	includePosProperties?: boolean;
	eudicLists?: string[];
}

export interface MarkdownPreview {
	frontmatter: Record<string, unknown>;
	tags: string[];
	body: string;
	managedBlock: string;
	content: string;
}

interface TemplateContext {
	word: string;
	originalWord: string;
	phonetic_uk: string;
	phonetic_us: string;
	audio_uk: string;
	audio_us: string;
	definitions: string;
	examples: string;
	forms: string;
	phonetics: string;
	web_translations: string;
	aliases_yaml: string;
	dict_source_yaml: string;
	eudic_lists_yaml: string;
	exams_yaml: string;
	pos_yaml: string;
}

interface HeadingSection {
	title: string;
	start: number;
	end: number;
	text: string;
}

const CONTROLLED_FRONTMATTER_KEYS = ['tags', 'word', 'aliases', 'dict_source', 'eudic_lists', 'exams', 'pos'];

function unique(values: string[]): string[] {
	return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

function yamlSnippet(key: string, value: unknown): string {
	if (value === undefined || (Array.isArray(value) && value.length === 0)) {
		return '';
	}
	return stringifyYaml({ [key]: value });
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((item): item is string => typeof item === 'string');
}

export class MarkdownGenerator {
	static generate(word: string, entry: DictEntry, options: MarkdownGenerateOptions): string {
		return this.preview(word, entry, options).content;
	}

	static preview(word: string, entry: DictEntry, options: MarkdownGenerateOptions): MarkdownPreview {
		const context = this.createContext(word, entry, options);
		const frontmatterTemplate = options.frontmatterTemplate || DEFAULT_FRONTMATTER_TEMPLATE;
		const bodyTemplate = options.bodyTemplate || DEFAULT_BODY_TEMPLATE;

		const frontmatterText = this.renderTemplate(frontmatterTemplate, context).trim();
		const parsedFrontmatter = this.parseFrontmatter(frontmatterText);
		const frontmatter = this.normalizeFrontmatter(parsedFrontmatter, word, entry, options);
		const body = this.renderTemplate(bodyTemplate, context).trimEnd() + '\n';
		const content = `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;

		return {
			frontmatter,
			tags: Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] : [],
			body,
			managedBlock: body.trim(),
			content,
		};
	}

	static mergeWithExisting(
		existingContent: string,
		generatedContent: string,
		protectedHeadings: string[] = []
	): string {
		const existing = this.splitFrontmatter(existingContent);
		const generated = this.splitFrontmatter(generatedContent);
		const existingFrontmatter = existing.frontmatter ? this.parseFrontmatter(existing.frontmatter) : {};
		const generatedFrontmatter = generated.frontmatter ? this.parseFrontmatter(generated.frontmatter) : {};
		const mergedFrontmatter = this.mergeFrontmatter(existingFrontmatter, generatedFrontmatter);
		const cleanExistingBody = this.removeLegacyMarkers(existing.body);
		const mergedBody = this.preserveHeadingSections(cleanExistingBody, generated.body, protectedHeadings);

		return `---\n${stringifyYaml(mergedFrontmatter)}---\n\n${mergedBody.trimStart()}`;
	}

	private static createContext(word: string, entry: DictEntry, options: MarkdownGenerateOptions): TemplateContext {
		const aliases = this.getAliases(word, entry, options.originalWord);
		const exams = options.includeExamProperties ? unique(entry.tags) : [];
		const pos = options.includePosProperties ? this.getPartsOfSpeech(entry) : [];
		const dictSource = options.dictSource ? yamlSnippet('dict_source', options.dictSource) : '';
		const eudicLists = yamlSnippet('eudic_lists', unique(options.eudicLists || []));

		return {
			word,
			originalWord: options.originalWord || word,
			phonetic_uk: entry.ph_uk,
			phonetic_us: entry.ph_us,
			audio_uk: entry.audio_uk,
			audio_us: entry.audio_us,
			definitions: this.renderDefinitions(entry),
			examples: this.renderExamples(entry),
			forms: this.renderForms(entry),
			phonetics: this.renderPhonetics(entry),
			web_translations: this.renderWebTranslations(entry),
			aliases_yaml: yamlSnippet('aliases', aliases),
			dict_source_yaml: dictSource,
			eudic_lists_yaml: eudicLists,
			exams_yaml: yamlSnippet('exams', exams),
			pos_yaml: yamlSnippet('pos', pos),
		};
	}

	private static normalizeFrontmatter(
		frontmatter: Record<string, unknown>,
		word: string,
		entry: DictEntry,
		options: MarkdownGenerateOptions
	): Record<string, unknown> {
		const normalized = { ...frontmatter };
		if (normalized.tags === undefined) {
			normalized.tags = ['vocabulary'];
		}
		normalized.word = typeof normalized.word === 'string' && normalized.word.trim() ? normalized.word : word;

		const aliases = this.getAliases(word, entry, options.originalWord);
		if (aliases.length > 0 && normalized.aliases === undefined) {
			normalized.aliases = aliases;
		}

		if (options.dictSource && normalized.dict_source === undefined) {
			normalized.dict_source = options.dictSource;
		}

		if (options.eudicLists && options.eudicLists.length > 0) {
			normalized.eudic_lists = unique(options.eudicLists);
		} else {
			delete normalized.eudic_lists;
		}

		if (options.includeExamProperties) {
			const exams = unique(entry.tags);
			if (exams.length > 0) normalized.exams = exams;
		} else {
			delete normalized.exams;
		}

		if (options.includePosProperties) {
			const pos = this.getPartsOfSpeech(entry);
			if (pos.length > 0) normalized.pos = pos;
		} else {
			delete normalized.pos;
		}

		return normalized;
	}

	private static renderTemplate(template: string, context: TemplateContext): string {
		return template.replace(/\{\{(\w+)\}\}/g, (_match, key: keyof TemplateContext) => {
			const value = context[key];
			return typeof value === 'string' ? value : '';
		});
	}

	private static parseFrontmatter(frontmatter: string): Record<string, unknown> {
		if (!frontmatter.trim()) {
			return {};
		}

		try {
			const parsed: unknown = parseYaml(frontmatter);
			return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
		} catch (error) {
			console.warn('[LexiBridge] Failed to parse frontmatter template:', error);
			return { tags: ['vocabulary'] };
		}
	}

	private static splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
		const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
		if (!match || match[1] === undefined) {
			return { frontmatter: null, body: content };
		}
		return {
			frontmatter: match[1],
			body: content.slice(match[0].length),
		};
	}

	private static mergeFrontmatter(
		existingFrontmatter: Record<string, unknown>,
		generatedFrontmatter: Record<string, unknown>
	): Record<string, unknown> {
		const merged = { ...existingFrontmatter };
		for (const key of CONTROLLED_FRONTMATTER_KEYS) {
			if (key === 'tags') {
				const generatedTags = stringArray(generatedFrontmatter.tags);
				const preservedTags = stringArray(existingFrontmatter.tags)
					.filter(tag => !tag.startsWith('exam/') && !tag.startsWith('pos/'));
				merged.tags = unique([...generatedTags, ...preservedTags]);
				continue;
			}

			if (key === 'aliases') {
				merged.aliases = unique([
					...stringArray(generatedFrontmatter.aliases),
					...stringArray(existingFrontmatter.aliases),
				]);
				if ((merged.aliases as string[]).length === 0) {
					delete merged.aliases;
				}
				continue;
			}

			if (key === 'eudic_lists') {
				if (generatedFrontmatter.eudic_lists !== undefined) {
					merged.eudic_lists = generatedFrontmatter.eudic_lists;
				}
				continue;
			}

			if (generatedFrontmatter[key] !== undefined) {
				merged[key] = generatedFrontmatter[key];
			} else {
				delete merged[key];
			}
		}
		return merged;
	}

	private static removeLegacyMarkers(body: string): string {
		return body
			.split(LEGACY_MANAGED_BLOCK_START).join('')
			.split(LEGACY_MANAGED_BLOCK_END).join('')
			.replace(/\n{3,}/g, '\n\n');
	}

	private static preserveHeadingSections(
		existingBody: string,
		generatedBody: string,
		protectedHeadings: string[]
	): string {
		const titles = new Set(protectedHeadings.map(title => title.trim().toLowerCase()).filter(Boolean));
		if (titles.size === 0) return generatedBody.trimEnd() + '\n';

		const preserved = this.extractHeadingSections(existingBody, titles);
		let result = generatedBody.trimEnd();
		for (const section of preserved) {
			const generatedSections = this.findHeadingSections(result);
			const match = generatedSections.find(candidate => candidate.title === section.title);
			if (match) {
				result = result.slice(0, match.start).trimEnd()
					+ '\n\n' + section.text.trim()
					+ '\n\n' + result.slice(match.end).trimStart();
			} else {
				result = `${result.trimEnd()}\n\n${section.text.trim()}`;
			}
		}
		return result.trimEnd() + '\n';
	}

	private static extractHeadingSections(body: string, titles: Set<string>): HeadingSection[] {
		return this.findHeadingSections(body).filter(section => titles.has(section.title));
	}

	private static findHeadingSections(body: string): HeadingSection[] {
		const headings = [...body.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)].map(match => ({
			level: match[1]!.length,
			title: match[2]!.trim().toLowerCase(),
			start: match.index,
		}));
		return headings.map((heading, index) => {
			let end = body.length;
			for (let cursor = index + 1; cursor < headings.length; cursor++) {
				const candidate = headings[cursor]!;
				if (candidate.level <= heading.level) {
					end = candidate.start;
					break;
				}
			}
			return { title: heading.title, start: heading.start, end, text: body.slice(heading.start, end) };
		});
	}

	private static getAliases(word: string, entry: DictEntry, originalWord?: string): string[] {
		const aliases: string[] = [];
		for (const item of entry.exchange) {
			aliases.push(item.value);
		}

		if (originalWord && originalWord.toLowerCase() !== word.toLowerCase()) {
			aliases.push(originalWord);
		}

		return unique(aliases);
	}

	private static getPartsOfSpeech(entry: DictEntry): string[] {
		return unique(entry.definitions.map(def => def.pos.replace(/\./g, '')));
	}

	private static renderPhonetics(entry: DictEntry): string {
		if (!entry.ph_uk && !entry.ph_us && !entry.audio_uk && !entry.audio_us) {
			return '';
		}

		const lines = ['## 发音', ''];
		if (entry.ph_uk) lines.push(`- 英: \`/${entry.ph_uk}/\``);
		if (entry.ph_us) lines.push(`- 美: \`/${entry.ph_us}/\``);
		if (entry.audio_uk) lines.push(`- 英音频: ${entry.audio_uk}`);
		if (entry.audio_us) lines.push(`- 美音频: ${entry.audio_us}`);
		return lines.join('\n') + '\n';
	}

	private static renderDefinitions(entry: DictEntry): string {
		if (entry.definitions.length === 0) {
			return '';
		}

		const lines = ['## 释义', ''];
		for (const def of entry.definitions) {
			const escapedTrans = def.trans.replace(/\[/g, '\\[');
			lines.push(def.pos ? `- ***${def.pos}*** ${escapedTrans}` : `- ${escapedTrans}`);
		}
		return lines.join('\n') + '\n';
	}

	private static renderWebTranslations(entry: DictEntry): string {
		if (!entry.webTrans || entry.webTrans.length === 0) {
			return '';
		}

		const lines = ['## 网络翻译', ''];
		for (const item of entry.webTrans) {
			const numberedValues = item.value.map((v, i) => `${i + 1}. ${v}`).join(' ');
			lines.push(`- **${item.key}**: ${numberedValues}`);
		}
		return lines.join('\n') + '\n';
	}

	private static renderExamples(entry: DictEntry): string {
		if (!entry.bilingualExamples || entry.bilingualExamples.length === 0) {
			return '';
		}

		const lines = ['## 例句', ''];
		for (const example of entry.bilingualExamples) {
			lines.push(`- ${example.eng}`);
			lines.push(`  - ${example.chn}`);
		}
		return lines.join('\n') + '\n';
	}

	private static renderForms(entry: DictEntry): string {
		if (entry.exchange.length === 0) {
			return '';
		}

		const lines = ['## 词形变化', ''];
		for (const item of entry.exchange) {
			lines.push(`- ${item.name}: ${item.value}`);
		}
		return lines.join('\n') + '\n';
	}
}
