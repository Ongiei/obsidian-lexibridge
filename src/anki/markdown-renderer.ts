export interface AnkiMarkdownRenderer {
	render(markdown: string): string;
}

export class BasicAnkiMarkdownRenderer implements AnkiMarkdownRenderer {
	render(markdown: string): string {
		return markdownToHtml(markdown);
	}
}

export const BASIC_ANKI_MARKDOWN_RENDERER = new BasicAnkiMarkdownRenderer();

export function markdownToHtml(markdown: string): string {
	const lines = markdown.replace(/\r\n/g, '\n').split('\n');
	const html: string[] = [];
	let listType: 'ul' | 'ol' | null = null;

	const closeList = () => {
		if (listType) {
			html.push(`</${listType}>`);
			listType = null;
		}
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			closeList();
			continue;
		}

		const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
		if (unordered?.[1]) {
			if (listType !== 'ul') {
				closeList();
				html.push('<ul>');
				listType = 'ul';
			}
			html.push(`<li>${inlineMarkdownToHtml(unordered[1])}</li>`);
			continue;
		}

		const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
		if (ordered?.[1]) {
			if (listType !== 'ol') {
				closeList();
				html.push('<ol>');
				listType = 'ol';
			}
			html.push(`<li>${inlineMarkdownToHtml(ordered[1])}</li>`);
			continue;
		}

		closeList();
		html.push(`<p>${inlineMarkdownToHtml(trimmed)}</p>`);
	}

	closeList();
	return html.join('');
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function inlineMarkdownToHtml(markdown: string): string {
	const linkPlaceholders: string[] = [];
	const withLinkPlaceholders = markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
		const token = `%%LEXIBRIDGE_LINK_${linkPlaceholders.length}%%`;
		linkPlaceholders.push(`<a href="${escapeAttribute(href)}">${escapeHtml(label)}</a>`);
		return token;
	});
	const escaped = escapeHtml(withLinkPlaceholders);
	return escaped
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>')
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/%%LEXIBRIDGE_LINK_(\d+)%%/g, (_match, index: string) => linkPlaceholders[Number(index)] || '');
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replace(/\s/g, '%20');
}
