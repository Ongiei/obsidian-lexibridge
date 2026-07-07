const WORD_REGEX = /^[a-zA-Z\s'-]+$/;

export function sanitizeWord(input: string): string {
	return input.trim().replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
}

export function isValidWord(word: string): boolean {
	return word.length > 0 && word.length <= 50 && WORD_REGEX.test(word);
}
