// Smoke-test the packed (fully minified) dist/plugin.js against the mock host.
// This catches packaging regressions such as a broken virtual-module import or
// renamed registrations that unit tests against src/ cannot see.

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = path.join(root, '.cache')
await mkdir(cache, { recursive: true })

const mockPath = path.join(cache, 'mock.mjs')
const pluginPath = path.join(cache, 'packed-plugin.mjs')

await build({
  entryPoints: [path.join(root, 'tests', 'mocks', 'motrix-plugin-api.ts')],
  outfile: mockPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
})

const manifest = JSON.parse(await readFile(path.join(root, 'motrix-plugin.json'), 'utf8'))
const archive = path.join(root, 'dist', `${manifest.id}-${manifest.version}.moext`)
const unpack = (entry) => execFileSync('unzip', ['-p', archive, entry], { encoding: 'utf8' })
const packedManifest = JSON.parse(unpack('motrix-plugin.json'))
assert.deepEqual(packedManifest, manifest)
const qualities = ['highest', '2160p', '1440p', '1080p', '720p', '480p']
const inspectSchema = packedManifest.contributes.commands.find((command) => command.id.endsWith('.inspectMedia')).resultSchema.properties
const resolveSchema = packedManifest.contributes.commands.find((command) => command.id.endsWith('.resolve')).argsSchema.properties
assert.deepEqual(inspectSchema.qualities.items.enum, qualities)
assert.deepEqual(inspectSchema.defaultQuality.enum, qualities)
assert.deepEqual(resolveSchema.quality.enum, qualities)
for (const locale of ['en-US', 'zh-CN']) {
  assert.deepEqual(JSON.parse(unpack(`locales/${locale}.json`)), JSON.parse(await readFile(path.join(root, 'locales', `${locale}.json`), 'utf8')))
}
const bundle = unpack('dist/plugin.js')
await writeFile(
  pluginPath,
  bundle.replaceAll('motrix:plugin-api', './mock.mjs')
)

const mock = await import(pathToFileURL(mockPath).href)
await import(pathToFileURL(pluginPath).href)

mock.hostState.config = { enabled: true, preferredQuality: '720p', cookie: '' }
mock.hostState.request = async (options) => {
  const body = options.url.includes('/x/web-interface/view')
    ? {
        code: 0,
        data: {
          bvid: 'BV1GJ411x7h7',
          aid: 1,
          title: 'smoke test',
          duration: 1,
          cid: 2,
          pages: [{ cid: 2, page: 1, part: 'smoke test', duration: 1 }],
        },
      }
    : {
        code: 0,
        data: {
          quality: 64,
          format: 'mp4720',
          durl: [{ url: 'https://cdn.example/smoke.mp4', backup_url: [] }],
          support_formats: [{ quality: 64, new_description: '720P' }],
        },
      }
  return {
    status: 200,
    headers: [],
    body: JSON.stringify(body),
    finalUrl: options.url,
    redirected: false,
  }
}

const patches = []
const metadata = new Map()
const ctx = {
  type: 'http',
  uris: ['https://www.bilibili.com/video/BV1GJ411x7h7/'],
  headers: [],
  signal: new AbortController().signal,
  metadata: { set: (key, value) => metadata.set(key, value) },
  update: (patch) => patches.push(patch),
}

if (typeof mock.hostState.beforeCreate !== 'function') {
  throw new Error('packed bundle did not register a beforeCreate hook')
}
await mock.hostState.beforeCreate(ctx)

