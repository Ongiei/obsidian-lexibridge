# LexiBridge

Local-first dictionary tools for Obsidian, with offline English-Chinese definitions, optional online enrichment, safe vocabulary-note linking, wordbook synchronization, and one-way Anki export.

[中文说明](README.zh-CN.md)

> LexiBridge is currently in `0.x` development. Features and stored data structures may still change.

LexiBridge supports Obsidian 1.8.7 and later. Dictionary, note, and reading features work on desktop and mobile. Anki export requires Anki Desktop and AnkiConnect.

## Features

- Install and query the ECDICT English-Chinese dictionary locally.
- Generate structured vocabulary notes from editable Markdown and frontmatter templates.
- Preserve user-written content under one or more configured headings when notes are refreshed.
- Resolve inflected words to lemma notes while preserving proper capitalization and aliases.
- Preview and add short Obsidian WikiLinks in a selection, section, or whole document.
- Show non-destructive virtual links in Reading view and Live Preview.
- Hover or select a virtual link to preview the vocabulary note, open it, or convert matching occurrences to real short links.
- Find vocabulary links that can be removed and discover words without existing vocabulary notes.
- Optionally enrich one word at a time with Youdao.
- Optionally synchronize selected Eudic wordbooks with matching local subfolders.
- Optionally send vocabulary notes one way to Anki through AnkiConnect.

## Dictionary sources

### ECDICT

ECDICT is the default definition source. LexiBridge downloads `ecdict.csv` from [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT), converts it locally, and imports the entries into IndexedDB. Dictionary data is not written into the vault.

The settings page can test and select GitHub, ghproxy.net, gh-proxy.com, jsDelivr, or Statically download endpoints. Installation and updates use a pinned upstream commit and validate the downloaded file, imported entry count, and representative entries before replacing the active local database. A failed update leaves the existing database available.

Batch migration only processes notes marked with `dict_source: eudic` or a legacy Eudic synchronization callout. It runs entirely against the local ECDICT database. LexiBridge does not add hidden management comments or synchronization callouts to vocabulary notes.

### Youdao enrichment

Youdao is an optional, user-initiated online source. It can supply phonetics, definitions, forms, web translations, and examples when requested for a single word. It is never used for automatic batch processing.

Requests are serialized, use randomized spacing and limited retries, and pause after HTTP 403 or 429 responses. You can disable online fallback and use ECDICT only. The dictionary panel can switch between ECDICT and Youdao; the default source for editor selection lookup is configurable.

## Vocabulary notes and links

LexiBridge writes vocabulary notes under the configured folder. Templates control frontmatter and body structure. Existing content below protected headings such as `## Notes` is retained by heading level during an update.

Automatic linking previews every proposed change before writing. Links use the shortest unambiguous Obsidian target, preserve the displayed source text as an alias when needed, and avoid code, links, frontmatter, configured headings, and other excluded Markdown regions.

Virtual links do not modify Markdown. They are visible in Reading view and Live Preview while the plugin is enabled. Their compact preview can convert all matching occurrences in the current document to real short WikiLinks so backlinks remain useful even if LexiBridge is later disabled.

## Eudic wordbook synchronization

Eudic is an optional wordbook connector, not a general definition source. After an official Open API token is configured, each selected remote wordbook maps to a separate subfolder inside the vocabulary-note folder. The same word may belong to more than one wordbook.

Remote wordbook renames update their mapped local folders. Renaming a mapped local wordbook folder can update the corresponding remote wordbook.

Deletion, a missing synchronization baseline, or substantial divergence after a long inactive period pauses automatic synchronization. Manual synchronization displays the complete difference list and offers three alignment strategies:

- **Preserve both sides** restores missing items and performs no deletion.
- **Local wins** uploads local data and removes remote items that are absent locally.
- **Cloud wins** downloads remote data and moves unmatched local files to the Obsidian trash.

Destructive plans remain subject to the configured deletion limit. LexiBridge stores a bounded synchronization history and can restore recorded local deletions. Successful checkpoints are saved during long operations, so interrupted synchronization can continue later.

## Anki export

Anki is an optional one-way export target. Obsidian remains the source of card content; Anki owns review scheduling, history, suspension state, and optional AnkiWeb synchronization.

