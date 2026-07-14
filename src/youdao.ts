import {requestUrl} from 'obsidian';
import {DictEntry} from './types';

const ALLOWED_AUDIO_DOMAINS = ['dict.youdao.com'];

interface WebTranslationItem {
	'@key'?: string;
	key?: string;
	trans?: { value?: string }[];
}

interface SentencePair {
	sentence?: string;
	'sentence-translation'?: string;
}

interface YoudaoJsonResponse {
	ec?: {
		word?: {
			'return-phrase'?: string;
			usphone?: string;
			ukphone?: string;
			usspeech?: string;
			ukspeech?: string;
			trs?: {
				tr?: {
					pos?: string;
					l?: {
						i?: string[];
					};
				}[];
			}[];
			wfs?: {
				wf?: {
					name: string;
					value: string;
				};
			}[];
		}[];
		exam_type?: string[];
	};
	web_trans?: {
		'web-translation'?: WebTranslationItem[];
	};
	blng_sents_part?: {
		'sentence-pair'?: SentencePair[];
	};
}

export class YoudaoRequestError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
		this.name = 'YoudaoRequestError';
	}
}

export class YoudaoService {
	private static readonly BASE_URL = 'https://dict.youdao.com/jsonapi';

	static async lookup(word: string): Promise<DictEntry | null> {
		const url = `${this.BASE_URL}?q=${encodeURIComponent(word)}`;
		const response = await requestUrl({
			url,
			method: 'GET',
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
			},
			throw: false,
		});

		if (response.status !== 200) {
			throw new YoudaoRequestError(`有道词典请求失败：服务器返回 ${response.status}`, response.status);
		}

		const data = response.json as unknown as YoudaoJsonResponse;
		return this.parseJson(data, word);
	}

	private static validateAudioUrl(url: string): string {
		if (!url) return '';
		try {
			const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
			if (!ALLOWED_AUDIO_DOMAINS.some(domain =>
				urlObj.hostname === domain || urlObj.hostname.endsWith(`.${domain}`)
			)) {
				return '';
			}
			return url;
		} catch {
			return '';
		}
	}

	private static parseJson(data: YoudaoJsonResponse, originalWord: string): DictEntry | null {
		if (!data?.ec?.word || data.ec.word.length === 0) {
			return null;
		}

		const entryData = data.ec.word[0];
		if (!entryData) {
			return null;
		}

		const ph_uk = entryData.ukphone ?? "";
		const ph_us = entryData.usphone ?? "";

		let audio_uk = "";
		let audio_us = "";
		if (entryData.ukspeech) {
			const rawUrl = entryData.ukspeech.startsWith('http') 
				? entryData.ukspeech 
				: `https://dict.youdao.com/dictvoice?audio=${entryData.ukspeech}`;
			audio_uk = this.validateAudioUrl(rawUrl);
		}
		if (entryData.usspeech) {
			const rawUrl = entryData.usspeech.startsWith('http') 
				? entryData.usspeech 
				: `https://dict.youdao.com/dictvoice?audio=${entryData.usspeech}`;
			audio_us = this.validateAudioUrl(rawUrl);
		}

		const definitions: { pos: string; trans: string }[] = [];
		if (entryData.trs) {
			for (const tr of entryData.trs) {
				try {
					if (tr?.tr?.[0]?.l?.i?.[0]) {
						let pos = tr.tr[0].pos ?? "";
						let trans = tr.tr[0].l.i[0];

						if (!pos) {
							const posMatch = trans.match(/^([a-z]+\.\s+)/i);
							if (posMatch?.[1]) {
								pos = posMatch[1].trim();
								trans = trans.substring(posMatch[0].length);
							}
						}

						definitions.push({ pos, trans });
					}
				} catch (e) {
					console.warn('Error parsing definition:', e);
				}
			}
		}

		const tags: string[] = data.ec.exam_type ?? [];

		const exchange: { name: string; value: string }[] = [];
		if (entryData.wfs) {
			for (const item of entryData.wfs) {
				if (item?.wf?.name && item?.wf?.value) {
					exchange.push({
						name: item.wf.name,
						value: item.wf.value
					});
				}
			}
		}

		const entry: DictEntry = {
			word: entryData['return-phrase']?.trim() || originalWord,
			ph_uk,
			ph_us,
			audio_uk,
			audio_us,
			definitions,
			tags,
			exchange
		};

		try {
			const webTransRaw = data.web_trans?.['web-translation'];
			if (webTransRaw && Array.isArray(webTransRaw)) {
				const queryLower = originalWord.toLowerCase().trim();
				const webTrans: { key: string; value: string[] }[] = [];
				for (const item of webTransRaw) {
					const key = item['@key'] ?? item.key ?? '';
					const values: string[] = [];
					if (item.trans) {
						for (const t of item.trans) {
							if (t.value) {
								values.push(t.value);
							}
						}
					}
					if (key.toLowerCase().trim() === queryLower && values.length > 0) {
						webTrans.push({ key, value: values });
					}
				}
				if (webTrans.length > 0) {
					entry.webTrans = webTrans;
				}
			}

			const bilingualRaw = data.blng_sents_part?.['sentence-pair'];
			if (bilingualRaw && Array.isArray(bilingualRaw)) {
				const examples: { eng: string; chn: string }[] = [];
				for (let i = 0; i < Math.min(bilingualRaw.length, 5); i++) {
					const item = bilingualRaw[i];
					if (!item) continue;
					const eng = item.sentence ?? '';
					const chn = item['sentence-translation'] ?? '';
					if (eng && chn) {
						examples.push({ eng, chn });
					}
				}
				if (examples.length > 0) {
					entry.bilingualExamples = examples;
				}
			}
		} catch (error) {
			console.error('Extended info parsing failed:', error);
		}

		if (definitions.length > 0 || ph_uk || ph_us) {
			return entry;
		}

		return null;
	}
}
