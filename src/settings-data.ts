import {DEFAULT_SETTINGS, LexiBridgeSettings} from "./settings";
import {DEFAULT_ANKI_ENDPOINT, LEXIBRIDGE_ANKI_MODEL_NAME} from './anki/types';

export function normalizeSettings(loaded: unknown): LexiBridgeSettings {
	const settings: LexiBridgeSettings = Object.assign({}, DEFAULT_SETTINGS);
	if (!loaded || typeof loaded !== 'object') {
		return settings;
	}

	const source = loaded as Partial<LexiBridgeSettings>;
	for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof LexiBridgeSettings)[]) {
		const value = source[key];
		if (value !== undefined) {
			Object.assign(settings, { [key]: value });
		}
	}

	if (typeof settings.bodyTemplate !== 'string') settings.bodyTemplate = DEFAULT_SETTINGS.bodyTemplate;
	settings.bodyTemplate = settings.bodyTemplate
		.split('<!-- lexibridge:managed:start -->').join('')
		.split('<!-- lexibridge:managed:end -->').join('')
		.replace(/\n{3,}/g, '\n\n')
		.trim() + '\n';
	if (!Array.isArray(settings.protectedHeadings)) {
		settings.protectedHeadings = [...DEFAULT_SETTINGS.protectedHeadings];
	} else {
		settings.protectedHeadings = [...new Set(settings.protectedHeadings
			.filter((value): value is string => typeof value === 'string')
			.map(value => value.replace(/^#+\s*/, '').trim())
			.filter(Boolean))];
	}
	const validSources = new Set([
		'github', 'ghproxy-net', 'gh-proxy-com', 'jsdelivr',
		'jsdelivr-fastly', 'jsdelivr-gcore', 'statically',
	]);
	if (!validSources.has(settings.ecdictDownloadSource)) {
		settings.ecdictDownloadSource = DEFAULT_SETTINGS.ecdictDownloadSource;
	}
	settings.anki = normalizeAnkiSettings(source.anki);

	return settings;
}

function normalizeAnkiSettings(loaded: unknown): LexiBridgeSettings['anki'] {
	const defaults = DEFAULT_SETTINGS.anki;
	const source = loaded && typeof loaded === 'object' ? loaded as Partial<LexiBridgeSettings['anki']> : {};
	const anki = Object.assign({}, defaults, source);

	anki.enabled = source.enabled === true;
	anki.endpoint = normalizeAnkiEndpoint(source.endpoint, source.allowRemoteEndpoint === true);
	anki.deckName = typeof source.deckName === 'string' && source.deckName.trim()
		? source.deckName.trim()
		: defaults.deckName;
	anki.modelName = LEXIBRIDGE_ANKI_MODEL_NAME;
	anki.ankiSourceId = typeof source.ankiSourceId === 'string' && source.ankiSourceId.trim()
		? source.ankiSourceId.trim()
		: createSourceId();
	anki.includeProtectedSections = source.includeProtectedSections === true;
	anki.syncAnkiWebAfterPush = source.syncAnkiWebAfterPush === true;
	anki.missingSourcePolicy = source.missingSourcePolicy === 'tag' ? 'tag' : 'keep';
	anki.allowRemoteEndpoint = source.allowRemoteEndpoint === true;

	return anki;
}

function normalizeAnkiEndpoint(endpoint: unknown, allowRemoteEndpoint: boolean): string {
	if (typeof endpoint !== 'string' || !endpoint.trim()) {
		return DEFAULT_ANKI_ENDPOINT;
	}
	try {
		const parsed = new URL(endpoint.trim());
		const isLocal = parsed.protocol === 'http:'
			&& (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
		if (isLocal || allowRemoteEndpoint) {
			return parsed.toString().replace(/\/$/, '');
		}
	} catch {
		return DEFAULT_ANKI_ENDPOINT;
	}
	return DEFAULT_ANKI_ENDPOINT;
}

function createSourceId(): string {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}
	return `source-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
