const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const outDir = 'vault/.obsidian/plugins/lexibridge';
const outfile = path.join(outDir, 'main.js');

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

esbuild.build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    external: [
        'obsidian', 'electron',
        '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands',
        '@codemirror/language', '@codemirror/lint', '@codemirror/search',
        '@codemirror/state', '@codemirror/view',
        '@lezer/common', '@lezer/highlight', '@lezer/lr'
    ],
    format: 'cjs',
    target: 'es2018',
    sourcemap: 'inline',
    outfile,
    minify: false,
}).then(() => {
    fs.copyFileSync('manifest.json', path.join(outDir, 'manifest.json'));
    fs.copyFileSync('styles.css', path.join(outDir, 'styles.css'));
    console.log('Build complete!');
}).catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
});