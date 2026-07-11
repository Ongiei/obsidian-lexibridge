import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'lexibridge-ecdict-utils-'));
const outfile = join(tmp, 'ecdict-utils.mjs');

await esbuild.build({ entryPoints: ['src/utils/ecdict.ts'], bundle: true, format: 'esm', platform: 'node', outfile });
const {
	createEcdictColumnMap,
	parseCsvRows,
	storedEcdictEntryToDictEntry,
	toStoredEcdictEntry,
} = await import(pathToFileURL(outfile).href);

const csv = '\uFEFFword,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange\r\n'
	+ 'perceive,pəˈsiːv,"to notice","v. 察觉\n理解",v:100,3,1,"cet4 ky",10,20,"p:perceived/d:perceived/3:perceives/i:perceiving"\r\n'
	+ 'quote,,"say ""hello""",说你好,,,,,,,\r\n';
const rows = [...parseCsvRows(csv)];
assert.equal(rows.length, 3);
const columns = createEcdictColumnMap(rows[0].values);
const stored = toStoredEcdictEntry(rows[1].values, columns);
assert.equal(stored.word, 'perceive');
const entry = storedEcdictEntryToDictEntry(stored);
assert.deepEqual(entry.definitions, [{ pos: 'v.', trans: '察觉' }, { pos: '', trans: '理解' }]);
assert.deepEqual(entry.tags, ['cet4', 'ky']);
assert.deepEqual(entry.exchange.map(item => item.name), ['过去式', '过去分词', '第三人称单数', '现在分词']);
assert.equal(toStoredEcdictEntry(rows[2].values, columns).definition, 'say "hello"');
assert.throws(() => createEcdictColumnMap(['word']), /缺少字段/);

console.log('ECDICT utils tests passed');
