import {DictionaryProvider} from './dictionary-provider';
import {DictEntry} from './types';
import {YoudaoRequestError, YoudaoService} from './youdao';

const MINIMUM_INTERVAL_MS = 1000;
const MAXIMUM_INTERVAL_MS = 60000;
const JITTER_MS = 300;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

type LookupFunction = (word: string) => Promise<DictEntry | null>;
type WaitFunction = (ms: number) => Promise<void>;

export class YoudaoProvider implements DictionaryProvider {
	readonly id = 'youdao' as const;
	readonly displayName = '有道在线增强';
	private queue: Promise<void> = Promise.resolve();
	private nextAllowedAt = 0;
	private cooldownUntil = 0;

	constructor(
		private getMinimumIntervalMs: () => number,
		private lookupFunction: LookupFunction = word => YoudaoService.lookup(word),
		private wait: WaitFunction = delay,
		private now: () => number = Date.now,
		private random: () => number = Math.random
	) {}

	lookup(word: string): Promise<DictEntry | null> {
		const pending = this.queue.then(() => this.lookupWithRetry(word));
		this.queue = pending.then(() => undefined, () => undefined);
		return pending;
	}

	private async lookupWithRetry(word: string): Promise<DictEntry | null> {
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			await this.waitForTurn();
			try {
				return await this.lookupFunction(word);
			} catch (error) {
				if (error instanceof YoudaoRequestError && (error.status === 403 || error.status === 429)) {
					this.cooldownUntil = this.now() + RATE_LIMIT_COOLDOWN_MS;
					throw new Error('有道在线查询已触发频率限制，已暂停 5 分钟');
				}

				const retryable = error instanceof YoudaoRequestError && error.status >= 500;
				if (!retryable || attempt === MAX_ATTEMPTS - 1) throw error;
				await this.wait(1000 * 2 ** attempt);
			}
		}
		return null;
	}

	private async waitForTurn(): Promise<void> {
		const now = this.now();
		const waitUntil = Math.max(this.nextAllowedAt, this.cooldownUntil);
		if (waitUntil > now) await this.wait(waitUntil - now);

		const configuredInterval = this.getMinimumIntervalMs();
		const interval = Math.min(MAXIMUM_INTERVAL_MS, Math.max(MINIMUM_INTERVAL_MS, configuredInterval));
		this.nextAllowedAt = this.now() + interval + Math.floor(this.random() * JITTER_MS);
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms));
}
