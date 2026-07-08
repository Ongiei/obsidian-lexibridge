# LexiBridge

一座连接 Obsidian 与词汇数据源的桥梁，专为语言学习者和重度阅读者打造。

## 核心功能

### 生词本同步

将你的云端生词本无缝同步至 Obsidian，目前支持欧路词典。

同步使用欧路官方 Open API 的生词本接口，读取云端列表中的 `word` 和 `exp`。这里拿到的是较基础的释义数据，不是欧路客户端里的完整词典详情。

### 有道释义补全

创建单词笔记、批量补全释义、查询面板和悬浮查词面板使用有道网页 JSON 接口 `dict.youdao.com/jsonapi`，解析音标、释义、词形、网络释义和例句。

批量更新缺失释义只处理欧路同步生成的基础词条，也就是 `dict_source: eudic` 或带欧路同步提示块的笔记。它会用有道重新生成 LexiBridge 管理区块，并保留用户手写正文。

### 本地词库与 Lemma 词元识别

智能识别单词变形。无论复数、过去式还是分词，都能精准匹配并指向同一个词根笔记，彻底解决英语阅读中的双链跳转痛点。

### 一键双链当前文档

自动扫描当前阅读的文章，自动与你同步下来的本地词库进行比对，并为匹配的生词一键生成双向链接。

## 安装

### BRAT（推荐）

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. 添加仓库：`Ongiei/obsidian-lexibridge`
3. 启用插件

### 手动安装

1. 从 [Releases](https://github.com/Ongiei/obsidian-lexibridge/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`
2. 放入 `.obsidian/plugins/lexibridge/`
3. 重启 Obsidian 并启用插件

## 使用

1. **获取 Token**：在欧路词典官网获取你的 API Token 并填入插件设置
2. **设置路径**：指定一个用于保存单词卡片的本地文件夹
3. **一键同步**：点击侧边栏的同步按钮，瞬间完成知识库构建

## 命令

| 命令 | 功能 |
|------|------|
| 打开词典视图 | 打开词典侧边栏 |
| 创建词元笔记 | 创建词根笔记 |
| 查询选中内容 | 查询选中词 |
| 自动链接当前文档 | 自动双链 |
| 预检欧路同步 | 欧路同步 |
| 批量更新缺失释义 | 批量更新释义 |

## 致谢

- [欧路词典](https://my.eudic.net/)
- [有道词典](https://dict.youdao.com/)
- [wink-lemmatizer](https://github.com/winkjs/wink-lemmatizer)

## License

[0-BSD](LICENSE)
