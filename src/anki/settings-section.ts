import { Notice, Setting } from 'obsidian';
import type LexiBridgePlugin from '../main';
import {
	DEFAULT_ANKI_BACK_TEMPLATE,
	DEFAULT_ANKI_CARD_CSS,
	DEFAULT_ANKI_FRONT_TEMPLATE,
} from './types';

export function renderAnkiSettingsSection(containerEl: HTMLElement, plugin: LexiBridgePlugin): void {
	new Setting(containerEl)
		.setName('Anki 导出')
		.setHeading();

	new Setting(containerEl)
		.setName('启用 Anki 导出')
		.setDesc('通过本机 AnkiConnect 将单词笔记发送到 Anki Desktop。不会在单词笔记中写入同步标记。')
		.addToggle(toggle => {
			toggle.setValue(plugin.settings.anki.enabled).onChange(async value => {
				plugin.settings.anki.enabled = value;
				await plugin.saveSettings();
				plugin.reconfigureServices();
			});
		});

	new Setting(containerEl)
		.setName('连接状态')
		.setDesc('测试连接只请求 AnkiConnect 版本号，不会发送单词笔记内容。')
		.addButton(button => {
			button.setButtonText('测试连接').onClick(async () => {
				button.setDisabled(true);
				try {
					const version = await plugin.testAnkiConnection();
					new Notice(`AnkiConnect 连接正常，API v${version}`);
				} catch (error) {
					new Notice(`AnkiConnect 连接失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					button.setDisabled(false);
				}
			});
		});

	new Setting(containerEl)
		.setName('Anki 牌组')
		.setDesc('选择或输入要写入的 Anki 牌组。加载列表只会在点击按钮后连接 AnkiConnect。')
		.addText(text => {
			text.setPlaceholder('LexiBridge').setValue(plugin.settings.anki.deckName).onChange(async value => {
				plugin.settings.anki.deckName = value.trim() || 'LexiBridge';
				await plugin.saveSettings();
			});
		})
		.addButton(button => {
			button.setButtonText('加载牌组列表').onClick(async () => {
				button.setDisabled(true);
				try {
					const deckNames = await plugin.loadAnkiDeckNames();
					renderDeckPicker(containerEl, plugin, deckNames);
				} catch (error) {
					new Notice(`加载 Anki 牌组失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					button.setDisabled(false);
				}
			});
		})
		.addButton(button => {
			button.setButtonText('创建牌组').onClick(async () => {
				button.setDisabled(true);
				try {
					await plugin.createAnkiDeck(plugin.settings.anki.deckName);
					new Notice(`Anki 牌组已准备好：${plugin.settings.anki.deckName}`);
				} catch (error) {
					new Notice(`创建 Anki 牌组失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					button.setDisabled(false);
				}
			});
		});

	new Setting(containerEl)
		.setName('包含保护标题内容')
		.setDesc('将保护标题下的内容映射到 Anki 的 Notes 字段；默认不覆盖 Markdown。')
		.addToggle(toggle => {
			toggle.setValue(plugin.settings.anki.includeProtectedSections).onChange(async value => {
				plugin.settings.anki.includeProtectedSections = value;
				await plugin.saveSettings();
			});
		});

	new Setting(containerEl)
		.setName('同步后触发 AnkiWeb')
		.setDesc('成功新增或更新本机 Anki 笔记后，请求 Anki Desktop 执行自己的 AnkiWeb 同步。LexiBridge 不保存 AnkiWeb 凭据。')
		.addToggle(toggle => {
			toggle.setValue(plugin.settings.anki.syncAnkiWebAfterPush).onChange(async value => {
				plugin.settings.anki.syncAnkiWebAfterPush = value;
				await plugin.saveSettings();
			});
		});

	new Setting(containerEl)
		.setName('源文件缺失时')
		.setDesc('默认保留 Anki 笔记不动。可选只添加缺失源文件标签，不删除、不暂停。')
		.addDropdown(dropdown => {
			dropdown
				.addOption('keep', '保留不处理')
				.addOption('tag', '添加缺失源文件标签')
				.setValue(plugin.settings.anki.missingSourcePolicy)
				.onChange(async value => {
					plugin.settings.anki.missingSourcePolicy = value === 'tag' ? 'tag' : 'keep';
					await plugin.saveSettings();
				});
		});

	new Setting(containerEl)
		.setName('AnkiConnect 地址')
		.setDesc('默认只允许本机 127.0.0.1 或 localhost；远程地址需要显式开启。')
		.addText(text => {
			text.setPlaceholder('http://127.0.0.1:8765').setValue(plugin.settings.anki.endpoint).onChange(async value => {
				plugin.settings.anki.endpoint = value.trim();
				await plugin.saveSettings();
			});
		});

	new Setting(containerEl)
		.setName('允许远程 AnkiConnect 地址')
		.setDesc('开启后会把选中的单词笔记内容发送到配置的远程地址。仅在你信任该地址时使用。')
		.addToggle(toggle => {
			toggle.setValue(plugin.settings.anki.allowRemoteEndpoint).onChange(async value => {
				plugin.settings.anki.allowRemoteEndpoint = value;
				await plugin.saveSettings();
			});
		});

	new Setting(containerEl)
		.setName('卡片正面模板')
		.setDesc('使用 Anki 模板语法；同步时会更新 LexiBridge 管理的笔记类型。')
		.addTextArea(text => {
			text.setValue(plugin.settings.anki.frontTemplate).onChange(async value => {
				plugin.settings.anki.frontTemplate = value;
				await plugin.saveSettings();
			});
			text.inputEl.rows = 8;
			text.inputEl.addClass('lexibridge-anki-template-input');
		});

	new Setting(containerEl)
		.setName('卡片背面模板')
		.setDesc('可使用 Word、Definition、Examples、Forms、Notes 和 Source 等字段。')
		.addTextArea(text => {
			text.setValue(plugin.settings.anki.backTemplate).onChange(async value => {
				plugin.settings.anki.backTemplate = value;
				await plugin.saveSettings();
			});
			text.inputEl.rows = 12;
			text.inputEl.addClass('lexibridge-anki-template-input');
		});

	new Setting(containerEl)
		.setName('卡片样式 CSS')
		.setDesc('应用到 LexiBridge 管理的 Anki 笔记类型。')
		.addTextArea(text => {
			text.setValue(plugin.settings.anki.cardCss).onChange(async value => {
				plugin.settings.anki.cardCss = value;
				await plugin.saveSettings();
			});
			text.inputEl.rows = 14;
			text.inputEl.addClass('lexibridge-anki-template-input');
		})
		.addButton(button => button.setButtonText('恢复默认').onClick(async () => {
			plugin.settings.anki.frontTemplate = DEFAULT_ANKI_FRONT_TEMPLATE;
			plugin.settings.anki.backTemplate = DEFAULT_ANKI_BACK_TEMPLATE;
			plugin.settings.anki.cardCss = DEFAULT_ANKI_CARD_CSS;
			await plugin.saveSettings();
			new Notice('已恢复默认 Anki 模板，重新打开设置页即可查看。');
		}));

	new Setting(containerEl)
		.setName('预览完整同步')
		.setDesc('扫描单词笔记并读取当前 Anki 中由本插件管理的笔记，只显示计划，不写入。')
		.addButton(button => {
			button.setButtonText('预览').setCta().onClick(async () => {
				button.setDisabled(true);
				try {
					await plugin.previewFullAnkiSync();
				} catch (error) {
					new Notice(`Anki 同步预览失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					button.setDisabled(false);
				}
			});
		});
}

function renderDeckPicker(containerEl: HTMLElement, plugin: LexiBridgePlugin, deckNames: string[]): void {
	const existing = containerEl.querySelector('.lexibridge-anki-deck-picker');
	existing?.remove();
	if (deckNames.length === 0) {
		new Notice('Anki 中没有可选择的牌组。');
		return;
	}
	const wrapper = containerEl.createEl('div', { cls: 'lexibridge-anki-deck-picker' });
	new Setting(wrapper)
		.setName('选择 Anki 牌组')
		.setDesc('列表来自当前运行中的 Anki Desktop。')
		.addDropdown(dropdown => {
			for (const deckName of deckNames) dropdown.addOption(deckName, deckName);
			const current = deckNames.includes(plugin.settings.anki.deckName)
				? plugin.settings.anki.deckName
				: deckNames[0] || plugin.settings.anki.deckName;
			dropdown.setValue(current).onChange(async value => {
				plugin.settings.anki.deckName = value;
				await plugin.saveSettings();
			});
		});
}
