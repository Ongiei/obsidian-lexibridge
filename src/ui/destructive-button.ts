import {ButtonComponent} from 'obsidian';

/** Keeps destructive controls compatible with the plugin's minimum Obsidian version. */
export function markDestructive(button: ButtonComponent): ButtonComponent {
	button.buttonEl.addClass('mod-warning');
	return button;
}
