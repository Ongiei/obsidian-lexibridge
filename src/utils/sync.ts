export interface SyncSetDiff {
	localAdded: string[];
	cloudAdded: string[];
	localDeleted: string[];
	cloudDeleted: string[];
}

export type SyncOperationType = 'delete_cloud' | 'download' | 'upload' | 'trash_local';

export function updateManifestAfterSuccessfulOperation(
	manifestWords: Set<string>,
	type: SyncOperationType,
	word: string
): void {
	const normalizedWord = word.toLowerCase();
	if (type === 'download' || type === 'upload') {
		manifestWords.add(normalizedWord);
	} else {
		manifestWords.delete(normalizedWord);
	}
}

export function getEffectiveUploadCategoryIds(
	syncCategoryIds: string[],
	defaultUploadCategoryId: string,
	frontmatterCategoryIds: string[] = []
): string[] {
	const syncScope = [...new Set(syncCategoryIds.filter(Boolean))];
	const frontmatterTargets = [...new Set(frontmatterCategoryIds.filter(Boolean))];
	const targetsInScope = syncScope.length > 0
		? frontmatterTargets.filter(categoryId => syncScope.includes(categoryId))
		: frontmatterTargets;
	if (targetsInScope.length > 0) {
		return targetsInScope;
	}

	if (syncScope.length > 0) {
		return syncScope.includes(defaultUploadCategoryId)
			? [defaultUploadCategoryId]
			: [syncScope[0]!];
	}

	return [defaultUploadCategoryId || '0'];
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`操作超时：${operation}`));
		}, ms);

		promise
			.then(result => {
				clearTimeout(timer);
				resolve(result);
			})
			.catch(err => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			});
	});
}

export function getValidFilename(word: string): string {
	let sanitized = word.toLowerCase();
	sanitized = sanitized.replace(/[<>:"/\\|?*]/g, '_');
	sanitized = sanitized.replace(/^\.+|\.+$/g, '');
	sanitized = sanitized.replace(/_{2,}/g, '_');
	return sanitized || 'unnamed';
}

export function diffSyncSets(
	manifestWords: Iterable<string>,
	localWords: Set<string>,
	cloudWords: Set<string>
): SyncSetDiff {
	const manifest = new Set(Array.from(manifestWords).map(word => word.toLowerCase()));
	const localAdded: string[] = [];
	const cloudAdded: string[] = [];
	const localDeleted: string[] = [];
	const cloudDeleted: string[] = [];

	for (const word of localWords) {
		if (!manifest.has(word) && !cloudWords.has(word)) {
			localAdded.push(word);
		}
	}

	for (const word of cloudWords) {
		if (!manifest.has(word) && !localWords.has(word)) {
			cloudAdded.push(word);
		}
	}

	for (const word of manifest) {
		if (cloudWords.has(word) && !localWords.has(word)) {
			localDeleted.push(word);
		}

		if (localWords.has(word) && !cloudWords.has(word)) {
			cloudDeleted.push(word);
		}
	}

	return { localAdded, cloudAdded, localDeleted, cloudDeleted };
}

export function parseEudicExpDefinitions(exp: string): { pos: string; trans: string }[] {
	if (!exp) return [{ pos: '', trans: '释义待更新' }];

	let text = exp;
	text = text.replace(/<[^>]+>/g, ' ');
	text = text.replace(/\.\.\./g, '').trim();

	const posPattern = /(?:;|^)\s*(adj|adv|art|aux|conj|int|n|num|prep|pron|v|vi|vt)\.\s*/gm;
	text = text.replace(posPattern, '\n- ***$1.*** ');
	text = text.replace(/^\n- /, '- ');

	const lines = text.split('\n').map(line => line.trim().replace(/^- /, '')).filter(Boolean);
	if (lines.length === 0) return [{ pos: '', trans: '释义待更新' }];

	return lines.map(line => {
		const match = line.match(/^\*\*\*([^*]+)\*\*\*\s*(.+)$/);
		if (match?.[1] && match?.[2]) {
			return { pos: match[1], trans: match[2] };
		}
		return { pos: '', trans: line };
	});
}
