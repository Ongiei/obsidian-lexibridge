import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import LexiBridgePlugin from "./main";
import {EudicService, EudicCategory} from "./eudic";
import {DEFAULT_BODY_TEMPLATE, DEFAULT_FRONTMATTER_TEMPLATE} from "./utils/markdown-generator";
import {ConfirmModal} from "./ui/confirm-modal";
import {FolderSuggest} from "./ui/folder-suggest";
import {withTimeout} from "./utils/sync";
import {AnkiSettings} from './anki/types';
import {renderAnkiSettingsSection} from './anki/settings-section';
import {
	ECDICT_DOWNLOAD_SOURCES,
	EcdictDownloadSourceId,
	EcdictStatus,
	formatBytes,
} from './ecdict';
import {EcdictProgressNotice} from './modal';

const CATEGORY_LOAD_TIMEOUT_MS = 15000;

export interface LexiBridgeSettings {
	folderPath: string;
	frontmatterTemplate: string;
	bodyTemplate: string;
	protectedHeadings: string[];
	ecdictDownloadSource: EcdictDownloadSourceId;
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
	enableYoudaoFallback: boolean;
	youdaoMinIntervalMs: number;
	anki: AnkiSettings;
}

export const DEFAULT_SETTINGS: LexiBridgeSettings = {
	folderPath: 'LexiBridge',
	frontmatterTemplate: DEFAULT_FRONTMATTER_TEMPLATE,
	bodyTemplate: DEFAULT_BODY_TEMPLATE,
	protectedHeadings: ['笔记', 'Notes'],
	ecdictDownloadSource: 'jsdelivr',
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
	enableYoudaoFallback: true,
	youdaoMinIntervalMs: 2000,
	anki: {
		enabled: false,
		endpoint: 'http://127.0.0.1:8765',
		deckName: 'LexiBridge',
		modelName: 'LexiBridge Vocabulary',
		ankiSourceId: '',
		includeProtectedSections: false,
		syncAnkiWebAfterPush: false,
		missingSourcePolicy: 'keep',
		allowRemoteEndpoint: false,
	},
};

export class LexiBridgeSettingTab extends PluginSettingTab {
	plugin: LexiBridgePlugin;
	private categories: EudicCategory[] = [];
	private categoriesLoaded = false;
	private categoriesLoading = false;
	private categoriesError: string | null = null;
	private ecdictStatus: EcdictStatus | null = null;
	private ecdictStatusLoading = false;

	constructor(app: App, plugin: LexiBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.addClass('lexibridge-settings');
		if (
			this.plugin.settings.eudicToken
			&& !this.categoriesLoaded
			&& !this.categoriesLoading
			&& !this.categoriesError
		) {
			this.categoriesLoading = true;
			void this.loadCategories();
		}
		if (!this.ecdictStatus && !this.ecdictStatusLoading) {
			this.ecdictStatusLoading = true;
			void this.loadEcdictStatus();
		}

		this.renderLocalDictionarySection(containerEl);
		this.renderTemplateSection(containerEl);
		renderAnkiSettingsSection(containerEl, this.plugin);
		this.renderReadingSection(containerEl);
		this.renderOnlineDictionarySection(containerEl);
		this.renderSyncSection(containerEl);
		this.renderAdvancedSection(containerEl);
	}

	private async loadEcdictStatus(): Promise<void> {
		try {
			this.ecdictStatus = await this.plugin.getEcdictStatus();
		} catch (error) {
			console.error('[LexiBridge] Failed to read ECDICT status:', error);
			this.ecdictStatus = { installed: false, valid: false, installation: null };
		} finally {
			this.ecdictStatusLoading = false;
			this.display();
		}
	}

	private async loadCategories(): Promise<void> {
		try {
			this.categoriesLoading = true;
			this.categoriesError = null;
			const service = new EudicService(this.plugin.settings.eudicToken);
			this.categories = await withTimeout(
				service.getCategories('en'),
				CATEGORY_LOAD_TIMEOUT_MS,
				'加载欧路生词本列表'
			);
			this.categoriesLoaded = true;
		} catch (error) {
			this.categories = [];
			this.categoriesLoaded = false;
			this.categoriesError = error instanceof Error ? error.message : String(error);
			console.error('[LexiBridge] Failed to load categories:', error);
		} finally {
			this.categoriesLoading = false;
			this.display();
		}
	}

