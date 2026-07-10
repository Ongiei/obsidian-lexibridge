export interface MarkdownTextPart {
	text: string;
	isProtected: boolean;
}

const PROTECTED_MARKDOWN_PATTERN = /(`+[^`\n]*`+|!?\[\[[^\]\n]+\]\]|!?\[[^\]\n]*\]\([^\n)]*\)|!?\[[^\]\n]*\]\[[^\]\n]*\]|<[^>\n]+>|(?:https?:\/\/|mailto:|www\.)[^\s<>()]+|#[a-zA-Z0-9_/-]+)/g;

export function splitProtectedMarkdown(text: string): MarkdownTextPart[] {
	const parts: MarkdownTextPart[] = [];
	let match: RegExpExecArray | null;
	let lastEnd = 0;

	PROTECTED_MARKDOWN_PATTERN.lastIndex = 0;
	while ((match = PROTECTED_MARKDOWN_PATTERN.exec(text)) !== null) {
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

export function getFenceMarker(line: string): { character: '`' | '~'; length: number } | null {
	const match = line.match(/^\s{0,3}(`{3,}|~{3,})/);
	const marker = match?.[1];
	if (!marker) return null;
	return {
		character: marker[0] as '`' | '~',
		length: marker.length,
	};
}

export function isReferenceDefinition(line: string): boolean {
	return /^\s{0,3}\[[^\]]+\]:/.test(line);
}
