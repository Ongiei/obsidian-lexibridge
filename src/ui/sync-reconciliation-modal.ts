import {App, Modal, Setting} from 'obsidian';
import {
	buildSyncOperationsForAlignment,
	type SyncAlignmentMode,
	type SyncDifference,
	type SyncDifferenceType,
	type SyncDryRunResult,
} from '../sync';

const ALIGNMENT_OPTIONS: Record<SyncAlignmentMode, {label: string; description: string}> = {
	'preserve-both': {
		label: '保留双方改动（推荐）',
		description: '把仅存在于一侧的词条复制到另一侧；已删除或缺失的词条会被恢复，不删除任何一侧的数据。',
	},
	'local-wins': {
		label: '以本地为准',
		description: '上传本地词条，并从云端删除本地不存在或仅云端存在的词条。',
	},
	'cloud-wins': {
		label: '以云端为准',
		description: '下载云端词条，并将本地不存在于云端或仅本地存在的词条移入 Obsidian 回收站。',
	},
};

const DIFFERENCE_LABELS: Record<SyncDifferenceType, string> = {
	localAdded: '仅本地存在',
	cloudAdded: '仅云端存在',
	localDeleted: '本地已删除或缺失',
	cloudDeleted: '云端已删除或缺失',
};

const ACTION_LABELS: Record<SyncAlignmentMode, Record<SyncDifferenceType, string>> = {
	'preserve-both': {
		localAdded: '上传到云端',
		cloudAdded: '下载到本地',
		localDeleted: '从云端恢复到本地',
		cloudDeleted: '上传本地副本到云端',
	},
	'local-wins': {
		localAdded: '上传到云端',
		cloudAdded: '从云端删除',
		localDeleted: '从云端删除',
		cloudDeleted: '上传到云端',
	},
	'cloud-wins': {
		localAdded: '移入本地回收站',
		cloudAdded: '下载到本地',
		localDeleted: '从云端恢复到本地',
		cloudDeleted: '移入本地回收站',
	},
};

const REASON_LABELS: Record<NonNullable<SyncDryRunResult['alignmentReasons']>[number], string> = {
	'local-missing': '检测到本地词条或词库目录缺失',
	'cloud-missing': '检测到云端词条缺失',
	'missing-baseline': '找不到可用于判断删除意图的上次同步基线',
	'stale-divergence': '距离上次同步较久，且累计变更较多',
};

export class SyncReconciliationModal extends Modal {
	private mode: SyncAlignmentMode = 'preserve-both';
	private settled = false;
	private planEl: HTMLElement | null = null;
	private differenceListEl: HTMLElement | null = null;

	constructor(
		app: App,
		private result: SyncDryRunResult,
		private onDecision: (mode: SyncAlignmentMode | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.addClass('lexibridge-sync-reconciliation-modal');
		this.contentEl.createEl('h2', {text: '同步对齐'});
		this.contentEl.createEl('p', {
			cls: 'lexibridge-sync-reconciliation-intro',
			text: '检测到删除、缺失或较长时间未同步后的数据分叉。请先查看全部差异，再选择一个统一方案。不会逐项执行不同决定。',
		});

		const reasons = this.result.alignmentReasons ?? [];
		if (reasons.length > 0) {
			const reasonList = this.contentEl.createEl('ul', {cls: 'lexibridge-sync-reconciliation-reasons'});
			for (const reason of reasons) {
				reasonList.createEl('li', {text: REASON_LABELS[reason]});
			}
		}

		new Setting(this.contentEl)
			.setName('对齐方式')
			.setDesc('默认保留双方数据。只有明确选择以其中一侧为准时，才会计划删除。')
			.addDropdown(dropdown => {
				for (const [value, option] of Object.entries(ALIGNMENT_OPTIONS) as Array<[SyncAlignmentMode, typeof ALIGNMENT_OPTIONS[SyncAlignmentMode]]>) {
					dropdown.addOption(value, option.label);
				}
				dropdown.setValue(this.mode).onChange(value => {
					this.mode = value as SyncAlignmentMode;
					this.renderPlan();
					this.renderDifferenceLists();
				});
			});

		this.planEl = this.contentEl.createDiv({cls: 'lexibridge-sync-reconciliation-plan'});
		this.renderPlan();
		this.differenceListEl = this.contentEl.createDiv({cls: 'lexibridge-sync-reconciliation-differences'});
		this.renderDifferenceLists();

		new Setting(this.contentEl)
			.addButton(button => button
				.setButtonText('按此方案同步')
				.setCta()
				.onClick(() => this.settle(this.mode)))
			.addButton(button => button
				.setButtonText('取消')
				.onClick(() => this.settle(null)));
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) this.onDecision(null);
	}

	private renderPlan(): void {
		if (!this.planEl) return;
		this.planEl.empty();
		const option = ALIGNMENT_OPTIONS[this.mode];
		this.planEl.createEl('strong', {text: option.label});
		this.planEl.createEl('p', {text: option.description});

		const operations = buildSyncOperationsForAlignment(this.result.differences ?? [], this.mode);
		const counts = {upload: 0, download: 0, delete_cloud: 0, trash_local: 0};
		for (const operation of operations) counts[operation.type] += 1;
		const summary = [
			`上传 ${counts.upload}`,
			`下载 ${counts.download}`,
			`云端删除 ${counts.delete_cloud}`,
			`本地移入回收站 ${counts.trash_local}`,
		];
		this.planEl.createEl('p', {cls: 'lexibridge-sync-reconciliation-summary', text: `计划：${summary.join('，')}`});
		this.planEl.toggleClass('is-destructive', counts.delete_cloud + counts.trash_local > 0);
	}

	private renderDifferenceLists(): void {
		if (!this.differenceListEl) return;
		this.differenceListEl.empty();
		const groups = new Map<SyncDifferenceType, SyncDifference[]>();
		for (const difference of this.result.differences ?? []) {
			const entries = groups.get(difference.type) ?? [];
			entries.push(difference);
			groups.set(difference.type, entries);
		}

		for (const type of ['localDeleted', 'cloudDeleted', 'localAdded', 'cloudAdded'] as const) {
			const differences = groups.get(type);
			if (!differences?.length) continue;
			const details = this.differenceListEl.createEl('details', {
				attr: type === 'localDeleted' || type === 'cloudDeleted' ? {open: ''} : {},
			});
			details.createEl('summary', {text: `${DIFFERENCE_LABELS[type]} (${differences.length})`});
			const list = details.createEl('ul', {cls: 'lexibridge-sync-reconciliation-list'});
			for (const difference of differences) {
				const item = list.createEl('li');
				const entry = item.createDiv({cls: 'lexibridge-sync-reconciliation-entry'});
				entry.createEl('strong', {text: `${difference.categoryName} · ${difference.word}`});
				entry.createSpan({
					cls: 'lexibridge-sync-reconciliation-action',
					text: ACTION_LABELS[this.mode][difference.type],
				});
				item.createDiv({cls: 'lexibridge-sync-reconciliation-path', text: difference.path});
			}
		}
	}

	private settle(mode: SyncAlignmentMode | null): void {
		if (this.settled) return;
		this.settled = true;
		this.close();
		this.onDecision(mode);
	}
}
