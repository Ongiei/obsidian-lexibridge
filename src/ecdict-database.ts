import {StoredEcdictEntry, storedEcdictEntryToDictEntry} from './utils/ecdict';
import {DictEntry} from './types';

const DATABASE_NAME = 'lexibridge-ecdict';
const DATABASE_VERSION = 1;
const META_STORE = 'metadata';
const ENTRY_STORES = ['entries-a', 'entries-b'] as const;
const INSTALLATION_KEY = 'installation';

export type EcdictEntryStore = typeof ENTRY_STORES[number];

export interface EcdictInstallation {
	key: typeof INSTALLATION_KEY;
	activeStore: EcdictEntryStore;
	sourceSha: string;
	packageSize: number;
	entryCount: number;
	installedAt: number;
}

export class EcdictDatabase {
	private databasePromise: Promise<IDBDatabase> | null = null;

	async getInstallation(): Promise<EcdictInstallation | null> {
		const database = await this.open();
		return this.request<EcdictInstallation | undefined>(
			database.transaction(META_STORE, 'readonly').objectStore(META_STORE)
				.get(INSTALLATION_KEY) as IDBRequest<EcdictInstallation | undefined>
		).then(value => value || null);
	}

	async lookup(word: string): Promise<DictEntry | null> {
		const installation = await this.getInstallation();
		if (!installation) return null;
		return this.lookupInStore(installation.activeStore, word);
	}

	async lookupInStore(storeName: EcdictEntryStore, word: string): Promise<DictEntry | null> {
		const database = await this.open();
		const stored = await this.request<StoredEcdictEntry | undefined>(
			database.transaction(storeName, 'readonly')
				.objectStore(storeName)
				.get(word.toLowerCase()) as IDBRequest<StoredEcdictEntry | undefined>
		);
		return stored ? storedEcdictEntryToDictEntry(stored) : null;
	}

	async prepareImport(): Promise<EcdictEntryStore> {
		const installation = await this.getInstallation();
		const targetStore: EcdictEntryStore = installation?.activeStore === ENTRY_STORES[0]
			? ENTRY_STORES[1]
			: ENTRY_STORES[0];
		const database = await this.open();
		await this.transactionComplete(database.transaction(targetStore, 'readwrite'), transaction => {
			transaction.objectStore(targetStore).clear();
		});
		return targetStore;
	}

	async putBatch(storeName: EcdictEntryStore, entries: StoredEcdictEntry[]): Promise<void> {
		if (entries.length === 0) return;
		const database = await this.open();
		await this.transactionComplete(database.transaction(storeName, 'readwrite'), transaction => {
			const store = transaction.objectStore(storeName);
			for (const entry of entries) store.put(entry);
		});
	}

	async finishImport(installation: Omit<EcdictInstallation, 'key'>): Promise<void> {
		const database = await this.open();
		await this.transactionComplete(database.transaction(META_STORE, 'readwrite'), transaction => {
			transaction.objectStore(META_STORE).put({ key: INSTALLATION_KEY, ...installation });
		});
	}

	async clearStore(storeName: EcdictEntryStore): Promise<void> {
		const database = await this.open();
		await this.transactionComplete(database.transaction(storeName, 'readwrite'), transaction => {
			transaction.objectStore(storeName).clear();
		});
	}

	async remove(): Promise<void> {
		const database = await this.open();
		await this.transactionComplete(database.transaction([...ENTRY_STORES, META_STORE], 'readwrite'), transaction => {
			for (const storeName of ENTRY_STORES) transaction.objectStore(storeName).clear();
			transaction.objectStore(META_STORE).clear();
		});
	}

	async count(storeName: EcdictEntryStore): Promise<number> {
		const database = await this.open();
		return this.request<number>(database.transaction(storeName, 'readonly').objectStore(storeName).count());
	}

	private open(): Promise<IDBDatabase> {
		if (this.databasePromise) return this.databasePromise;
		this.databasePromise = new Promise((resolve, reject) => {
			const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
			request.onupgradeneeded = () => {
				const database = request.result;
				for (const storeName of ENTRY_STORES) {
					if (!database.objectStoreNames.contains(storeName)) {
						database.createObjectStore(storeName, { keyPath: 'key' });
					}
				}
				if (!database.objectStoreNames.contains(META_STORE)) {
					database.createObjectStore(META_STORE, { keyPath: 'key' });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error || new Error('无法打开 ECDICT 本地数据库'));
			request.onblocked = () => reject(new Error('ECDICT 数据库被其他窗口占用'));
		});
		return this.databasePromise;
	}

	private request<T>(request: IDBRequest<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error || new Error('ECDICT 数据库操作失败'));
		});
	}

	private transactionComplete(
		transaction: IDBTransaction,
		perform: (transaction: IDBTransaction) => void
	): Promise<void> {
		return new Promise((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error || new Error('ECDICT 数据库事务失败'));
			transaction.onabort = () => reject(transaction.error || new Error('ECDICT 数据库事务已中止'));
			perform(transaction);
		});
	}
}
