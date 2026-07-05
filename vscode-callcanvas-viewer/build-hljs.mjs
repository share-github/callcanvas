import { build } from 'esbuild';
import { createRequire } from 'module';

// Custom bundle: highlight.js core + java + javascript + typescript + xml (JSX/TSX subLanguage)
await build({
    stdin: {
        contents: `
import hljs from 'highlight.js/lib/core';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
window.hljs = hljs;
`,
        resolveDir: '.',
    },
    bundle: true,
    minify: true,
    format: 'iife',
    outfile: 'media/highlight.min.js',
    platform: 'browser',
});

console.log('highlight.min.js built successfully');
