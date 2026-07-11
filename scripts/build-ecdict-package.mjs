import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { once } from 'node:events';
import { createGzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const options = parseArguments(process.argv.slice(2));
if (!options.source || !options.sourceSha || !options.outDir) {
	throw new Error('Usage: node scripts/build-ecdict-package.mjs --source <ecdict.csv> --source-sha <git-blob-sha> --out-dir <directory>');
}
if (!/^[a-f0-9]{40}$/i.test(options.sourceSha)) throw new Error('source-sha must be a 40-character Git blob SHA');

const sourcePath = resolve(options.source);
const outDir = resolve(options.outDir);
await mkdir(outDir, { recursive: true });
const utility = await loadEcdictUtility();
const csv = readFileSync(sourcePath, 'utf8');
const rows = utility.parseCsvRows(csv);
const header = rows.next();
if (header.done) throw new Error('ECDICT source CSV is empty');
const columns = utility.createEcdictColumnMap(header.value.values);
const packagePath = join(outDir, 'ecdict.jsonl.gz');
const gzip = createGzip({ level: 9 });
const output = createWriteStream(packagePath);
gzip.pipe(output);

const seen = new Set();
let entryCount = 0;
for (const row of rows) {
	const entry = utility.toStoredEcdictEntry(row.values, columns);
	if (!entry || seen.has(entry.key)) continue;
	if (!entry.phonetic && !entry.translation && !entry.definition) continue;
	seen.add(entry.key);
	const compact = [entry.key, entry.word, entry.phonetic, entry.definition, entry.translation, entry.tags, entry.exchange];
	if (!gzip.write(`${JSON.stringify(compact)}\n`)) await once(gzip, 'drain');
	entryCount++;
}
gzip.end();
await once(output, 'close');

const packageSize = statSync(packagePath).size;
const packageSha256 = await hashFile(packagePath);
const datasetVersion = `${new Date().toISOString().slice(0, 10)}-${options.sourceSha.slice(0, 7)}`;
const manifest = {
	schemaVersion: 1,
	datasetVersion,
	sourceRepository: 'https://github.com/skywind3000/ECDICT',
	sourceFile: basename(sourcePath),
	sourceSha: options.sourceSha,
	sourceSize: statSync(sourcePath).size,
	packageUrl: 'https://github.com/Ongiei/obsidian-lexibridge/releases/download/ecdict-data-v1/ecdict.jsonl.gz',
	packageSize,
	packageSha256,
	entryCount,
	createdAt: new Date().toISOString(),
};
writeFileSync(join(outDir, 'ecdict-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));

async function loadEcdictUtility() {
	const temp = mkdtempSync(join(tmpdir(), 'lexibridge-ecdict-build-'));
	const outfile = join(temp, 'ecdict-utils.mjs');
	await esbuild.build({ entryPoints: ['src/utils/ecdict.ts'], bundle: true, format: 'esm', platform: 'node', outfile });
	return import(pathToFileURL(outfile).href);
}

function hashFile(path) {
	return new Promise((resolveHash, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(path);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolveHash(hash.digest('hex')));
	});
}

function parseArguments(args) {
	const parsed = {};
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]?.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		const value = args[index + 1];
		if (key && value) parsed[key] = value;
	}
	return parsed;
}
