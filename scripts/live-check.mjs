// Bundle the TypeScript live check to a temporary ESM file, then run it.
// esbuild is already a dev dependency; this avoids adding a TS runner.
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(root, '.cache', 'live-check.mjs')

await build({
  entryPoints: [path.join(root, 'scripts', 'live-check.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'warning',
})

await import(pathToFileURL(outfile).href)
