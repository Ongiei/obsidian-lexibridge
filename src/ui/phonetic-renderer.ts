import { DictEntry } from '../types';

export function renderPhoneticButtons(container: HTMLElement, entry: DictEntry): void {
	if (!entry.ph_uk && !entry.ph_us) return;

	const phoneticContainer = document.createElement('div');
	phoneticContainer.className = 'dict-phonetic-container';

	if (entry.ph_uk) {
		const ukPhoneticBtn = document.createElement('button');
		ukPhoneticBtn.type = 'button';
		ukPhoneticBtn.className = 'dict-phonetic-btn';
		ukPhoneticBtn.textContent = `英 /${entry.ph_uk}/`;
		if (entry.audio_uk) {
			ukPhoneticBtn.addEventListener('click', () => playAudio(entry.audio_uk));
		}
		phoneticContainer.appendChild(ukPhoneticBtn);
	}

	if (entry.ph_us) {
		const usPhoneticBtn = document.createElement('button');
		usPhoneticBtn.type = 'button';
		usPhoneticBtn.className = 'dict-phonetic-btn';
		usPhoneticBtn.textContent = `美 /${entry.ph_us}/`;
		if (entry.audio_us) {
			usPhoneticBtn.addEventListener('click', () => playAudio(entry.audio_us));
		}
		phoneticContainer.appendChild(usPhoneticBtn);
	}

	container.appendChild(phoneticContainer);
}

function playAudio(audioUrl: string): void {
	void new Audio(audioUrl).play().catch((error: unknown) => {
		console.warn('[LexiBridge] Failed to play pronunciation audio:', error);
	});
}
