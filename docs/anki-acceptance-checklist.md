# LexiBridge Anki acceptance checklist

This checklist maps `docs/anki-integration-plan.md` section 20 to current evidence.

## Automated evidence

- Users can test AnkiConnect without transmitting note content.
  - Evidence: `src/anki/sync-service.ts` calls `testConnection()`; `src/anki/anki-connect-client.ts` sends only the `version` action.
  - Evidence: `scripts/test-anki-utils.mjs` covers the version request and API error handling.

- Current-note and folder sync add/update notes without duplication.
  - Evidence: `scripts/test-anki-utils.mjs` covers first sync, repeat sync, file rename with stable `frontmatter.word`, and current-file isolation.

- Repeat sync is idempotent.
  - Evidence: `scripts/test-anki-utils.mjs` verifies the second sync adds zero notes and keeps one managed note.

- Updates preserve Anki note identity.
  - Evidence: `scripts/test-anki-utils.mjs` verifies `updateNoteFields` is called with the existing note ID.
  - Manual evidence still required for real card scheduling behavior.

- Markdown files receive no Anki metadata or markers.
  - Evidence: Anki IDs and hashes are generated only in `src/anki/card-mapper.ts` fields; no Anki write path touches Obsidian Markdown.

- Non-LexiBridge Anki notes cannot be modified or deleted.
  - Evidence: Anki queries are scoped to `lexibridge::source::<ankiSourceId>` tags.
  - Evidence: destructive missing-source actions re-scan current scoped notes before execution.

- Missing sources are non-destructive by default.
  - Evidence: default `missingSourcePolicy` is `keep`.
  - Evidence: preview actions require explicit user clicks, and deletion uses a second confirmation.
  - Evidence: zero-source scans reject suspend/delete.

- Bulk changes have a no-write preview.
  - Evidence: `previewFullAnkiSync()` opens `AnkiSyncPreviewModal`; writes require a separate confirm action.

- Mobile behavior is explicitly gated.
  - Evidence: `AnkiSyncService.assertDesktopAvailable()` checks `Platform.isDesktopApp`.
  - Evidence: `manifest.json` keeps `isDesktopOnly` false.

- Privacy/network behavior is documented in README and settings.
  - Evidence: README has Anki export and network/privacy sections.
  - Evidence: settings text explains AnkiConnect endpoint and remote-host opt-in.

- Unit, service, existing regression, build, lint gates pass.
  - Evidence: run `npm test`, `npm run lint`, `npm run build`, and `git diff --check`.

## Manual evidence still required

Run this only after Anki Desktop is running and AnkiConnect is listening on the configured endpoint:

```bash
npm run test:anki-manual
```

The script validates a real AnkiConnect round trip:

- create a disposable manual-acceptance deck and model;
- add two notes;
- update one note with `updateNoteFields`;
- verify the same note ID and card IDs remain after update;
- query notes by the LexiBridge source tag;
- delete the notes it created.

If the script fails with `fetch failed`, AnkiConnect is not reachable at `http://127.0.0.1:8765` or the `ANKI_CONNECT_ENDPOINT` override.
