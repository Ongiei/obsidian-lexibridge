import { DictEntry } from '../types';

interface AudioWindow extends Window {
	Audio: new (src?: string) => HTMLAudioElement;
}

export function renderPhoneticButtons(container: HTMLElement, entry: DictEntry): void {
	if (!entry.ph_uk && !entry.ph_us) return;

	const ownerDocument = container.ownerDocument ?? activeDocument;
	const ownerWindow = (ownerDocument.defaultView ?? activeWindow) as AudioWindow;
	const phoneticContainer = ownerDocument.createElement('div');
	phoneticContainer.className = 'dict-phonetic-container';

	if (entry.ph_uk) {
		const ukPhoneticBtn = ownerDocument.createElement('button');
		ukPhoneticBtn.type = 'button';
		ukPhoneticBtn.className = 'dict-phonetic-btn';
		ukPhoneticBtn.textContent = `英 /${entry.ph_uk}/`;
		if (entry.audio_uk) {
			ukPhoneticBtn.addEventListener('click', () => playAudio(entry.audio_uk, ownerWindow));
		}
		phoneticContainer.appendChild(ukPhoneticBtn);
	}

	if (entry.ph_us) {
		const usPhoneticBtn = ownerDocument.createElement('button');
		usPhoneticBtn.type = 'button';
		usPhoneticBtn.className = 'dict-phonetic-btn';
		usPhoneticBtn.textContent = `美 /${entry.ph_us}/`;
		if (entry.audio_us) {
			usPhoneticBtn.addEventListener('click', () => playAudio(entry.audio_us, ownerWindow));
		}
		phoneticContainer.appendChild(usPhoneticBtn);
	}

	container.appendChild(phoneticContainer);
}

function playAudio(audioUrl: string, ownerWindow: AudioWindow): void {
	void new ownerWindow.Audio(audioUrl).play().catch((error: unknown) => {
		console.warn('[LexiBridge] Failed to play pronunciation audio:', error);
	});
}
