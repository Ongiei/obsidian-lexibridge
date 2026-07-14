const WORD_REGEX = /^[a-zA-Z\s'-]+$/;

export interface DictionaryWordNameOptions {
	preserveTitleCase?: boolean;
}

export function sanitizeWord(input: string): string {
	return input.trim().replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '');
}

export function isValidWord(word: string): boolean {
	return word.length > 0 && word.length <= 50 && WORD_REGEX.test(word);
}

export function resolveDictionaryWordName(
	input: string,
	dictionaryWord: string,
	options: DictionaryWordNameOptions = {}
): string {
	const original = sanitizeWord(input);
	const canonical = sanitizeWord(dictionaryWord);
	if (!original) return canonical;
	if (!canonical) return original;

	if (isAllCaps(original) || hasInternalCapitalization(original)) return original;
	if (options.preserveTitleCase && isTitleCase(original) && canonical === canonical.toLowerCase()) return original;
	return canonical;
}

function isAllCaps(word: string): boolean {
	const letters = word.replace(/[^a-zA-Z]/g, '');
	return letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

function isTitleCase(word: string): boolean {
	return /^[A-Z][a-z]+(?:[-'][a-z]+)*$/.test(word);
}

function hasInternalCapitalization(word: string): boolean {
	return /[A-Z]/.test(word) && !isAllCaps(word) && !isTitleCase(word);
}
