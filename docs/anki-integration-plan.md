# LexiBridge Anki integration plan

## 1. Decision summary

Build a desktop-only, one-way content sync from LexiBridge word notes to Anki Desktop through AnkiConnect.

- Obsidian Markdown is the source of truth for card content.
- Anki owns scheduling, review history, suspension, and AnkiWeb synchronization.
- Updating a card must update the existing Anki note, never delete and recreate it.
- Do not write Anki IDs, comments, or synchronization markers into Markdown files.
- Do not implement full Anki-to-Obsidian content synchronization.
- Do not generate `.apkg` in the first implementation.
- Do not automatically delete Anki notes that disappear from Obsidian.

This is an optional integration. ECDICT, Youdao, Eudic synchronization, and normal word-note workflows must continue to work when Anki and AnkiConnect are absent.

## 2. Terminology

Use precise labels in code and UI:

- **Send to Anki**: create or update notes in the local Anki Desktop collection through AnkiConnect.
- **Sync AnkiWeb**: ask Anki Desktop to run its own cloud synchronization after local changes.
- **Bidirectional sync**: merge content edits in both Obsidian and Anki. This is explicitly out of scope.

The main command should be named **Sync word notes to Anki**, but its description must clarify that Obsidian content is sent one way to local Anki.

## 3. Why full bidirectional sync is rejected

Full content synchronization has a poor risk-to-value ratio:

- Anki fields contain HTML while source notes contain Markdown.
- Both sides can edit the same semantic field, requiring conflict resolution.
- Anki deletion is ambiguous and must not imply deletion of a Markdown file.
- Recreating Anki notes can destroy review history and scheduling.
- LexiBridge already coordinates ECDICT, Youdao, Eudic, Markdown, and local plugin state.

Allowed read-only information from Anki:

- whether a LexiBridge note exists;
- its Anki note ID and card IDs in previews or logs;
- whether it is suspended or missing;
- synchronization errors.

Do not write review counts, due dates, ease, intervals, or Anki-edited content back into Markdown.

## 4. System architecture

```text
Vault word notes
    -> WordNoteRepository
    -> AnkiCardMapper
    -> AnkiSyncPlanner
    -> preview (no writes)
    -> AnkiSyncService
    -> AnkiConnectClient
    -> Anki Desktop
    -> optional AnkiWeb sync
```

### Required module layout

```text
src/anki/
  types.ts
  anki-connect-client.ts
  word-note-repository.ts
  card-mapper.ts
  sync-planner.ts
  sync-service.ts
  model-manager.ts
  settings-section.ts
  sync-preview-modal.ts
  progress-notice.ts
```

Responsibilities:

- `AnkiConnectClient`: protocol only; typed request/response validation, timeout, connection test, multi-action support.
- `WordNoteRepository`: locate LexiBridge word notes and read normalized snapshots from files.
- `AnkiCardMapper`: pure conversion from a word-note snapshot to Anki fields, tags, deck, and stable identity.
- `AnkiSyncPlanner`: compare desired snapshots with notes currently managed in Anki; return adds, updates, unchanged, missing-source, and errors.
- `AnkiModelManager`: validate or create the LexiBridge note type and templates. Never modify an incompatible existing model silently.
- `AnkiSyncService`: execute an approved plan serially or in bounded batches and report per-item results.
- UI modules: settings, preview, and theme-compatible progress only. They must not contain synchronization rules.

`main.ts` should only initialize the service, register commands, and delegate. Do not add Anki request or mapping logic to `main.ts`, `WordNoteService`, or the existing Eudic `SyncService`.

## 5. Platform boundary

AnkiConnect normally listens on local loopback and requires Anki Desktop to be running.

- Mark Anki commands unavailable on Obsidian mobile and show a concise explanation.
- Do not change the whole plugin to `isDesktopOnly: true`; only gate the Anki feature with `Platform.isDesktopApp`.
- Default endpoint: `http://127.0.0.1:8765`.
- Endpoint changes are an advanced setting and must accept only `http://127.0.0.1`, `http://localhost`, or an explicit opt-in remote host.
- Never send vault content during a connection test.
- Document that sending cards to Anki transmits selected note content to the configured endpoint.

