export const ANKI_CONNECT_VERSION = 6;
export const DEFAULT_ANKI_ENDPOINT = 'http://127.0.0.1:8765';
export const DEFAULT_ANKI_DECK = 'LexiBridge';
export const LEXIBRIDGE_ANKI_MODEL_NAME = 'LexiBridge Vocabulary';
export const LEXIBRIDGE_ANKI_MODEL_FIELDS = [
	'LexiBridgeId',
	'Word',
	'Phonetic',
	'Definition',
	'Examples',
	'Forms',
	'Notes',
	'Source',
	'ContentHash',
] as const;

export const DEFAULT_ANKI_FRONT_TEMPLATE = `
<div class="lexibridge-card">
	<div class="lexibridge-word">{{Word}}</div>
	{{#Phonetic}}<div class="lexibridge-phonetic">{{Phonetic}}</div>{{/Phonetic}}
</div>
`.trim();

export const DEFAULT_ANKI_BACK_TEMPLATE = `
{{FrontSide}}
<hr id="answer">
<div class="lexibridge-card lexibridge-back">
	<div class="lexibridge-section">{{Definition}}</div>
	{{#Examples}}<div class="lexibridge-section">{{Examples}}</div>{{/Examples}}
	{{#Forms}}<div class="lexibridge-section">{{Forms}}</div>{{/Forms}}
	{{#Notes}}<div class="lexibridge-section lexibridge-notes">{{Notes}}</div>{{/Notes}}
	{{#Source}}<div class="lexibridge-source">{{Source}}</div>{{/Source}}
</div>
`.trim();

export const DEFAULT_ANKI_CARD_CSS = `
.card {
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	font-size: 18px;
	line-height: 1.55;
	color: #222;
	background: #fafafa;
}
.lexibridge-word { font-size: 32px; font-weight: 700; margin-bottom: 8px; }
.lexibridge-phonetic, .lexibridge-source { color: #666; font-size: 14px; }
.lexibridge-section { margin: 12px 0; }
.lexibridge-section ul, .lexibridge-section ol { padding-left: 1.4em; }
.lexibridge-notes { border-top: 1px solid #ddd; padding-top: 12px; }
@media (prefers-color-scheme: dark) {
	.card { color: #eee; background: #1f1f1f; }
	.lexibridge-phonetic, .lexibridge-source { color: #aaa; }
	.lexibridge-notes { border-top-color: #444; }
}
`.trim();

export type MissingSourcePolicy = 'keep' | 'tag';
export type MissingSourceAction = 'tag' | 'suspend' | 'delete';

export interface AnkiSettings {
	enabled: boolean;
	endpoint: string;
	deckName: string;
	modelName: string;
	ankiSourceId: string;
	includeProtectedSections: boolean;
	syncAnkiWebAfterPush: boolean;
	missingSourcePolicy: MissingSourcePolicy;
	allowRemoteEndpoint: boolean;
	frontTemplate: string;
	backTemplate: string;
	cardCss: string;
}

export interface WordNoteSnapshot {
	filePath: string;
	word: string;
	aliases: string[];
	dictSource?: string;
	tags: string[];
	phoneticsMarkdown: string;
	definitionsMarkdown: string;
	examplesMarkdown: string;
	formsMarkdown: string;
	protectedMarkdown: string;
	sourceMarkdown: string;
	modifiedTime: number;
}

export interface DesiredAnkiNote {
	lexiBridgeId: string;
	word: string;
	deckName: string;
	modelName: string;
	fields: Record<string, string>;
	tags: string[];
	contentHash: string;
	sourceFilePath: string;
}

export interface AnkiFieldValue {
	value: string;
	order?: number;
}

export interface AnkiNoteInfo {
	noteId: number;
	modelName: string;
	tags: string[];
	fields: Record<string, AnkiFieldValue>;
	cards: number[];
}

export interface PlannedAdd {
	desired: DesiredAnkiNote;
}

export interface PlannedUpdate {
	desired: DesiredAnkiNote;
	existing: AnkiNoteInfo;
}

export interface PlannedUnchanged {
	desired: DesiredAnkiNote;
	existing: AnkiNoteInfo;
}

export interface PlannedMissingSource {
	existing: AnkiNoteInfo;
	lexiBridgeId: string;
}

export interface PlannedConflict {
	lexiBridgeId: string;
	message: string;
	noteIds?: number[];
	filePaths?: string[];
}

export interface PlannedError {
	filePath?: string;
	message: string;
}

export interface AnkiSyncPlan {
	adds: PlannedAdd[];
	updates: PlannedUpdate[];
	unchanged: PlannedUnchanged[];
	missingSources: PlannedMissingSource[];
	conflicts: PlannedConflict[];
	errors: PlannedError[];
}

export interface AnkiPreviewResult {
	plan: AnkiSyncPlan;
	desiredCount: number;
	existingCount: number;
}

export interface AnkiExecutionStats {
	added: number;
	updated: number;
	unchanged: number;
	failed: number;
	verified: number;
}

export interface AnkiExecutionResult {
	success: boolean;
	stats: AnkiExecutionStats;
	errors: string[];
}

export interface AnkiConnectEnvelope {
	action: string;
	version: number;
	params?: Record<string, unknown>;
}

export interface AnkiConnectResponse<T> {
	result: T;
	error: string | null;
}

export interface AnkiMultiAction {
	action: string;
	params?: Record<string, unknown>;
}

export type AnkiConnectTransport = (request: AnkiConnectEnvelope, endpoint: string, timeoutMs: number) => Promise<unknown>;

export const EMPTY_ANKI_SYNC_PLAN: AnkiSyncPlan = {
	adds: [],
	updates: [],
	unchanged: [],
	missingSources: [],
	conflicts: [],
	errors: [],
};
