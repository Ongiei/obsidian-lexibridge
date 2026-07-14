import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import type {SettingDefinitionItem} from "obsidian";
import LexiBridgePlugin from "./main";
import {EudicService, EudicCategory} from "./eudic";
import {DEFAULT_BODY_TEMPLATE, DEFAULT_FRONTMATTER_TEMPLATE} from "./utils/markdown-generator";
import {ConfirmModal} from "./ui/confirm-modal";
import {withTimeout} from "./utils/sync";
import {
	AnkiSettings,
	DEFAULT_ANKI_BACK_TEMPLATE,
	DEFAULT_ANKI_CARD_CSS,
	DEFAULT_ANKI_FRONT_TEMPLATE,
} from './anki/types';
import {renderAnkiSettingsSection} from './anki/settings-section';
import {
	ECDICT_DOWNLOAD_SOURCES,
	EcdictDownloadSourceId,
	EcdictStatus,
	formatBytes,
} from './ecdict';
import {EcdictProgressNotice} from './modal';
import {DictionaryProviderId} from './dictionary-provider';
import {normalizeVaultFolderPath} from './utils/vault-path';
import {markDestructive} from './ui/destructive-button';

const CATEGORY_LOAD_TIMEOUT_MS = 15000;
type SettingsTabId = 'dictionary' | 'notes' | 'reading' | 'anki' | 'sync' | 'advanced';

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
	autoLinkMinWordLength: number;
	autoLinkIgnoredWords: string[];
	autoLinkSkipHeadings: boolean;
	autoLinkSkipBlockquotes: boolean;
	autoLinkExcludedHeadings: string[];
	autoLinkSkipWordFolder: boolean;
	virtualLinksEnabled: boolean;
	enableYoudaoFallback: boolean;
	selectionLookupSource: DictionaryProviderId;
	youdaoMinIntervalMs: number;
	syncDeletionProtection: boolean;
	syncMaxDeletionCount: number;
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
	autoLinkMinWordLength: 2,
	autoLinkIgnoredWords: [],
	autoLinkSkipHeadings: false,
	autoLinkSkipBlockquotes: true,
	autoLinkExcludedHeadings: [],
	autoLinkSkipWordFolder: true,
	virtualLinksEnabled: false,
	enableYoudaoFallback: true,
	selectionLookupSource: 'ecdict',
	youdaoMinIntervalMs: 2000,
	syncDeletionProtection: true,
	syncMaxDeletionCount: 50,
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
		frontTemplate: DEFAULT_ANKI_FRONT_TEMPLATE,
		backTemplate: DEFAULT_ANKI_BACK_TEMPLATE,
		cardCss: DEFAULT_ANKI_CARD_CSS,
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
	private activeTab: SettingsTabId = 'dictionary';
	private definitionContainerEl: HTMLElement | null = null;

	constructor(app: App, plugin: LexiBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.renderSettings(this.containerEl);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [{
			name: 'LexiBridge settings',
			desc: 'Dictionary, vocabulary notes, reading links, Anki export, wordbook synchronization, and advanced options.',
			aliases: ['ECDICT', 'Youdao', 'Anki', 'Eudic', '词典', '单词笔记', '阅读', '生词本同步'],
			render: setting => {
				const containerEl = setting.settingEl;
				this.definitionContainerEl = containerEl;
				this.renderSettings(containerEl);
				return () => {
					if (this.definitionContainerEl === containerEl) this.definitionContainerEl = null;
					containerEl.empty();
				};
			},
		}];
	}

	private refresh(): void {
		this.renderSettings(this.definitionContainerEl ?? this.containerEl);
	}

	private renderSettings(containerEl: HTMLElement): void {
		containerEl.empty();
		containerEl.addClass('lexibridge-settings');
		if (
			this.activeTab === 'sync'
			&&
			this.plugin.settings.eudicToken
			&& !this.categoriesLoaded
			&& !this.categoriesLoading
			&& !this.categoriesError
		) {
			this.categoriesLoading = true;
			void this.loadCategories();
		}
		if (this.activeTab === 'dictionary' && !this.ecdictStatus && !this.ecdictStatusLoading) {
			this.ecdictStatusLoading = true;
			void this.loadEcdictStatus();
		}

		this.renderTabs(containerEl);
		const contentEl = containerEl.createDiv({cls: 'lexibridge-settings-tab-content'});
		if (this.activeTab === 'dictionary') {
			this.renderLocalDictionarySection(contentEl);
			this.renderOnlineDictionarySection(contentEl);
		} else if (this.activeTab === 'notes') this.renderTemplateSection(contentEl);
		else if (this.activeTab === 'reading') this.renderReadingSection(contentEl);
		else if (this.activeTab === 'anki') renderAnkiSettingsSection(contentEl, this.plugin);
		else if (this.activeTab === 'sync') this.renderSyncSection(contentEl);
		else this.renderAdvancedSection(contentEl);
	}

	private renderTabs(containerEl: HTMLElement): void {
		const tabs: Array<[SettingsTabId, string]> = [
			['dictionary', '词典'], ['notes', '单词笔记'], ['reading', '阅读'],
			['anki', 'Anki'], ['sync', '生词本同步'], ['advanced', '高级'],
		];
		const tabList = containerEl.createDiv({cls: 'lexibridge-settings-tabs', attr: {role: 'tablist'}});
		for (const [id, label] of tabs) {
			const tab = tabList.createEl('button', {
				cls: `lexibridge-settings-tab${id === this.activeTab ? ' is-active' : ''}`,
				text: label,
				attr: {role: 'tab', 'aria-selected': String(id === this.activeTab)},
			});
			tab.addEventListener('click', () => {
				this.activeTab = id;
				this.refresh();
			});
		}
	}

	private async loadEcdictStatus(): Promise<void> {
		try {
			this.ecdictStatus = await this.plugin.getEcdictStatus();
		} catch (error) {
			console.error('[LexiBridge] Failed to read ECDICT status:', error);
			this.ecdictStatus = { installed: false, valid: false, installation: null };
		} finally {
			this.ecdictStatusLoading = false;
			this.refresh();
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
			this.refresh();
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
							this.refresh();
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
					markDestructive(button.setButtonText('删除')).onClick(() => {
						new ConfirmModal(this.app, '删除本机上的 ECDICT 数据？现有单词笔记不会受影响。', () => {
							void (async () => {
								await this.plugin.removeEcdict();
								this.ecdictStatus = null;
								this.refresh();
								new Notice('ECDICT 本地词典已删除');
							})();
						}).open();
					});
				});
		}

		const ecdictNote = containerEl.createDiv({cls: 'lexibridge-setting-note'});
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
						this.refresh();
					} catch (error) {
						new Notice(`ECDICT 节点测速失败：${error instanceof Error ? error.message : String(error)}`);
					} finally {
						notice.hide();
						button.setDisabled(false);
					}
				});
			});

		const batchNote = containerEl.createDiv({cls: 'lexibridge-setting-note'});
		batchNote.createEl('p', {text: '批量迁移只处理 dict_source: eudic 或带历史欧路同步提示块的笔记，全程使用本地 ECDICT。'});
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

		new Setting(containerEl)
			.setName('虚拟链接')
			.setDesc('在阅读模式和 Live Preview 中高亮词库单词；点击后可查词、创建词元笔记或写入真实链接，不会自动修改 Markdown')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.virtualLinksEnabled)
				.onChange(async value => {
					this.plugin.settings.virtualLinksEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.refreshVirtualLinks();
				}));

		new Setting(containerEl)
			.setName('跳过单词笔记文件夹')
			.setDesc('不在单词笔记内部批量添加或显示虚拟链接')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoLinkSkipWordFolder)
				.onChange(async value => {
					this.plugin.settings.autoLinkSkipWordFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('跳过标题')
			.setDesc('批量链接时不处理 Markdown 标题中的单词')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoLinkSkipHeadings)
				.onChange(async value => {
					this.plugin.settings.autoLinkSkipHeadings = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('跳过引用块')
			.setDesc('批量链接时不处理以 > 开头的引用和 callout 内容')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoLinkSkipBlockquotes)
				.onChange(async value => {
					this.plugin.settings.autoLinkSkipBlockquotes = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('排除标题内容')
			.setDesc('每行一个标题名；该标题及其下级内容不会被批量链接')
			.addTextArea(text => {
				text.setPlaceholder('代码\n参考资料')
					.setValue(this.plugin.settings.autoLinkExcludedHeadings.join('\n'))
					.onChange(async value => {
						this.plugin.settings.autoLinkExcludedHeadings = value.split(/\r?\n/)
							.map(item => item.replace(/^#+\s*/, '').trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
			});

		new Setting(containerEl)
			.setName('最短单词长度')
			.setDesc('短于该长度的单词不会自动链接或显示为虚拟链接')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '20';
				text.setValue(String(this.plugin.settings.autoLinkMinWordLength)).onChange(async value => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 20) {
						this.plugin.settings.autoLinkMinWordLength = parsed;
						await this.plugin.saveSettings();
					}
				});
			});

		new Setting(containerEl)
			.setName('忽略词')
			.setDesc('每行一个单词，匹配时忽略大小写')
			.addTextArea(text => {
				text.setPlaceholder('the\na\nan')
					.setValue(this.plugin.settings.autoLinkIgnoredWords.join('\n'))
					.onChange(async value => {
						this.plugin.settings.autoLinkIgnoredWords = value.split(/\r?\n/).map(item => item.trim().toLowerCase()).filter(Boolean);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 5;
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

		new Setting(containerEl)
			.setName('编辑器选词查询来源')
			.setDesc('编辑器右键菜单和“查询选中或光标处单词”命令使用的词典；查词侧边栏仍可随时切换。')
			.addDropdown(dropdown => dropdown
				.addOption('ecdict', 'ECDICT 本地词典')
				.addOption('youdao', '有道在线词典')
				.setValue(this.plugin.settings.selectionLookupSource)
				.onChange(async value => {
					this.plugin.settings.selectionLookupSource = value as DictionaryProviderId;
					await this.plugin.saveSettings();
				}));

		const note = containerEl.createDiv({cls: 'lexibridge-setting-note'});
		note.createEl('p', {text: '“使用有道在线增强当前或选中词条”命令始终是主动操作。网页接口没有公开 SLA，可能限流或变更，因此不用于自动批处理。'});
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
			this.refresh();
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
				text.setPlaceholder('LexiBridge').setValue(this.plugin.settings.folderPath).onChange(async value => {
					const normalized = normalizeVaultFolderPath(value);
					if (normalized !== value.trim()) new Notice('路径已按 Vault 规则规范化');
					this.plugin.settings.folderPath = normalized;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('保护标题')
			.setDesc('每行一个 Markdown 标题，例如 ## 笔记。更新时保留该层级标题及其下级内容；不写 # 时匹配任意层级。')
			.addTextArea(text => {
				text.setPlaceholder('笔记\nNotes')
					.setValue(this.plugin.settings.protectedHeadings.join('\n'))
					.onChange(async value => {
						this.plugin.settings.protectedHeadings = [...new Set(
							value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
						)];
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
			});

		new Setting(containerEl)
			.setName('写入 exams 属性')
			.setDesc('将考试级别写入 properties 的 exams 字段')
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
			.setDesc('将词性写入 properties 的 pos 字段')
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
						this.refresh();
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
								this.refresh();
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
							this.refresh();
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
								this.refresh();
								void this.loadCategories();
							});
						});
				}

			if (this.categories.length > 0) {
				new Setting(containerEl)
					.setName('同步生词本范围')
					.setDesc('每个选中的远端生词本会映射为单词文件夹下的独立子文件夹；可多选。');

				const categoryContainer = containerEl.createDiv({cls: 'lexibridge-category-checkboxes'});

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
								this.refresh();
							})();
					});
					label.createSpan({text: cat.name});
				}

				new Setting(containerEl)
						.setName('默认上传生词本')
						.setDesc('直接放在单词根文件夹的旧笔记会迁移到此生词本；子文件夹中的新词按所在生词本上传。')
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
						this.refresh();
					});
			});

		if (this.plugin.settings.enableSync) {
			new Setting(containerEl)
				.setName('撤销最近删除')
				.setDesc('从同步增删记录中恢复最近一次仍可撤销的本地单词文件。最多保留 200 条记录。')
				.addButton(button => button.setButtonText('查看记录').onClick(() => {
					void this.plugin.openSyncHistory();
				}))
				.addButton(button => button.setButtonText('撤销').onClick(async () => {
					button.setDisabled(true);
					try {
						const restored = await this.plugin.undoLastSyncDeletion();
						new Notice(restored ? '已恢复最近删除的单词文件' : '没有可撤销的删除记录');
					} finally {
						button.setDisabled(false);
					}
				}));

			new Setting(containerEl)
				.setName('同步删除保护')
				.setDesc('删除或长期分叉会先展示完整差异清单，并要求选择统一对齐方式。本开关会限制已确认方案中的云端删除和本地回收站操作总数。')
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.syncDeletionProtection)
					.onChange(async value => {
						this.plugin.settings.syncDeletionProtection = value;
						await this.plugin.saveSettings();
						this.refresh();
					}));

			if (this.plugin.settings.syncDeletionProtection) {
				new Setting(containerEl)
					.setName('单次删除上限')
					.setDesc('已确认方案中云端删除和本地回收站操作的合计上限，最小为 1。超过后不会执行。')
					.addText(text => {
						text.inputEl.type = 'number';
						text.inputEl.min = '1';
						text.setValue(String(this.plugin.settings.syncMaxDeletionCount)).onChange(async value => {
							const parsed = Number.parseInt(value, 10);
							if (Number.isInteger(parsed) && parsed >= 1) {
								this.plugin.settings.syncMaxDeletionCount = parsed;
								await this.plugin.saveSettings();
							}
						});
					});
			}

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
							this.refresh();
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
				markDestructive(btn.setButtonText('清除同步记录'))
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
				markDestructive(btn.setButtonText('重置插件'))
					.onClick(() => {
						new ConfirmModal(
							this.app,
							'将所有设置恢复为默认值',
							() => {
								void (async () => {
									this.plugin.settings = {
										...DEFAULT_SETTINGS,
										protectedHeadings: [...DEFAULT_SETTINGS.protectedHeadings],
										syncCategoryIds: [...DEFAULT_SETTINGS.syncCategoryIds],
										anki: {...DEFAULT_SETTINGS.anki},
									};
									await this.plugin.saveSettings();
									this.plugin.reconfigureServices();
									this.refresh();
									new Notice('插件已重置为默认设置');
								})();
							}
						).open();
					});
			});
	}
}