## 6. Source note model

Anki synchronization reads files already present under `settings.folderPath`. It must not perform a dictionary lookup when syncing.

```ts
interface WordNoteSnapshot {
  filePath: string;
  word: string;
  aliases: string[];
  dictSource?: string;
  tags: string[];
  phoneticsMarkdown: string;
  definitionsMarkdown: string;
  examplesMarkdown: string;
  formsMarkdown: string;
  protectedMarkdown: string;
  sourceMarkdown: string;
  modifiedTime: number;
}
```

Rules:

1. `frontmatter.word` is the canonical word; fall back to the filename only when absent.
2. Read all files recursively under the configured word-note folder.
3. Section extraction must use a structured Markdown heading scanner, not loose substring replacement.
4. The current generated headings (`发音`, `释义`, `网络翻译`, `例句`, `词形变化`) are defaults, not permanent APIs. Missing sections become empty fields.
5. Content under `settings.protectedHeadings` may be mapped into the optional `Notes` field.
6. Preserve source paths for an `obsidian://open` link, but do not expose absolute filesystem paths.
7. Compute a content hash from normalized desired Anki fields. Do not hash mtime alone.

## 7. Stable identity and ownership

Create a persistent `ankiSourceId` once and store it in plugin settings/data. It is a random UUID representing this LexiBridge installation/vault integration.

Each desired Anki note has:

```text
LexiBridgeId = <ankiSourceId>:<normalized canonical word>
```

The managed Anki note also receives:

```text
lexibridge
lexibridge::source::<safe-source-id>
```

Use the `LexiBridgeId` field as the primary identity and the source tag for scoped queries. Never identify notes by the visible front field alone.

Why this design:

- file renames do not duplicate cards;
- no sync metadata pollutes Markdown;
- LexiBridge can query Anki to reconstruct state after a local cache is lost;
- one vault cannot overwrite another vault's managed cards;
- non-LexiBridge Anki notes are outside the query scope and cannot be touched.

The local plugin data may cache `LexiBridgeId -> noteId/hash`, but Anki remains authoritative for Anki note IDs. A missing cache must cause reconstruction, not duplicate creation.

## 8. Anki note type

Create a dedicated model named `LexiBridge Vocabulary` with these fields:

1. `LexiBridgeId`
2. `Word`
3. `Phonetic`
4. `Definition`
5. `Examples`
6. `Forms`
7. `Notes`
8. `Source`
9. `ContentHash`

Default card:

- Front: `Word`, then `Phonetic` when present.
- Back: `FrontSide`, divider, `Definition`, optional `Examples`, `Forms`, `Notes`, then a restrained source link.

Requirements:

- Use a fixed internal model identity/version constant.
- Check field names before every first sync in a session.
- If a model with the same name has incompatible fields, stop and explain; do not overwrite it.
- CSS must be self-contained and use neutral Anki-compatible colors with `prefers-color-scheme` support.
- Keep templates simple. Advanced user-editable Anki templates are not part of the first milestone.

## 9. Markdown-to-HTML conversion

Anki fields are HTML. The conversion layer must be deterministic and tested.

Initial supported subset:

- paragraphs and line breaks;
- ordered and unordered lists;
- emphasis, strong text, and code;
- links;
- the generated definition and example structures;
- `obsidian://open` source link.

Do not send raw unsanitized HTML. Either:

1. use Obsidian `MarkdownRenderer` in a detached container and sanitize/normalize the resulting DOM; or
2. use a small established Markdown parser already compatible with the project bundle.

Prefer the Obsidian renderer for the first version to avoid adding a large dependency, but isolate it behind a renderer interface so it can be replaced.

Wiki-link embeds, images, and audio are out of scope for the first milestone. Plain links may remain links. Media synchronization is a separate later milestone using AnkiConnect media APIs and content-addressed filenames.

## 10. Sync algorithm

### Discovery

