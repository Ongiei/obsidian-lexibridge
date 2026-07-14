import {normalizePath} from 'obsidian';

export function normalizeVaultFolderPath(value: unknown, fallback = 'LexiBridge'): string {
	if (typeof value !== 'string') return fallback;
	const sanitized = value.trim().replace(/\\/g, '/').replace(/\.\.(?:\/|$)/g, '').replace(/^\/+/, '');
	const normalized = normalizePath(sanitized).replace(/\/$/, '');
	return normalized && normalized !== '.' ? normalized : fallback;
}
