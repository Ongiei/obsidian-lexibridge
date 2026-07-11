import {DictEntry} from '../types';

export interface CsvRow {
	values: string[];
	endOffset: number;
}

export interface StoredEcdictEntry {
	key: string;
	word: string;
	phonetic: string;
	definition: string;
	translation: string;
	tags: string;
	exchange: string;
}

const EXCHANGE_LABELS: Record<string, string> = {
	p: '过去式',
	d: '过去分词',
	i: '现在分词',
	'3': '第三人称单数',
	r: '比较级',
	t: '最高级',
	s: '复数',
	'0': '原形',
	'1': '原形变化',
};

export function* parseCsvRows(text: string): Generator<CsvRow> {
	let field = '';
	let row: string[] = [];
	let inQuotes = false;

	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (inQuotes) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index++;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"' && field.length === 0) {
			inQuotes = true;
		} else if (char === ',') {
			row.push(field);
			field = '';
		} else if (char === '\n') {
			row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
			yield { values: row, endOffset: index + 1 };
			field = '';
			row = [];
		} else {
			field += char;
		}
	}

	if (field.length > 0 || row.length > 0) {
		row.push(field);
		yield { values: row, endOffset: text.length };
	}
}

export function createEcdictColumnMap(header: string[]): Map<string, number> {
	const columns = new Map<string, number>();
	header.forEach((name, index) => columns.set(name.replace(/^\uFEFF/, '').trim().toLowerCase(), index));
	for (const required of ['word', 'phonetic', 'definition', 'translation', 'tag', 'exchange']) {
		if (!columns.has(required)) {
			throw new Error(`ECDICT 数据缺少字段：${required}`);
		}
	}
	return columns;
}

export function toStoredEcdictEntry(row: string[], columns: Map<string, number>): StoredEcdictEntry | null {
	const value = (name: string) => row[columns.get(name) ?? -1]?.trim() || '';
	const word = value('word');
	if (!word) return null;
	return {
		key: word.toLowerCase(),
		word,
		phonetic: value('phonetic'),
		definition: value('definition'),
		translation: value('translation'),
		tags: value('tag'),
		exchange: value('exchange'),
	};
}

export function storedEcdictEntryToDictEntry(stored: StoredEcdictEntry): DictEntry | null {
	const definitionText = stored.translation || stored.definition;
	const definitions = splitDefinitions(definitionText);
	if (definitions.length === 0 && !stored.phonetic) return null;

	return {
		word: stored.word,
		ph_uk: stored.phonetic,
		ph_us: '',
		audio_uk: '',
		audio_us: '',
		definitions,
		tags: stored.tags.split(/\s+/).filter(Boolean),
		exchange: parseExchange(stored.exchange),
	};
}

function splitDefinitions(text: string): { pos: string; trans: string }[] {
	return text
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => {
			const match = line.match(/^([a-z]+\.)\s*(.+)$/i);
			return match?.[1] && match[2]
				? { pos: match[1], trans: match[2] }
				: { pos: '', trans: line };
		});
}

function parseExchange(exchange: string): { name: string; value: string }[] {
	if (!exchange) return [];
	return exchange.split('/').flatMap(item => {
		const separator = item.indexOf(':');
		if (separator <= 0) return [];
		const type = item.slice(0, separator);
		const value = item.slice(separator + 1).trim();
		if (!value) return [];
		return [{ name: EXCHANGE_LABELS[type] || type, value }];
	});
}