1. Load desired `WordNoteSnapshot` objects from the configured folder.
2. Map them to desired Anki notes and hashes.
3. Query only Anki notes tagged with this `ankiSourceId`.
4. Fetch fields and tags for those note IDs.

### Plan

Classify every item:

```ts
interface AnkiSyncPlan {
  adds: PlannedAdd[];
  updates: PlannedUpdate[];
  unchanged: PlannedUnchanged[];
  missingSources: PlannedMissingSource[];
  conflicts: PlannedConflict[];
  errors: PlannedError[];
}
```

- Add: desired ID does not exist in Anki.
- Update: ID exists and `ContentHash` differs.
- Unchanged: ID and hash match.
- Missing source: managed Anki note exists but no Markdown source exists.
- Conflict: duplicate Anki notes share one `LexiBridgeId`, model is incompatible, or canonical words collide.

### Preview

All bulk writes require a preview showing counts and expandable errors. The preview must make no Anki changes.

### Execute

- Use `addNotes` for validated additions.
- Use `updateNoteFields` for updates so scheduling and review history remain intact.
- Reconcile only LexiBridge-owned tags; preserve unrelated tags the user added in Anki.
- Use bounded batches and report partial failures per note.
- Re-query changed notes after execution and verify IDs/hashes.
- Do not treat a transport success as proof that every multi-action item succeeded.

## 11. Missing-source and deletion policy

Default behavior for a missing Markdown source: add the tag `lexibridge::source-missing` and leave the note and cards intact.

Provide these explicit actions in the preview:

- Ignore and keep card (default).
- Tag as source missing.
- Suspend cards.
- Permanently delete Anki notes.

Permanent deletion must be off by default, require a second confirmation, state the number of notes, and only operate on IDs proven to belong to the current `ankiSourceId`.

Never delete an Anki note merely because a file is temporarily moved, the folder is unavailable, parsing failed, or the scan returned zero files. A zero-source scan must disable destructive actions.

## 12. AnkiWeb policy

After successful local changes, optionally invoke AnkiConnect's sync action.

- Setting: `syncAnkiWebAfterPush`, default `false`.
- Run only when adds or updates succeeded.
- Report it as best effort; do not claim AnkiWeb success without a verifiable response.
- Never request or store AnkiWeb credentials in LexiBridge.

## 13. Settings design

Add a new top-level **Anki export** section after **Word notes**, not inside Eudic synchronization.

Recommended settings:

```ts
interface AnkiSettings {
  enabled: boolean;
  endpoint: string;
  deckName: string;
  modelName: string; // fixed/read-only in v1
  ankiSourceId: string;
  includeProtectedSections: boolean;
  syncAnkiWebAfterPush: boolean;
  missingSourcePolicy: 'keep' | 'tag';
}
```

UI controls:

- Enable Anki export toggle.
- Connection status and **Test connection** button.
- Deck dropdown loaded only after a successful connection, plus create-deck action.
- Include protected sections toggle.
- Push to AnkiWeb toggle with precise explanation.
- Advanced endpoint field.
- **Preview full sync** command button.

Do not contact Anki during settings-page render. Network calls occur only after user action.

## 14. Commands

Stable command IDs:

```text
anki-sync-current-word
anki-preview-full-sync
anki-test-connection
```

Optional later commands:

```text
anki-mark-missing-sources
anki-sync-ankiweb
```

The current-word command is safe to execute without a bulk preview when it only adds or updates one note. Deletion always requires preview and confirmation.

## 15. Error handling

Expected user-facing conditions:

- Anki Desktop is not running.
- AnkiConnect is not installed or endpoint is unreachable.
- AnkiConnect API version is unsupported.
- Origin permission is denied by AnkiConnect.
- Deck or model cannot be created.
- Existing model has incompatible fields.
- Duplicate `LexiBridgeId` values exist.
- Individual add/update operations fail.
- AnkiWeb sync cannot be confirmed.

Messages must identify the failed phase and preserve retryability. Do not collapse all errors into "sync failed".

Use the existing theme-compatible persistent Notice for execution progress. Use a modal only for the preflight plan and destructive confirmation.

