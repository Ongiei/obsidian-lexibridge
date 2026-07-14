import {DEFAULT_SETTINGS, LexiBridgeSettings} from "./settings";
import {DEFAULT_ANKI_ENDPOINT, LEXIBRIDGE_ANKI_MODEL_NAME} from './anki/types';
import {normalizeVaultFolderPath} from './utils/vault-path';

export function normalizeSettings(loaded: unknown): LexiBridgeSettings {
	const settings: LexiBridgeSettings = {
		...DEFAULT_SETTINGS,
		protectedHeadings: [...DEFAULT_SETTINGS.protectedHeadings],
		syncCategoryIds: [...DEFAULT_SETTINGS.syncCategoryIds],
		anki: {...DEFAULT_SETTINGS.anki},
	};
	if (!loaded || typeof loaded !== 'object') {
		settings.anki = normalizeAnkiSettings(undefined);
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
	settings.folderPath = normalizeVaultFolderPath(settings.folderPath, DEFAULT_SETTINGS.folderPath);
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
			.map(value => value.trim())
			.map(value => /^#{1,6}\s+\S/.test(value) ? value.replace(/\s+#+\s*$/, '') : value.replace(/^#+\s*/, ''))
			.filter(Boolean))];
	}
	settings.syncCategoryIds = Array.isArray(settings.syncCategoryIds)
		? [...new Set(settings.syncCategoryIds.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean))]
		: [];
	settings.autoLinkMinWordLength = Number.isInteger(settings.autoLinkMinWordLength)
		? Math.min(20, Math.max(1, settings.autoLinkMinWordLength))
		: DEFAULT_SETTINGS.autoLinkMinWordLength;
	settings.autoLinkIgnoredWords = Array.isArray(settings.autoLinkIgnoredWords)
		? [...new Set(settings.autoLinkIgnoredWords
			.filter((value): value is string => typeof value === 'string')
			.map(value => value.trim().toLowerCase())
			.filter(Boolean))]
		: [];
	settings.autoLinkSkipHeadings = settings.autoLinkSkipHeadings === true;
	settings.autoLinkSkipBlockquotes = settings.autoLinkSkipBlockquotes !== false;
	settings.autoLinkExcludedHeadings = Array.isArray(settings.autoLinkExcludedHeadings)
		? [...new Set(settings.autoLinkExcludedHeadings
			.filter((value): value is string => typeof value === 'string')
			.map(value => value.replace(/^#+\s*/, '').trim())
			.filter(Boolean))]
		: [];
	settings.autoLinkSkipWordFolder = settings.autoLinkSkipWordFolder !== false;
	settings.virtualLinksEnabled = settings.virtualLinksEnabled === true;
	settings.selectionLookupSource = settings.selectionLookupSource === 'youdao' ? 'youdao' : 'ecdict';
	settings.syncDeletionProtection = settings.syncDeletionProtection !== false;
	settings.syncMaxDeletionCount = Number.isInteger(settings.syncMaxDeletionCount)
		? Math.max(1, settings.syncMaxDeletionCount)
		: DEFAULT_SETTINGS.syncMaxDeletionCount;
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
	anki.frontTemplate = typeof source.frontTemplate === 'string' && source.frontTemplate.trim()
		? source.frontTemplate.trim()
		: defaults.frontTemplate;
	anki.backTemplate = typeof source.backTemplate === 'string' && source.backTemplate.trim()
		? source.backTemplate.trim()
		: defaults.backTemplate;
	anki.cardCss = typeof source.cardCss === 'string' && source.cardCss.trim()
		? source.cardCss.trim()
		: defaults.cardCss;

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
