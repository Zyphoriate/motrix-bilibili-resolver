/**
 * Live end-to-end check against the real Bilibili API and CDN.
 *
 * This script is intentionally outside the plugin bundle: it implements the
 * ResolverDeps contract with Node's fetch/crypto, then exercises the same code
 * Motrix runs. Run with `pnpm live-check`.
 */

import { createHash } from 'node:crypto'
import {
  API_BASE,
  apiHeaders,
  fetchPlayInfo,
  fetchVideoInfo,
  mediaHeaders,
  type DashStream,
} from '../src/bilibili/api'
import { resolveBilibili } from '../src/bilibili/resolve'
import type {
  HttpRequestOptions,
  HttpResponse,
  ResolverDeps,
} from '../src/bilibili/types'
import { parseBilibiliUrl } from '../src/bilibili/url'
import { keyFromWbiUrl, mixinKey, signWbi } from '../src/bilibili/wbi'

async function nodeRequest(
  url: string,
  init?: HttpRequestOptions
): Promise<HttpResponse> {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.headers,
    redirect: init?.redirect ?? 'follow',
    signal: init?.signal,
  })
  return {
    status: response.status,
    headers: [...response.headers.entries()].map(([name, value]) => ({
      name,
      value,
    })),
    body: await response.text(),
    finalUrl: response.url,
  }
}

function makeDeps(quality: '1080p' | '720p' | '480p' = '720p'): ResolverDeps {
  return {
    quality,
    request: nodeRequest,
    md5: async (text) =>
      createHash('md5').update(text, 'utf8').digest('hex'),
    now: () => Date.now(),
    log: {
      debug: (message, fields) =>
        console.log(`  [debug] ${message}`, fields ?? ''),
      info: (message, fields) => console.log(`  [info] ${message}`, fields ?? ''),
      warn: (message, fields) =>
        console.log(`  [warn] ${message}`, fields ?? ''),
    },
  }
}

async function checkMedia(
  kind: string,
  url: string,
  headers: Record<string, string>
): Promise<void> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { ...headers, Range: 'bytes=0-1023' },
  })
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`${kind} media URL returned HTTP ${response.status}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  const bytes = (await response.arrayBuffer()).byteLength
  console.log(
    `  ✓ ${kind} media reachable: HTTP ${response.status}, ${bytes} bytes, ${contentType}`
  )
}

function pickLiveDash(
  streams: DashStream[],
  preferredQn: number
): DashStream | undefined {
  const playable = [...streams].sort(
    (a, b) => b.id - a.id || (b.bandwidth ?? 0) - (a.bandwidth ?? 0)
  )
  const atOrBelow = playable.filter((stream) => stream.id <= preferredQn)
  const pool = atOrBelow.length > 0 ? atOrBelow : playable
  const picked = pool.find((stream) => stream.codecid === 7) ?? pool[0]
  if (!picked) return undefined
  // Prefer the stable upos origin mirror over a PCDN primary.
  const stable = picked.backupUrls.find((url) =>
    /^upos-[a-z0-9-]+\.bilivideo\.com$/i.test(new URL(url).hostname)
  )
  return stable ? { ...picked, url: stable } : picked
}

async function main(): Promise<void> {
  const cases = [
    {
      label: 'single BV page',
      url: 'https://www.bilibili.com/video/BV1GJ411x7h7/',
    },
    {
      label: 'multi-part p=2',
      url: 'https://www.bilibili.com/video/BV17Yy3zxE9F/?p=2',
    },
    {
      label: 'av link',
      url: 'https://www.bilibili.com/video/av80433022/',
    },
    {
      label: 'b23.tv short link',
      url: 'https://b23.tv/BV1GJ411x7h7',
    },
  ]

  for (const testCase of cases) {
    console.log(`\n▶ ${testCase.label}: ${testCase.url}`)
    const result = await resolveBilibili(testCase.url, makeDeps('720p'))
    if (result.kind !== 'direct') {
      throw new Error(`expected a direct MP4, got ${result.kind}`)
    }
    console.log(
      `  ✓ resolved ${result.title} (${result.qualityLabel}, ${result.format})`
    )
    console.log(`  filename: ${result.filename}`)
    console.log(`  mirrors: ${1 + result.altUrls.length}`)
    await checkMedia('direct', result.url, result.headers)
  }

  console.log('\n▶ Anonymous 1080P via try_look=1 + DASH mux')
  const muxResult = await resolveBilibili(
    'https://www.bilibili.com/video/BV1GJ411x7h7/',
    makeDeps('1080p'),
    { allowMux: true, preferMux: true }
  )
  if (muxResult.kind !== 'mux') {
    throw new Error(`expected a mux result, got ${muxResult.kind}`)
  }
  console.log(
    `  ✓ resolved mux ${muxResult.title} (${muxResult.qualityLabel}, ${muxResult.container})`
  )
  await checkMedia('mux video', muxResult.video.url, muxResult.video.headers)
  await checkMedia('mux audio', muxResult.audio.url, muxResult.audio.headers)

  console.log('\n▶ DASH fallback stream selection (fnval=4048)')
  const target = parseBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7/')
  if (!target || target.kind !== 'video') throw new Error('parse failed')
  const deps = makeDeps('1080p')
  const info = await fetchVideoInfo(deps, target)
  const page = info.pages[0]!
  const play = await fetchPlayInfo(deps, {
    bvid: info.bvid,
    aid: info.aid,
    cid: page.cid,
    qn: 80,
    fnval: 4048,
  })
  const video = pickLiveDash(play.dash?.video ?? [], 80)
  const audio = pickLiveDash(play.dash?.audio ?? [], 30280)
  if (!video || !audio) throw new Error('no DASH stream returned')
  const headers = mediaHeaders(target.pageUrl)
  console.log(`  ✓ picked video qn ${video.id}, audio qn ${audio.id}`)
  await checkMedia('dash video', video.url, headers)
  await checkMedia('dash audio', audio.url, headers)

  console.log('\n▶ WBI-signed playurl')
  const navResponse = await nodeRequest(`${API_BASE}/x/web-interface/nav`, {
    headers: apiHeaders(deps),
  })
  const nav = JSON.parse(navResponse.body) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } }
  }
  const imgUrl = nav.data?.wbi_img?.img_url
  const subUrl = nav.data?.wbi_img?.sub_url
  if (!imgUrl || !subUrl) throw new Error('nav has no wbi_img')
  const query = await signWbi(
    {
      bvid: info.bvid,
      cid: page.cid,
      qn: 64,
      fnval: 1,
      fnver: 0,
      fourk: 1,
    },
    mixinKey(keyFromWbiUrl(imgUrl), keyFromWbiUrl(subUrl)),
    (text) => deps.md5(text),
    Math.floor(Date.now() / 1000)
  )
  const signedResponse = await nodeRequest(
    `${API_BASE}/x/player/wbi/playurl?${query}`,
    { headers: apiHeaders(deps) }
  )
  const signed = JSON.parse(signedResponse.body) as {
    code: number
    message?: string
    data?: { durl?: Array<{ url?: string }> }
  }
  if (signed.code !== 0) {
    throw new Error(
      `WBI-signed playurl failed: ${signed.code} ${signed.message ?? ''}`
    )
  }
  const signedUrl = signed.data?.durl?.[0]?.url
  if (!signedUrl) throw new Error('WBI-signed playurl returned no durl')
  console.log('  ✓ WBI signature accepted')
  await checkMedia('WBI direct', signedUrl, headers)

  console.log('\n✅ all live checks passed')
}

main().catch((error) => {
  console.error('\n❌ live check failed:', error)
  process.exitCode = 1
})