if (patches.length !== 1) throw new Error('packed bundle did not rewrite ctx')
if (patches[0].uris[0] !== 'https://cdn.example/smoke.mp4') {
  throw new Error(`unexpected resolved URL: ${patches[0].uris[0]}`)
}
if (patches[0].filename !== undefined || metadata.get('filename') !== 'smoke test.mp4') {
  throw new Error('packed bundle must persist the title for host finalization')
}
if (!manifest.permissions.includes('metadata')) {
  throw new Error('persisted title metadata requires the metadata permission')
}
if (typeof mock.hostState.beforeFinalize !== 'function') {
  throw new Error('packed bundle did not register beforeFinalize')
}
const finalTargets = []
await mock.hostState.beforeFinalize({
  task: { type: 'http' },
  metadata: { get: (key) => metadata.get(key) },
  update: (patch) => finalTargets.push(patch),
})
if (finalTargets.length !== 1 || finalTargets[0].filePath !== 'smoke test.mp4') {
  throw new Error('packed bundle did not choose the title for the published file')
}
if (!mock.hostState.commands.has('community.bilibili-resolver.resolve')) {
  throw new Error('packed bundle did not register the public resolve command')
}
const inspect = mock.hostState.commands.get('community.bilibili-resolver.inspectMedia')
if (typeof inspect !== 'function') {
  throw new Error('packed bundle did not register the public inspection command')
}
const collection = await inspect({ url: ctx.uris[0] })
if (collection.schemaVersion !== 1 || collection.defaultQuality !== '720p' ||
    collection.entries.length !== 1 || collection.entries[0].id !== '2' ||
    collection.entries[0].url !== `${ctx.uris[0]}?p=1`) {
  throw new Error('packed inspection command returned incompatible collection metadata')
}
if (!manifest.categories.includes('post-action')) {
  throw new Error('beforeFinalize post-processing requires the post-action category')
}
if (!mock.hostState.commands.has('community.bilibili-resolver.flushCache')) {
  throw new Error('packed bundle did not register the cache command')
}

const resolve = mock.hostState.commands.get('community.bilibili-resolver.resolve')
const flush = mock.hostState.commands.get('community.bilibili-resolver.flushCache')
for (const preference of ['highest', undefined, '720p']) {
  mock.hostState.config.preferredQuality = preference
  await flush({})
  const requests = []
  mock.hostState.request = async (options) => {
    const url = new URL(options.url)
    requests.push(url)
    return {
      status: 200, headers: [], finalUrl: options.url,
      body: JSON.stringify({ code: 0, data: url.pathname.endsWith('/view') ? {
        bvid: 'BV1GJ411x7h7', aid: 1, title: 'packed selected part', cid: 2,
        pages: [{ cid: 2, page: 1, part: 'one' }, { cid: 3, page: 2, part: 'two' }],
      } : {
        quality: 80, dash: {
          video: [
            { id: 127, width: 7680, height: 4320, codecid: 12, baseUrl: 'https://cdn.example/8k.m4s' },
            { id: 120, width: 3840, height: 2160, codecid: 12, baseUrl: 'https://cdn.example/4k.m4s' },
            { id: 64, width: 1280, height: 720, codecid: 7, baseUrl: 'https://cdn.example/720p.m4s' },
          ],
          audio: [{ id: 30280, baseUrl: 'https://cdn.example/audio.m4s' }],
        },
      } }),
    }
  }
  const preview = await inspect({ url: ctx.uris[0] })
  const expectedQuality = preference === '720p' ? '720p' : 'highest'
  assert.equal(preview.defaultQuality, expectedQuality)
  assert.deepEqual(preview.qualities, qualities)
  const result = await resolve({ url: preview.entries[1].url, quality: preview.defaultQuality })
  // Observable task inputs from the packed entry point, not source string checks.
  assert.equal(result.kind, 'mux')
  assert.equal(result.video.url, `https://cdn.example/${preference === '720p' ? '720p' : '8k'}.m4s`)
  assert.equal(result.audio.url, 'https://cdn.example/audio.m4s')
  assert(requests.every((url) => !url.href.includes('highest')))
  assert(requests.some((url) => url.searchParams.get('fnval') === '4048'))
  assert.equal(result.title, 'packed selected part - P2 two')
  assert(requests.some((url) => url.searchParams.get('cid') === '3' && url.searchParams.get('qn') === (preference === '720p' ? '64' : '127')))
}
console.log('✓ actual extension archive: manifest/locales, title hook, highest protocol schema, preview preference and 8K/720p mux task smoke passed')
