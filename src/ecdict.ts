import {requestUrl, RequestUrlParam, RequestUrlResponse} from 'obsidian';
import {gunzipSync, strFromU8} from 'fflate';
import {DictionaryProvider} from './dictionary-provider';
import {EcdictDatabase, EcdictEntryStore, EcdictInstallation} from './ecdict-database';
import {StoredEcdictEntry} from './utils/ecdict';

const PACKAGE_METADATA_URL = 'https://github.com/Ongiei/obsidian-lexibridge/releases/download/ecdict-data-v1/ecdict-manifest.json';
const PACKAGE_HOST = 'github.com';
const PACKAGE_PATH_PREFIX = '/Ongiei/obsidian-lexibridge/releases/download/ecdict-data-v1/';
const MINIMUM_ENTRY_COUNT = 500000;
const IMPORT_BATCH_SIZE = 1000;

export interface EcdictSourceMetadata {
	schemaVersion: number;
	datasetVersion: string;
	sourceSha: string;
	sourceSize: number;
	packageUrl: string;
	packageSize: number;
	packageSha256: string;
	entryCount: number;
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
		private minimumEntryCount: number = MINIMUM_ENTRY_COUNT
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

	async checkForUpdate(): Promise<{ available: boolean; source: EcdictSourceMetadata }> {
		const source = await this.fetchSourceMetadata();
		const installation = await this.database.getInstallation();
		return { available: !installation || installation.sourceSha !== source.sourceSha, source };
	}

	async install(
		onProgress?: (progress: EcdictProgress) => void,
		abortSignal?: { aborted: boolean }
	): Promise<EcdictInstallation> {
		onProgress?.({ phase: 'metadata', progress: 0, message: '正在检查 ECDICT 数据版本...' });
		const source = await this.fetchSourceMetadata();
		this.throwIfAborted(abortSignal);

		onProgress?.({ phase: 'download', progress: 0.03, message: `正在下载 ECDICT（${formatBytes(source.packageSize)}）...` });
		const response = await this.request({ url: source.packageUrl, method: 'GET', throw: false });
		if (response.status !== 200) throw new Error(`ECDICT 下载失败：服务器返回 ${response.status}`);
		if (response.arrayBuffer.byteLength !== source.packageSize) {
			throw new Error(`ECDICT 文件大小校验失败：预期 ${source.packageSize}，实际 ${response.arrayBuffer.byteLength}`);
		}
		const actualSha256 = await sha256Hex(response.arrayBuffer);
		if (actualSha256 !== source.packageSha256) throw new Error('ECDICT 数据包哈希校验失败');
		this.throwIfAborted(abortSignal);

		let packageText: string;
		try {
			packageText = strFromU8(gunzipSync(new Uint8Array(response.arrayBuffer)));
		} catch {
			throw new Error('ECDICT 数据包解压失败');
		}
		const previousInstallation = await this.database.getInstallation();
		const targetStore = await this.database.prepareImport();
		let committed = false;
		try {
			const parsedCount = await this.importPackage(packageText, targetStore, onProgress, abortSignal);

			onProgress?.({ phase: 'validate', progress: 0.98, message: '正在校验本地词典...' });
			const count = await this.database.count(targetStore);
			if (count < this.minimumEntryCount) {
				throw new Error(`ECDICT 词条数量异常：解析 ${parsedCount}，有效词条 ${count}`);
			}
			if (!await this.database.lookupInStore(targetStore, 'the')) {
				throw new Error('ECDICT 核心词条校验失败');
			}
			if (count !== source.entryCount) {
				throw new Error(`ECDICT 清单数量不一致：预期 ${source.entryCount}，实际 ${count}`);
			}

			const installation: EcdictInstallation = {
				key: 'installation',
				activeStore: targetStore,
				sourceSha: source.sourceSha,
				packageSize: source.packageSize,
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

	private async fetchSourceMetadata(): Promise<EcdictSourceMetadata> {
		const response = await this.request({
			url: PACKAGE_METADATA_URL,
			method: 'GET',
			throw: false,
		});
		if (response.status !== 200) throw new Error(`无法获取 ECDICT 版本信息：服务器返回 ${response.status}`);
		const data = response.json as Partial<EcdictSourceMetadata>;
		if (
			data.schemaVersion !== 1
			|| !data.datasetVersion
			|| !data.sourceSha || !/^[a-f0-9]{40}$/i.test(data.sourceSha)
			|| !data.sourceSize
			|| !data.packageUrl
			|| !data.packageSize
			|| !data.packageSha256 || !/^[a-f0-9]{64}$/i.test(data.packageSha256)
			|| !data.entryCount || data.entryCount < this.minimumEntryCount
		) {
			throw new Error('ECDICT 版本信息格式无效');
		}
		const packageUrl = new URL(data.packageUrl);
		if (
			packageUrl.protocol !== 'https:'
			|| packageUrl.hostname !== PACKAGE_HOST
			|| !packageUrl.pathname.startsWith(PACKAGE_PATH_PREFIX)
		) {
			throw new Error('ECDICT 下载地址不受信任');
		}
		return data as EcdictSourceMetadata;
	}

	private async importPackage(
		packageText: string,
		targetStore: EcdictEntryStore,
		onProgress?: (progress: EcdictProgress) => void,
		abortSignal?: { aborted: boolean }
	): Promise<number> {
		let batch: StoredEcdictEntry[] = [];
		let count = 0;
		let offset = 0;

		while (offset < packageText.length) {
			this.throwIfAborted(abortSignal);
			const lineEnd = packageText.indexOf('\n', offset);
			const endOffset = lineEnd === -1 ? packageText.length : lineEnd;
			const line = packageText.slice(offset, endOffset);
			offset = lineEnd === -1 ? packageText.length : lineEnd + 1;
			if (line) batch.push(parsePackageLine(line));
			if (batch.length < IMPORT_BATCH_SIZE) continue;

			await this.database.putBatch(targetStore, batch);
			count += batch.length;
			batch = [];
			const progress = 0.08 + (offset / packageText.length) * 0.88;
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

function parsePackageLine(line: string): StoredEcdictEntry {
	const parsed = JSON.parse(line) as unknown;
	if (!Array.isArray(parsed) || parsed.length !== 7 || parsed.some(value => typeof value !== 'string')) {
		throw new Error('ECDICT 数据包包含无效词条');
	}
	const [key, word, phonetic, definition, translation, tags, exchange] = parsed as [string, string, string, string, string, string, string];
	if (!key || !word) throw new Error('ECDICT 数据包包含空词条');
	return { key, word, phonetic, definition, translation, tags, exchange };
}

async function sha256Hex(arrayBuffer: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function yieldToEventLoop(): Promise<void> {
	return new Promise(resolve => globalThis.setTimeout(resolve, 0));
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
