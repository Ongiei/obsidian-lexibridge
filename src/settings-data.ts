import {DEFAULT_SETTINGS, LexiBridgeSettings} from "./settings";

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

	return settings;
}