LexiBridge creates or updates the `LexiBridge Vocabulary` note type and identifies managed notes through a stable `LexiBridgeId` field. Updates use AnkiConnect field updates instead of deleting and recreating notes, preserving note IDs, card IDs, and review history. Card front, back, and CSS templates are editable in settings.

Full export begins with a read-only preview. Missing Markdown sources leave Anki notes unchanged by default. From the preview, users may explicitly tag missing-source notes, suspend their cards, or permanently delete them after confirmation. A zero-source scan refuses destructive actions. LexiBridge does not write Anki IDs or synchronization markers into Markdown.

## Installation

### BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Add `Ongiei/obsidian-lexibridge` as a beta plugin.
3. Enable **LexiBridge** in **Settings -> Community plugins**.
4. Open **Settings -> LexiBridge -> Dictionary**, test a mirror, and install ECDICT.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Ongiei/obsidian-lexibridge/releases/latest).
2. Place the files in `<vault>/.obsidian/plugins/lexibridge/`.
3. Restart Obsidian and enable LexiBridge.

## Basic usage

1. Install ECDICT from the LexiBridge dictionary settings.
2. Select a word or place the cursor inside it.
3. Run **Query selected or cursor word** to look it up, or **Create a lemma note for selected or cursor word** to create a vocabulary note.
4. Use the dictionary side panel to switch between local and optional online results.
5. Enable virtual links or run an automatic-link command when you want vocabulary words highlighted or written as real WikiLinks.

Optional Youdao lookup, Eudic wordbook synchronization, remote AnkiConnect endpoints, and AnkiWeb synchronization remain inactive until explicitly configured.

## Commands

| Command | Purpose |
| --- | --- |
| Open dictionary view | Open the local-first dictionary side panel. |
| Create a lemma note for selected or cursor word | Create or update a vocabulary note. |
| Query selected or cursor word | Look up the selected word or the word at the cursor. |
| Enrich current or selected word with Youdao | Explicitly refresh one vocabulary note from Youdao. |
| Automatically link current document | Preview vocabulary links for the whole document. |
| Link vocabulary words in current section | Limit link preview to the current heading section. |
| Link vocabulary words in selection | Limit link preview to selected text. |
| Inspect and remove vocabulary links | Preview real vocabulary WikiLinks that can be converted back to display text. |
| Discover missing vocabulary notes | List unlinked words that do not yet have vocabulary notes. |
| Migrate Eudic notes with ECDICT | Refresh eligible legacy notes entirely offline. |
| Synchronize Eudic wordbooks | Review differences and run the selected alignment plan. |
| Test AnkiConnect connection | Request only the AnkiConnect API version. |
| Synchronize vocabulary notes to Anki | Preview and send the full configured vocabulary-note scope. |
| Synchronize current vocabulary note to Anki | Add or update only the current vocabulary note. |

## Network and privacy

| Feature | Endpoint | Data sent |
| --- | --- | --- |
| ECDICT installation or update | skywind3000/ECDICT or selected mirror | No vault content. |
| ECDICT lookup and migration | None | Nothing. |
| Youdao enrichment | `dict.youdao.com/jsonapi` | The word explicitly queried by the user. |
| Eudic synchronization | Official Eudic Open API | Words and wordbook operations in the selected scope. |
| AnkiConnect connection test | `http://127.0.0.1:8765` by default | No vault content. |
| Anki export | Configured AnkiConnect endpoint | Selected vocabulary-note content, tags, and source links. |
| AnkiWeb trigger | Performed by Anki Desktop | LexiBridge never receives AnkiWeb credentials. |

LexiBridge contains no telemetry. The Eudic token is stored as plain text in the plugin's `data.json`; do not publish or share that file.

Vault access is limited to the configured vocabulary-note folder, the active note or selected text, and files explicitly selected by the user. LexiBridge does not enumerate unrelated vault notes.

## Development

```bash
npm ci
npm test
npm run lint
npm run check:community
```

For the real AnkiConnect acceptance test, start Anki Desktop with AnkiConnect enabled, then run:

```bash
npm run test:anki-manual
```

## Data and dependency licenses

ECDICT is provided by [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT) under the MIT License. LexiBridge downloads the upstream CSV and processes it only on the local device.

The project structure is based on the [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin). Lemmatization uses the MIT-licensed [wink-lemmatizer](https://github.com/winkjs/wink-lemmatizer). Names and trademarks remain the property of their respective owners.

## License

[0-BSD](LICENSE)