## 16. Test strategy

### Unit tests

- AnkiConnect request envelope and response validation.
- timeout, malformed JSON, API error, and partial multi-action failure.
- stable ID generation and source tag sanitization.
- Markdown snapshot parsing with missing/custom sections.
- deterministic field rendering and HTML escaping.
- hash stability and hash changes.
- planner classifications, duplicates, and zero-source safety.
- tag reconciliation preserves unrelated Anki tags.

### Service tests

Use a fake AnkiConnect transport. Cover:

- first sync creates model/deck/notes;
- second identical sync is idempotent;
- content update retains the same note ID;
- file rename does not create a duplicate;
- one failed item does not mark the entire batch successful;
- missing source never deletes by default;
- destructive operations cannot escape the current source scope.

### Manual acceptance

1. Start a disposable Anki profile with AnkiConnect.
2. Add two word notes and sync.
3. Review one card once.
4. Edit its Markdown definition and sync again.
5. Verify the same Anki note/card IDs and retained scheduling history.
6. Rename the Markdown file and sync; verify no duplicate.
7. Delete one source file; verify no automatic deletion.
8. Change Obsidian light/dark themes and verify preview/progress readability.
9. Run existing LexiBridge test/build/lint/mobile gates.

## 17. Delivery phases

### Phase 1: transport and read-only preflight

- Add types and `AnkiConnectClient`.
- Add desktop/platform guard and connection test.
- Add settings normalization and settings section.
- Implement word-note repository, mapper, and pure sync planner.
- Show a no-write preview against a fake or real Anki collection.

Exit gate: no API action can mutate Anki yet; planner tests are complete.

### Phase 2: safe upsert

- Add model/deck validation and creation.
- Add current-note sync.
- Add full additions/updates execution.
- Add persistent progress Notice and readback verification.

Exit gate: repeated sync is idempotent and update preserves Anki note IDs and review scheduling.

### Phase 3: lifecycle controls

- Add missing-source tagging and optional suspension.
- Add guarded permanent deletion.
- Add optional AnkiWeb trigger.
- Add recovery/rebuild from Anki when the local cache is missing.

Exit gate: zero-source and partial-failure safety tests pass.

### Phase 4: optional media

- Audio and image discovery.
- Content-addressed media upload.
- Reference counting and conservative cleanup.

Do not begin Phase 4 until Phases 1-3 are stable.

## 18. Explicit non-goals for the first release

- Studying or scheduling cards inside Obsidian.
- Full Anki-to-Obsidian content synchronization.
- Importing arbitrary Anki note types.
- Cloze-card generation.
- `.apkg` generation.
- Mobile Obsidian direct synchronization.
- Automatic background sync on every file modification.
- Automatic permanent deletion.
- Media synchronization.

## 19. References

- AnkiConnect API: <https://git.sr.ht/~foosoft/anki-connect>
- Yanki Obsidian: <https://github.com/kitschpatrol/yanki-obsidian>
- Yanki TypeScript architecture: see its `yanki` and `yanki-connect` packages.
- Simple Anki Sync: <https://github.com/lukmay/simple-anki-sync>
- Obsidian to Anki: <https://github.com/ObsidianToAnki/Obsidian_to_Anki>
- Anki text import behavior: <https://docs.ankiweb.net/importing/text-files.html>
- Anki packaged decks: <https://docs.ankiweb.net/importing/packaged-decks.html>

## 20. Completion definition

The Anki integration is complete only when all of the following are true:

- users can test AnkiConnect without transmitting note content;
- current-note and folder sync add/update notes without duplication;
- repeat sync is idempotent;
- updates preserve Anki note/card identity and scheduling;
- Markdown files receive no Anki metadata or markers;
- non-LexiBridge Anki notes cannot be modified or deleted;
- missing sources are non-destructive by default;
- bulk changes have a no-write preview;
- mobile behavior is explicitly gated;
- privacy/network behavior is documented in README and settings;
- unit, service, existing regression, build, lint, and manual acceptance gates pass.