	private resetCategoryState(): void {
		this.categories = [];
		this.categoriesLoaded = false;
		this.categoriesLoading = false;
		this.categoriesError = null;
	}

	private renderLocalDictionarySection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('本地词典')
			.setHeading();

		if (this.ecdictStatusLoading || !this.ecdictStatus) {
			new Setting(containerEl)
				.setName('ECDICT 本地词典')
				.setDesc('正在读取本地词典状态...');
		} else if (!this.ecdictStatus.installed) {
			new Setting(containerEl)
				.setName('ECDICT 本地词典')
				.setDesc('尚未安装。将从 ECDICT 上游下载约 63 MB 的原始 CSV，导入后可完全离线使用。')
				.addButton(button => {
					button.setButtonText('下载并安装').setCta().onClick(() => {
						void this.installEcdict();
					});
				});
		} else {
			const installation = this.ecdictStatus.installation!;
			const installedAt = new Date(installation.installedAt).toLocaleDateString();
			const statusText = this.ecdictStatus.valid ? '已安装' : '校验失败，建议重新安装';
			new Setting(containerEl)
				.setName(`ECDICT 本地词典：${statusText}`)
				.setDesc(`${installation.entryCount.toLocaleString()} 条词条 · 下载包 ${formatBytes(installation.packageSize)} · 安装于 ${installedAt}`)
				.addButton(button => {
					button.setButtonText('校验').onClick(async () => {
						button.setDisabled(true);
						try {
							this.ecdictStatus = await this.plugin.getEcdictStatus();
							new Notice(this.ecdictStatus.valid ? 'ECDICT 本地词典校验通过' : 'ECDICT 校验失败，请重新安装');
							this.display();
						} catch (error) {
							new Notice(`ECDICT 校验失败：${error instanceof Error ? error.message : String(error)}`);
						} finally {
							button.setDisabled(false);
						}
					});
				})
				.addButton(button => {
					button.setButtonText('检查更新').onClick(async () => {
						button.setDisabled(true);
						try {
							const result = await this.plugin.checkEcdictUpdate(this.plugin.settings.ecdictDownloadSource);
							if (!result.available && this.ecdictStatus?.valid) {
								new Notice('ECDICT 已是最新版本');
								return;
							}
							new ConfirmModal(this.app, '发现 ECDICT 更新，下载并替换当前本地词典？', () => {
								void this.installEcdict();
							}).open();
						} catch (error) {
							new Notice(`检查 ECDICT 更新失败：${error instanceof Error ? error.message : String(error)}`);
						} finally {
							button.setDisabled(false);
						}
					});
				})
				.addButton(button => {
					button.setButtonText('重新安装').onClick(() => {
						void this.installEcdict();
					});
				})
				.addButton(button => {
					button.setButtonText('删除').setWarning().onClick(() => {
						new ConfirmModal(this.app, '删除本机上的 ECDICT 数据？现有单词笔记不会受影响。', () => {
							void (async () => {
								await this.plugin.removeEcdict();
								this.ecdictStatus = null;
								this.display();
								new Notice('ECDICT 本地词典已删除');
							})();
						}).open();
					});
				});
		}

		const ecdictNote = containerEl.createEl('div', {cls: 'lexibridge-setting-note'});
		ecdictNote.createEl('p', {text: 'ECDICT 是默认释义来源。数据直接来自 skywind3000/ECDICT，保存在本机 IndexedDB，不写入 Vault。'});

