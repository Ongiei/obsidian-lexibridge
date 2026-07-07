import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import LexiBridgePlugin from "./main";
import {EudicService, EudicCategory} from "./eudic";
import {DEFAULT_BODY_TEMPLATE, DEFAULT_FRONTMATTER_TEMPLATE} from "./utils/markdown-generator";
import {ConfirmModal} from "./ui/confirm-modal";
import {FolderSuggest} from "./ui/folder-suggest";

export type DictionarySource = 'eudic' | 'youdao';

export interface LexiBridgeSettings {
	folderPath: string;
	frontmatterTemplate: string;
	bodyTemplate: string;
	includeExamProperties: boolean;
	includePosProperties: boolean;
	previewBeforeWrite: boolean;
	eudicToken: string;
	syncCategoryIds: string[];
	defaultUploadCategoryId: string;
	enableSync: boolean;
	autoSync: boolean;
	syncInterval: number;
	syncOnStartup: boolean;
	startupDelay: number;
	autoLinkFirstOnly: boolean;
	dictionarySource: DictionarySource;
	apiDelayMs: number;
}

export const DEFAULT_SETTINGS: LexiBridgeSettings = {
	folderPath: 'LexiBridge',
	frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
	bodyTemplate: DEFAULT_BODY_TEMPLATE,
	includeExamProperties: false,
	includePosProperties: false,
	previewBeforeWrite: true,
	eudicToken: '',
	syncCategoryIds: [],
	defaultUploadCategoryId: '',
	enableSync: false,
	autoSync: false,
	syncInterval: 30,
	syncOnStartup: false,
	startupDelay: 10,
	autoLinkFirstOnly: true,
	dictionarySource: 'youdao',
	apiDelayMs: 500,
};

export class LexiBridgeSettingTab extends PluginSettingTab {
	plugin: LexiBridgePlugin;
	private categories: EudicCategory[] = [];
	private categoriesLoaded = false;

	constructor(app: App, plugin: LexiBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.addClass('lexibridge-settings');

		this.renderDictionarySection(containerEl);
		this.renderTemplateSection(containerEl);
		this.renderSyncSection(containerEl);
		this.renderAdvancedSection(containerEl);

		if (this.plugin.settings.eudicToken) {
			void this.loadCategories();
		}
	}

	private async loadCategories(): Promise<void> {
		if (this.categoriesLoaded) return;

		try {
			const service = new EudicService(this.plugin.settings.eudicToken);
			this.categories = await service.getCategories('en');
			this.categoriesLoaded = true;
			this.display();
		} catch (error) {
			console.error('[LexiBridge] Failed to load categories:', error);
		}
	}

	private renderDictionarySection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('查词与本地笔记')
			.setHeading();

