const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const EUDIC_SYNC_CALLOUT = /(?:^|\n)>\s*\[!info\]\s*(?:欧路同步|Eudic Sync)\s*\r?\n(?:^>.*(?:\r?\n|$))*/gmi;

/**
 * Keeps the hover preview focused on the readable note body. The note itself is
 * never changed. The callout rule is retained only for notes written by older
 * LexiBridge releases.
 */
export function getVirtualLinkPreviewMarkdown(markdown: string): string {
	return markdown
		.replace(FRONTMATTER_BLOCK, '')
		.replace(EUDIC_SYNC_CALLOUT, '\n')
		.trim();
}
