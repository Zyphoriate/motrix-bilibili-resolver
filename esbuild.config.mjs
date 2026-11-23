import { build } from 'esbuild'

// Same bundling rules as the official builtin plugins: the host injects
// `motrix:plugin-api`, so it must stay external. Minify whitespace/syntax only
// (identifier renaming is unnecessary for a small bundle and is the
// conservative choice official plugins use).
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/plugin.js',
  bundle: true,
  format: 'esm',
  target: 'es2020',
  platform: 'neutral',
  external: ['motrix:plugin-api'],
  minifyWhitespace: true,
  minifySyntax: true,
  treeShaking: true,
  legalComments: 'none',
  logLevel: 'info',
})