		new Setting(containerEl)
			.setName('单词存储文件夹')
			.setDesc('保存单词笔记的文件夹')
			.addText((text) => {
				new FolderSuggest(this.app, text.inputEl);
				text
					.setPlaceholder('输入单词...')
					.setValue(this.plugin.settings.folderPath)
					.onChange(async (value) => {
						const sanitized = value.replace(/\.\./g, '').replace(/^\/+/, '');
						if (sanitized !== value) {
							new Notice('路径包含非法字符，已自动清理');
						}
						this.plugin.settings.folderPath = sanitized || 'LexiBridge';
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('词典数据源')
			.setDesc('创建笔记和批量更新释义时使用的词典')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('youdao', '有道词典')
					.setValue(this.plugin.settings.dictionarySource)
					.onChange(async (value) => {
						this.plugin.settings.dictionarySource = value as 'eudic' | 'youdao';
						await this.plugin.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName('API 请求间隔（毫秒）')
			.setDesc('词典 API 请求之间的延迟（毫秒，建议 500ms 以避免限流）')
			.addText((text) => {
				text
					.setValue(String(this.plugin.settings.apiDelayMs))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.apiDelayMs = num;
							await this.plugin.saveSettings();
						}
					});
				text.inputEl.type = 'number';
			});

		new Setting(containerEl)
			.setName('仅链接首次出现')
			.setDesc('只给文档中每个单词的第一次出现添加双链')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.autoLinkFirstOnly)
					.onChange(async (value) => {
						this.plugin.settings.autoLinkFirstOnly = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private renderTemplateSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('模板与写入策略')
			.setHeading();

		new Setting(containerEl)
			.setName('写入 exams 属性')
			.setDesc('将考试级别写入 properties 的 exams 字段；不会写入 exam/* 标签')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.includeExamProperties)
					.onChange(async (value) => {
						this.plugin.settings.includeExamProperties = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('写入 pos 属性')
			.setDesc('将词性写入 properties 的 pos 字段；不会写入 pos/* 标签')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.includePosProperties)
					.onChange(async (value) => {
						this.plugin.settings.includePosProperties = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('生成前预览')
			.setDesc('创建或更新单词笔记前显示将写入的字段、标签和插件管理区块')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.previewBeforeWrite)
					.onChange(async (value) => {
						this.plugin.settings.previewBeforeWrite = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Frontmatter 模板')
			.setDesc('可用变量：{{word}}、{{aliases_yaml}}、{{dict_source_yaml}}、{{eudic_lists_yaml}}、{{exams_yaml}}、{{pos_yaml}}')
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.frontmatterTemplate)
					.onChange(async (value) => {
						this.plugin.settings.frontmatterTemplate = value || DEFAULT_FRONTMATTER_TEMPLATE;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 8;
				text.inputEl.cols = 60;
			});

		new Setting(containerEl)
			.setName('正文模板')
			.setDesc('可用变量：{{word}}、{{phonetic_uk}}、{{audio_uk}}、{{definitions}}、{{examples}}、{{forms}}')
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.bodyTemplate)
					.onChange(async (value) => {
						this.plugin.settings.bodyTemplate = value || DEFAULT_BODY_TEMPLATE;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 14;
				text.inputEl.cols = 60;
			});

		new Setting(containerEl)
			.setName('恢复默认模板')
			.addButton((button) => {
				button
					.setButtonText('恢复默认')
					.onClick(async () => {
						this.plugin.settings.frontmatterTemplate = DEFAULT_FRONTMATTER_TEMPLATE;
						this.plugin.settings.bodyTemplate = DEFAULT_BODY_TEMPLATE;
						await this.plugin.saveSettings();
						this.display();
					});
			});
	}

	private renderSyncSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('欧路云端同步')
			.setHeading();

		new Setting(containerEl)
			.setName('欧路词典 API token')
			.setDesc('从欧路词典官网 获取你的 token')
			.addText((text) => {
				text
					.setPlaceholder('欧路词典 API token')
					.setValue(this.plugin.settings.eudicToken)
					.onChange(async (value) => {
						this.plugin.settings.eudicToken = value.trim();
						await this.plugin.saveSettings();
						this.plugin.reconfigureServices();
						this.categoriesLoaded = false;
						this.categories = [];
						this.display();
					});
				text.inputEl.type = 'password';
			});

		if (this.plugin.settings.eudicToken) {
			const warningEl = containerEl.createEl('p', { 
				cls: 'lexibridge-warning-text',
			});
			warningEl.setText('Token 以明文存储在插件数据中。请勿将 data.json 分享或上传到公开仓库。');

			if (this.categories.length === 0 && !this.categoriesLoaded) {
				containerEl.createEl('p', {text: '正在加载生词本列表...'});
				return;
			}

			if (this.categories.length > 0) {
				new Setting(containerEl)
					.setName('同步生词本范围')
					.setDesc('选择需要同步的生词本（可多选）');

				const categoryContainer = containerEl.createEl('div', {cls: 'lexibridge-category-checkboxes'});

				for (const cat of this.categories) {
					const isChecked = this.plugin.settings.syncCategoryIds.includes(cat.id);
					
					const label = categoryContainer.createEl('label', {cls: 'lexibridge-checkbox-label'});
					const checkbox = label.createEl('input', {type: 'checkbox'});
					checkbox.checked = isChecked;
					checkbox.addEventListener('change', () => {
						if (checkbox.checked) {
							if (!this.plugin.settings.syncCategoryIds.includes(cat.id)) {
								this.plugin.settings.syncCategoryIds.push(cat.id);
							}
						} else {
							this.plugin.settings.syncCategoryIds = this.plugin.settings.syncCategoryIds.filter(id => id !== cat.id);
						}
						void (async () => {
							await this.plugin.saveSettings();
							this.plugin.reconfigureServices();
						})();
					});
					label.createSpan({text: cat.name});
				}

				new Setting(containerEl)
					.setName('默认上传生词本')
					.setDesc('本地新建单词时默认上传到此生词本')
					.addDropdown((dropdown) => {
						for (const cat of this.categories) {
							dropdown.addOption(cat.id, cat.name);
						}
						dropdown
							.setValue(this.plugin.settings.defaultUploadCategoryId || this.categories[0]?.id || '')
							.onChange(async (value) => {
								this.plugin.settings.defaultUploadCategoryId = value;
								await this.plugin.saveSettings();
								this.plugin.reconfigureServices();
							});
					});
			}
		}

		new Setting(containerEl)
			.setName('启用同步')
			.setDesc('启用欧路词典和 Obsidian 之间的双向同步')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.enableSync)
					.onChange(async (value) => {
						this.plugin.settings.enableSync = value;
						await this.plugin.saveSettings();
						this.plugin.reconfigureServices();
						this.display();
					});
			});

		if (this.plugin.settings.enableSync) {
			new Setting(containerEl)
				.setName('启动时同步')
				.setDesc('插件加载时自动同步')
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.syncOnStartup)
						.onChange(async (value) => {
							this.plugin.settings.syncOnStartup = value;
							await this.plugin.saveSettings();
							this.plugin.reconfigureServices();
						});
				});

			new Setting(containerEl)
				.setName('启动延迟（秒）')
				.setDesc('启动时同步前的延迟时间（秒）')
				.addText((text) => {
					text
						.setValue(String(this.plugin.settings.startupDelay))
						.onChange(async (value) => {
							const num = parseInt(value, 10);
							if (!isNaN(num) && num >= 0) {
								this.plugin.settings.startupDelay = num;
								await this.plugin.saveSettings();
								this.plugin.reconfigureServices();
							}
						});
					text.inputEl.type = 'number';
				});

			new Setting(containerEl)
				.setName('自动同步')
				.setDesc('按固定间隔自动同步')
				.addToggle((toggle) => {
					toggle
						.setValue(this.plugin.settings.autoSync)
						.onChange(async (value) => {
							this.plugin.settings.autoSync = value;
							await this.plugin.saveSettings();
							this.plugin.reconfigureServices();
							this.display();
						});
				});

			if (this.plugin.settings.autoSync) {
				new Setting(containerEl)
					.setName('同步间隔（分钟）')
					.setDesc('同步频率（分钟，最小 5 分钟）')
					.addText((text) => {
						text
							.setValue(String(this.plugin.settings.syncInterval))
							.onChange(async (value) => {
								const num = parseInt(value, 10);
								if (!isNaN(num) && num >= 5) {
									this.plugin.settings.syncInterval = num;
									await this.plugin.saveSettings();
									this.plugin.reconfigureServices();
								}
							});
						text.inputEl.type = 'number';
					});
			}
		}
	}

	private renderAdvancedSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('通用与高级')
			.setHeading();

		new Setting(containerEl)
			.setName('清除同步记录')
			.setDesc('重置同步清单，下次同步将把所有单词视为新词')
			.addButton((btn) => {
				btn
					.setButtonText('清除同步记录')
					.setWarning()
					.onClick(() => {
						new ConfirmModal(
							this.app,
							'重置同步清单，下次同步将把所有单词视为新词',
							() => {
								void (async () => {
									await this.plugin.clearSyncManifest();
									new Notice('同步记录已清除');
								})();
							}
						).open();
					});
			});

		new Setting(containerEl)
			.setName('重置插件')
			.setDesc('将所有设置恢复为默认值')
			.addButton((btn) => {
				btn
					.setButtonText('重置插件')
					.setWarning()
					.onClick(() => {
						new ConfirmModal(
							this.app,
							'将所有设置恢复为默认值',
							() => {
								void (async () => {
									this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
									await this.plugin.saveSettings();
									this.plugin.reconfigureServices();
									this.display();
									new Notice('插件已重置为默认设置');
								})();
							}
						).open();
					});
			});
	}
}
