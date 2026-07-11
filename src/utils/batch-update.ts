import {parseYaml} from 'obsidian';
import { LexiBridgeSettings } from '../settings';
import { BatchWritePreview } from '../modal';

export interface LocalFrontmatter {
	tags?: string[];
	aliases?: string[];
	dict_source?: string;
	[key: string]: unknown;
}

export type BatchFileStatus = 'updated' | 'pending' | 'ignored';

export function getBatchWritePreview(settings: LexiBridgeSettings): BatchWritePreview {
	const fields = ['tags', 'word', 'aliases', 'dict_source'];
	if (settings.includeExamProperties) {
		fields.push('exams');
	}
	if (settings.includePosProperties) {
		fields.push('pos');
	}
	return {
		fields,
		tags: ['vocabulary'],
	};
}

export function parseFrontmatter(content: string): LocalFrontmatter | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match || !match[1]) {
		return null;
	}

	try {
		return parseYaml(match[1]) as LocalFrontmatter;
	} catch {
		return null;
	}
}

export function getBatchFileStatus(content: string, fm: LocalFrontmatter | null): BatchFileStatus {
	if (fm?.dict_source === 'ecdict' || fm?.dict_source === 'youdao') {
		return 'updated';
	}

	if (fm?.dict_source === 'eudic' || hasLegacySyncCallout(content)) {
		return 'pending';
	}

	return 'ignored';
}

export function getCandidateFilenames(word: string): string[] {
	return [`${word}.md`, `${word.toLowerCase()}.md`];
}

function hasLegacySyncCallout(content: string): boolean {
	return content.includes('[!info] Eudic Sync') || content.includes('[!info] 欧路同步');
}
