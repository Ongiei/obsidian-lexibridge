import {DictEntry} from './types';

export type DictionaryProviderId = 'ecdict' | 'youdao';
export type NoteDictionarySource = DictionaryProviderId | 'eudic';

export interface DictionaryLookupResult {
	entry: DictEntry;
	source: DictionaryProviderId;
}

export interface DictionaryProvider {
	readonly id: DictionaryProviderId;
	readonly displayName: string;
	lookup(word: string): Promise<DictEntry | null>;
}

export class DictionaryService {
	constructor(
		private localProvider: DictionaryProvider,
		private onlineProvider: DictionaryProvider,
		private shouldUseOnlineFallback: () => boolean
	) {}

	async lookup(word: string): Promise<DictionaryLookupResult | null> {
		const localEntry = await this.localProvider.lookup(word);
		if (localEntry) {
			return { entry: localEntry, source: this.localProvider.id };
		}

		if (!this.shouldUseOnlineFallback()) return null;
		return this.lookupOnline(word);
	}

	async lookupLocal(word: string): Promise<DictionaryLookupResult | null> {
		const entry = await this.localProvider.lookup(word);
		return entry ? { entry, source: this.localProvider.id } : null;
	}

	async lookupOnline(word: string): Promise<DictionaryLookupResult | null> {
		const entry = await this.onlineProvider.lookup(word);
		return entry ? { entry, source: this.onlineProvider.id } : null;
	}
}
