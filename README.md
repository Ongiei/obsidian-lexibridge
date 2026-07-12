# LexiBridge

本地优先的 Obsidian 多词典源工具：使用 ECDICT 离线生成英汉词汇笔记，按需调用有道增强内容，可选择与欧路生词本同步，也可将单词笔记发送到 Anki。

> LexiBridge 目前处于 `0.x` 开发阶段，功能和数据结构仍可能调整。

## 数据来源

### ECDICT 本地词典

ECDICT 是默认释义来源。首次使用时从 [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT) 直接下载约 63 MB 的 `ecdict.csv`，在本机转换并导入约 77 万条英汉词条。设置中可在 GitHub、ghproxy.net、gh-proxy.com、jsDelivr 和 Statically 节点之间测速与切换。

数据保存在当前 Obsidian 环境的 IndexedDB 中，不写入 Vault。插件支持校验、检查更新、重新安装和删除；更新失败时会继续保留原有词典。

批量迁移只处理 `dict_source: eudic` 或带欧路同步提示块的笔记，完全使用本地 ECDICT，不访问在线词典。笔记不写入隐藏管理标记；可在设置中配置一个或多个受保护标题，例如 `## 笔记`，更新时按标题层级保留其下的手写内容。

### 有道在线增强

用户主动查词或创建笔记时，若 ECDICT 没有收录，可选择使用有道网页 JSON 接口补充音标、释义、词形、网络释义和例句。查词侧边栏可在 ECDICT 与有道之间切换；单词文件的右键菜单也提供按需增强入口。

有道不会用于自动批处理。插件会串行请求、加入随机间隔、对服务端错误有限重试，并在遇到 403/429 时暂停五分钟。也可以关闭在线兜底，仅使用 ECDICT。

### 欧路生词本同步

欧路是可选的生词本同步连接器，不是通用查词来源。配置官方 Open API Token 后，可在选定生词本和 Obsidian 词库之间进行双向同步；下载的云端词条使用 API 返回的基础 `word` 和 `exp` 数据。

### Anki 导出

Anki 是可选的制卡出口。LexiBridge 通过本机 Anki Desktop 的 AnkiConnect 插件，把 Obsidian 单词笔记单向发送到 Anki；Obsidian 仍是卡片内容来源，Anki 负责复习进度、排程、暂停状态和 AnkiWeb 同步。

同步会创建或更新专用笔记类型 `LexiBridge Vocabulary`，用稳定的 `LexiBridgeId` 字段识别本插件管理的笔记。更新时使用 AnkiConnect 的字段更新接口，不删除重建笔记，因此会保留已有 note/card ID 和复习历史。Markdown 文件中不会写入 Anki ID、HTML 注释或同步标记。

全量发送前会先显示只读预览。源 Markdown 文件缺失时默认保留 Anki 笔记不动；可在预览中显式添加 `lexibridge::source-missing` 标签、暂停缺失源卡片，或在二次确认后永久删除缺失源 Anki 笔记。插件不会自动删除 Anki 笔记，且零源扫描会拒绝暂停或删除操作。

## 核心功能

- 使用模板生成结构化词汇笔记，并保留用户指定标题下的内容。
- 在查词侧边栏切换 ECDICT 本地词典和有道在线结果。
- 识别单词变形并链接到对应词元笔记。
- 为当前 Markdown 文档批量添加安全的双链。
- 使用本地 ECDICT 批量迁移已有欧路基础词条。
- 主动使用有道增强单个词条。
- 可选的欧路生词本双向同步。
- 可选将单词笔记发送到本机 Anki Desktop。

## 安装

### BRAT（推荐）

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件。
2. 添加仓库：`Ongiei/obsidian-lexibridge`。
3. 启用 LexiBridge。
4. 前往 **设置 → LexiBridge → 词典**，测速并下载 ECDICT。

LexiBridge 设置按词典、单词笔记、阅读、Anki、生词本同步和高级分类显示。

### 手动安装

1. 从 [Releases](https://github.com/Ongiei/obsidian-lexibridge/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`。
2. 放入 `.obsidian/plugins/lexibridge/`。
3. 重启 Obsidian 并启用插件。

## 命令

| 命令 | 功能 |
|------|------|
| 打开词典视图 | 打开本地优先的查词侧边栏 |
| 创建词元笔记 | 使用本地词典或按需在线兜底创建笔记 |
| 查询选中内容 | 查询选中的单词 |
| 使用有道在线增强选中词条 | 主动在线增强单个已有词条；单词文件右键菜单也提供此操作 |
| 自动链接当前文档 | 为本地词库中的单词添加双链 |
| 使用 ECDICT 批量迁移欧路词条 | 完全离线迁移已有欧路基础笔记 |
| 预检欧路同步 | 预览并执行可选的欧路同步 |
| 测试 AnkiConnect 连接 | 只请求 AnkiConnect 版本号，不发送笔记内容 |
| 同步单词笔记到 Anki | 先读取本地词库和已管理 Anki 笔记，预览新增、更新、缺失源和冲突，再由用户确认发送 |
| 同步当前单词笔记到 Anki | 将当前单词笔记新增或更新到 Anki |

## 网络与隐私

| 功能 | 网络请求 | 发送内容 |
|------|----------|----------|
| ECDICT 安装或更新 | skywind3000/ECDICT 或所选加速节点 | 不发送 Vault 内容 |
| ECDICT 查词和批量迁移 | 无 | 无 |
| 有道在线增强 | `dict.youdao.com/jsonapi` | 当前主动查询的单词 |
| 欧路生词本同步 | 欧路官方 Open API | 同步范围内的单词和生词本操作 |
| AnkiConnect 测试连接 | 默认 `http://127.0.0.1:8765` | 不发送 Vault 内容 |
| Anki 导出 | 配置的 AnkiConnect 地址 | 选中的单词笔记内容、标签和来源链接 |
| AnkiWeb 同步触发 | 由本机 Anki Desktop 处理 | LexiBridge 不接触 AnkiWeb 凭据 |

插件不包含遥测。欧路 Token 以明文保存在插件 `data.json` 中，请勿公开分享该文件。

## 开发验证

```bash
npm test
npm run lint
npm run build
```

真实 AnkiConnect 验收需要先在 Anki Desktop 中启用 AnkiConnect：

```bash
npm run test:anki-manual
```

## 数据许可

ECDICT 数据来自 [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)，按 MIT License 使用。LexiBridge 直接下载上游 CSV 并仅在本机进行解析与索引。

## License

[0-BSD](LICENSE)
