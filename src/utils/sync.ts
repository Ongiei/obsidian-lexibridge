export interface SyncSetDiff {
	localAdded: string[];
	cloudAdded: string[];
	localDeleted: string[];
	cloudDeleted: string[];
}

export type SyncOperationType = 'delete_cloud' | 'download' | 'upload' | 'trash_local';
export type SyncAlignmentReason = 'local-missing' | 'cloud-missing' | 'missing-baseline' | 'stale-divergence';

export const STALE_SYNC_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;
export const STALE_SYNC_CHANGE_THRESHOLD = 20;

export function getSyncDeletionSafetyError(
	diff: Pick<SyncSetDiff, 'localDeleted' | 'cloudDeleted'>,
	enabled: boolean,
	maxDeletionCount: number
): string | null {
	if (!enabled) return null;
	const limit = Number.isInteger(maxDeletionCount) ? Math.max(1, maxDeletionCount) : 50;
	const deletionCount = diff.localDeleted.length + diff.cloudDeleted.length;
	return deletionCount > limit
		? `同步删除保护已停止操作：计划删除 ${deletionCount} 个词条，超过单次上限 ${limit}。请检查单词文件夹、Token 和同步生词本范围。`
		: null;
}

export function getSyncOperationDeletionSafetyError(
	operations: Iterable<{type: SyncOperationType}>,
	enabled: boolean,
	maxDeletionCount: number
): string | null {
	if (!enabled) return null;
	const limit = Number.isInteger(maxDeletionCount) ? Math.max(1, maxDeletionCount) : 50;
	let deletionCount = 0;
	for (const operation of operations) {
		if (operation.type === 'delete_cloud' || operation.type === 'trash_local') deletionCount += 1;
	}
	return deletionCount > limit
		? `同步删除保护已停止操作：计划删除 ${deletionCount} 个词条，超过单次上限 ${limit}。请检查对齐策略和差异清单。`
		: null;
}

export function getSyncAlignmentReasons(
	diff: SyncSetDiff,
	manifestMissing: boolean,
	lastSyncTime: number,
	now = Date.now()
): SyncAlignmentReason[] {
	const reasons: SyncAlignmentReason[] = [];
	const totalChanges = diff.localAdded.length + diff.cloudAdded.length + diff.localDeleted.length + diff.cloudDeleted.length;
	if (diff.localDeleted.length > 0) reasons.push('local-missing');
	if (diff.cloudDeleted.length > 0) reasons.push('cloud-missing');
	if (manifestMissing && totalChanges > 0) reasons.push('missing-baseline');
	if (
		lastSyncTime > 0
		&& now - lastSyncTime >= STALE_SYNC_THRESHOLD_MS
		&& totalChanges >= STALE_SYNC_CHANGE_THRESHOLD
	) {
		reasons.push('stale-divergence');
	}
	return reasons;
}

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
		const timer = window.setTimeout(() => {
			reject(new Error(`操作超时：${operation}`));
		}, ms);

		promise
			.then(result => {
				window.clearTimeout(timer);
				resolve(result);
			})
			.catch(err => {
				window.clearTimeout(timer);
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
