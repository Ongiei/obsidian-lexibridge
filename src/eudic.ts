import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian';

const BASE_URL = 'https://api.frdic.com/api/open/v1';

export interface EudicCategory {
	id: string;
	language: string;
	name: string;
}

export interface EudicWord {
	word: string;
	exp: string;
}

interface EudicCategoriesResponse {
	data: EudicCategory[];
}

interface EudicAddWordsResponse {
	message: string;
}

interface EudicCreateCategoryResponse {
	data: EudicCategory;
}

interface EudicWordsResponse {
	data: EudicWord[];
	total?: number;
}

export class EudicService {
	private token: string;

	constructor(token: string) {
		this.token = token;
	}

	private static friendlyError(status: number, operation: string): string {
		const map: Record<number, string> = {
			400: '请求参数错误',
			401: 'API Token 无效，请检查设置',
			403: 'Token 权限不足',
			404: '资源不存在',
			429: '请求过于频繁，请稍后再试',
			500: '欧路服务器错误，请稍后再试',
			502: '欧路服务器暂时不可用',
			503: '欧路服务器维护中',
		};
		const reason = map[status] || `服务器返回错误 (${status})`;
		return `${operation}失败：${reason}`;
	}

	private async request(method: string, path: string, body?: unknown): Promise<RequestUrlResponse> {
		const url = `${BASE_URL}${path}`;
		const options: RequestUrlParam = {
			url,
			method,
			headers: {
				'Authorization': this.token,
				'Content-Type': 'application/json',
			},
			throw: false,
		};

		if (body) {
			options.body = JSON.stringify(body);
		}

		return requestUrl(options);
	}

	async getCategories(language: string = 'en'): Promise<EudicCategory[]> {
		const response = await this.request('GET', `/studylist/category?language=${language}`);
		if (response.status >= 400) {
			throw new Error(EudicService.friendlyError(response.status, '获取生词本列表'));
		}
		const data = response.json as EudicCategoriesResponse;
		return data.data;
	}

	async addWords(categoryId: string, words: string[], language: string = 'en'): Promise<string> {
		const response = await this.request('POST', '/studylist/words', {
			id: categoryId,
			category_id: categoryId,
			language,
			words,
		});

		if (response.status >= 400) {
			throw new Error(EudicService.friendlyError(response.status, '添加单词'));
		}

		const data = response.json as EudicAddWordsResponse;
		return data.message;
	}

	async createCategory(name: string, language: string = 'en'): Promise<EudicCategory> {
		const response = await this.request('POST', '/studylist/category', {
			language,
			name,
		});

		if (response.status >= 400) {
			throw new Error(EudicService.friendlyError(response.status, '创建生词本'));
		}

		const data = response.json as EudicCreateCategoryResponse;
		return data.data;
	}

	async renameCategory(id: string, name: string, language: string = 'en'): Promise<void> {
		const response = await this.request('PATCH', '/studylist/category', {id, language, name});
		if (response.status >= 400) {
			throw new Error(EudicService.friendlyError(response.status, '重命名生词本'));
		}
	}

	async getWords(categoryId: string, language: string = 'en', page: number = 0, pageSize: number = 100): Promise<EudicWord[]> {
		const params = new URLSearchParams({
			language,
			category_id: categoryId,
			page: String(page),
			page_size: String(pageSize),
		});
		const response = await this.request('GET', `/studylist/words?${params.toString()}`);
		
		if (response.status >= 400) {
			throw new Error(EudicService.friendlyError(response.status, '获取单词列表'));
		}

		const data = response.json as EudicWordsResponse;
		return data.data || [];
	}

	async deleteWords(categoryId: string, words: string[], language: string = 'en'): Promise<string> {
		const response = await this.request('DELETE', '/studylist/words', {
			id: categoryId,
			category_id: categoryId,
			language,
			words,
		});

		if (response.status >= 400) {
			throw new Error(EudicService.friendlyError(response.status, '删除单词'));
		}

		if (!response.text || response.text.trim() === '') {
			return 'success';
		}

		try {
			const data = response.json as EudicAddWordsResponse;
			return data.message || 'success';
		} catch {
			return 'success';
		}
	}

	static validateToken(token: string): boolean {
		return Boolean(token && token.trim().length > 0);
	}
}