		new Setting(containerEl)
			.setName('下载节点')
			.setDesc('选择 ECDICT 上游 CSV 的访问节点；测速只下载各节点的小型 README 文件。')
			.addDropdown(dropdown => {
				for (const source of ECDICT_DOWNLOAD_SOURCES) dropdown.addOption(source.id, source.name);
				dropdown.setValue(this.plugin.settings.ecdictDownloadSource).onChange(async value => {
					this.plugin.settings.ecdictDownloadSource = value as EcdictDownloadSourceId;
					await this.plugin.saveSettings();
				});
			})
			.addButton(button => {
				button.setButtonText('测速并选择').onClick(async () => {
					button.setDisabled(true);
					const notice = new Notice('正在逐个测试 ECDICT 下载节点...', 0);
					try {
						const results = await this.plugin.testEcdictDownloadSources();
						const available = results.filter(result => result.available && result.durationMs !== null)
							.sort((a, b) => a.durationMs! - b.durationMs!);
						if (available.length === 0) throw new Error('所有节点均不可用');
						const fastest = available[0]!;
						this.plugin.settings.ecdictDownloadSource = fastest.id;
						await this.plugin.saveSettings();
						const summary = results.map(result => `${result.name}: ${result.available ? `${result.durationMs} ms` : '不可用'}`).join('\n');
						new Notice(`已选择 ${fastest.name}\n\n${summary}`, 12000);
						this.display();
					} catch (error) {
						new Notice(`ECDICT 节点测速失败：${error instanceof Error ? error.message : String(error)}`);
					} finally {
						notice.hide();
						button.setDisabled(false);
					}
				});
			});

