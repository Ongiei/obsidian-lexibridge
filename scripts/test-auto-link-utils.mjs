import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-auto-link-utils-'));
const outfile = join(tmp, 'auto-link-utils.mjs');

await esbuild.build({
	entryPoints: ['src/utils/auto-link.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile,
});

const { getFenceMarker, isReferenceDefinition, splitProtectedMarkdown } = await import(pathToFileURL(outfile).href);

const line = 'word [label](https://example.com/word) ![[word]] `word` <span>word</span> #word';
const protectedParts = splitProtectedMarkdown(line).filter(part => part.isProtected).map(part => part.text);
assert.deepEqual(protectedParts, [
	'[label](https://example.com/word)',
	'![[word]]',
	'`word`',
	'<span>',
	'</span>',
	'#word',
]);
assert.deepEqual(getFenceMarker('```ts'), { character: '`', length: 3 });
assert.deepEqual(getFenceMarker('  ~~~~'), { character: '~', length: 4 });
assert.equal(getFenceMarker('plain text'), null);
assert.equal(isReferenceDefinition('[docs]: https://example.com/word'), true);
assert.equal(isReferenceDefinition('ordinary [docs] text'), false);

console.log('Auto-link utils tests passed');
