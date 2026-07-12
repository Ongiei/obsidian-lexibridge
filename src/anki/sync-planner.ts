import {
	AnkiNoteInfo,
	AnkiSyncPlan,
	DesiredAnkiNote,
	EMPTY_ANKI_SYNC_PLAN,
} from './types';

export class AnkiSyncPlanner {
	plan(desiredNotes: DesiredAnkiNote[], existingNotes: AnkiNoteInfo[]): AnkiSyncPlan {
		const plan: AnkiSyncPlan = cloneEmptyPlan();
		const desiredById = new Map<string, DesiredAnkiNote>();
		const existingById = new Map<string, AnkiNoteInfo[]>();

		for (const desired of desiredNotes) {
			const existing = desiredById.get(desired.lexiBridgeId);
			if (existing) {
				plan.conflicts.push({
					lexiBridgeId: desired.lexiBridgeId,
					message: '多个 Markdown 单词笔记映射到了同一个 LexiBridgeId。',
					filePaths: [existing.sourceFilePath, desired.sourceFilePath],
				});
				continue;
			}
			desiredById.set(desired.lexiBridgeId, desired);
		}

		for (const note of existingNotes) {
			const lexiBridgeId = getFieldValue(note, 'LexiBridgeId');
			if (!lexiBridgeId) {
				plan.errors.push({ message: `Anki 笔记 ${note.noteId} 缺少 LexiBridgeId 字段。` });
				continue;
			}
			const list = existingById.get(lexiBridgeId) || [];
			list.push(note);
			existingById.set(lexiBridgeId, list);
		}

		for (const [lexiBridgeId, notes] of existingById.entries()) {
			if (notes.length > 1) {
				plan.conflicts.push({
					lexiBridgeId,
					message: 'Anki 中存在重复的 LexiBridgeId，无法安全决定更新哪一条。',
					noteIds: notes.map(note => note.noteId),
				});
			}
		}

		for (const desired of desiredById.values()) {
			const existing = existingById.get(desired.lexiBridgeId) || [];
			if (existing.length > 1) continue;
			const note = existing[0];
			if (!note) {
				plan.adds.push({ desired });
				continue;
			}
			const existingHash = getFieldValue(note, 'ContentHash');
			if (existingHash === desired.contentHash) {
				plan.unchanged.push({ desired, existing: note });
			} else {
				plan.updates.push({ desired, existing: note });
			}
		}

		for (const [lexiBridgeId, notes] of existingById.entries()) {
			if (desiredById.has(lexiBridgeId) || notes.length > 1) continue;
			const note = notes[0];
			if (note) plan.missingSources.push({ existing: note, lexiBridgeId });
		}

		return plan;
	}
}

function getFieldValue(note: AnkiNoteInfo, fieldName: string): string {
	return note.fields[fieldName]?.value || '';
}

function cloneEmptyPlan(): AnkiSyncPlan {
	return {
		adds: [...EMPTY_ANKI_SYNC_PLAN.adds],
		updates: [...EMPTY_ANKI_SYNC_PLAN.updates],
		unchanged: [...EMPTY_ANKI_SYNC_PLAN.unchanged],
		missingSources: [...EMPTY_ANKI_SYNC_PLAN.missingSources],
		conflicts: [...EMPTY_ANKI_SYNC_PLAN.conflicts],
		errors: [...EMPTY_ANKI_SYNC_PLAN.errors],
	};
}
