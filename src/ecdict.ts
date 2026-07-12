import {requestUrl, RequestUrlParam, RequestUrlResponse} from 'obsidian';
import {DictionaryProvider} from './dictionary-provider';
import {EcdictDatabase, EcdictEntryStore, EcdictInstallation} from './ecdict-database';
import {createEcdictColumnMap, parseCsvRows, StoredEcdictEntry, toStoredEcdictEntry} from './utils/ecdict';

const UPSTREAM_REPOSITORY = 'skywind3000/ECDICT';
const UPSTREAM_FILE = 'ecdict.csv';
const UPSTREAM_COMMIT_API = `https://api.github.com/repos/${UPSTREAM_REPOSITORY}/commits?path=${UPSTREAM_FILE}&per_page=1`;
const MINIMUM_ENTRY_COUNT = 500000;
const IMPORT_BATCH_SIZE = 1000;
const SPEED_TEST_TIMEOUT_MS = 10000;

export type EcdictDownloadSourceId =
	| 'github'
	| 'ghproxy-net'
	| 'gh-proxy-com'
	| 'jsdelivr'
	| 'jsdelivr-fastly'
	| 'jsdelivr-gcore'
	| 'statically';

export interface EcdictDownloadSource {
	id: EcdictDownloadSourceId;
	name: string;
	buildUrl: (sha: string, file: string) => string;
}

export const ECDICT_DOWNLOAD_SOURCES: EcdictDownloadSource[] = [
	{
		id: 'github',
		name: 'GitHub 原始地址',
		buildUrl: (sha, file) => `https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${sha}/${file}`,
	},
	{
		id: 'ghproxy-net',
		name: 'ghproxy.net',
		buildUrl: (sha, file) => `https://ghproxy.net/https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${sha}/${file}`,
	},
	{
		id: 'gh-proxy-com',
		name: 'gh-proxy.com',
		buildUrl: (sha, file) => `https://gh-proxy.com/https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${sha}/${file}`,
	},
	{
		id: 'jsdelivr',
		name: 'jsDelivr CDN',
		buildUrl: (sha, file) => `https://cdn.jsdelivr.net/gh/${UPSTREAM_REPOSITORY}@${sha}/${file}`,
	},
	{
		id: 'jsdelivr-fastly',
		name: 'jsDelivr Fastly',
		buildUrl: (sha, file) => `https://fastly.jsdelivr.net/gh/${UPSTREAM_REPOSITORY}@${sha}/${file}`,
	},
	{
		id: 'jsdelivr-gcore',
		name: 'jsDelivr GCore',
		buildUrl: (sha, file) => `https://gcore.jsdelivr.net/gh/${UPSTREAM_REPOSITORY}@${sha}/${file}`,
	},
	{
		id: 'statically',
		name: 'Statically',
		buildUrl: (sha, file) => `https://cdn.statically.io/gh/${UPSTREAM_REPOSITORY}@${sha}/${file}`,
	},
];

export interface EcdictSourceMetadata {
	sourceSha: string;
	sourceUrl: string;
	sourceName: string;
}

export interface EcdictSpeedResult {
	id: EcdictDownloadSourceId;
	name: string;
	durationMs: number | null;
	available: boolean;
	error?: string;
}

export interface EcdictStatus {
	installed: boolean;
	valid: boolean;
	installation: EcdictInstallation | null;
}

export interface EcdictProgress {
	phase: 'metadata' | 'download' | 'import' | 'validate';
	progress: number;
	message: string;
}

type RequestFunction = (options: RequestUrlParam) => Promise<RequestUrlResponse>;

export class EcdictProvider implements DictionaryProvider {
	readonly id = 'ecdict' as const;
	readonly displayName = 'ECDICT 本地词典';

	constructor(private database: EcdictDatabase) {}

	lookup(word: string) {
		return this.database.lookup(word);
	}
}

export class EcdictManager {
	constructor(
		private database: EcdictDatabase,
		private request: RequestFunction = requestUrl,
		private minimumEntryCount: number = MINIMUM_ENTRY_COUNT,
		private minimumSourceBytes: number = 50_000_000
	) {}

	async getStatus(): Promise<EcdictStatus> {
		const installation = await this.database.getInstallation();
		if (!installation) return { installed: false, valid: false, installation: null };
		const count = await this.database.count(installation.activeStore);
		const sample = await this.database.lookup('the');
		return {
			installed: true,
			valid: count === installation.entryCount && count >= this.minimumEntryCount && Boolean(sample),
			installation,
		};
	}

	async checkForUpdate(sourceId: EcdictDownloadSourceId): Promise<{ available: boolean; source: EcdictSourceMetadata }> {
		const source = await this.fetchSourceMetadata(sourceId);
		const installation = await this.database.getInstallation();
		return { available: !installation || installation.sourceSha !== source.sourceSha, source };
	}

