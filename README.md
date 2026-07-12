# LexiBridge

本地优先的 Obsidian 多词典源工具：使用 ECDICT 离线生成英汉词汇笔记，按需调用有道增强内容，并可选择与欧路生词本同步。

> LexiBridge 目前处于 `0.x` 开发阶段，功能和数据结构仍可能调整。

## 数据来源

### ECDICT 本地词典

ECDICT 是默认释义来源。首次使用时从 [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT) 直接下载约 63 MB 的 `ecdict.csv`，在本机转换并导入约 77 万条英汉词条。设置中可在 GitHub、ghproxy.net、gh-proxy.com、jsDelivr 和 Statically 节点之间测速与切换。

数据保存在当前 Obsidian 环境的 IndexedDB 中，不写入 Vault。插件支持校验、检查更新、重新安装和删除；更新失败时会继续保留原有词典。

批量迁移只处理 `dict_source: eudic` 或带欧路同步提示块的笔记，完全使用本地 ECDICT，不访问在线词典。笔记不写入隐藏管理标记；可在设置中配置一个或多个受保护标题，更新时保留这些标题下的手写内容。

### 有道在线增强

用户主动查词或创建笔记时，若 ECDICT 没有收录，可选择使用有道网页 JSON 接口补充音标、释义、词形、网络释义和例句。

有道不会用于自动批处理。插件会串行请求、加入随机间隔、对服务端错误有限重试，并在遇到 403/429 时暂停五分钟。也可以关闭在线兜底，仅使用 ECDICT。

### 欧路生词本同步

欧路是可选的生词本同步连接器，不是通用查词来源。配置官方 Open API Token 后，可在选定生词本和 Obsidian 词库之间进行双向同步；下载的云端词条使用 API 返回的基础 `word` 和 `exp` 数据。

## 核心功能

- 使用模板生成结构化词汇笔记，并保留用户指定标题下的内容。
- 识别单词变形并链接到对应词元笔记。
- 为当前 Markdown 文档批量添加安全的双链。
- 使用本地 ECDICT 批量迁移已有欧路基础词条。
- 主动使用有道增强单个词条。
- 可选的欧路生词本双向同步。

## 安装

### BRAT（推荐）

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件。
2. 添加仓库：`Ongiei/obsidian-lexibridge`。
3. 启用 LexiBridge。
4. 前往 **设置 → LexiBridge → 本地词典**，测速并下载 ECDICT。

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
| 使用有道在线增强选中词条 | 主动在线增强单个已有词条 |
| 自动链接当前文档 | 为本地词库中的单词添加双链 |
| 使用 ECDICT 批量迁移欧路词条 | 完全离线迁移已有欧路基础笔记 |
| 预检欧路同步 | 预览并执行可选的欧路同步 |

## 网络与隐私

| 功能 | 网络请求 | 发送内容 |
|------|----------|----------|
| ECDICT 安装或更新 | skywind3000/ECDICT 或所选加速节点 | 不发送 Vault 内容 |
| ECDICT 查词和批量迁移 | 无 | 无 |
| 有道在线增强 | `dict.youdao.com/jsonapi` | 当前主动查询的单词 |
| 欧路生词本同步 | 欧路官方 Open API | 同步范围内的单词和生词本操作 |

插件不包含遥测。欧路 Token 以明文保存在插件 `data.json` 中，请勿公开分享该文件。

## 数据许可

ECDICT 数据来自 [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT)，按 MIT License 使用。LexiBridge 直接下载上游 CSV 并仅在本机进行解析与索引。

## License

[0-BSD](LICENSE)