		const batchNote = containerEl.createEl('div', {cls: 'lexibridge-setting-note'});
		batchNote.createEl('p', {text: '批量迁移只处理 dict_source: eudic 或带欧路同步提示块的笔记，全程使用本地 ECDICT。'});
	}

	private renderReadingSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('阅读与双链')
			.setHeading();

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

	private renderOnlineDictionarySection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('有道在线增强')
			.setHeading();

		new Setting(containerEl)
			.setName('本地未收录时在线查询')
			.setDesc('仅在用户主动查词或创建笔记且 ECDICT 未收录时请求有道；批量迁移永远不会使用有道。')
			.addToggle(toggle => {
				toggle.setValue(this.plugin.settings.enableYoudaoFallback).onChange(async value => {
					this.plugin.settings.enableYoudaoFallback = value;
					await this.plugin.saveSettings();
					this.plugin.reconfigureServices();
				});
			});

		new Setting(containerEl)
			.setName('最小请求间隔（毫秒）')
			.setDesc('最小 1000ms；插件会自动加入随机抖动，并在频率受限时暂停 5 分钟。')
			.addText(text => {
				text.setValue(String(this.plugin.settings.youdaoMinIntervalMs)).onChange(async value => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isFinite(parsed) && parsed >= 1000) {
						this.plugin.settings.youdaoMinIntervalMs = parsed;
						await this.plugin.saveSettings();
						this.plugin.reconfigureServices();
					}
				});
				text.inputEl.type = 'number';
			});

		const note = containerEl.createEl('div', {cls: 'lexibridge-setting-note'});
		note.createEl('p', {text: '“使用有道在线增强”命令始终是主动操作。网页接口没有公开 SLA，可能限流或变更，因此不用于自动批处理。'});
	}

	private async installEcdict(): Promise<void> {
		const progressNotice = new EcdictProgressNotice();
		try {
			const installation = await this.plugin.installEcdict(
				this.plugin.settings.ecdictDownloadSource,
				progress => progressNotice.update(progress),
				progressNotice.abortSignal
			);
			this.ecdictStatus = { installed: true, valid: true, installation };
			progressNotice.setComplete(`ECDICT 安装完成，共 ${installation.entryCount.toLocaleString()} 条词条`);
			this.display();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			progressNotice.setError(`安装失败：${message}`);
		}
	}

	private renderTemplateSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('单词笔记')
			.setHeading();

		new Setting(containerEl)
			.setName('存储文件夹')
			.setDesc('保存单词笔记的 Vault 文件夹')
			.addText(text => {
				new FolderSuggest(this.app, text.inputEl);
				text.setPlaceholder('LexiBridge').setValue(this.plugin.settings.folderPath).onChange(async value => {
					const sanitized = value.replace(/\.\./g, '').replace(/^\/+/, '');
					if (sanitized !== value) new Notice('路径包含非法字符，已自动清理');
					this.plugin.settings.folderPath = sanitized || 'LexiBridge';
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('保护标题')
			.setDesc('每行一个 Markdown 标题名，不要写 #。更新笔记时，这些标题及其下级内容会原样保留。')
			.addTextArea(text => {
				text.setPlaceholder('笔记\nNotes')
					.setValue(this.plugin.settings.protectedHeadings.join('\n'))
					.onChange(async value => {
						this.plugin.settings.protectedHeadings = [...new Set(
							value.split(/\r?\n/).map(item => item.replace(/^#+\s*/, '').trim()).filter(Boolean)
						)];
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
			});

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
			.setDesc('创建或更新单词笔记前显示将写入的属性、标签和正文')
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
			.setDesc('从欧路词典官网获取 Token，验证通过后保存')
			.addText((text) => {
				text
					.setPlaceholder('欧路词典 API token')
					.setValue(this.plugin.settings.eudicToken);
				text.inputEl.type = 'password';
			})
			.addButton((button) => {
				button
					.setButtonText('验证并保存')
					.setCta()
					.onClick(async () => {
						const input = containerEl.querySelector<HTMLInputElement>('input[type="password"]');
						const token = input?.value.trim() || '';
						button.setDisabled(true);
						try {
							if (!token) {
								this.plugin.settings.eudicToken = '';
								this.plugin.settings.enableSync = false;
								this.resetCategoryState();
								await this.plugin.saveSettings();
								this.plugin.reconfigureServices();
								this.display();
								new Notice('Token 已清除');
								return;
							}

							const service = new EudicService(token);
							const categories = await withTimeout(
								service.getCategories('en'),
								CATEGORY_LOAD_TIMEOUT_MS,
								'验证欧路 Token'
							);
							this.plugin.settings.eudicToken = token;
							this.categories = categories;
							this.categoriesLoaded = true;
							this.categoriesLoading = false;
							this.categoriesError = null;
							await this.plugin.saveSettings();
							this.plugin.reconfigureServices();
							this.display();
							new Notice('Token 验证成功');
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							this.categoriesError = message;
							new Notice(`Token 验证失败：${message}`);
						} finally {
							button.setDisabled(false);
						}
					});
			});

		if (this.plugin.settings.eudicToken) {
			const warningEl = containerEl.createEl('p', { 
				cls: 'lexibridge-warning-text',
			});
			warningEl.setText('Token 以明文存储在插件数据中。请勿将 data.json 分享或上传到公开仓库。');

				if (this.categoriesLoading) {
					containerEl.createEl('p', {text: '正在加载生词本列表...'});
				} else if (this.categoriesError) {
					new Setting(containerEl)
						.setName('生词本列表加载失败')
						.setDesc(this.categoriesError)
						.addButton((button) => {
							button.setButtonText('重试').onClick(() => {
								this.categoriesError = null;
								this.categoriesLoading = true;
								this.display();
								void this.loadCategories();
							});
						});
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
							if (
								this.plugin.settings.syncCategoryIds.length > 0
								&& !this.plugin.settings.syncCategoryIds.includes(this.plugin.settings.defaultUploadCategoryId)
							) {
								this.plugin.settings.defaultUploadCategoryId = this.plugin.settings.syncCategoryIds[0] || '';
							}
							void (async () => {
								await this.plugin.saveSettings();
								this.plugin.reconfigureServices();
								this.display();
							})();
					});
					label.createSpan({text: cat.name});
				}

				new Setting(containerEl)
						.setName('默认上传生词本')
						.setDesc('本地新建单词时默认上传到此生词本')
						.addDropdown((dropdown) => {
							const availableCategories = this.plugin.settings.syncCategoryIds.length > 0
								? this.categories.filter(cat => this.plugin.settings.syncCategoryIds.includes(cat.id))
								: this.categories;
							for (const cat of availableCategories) {
								dropdown.addOption(cat.id, cat.name);
							}
							const fallbackCategoryId = availableCategories[0]?.id || '';
							const selectedCategoryId = availableCategories.some(cat => cat.id === this.plugin.settings.defaultUploadCategoryId)
								? this.plugin.settings.defaultUploadCategoryId
								: fallbackCategoryId;
							dropdown
								.setValue(selectedCategoryId)
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
