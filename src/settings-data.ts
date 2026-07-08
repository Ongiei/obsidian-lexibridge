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

	if ((settings.dictionarySource as string) !== 'youdao') {
		settings.dictionarySource = 'youdao';
	}

	return settings;
}
