import { defineConfig } from 'vite';
import { metadata, pkg } from './scripts/metadata.mjs';

export default defineConfig({
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    plugins: [{
        name: 'userscript-metadata',
        generateBundle(_options, bundle) {
            const header = metadata();
            for (const output of Object.values(bundle)) {
                if (output.type === 'chunk' && output.isEntry) output.code = `${header}\n\n${output.code}`;
            }
            this.emitFile({ type: 'asset', fileName: 'uooc-study-plugin.meta.js', source: `${header}\n` });
        },
    }],
    build: {
        target: 'es2022',
        minify: false,
        cssMinify: false,
        sourcemap: false,
        lib: { entry: 'src/main.js', name: 'UoocStudyPlugin', formats: ['iife'], fileName: () => 'uooc-study-plugin.user.js' },
        rolldownOptions: { output: { minify: false } },
    },
});