	async testDownloadSources(): Promise<EcdictSpeedResult[]> {
		const sha = await this.fetchUpstreamSha();
		const results: EcdictSpeedResult[] = [];
		for (const source of ECDICT_DOWNLOAD_SOURCES) {
			const startedAt = performance.now();
			try {
				const response = await withRequestTimeout(
					this.request({ url: source.buildUrl(sha, 'README.md'), method: 'GET', throw: false }),
					SPEED_TEST_TIMEOUT_MS
				);
				if (response.status !== 200 || response.arrayBuffer.byteLength < 100 || !response.text.includes('# ECDICT')) {
					throw new Error(`HTTP ${response.status}`);
				}
				results.push({ id: source.id, name: source.name, durationMs: Math.round(performance.now() - startedAt), available: true });
			} catch (error) {
				results.push({
					id: source.id,
					name: source.name,
					durationMs: null,
					available: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return results;
	}

	async install(
		sourceId: EcdictDownloadSourceId,
		onProgress?: (progress: EcdictProgress) => void,
		abortSignal?: { aborted: boolean }
	): Promise<EcdictInstallation> {
		onProgress?.({ phase: 'metadata', progress: 0, message: '正在检查 ECDICT 上游版本...' });
		const source = await this.fetchSourceMetadata(sourceId);
		this.throwIfAborted(abortSignal);

		onProgress?.({ phase: 'download', progress: 0.03, message: `正在从 ${source.sourceName} 下载 ECDICT 原始 CSV（约 63 MB）...` });
		const response = await this.request({ url: source.sourceUrl, method: 'GET', throw: false });
		if (response.status !== 200) throw new Error(`ECDICT 下载失败：服务器返回 ${response.status}`);
		if (response.arrayBuffer.byteLength < this.minimumSourceBytes) throw new Error('ECDICT 下载文件异常过小');
		this.throwIfAborted(abortSignal);

		const csvText = response.text || new TextDecoder().decode(response.arrayBuffer);
		const previousInstallation = await this.database.getInstallation();
		const targetStore = await this.database.prepareImport();
		let committed = false;
		try {
			const parsedCount = await this.importCsv(csvText, targetStore, onProgress, abortSignal);
			onProgress?.({ phase: 'validate', progress: 0.98, message: '正在校验本地词典...' });
			const count = await this.database.count(targetStore);
			if (count < this.minimumEntryCount) {
				throw new Error(`ECDICT 词条数量异常：解析 ${parsedCount}，有效词条 ${count}`);
			}
			if (!await this.database.lookupInStore(targetStore, 'the')) throw new Error('ECDICT 核心词条校验失败');

			const installation: EcdictInstallation = {
				key: 'installation',
				activeStore: targetStore,
				sourceSha: source.sourceSha,
				packageSize: response.arrayBuffer.byteLength,
				entryCount: count,
				installedAt: Date.now(),
			};
			await this.database.finishImport(installation);
			committed = true;
			onProgress?.({ phase: 'validate', progress: 1, message: `ECDICT 已安装，共 ${count.toLocaleString()} 条词条` });
			if (previousInstallation && previousInstallation.activeStore !== targetStore) {
				void this.database.clearStore(previousInstallation.activeStore).catch(error => {
					console.warn('[LexiBridge] Failed to clean previous ECDICT store:', error);
				});
			}
			return installation;
		} catch (error) {
			if (!committed) await this.database.clearStore(targetStore);
			throw error;
		}
	}

	async remove(): Promise<void> {
		await this.database.remove();
	}

	private async fetchSourceMetadata(sourceId: EcdictDownloadSourceId): Promise<EcdictSourceMetadata> {
		const source = ECDICT_DOWNLOAD_SOURCES.find(item => item.id === sourceId) || ECDICT_DOWNLOAD_SOURCES[0]!;
		const sourceSha = await this.fetchUpstreamSha();
		return { sourceSha, sourceName: source.name, sourceUrl: source.buildUrl(sourceSha, UPSTREAM_FILE) };
	}

	private async fetchUpstreamSha(): Promise<string> {
		const response = await this.request({ url: UPSTREAM_COMMIT_API, method: 'GET', throw: false });
		if (response.status !== 200) throw new Error(`无法获取 ECDICT 上游版本：服务器返回 ${response.status}`);
		const data = response.json as unknown;
		const first = Array.isArray(data) ? data[0] as unknown : null;
		const sha = isRecord(first) && typeof first.sha === 'string' ? first.sha : '';
		if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('ECDICT 上游版本信息无效');
		return sha;
	}

	private async importCsv(
		csvText: string,
		targetStore: EcdictEntryStore,
		onProgress?: (progress: EcdictProgress) => void,
		abortSignal?: { aborted: boolean }
	): Promise<number> {
		const rows = parseCsvRows(csvText);
		const header = rows.next();
		if (header.done) throw new Error('ECDICT CSV 为空');
		const columns = createEcdictColumnMap(header.value.values);
		let batch: StoredEcdictEntry[] = [];
		let count = 0;
		let endOffset = header.value.endOffset;
		for (const row of rows) {
			this.throwIfAborted(abortSignal);
			endOffset = row.endOffset;
			const entry = toStoredEcdictEntry(row.values, columns);
			if (entry) batch.push(entry);
			if (batch.length < IMPORT_BATCH_SIZE) continue;
			await this.database.putBatch(targetStore, batch);
			count += batch.length;
			batch = [];
			const progress = 0.05 + (endOffset / csvText.length) * 0.92;
			onProgress?.({ phase: 'import', progress, message: `正在导入词条：${count.toLocaleString()}` });
			await yieldToEventLoop();
		}
		if (batch.length > 0) {
			await this.database.putBatch(targetStore, batch);
			count += batch.length;
		}
		return count;
	}

	private throwIfAborted(abortSignal?: { aborted: boolean }): void {
		if (abortSignal?.aborted) throw new Error('ECDICT 安装已取消');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object';
}

async function withRequestTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_resolve, reject) => window.setTimeout(() => reject(new Error('超时')), timeoutMs)),
	]);
}

function yieldToEventLoop(): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, 0));
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
