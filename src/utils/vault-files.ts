import { TFile, TFolder } from 'obsidian';

export function getMarkdownFilesRecursively(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	const pending: TFolder[] = [folder];

	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) continue;

		for (const child of current.children) {
			if (child instanceof TFolder) {
				pending.push(child);
			} else if (child instanceof TFile && child.extension === 'md') {
				files.push(child);
			}
		}
	}

	return files;
}
