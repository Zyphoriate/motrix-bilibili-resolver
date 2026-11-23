import { beforeEach, describe, expect, it } from 'vitest'
import { clearApiCache } from '../src/bilibili/api'
import {
  buildDisplayTitle,
  resolveBilibili,
  sanitizeFilename,
  toCommandResult,
  type DirectResolution,
  type MuxResolution,
} from '../src/bilibili/resolve'
import type { VideoInfo } from '../src/bilibili/api'
import { BilibiliError } from '../src/bilibili/types'
import {
  DASH_PAYLOAD,
  VIEW_PAYLOAD,
  directPlayPayload,
  json,
  makeDeps,
  param,
} from './helpers'

const VIDEO_URL = 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2'

beforeEach(() => {
  clearApiCache()
})

function routeViewAndDirect(play: (url: string) => unknown) {
  return makeDeps((url) => {
    if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
    if (url.includes('/x/player/playurl')) return json(play(url))
    throw new Error(`unexpected request: ${url}`)
  })
}

describe('resolveBilibili direct MP4', () => {
  it('rewrites a timed multi-part page to a direct URL with mirrors', async () => {
    const deps = routeViewAndDirect(() => directPlayPayload())
    const result = (await resolveBilibili(VIDEO_URL, deps)) as DirectResolution

    expect(result.kind).toBe('direct')
    expect(result.url).toBe('https://cdn.example/v.mp4')
    expect(result.altUrls).toEqual(['https://cdn2.example/v.mp4'])
    expect(result.filename).toBe('测试视频 - P2 第二集.mp4')
    expect(result.title).toBe('测试视频 - P2 第二集')
    expect(result.quality).toBe(64)
    expect(result.qualityLabel).toBe('720P 准高清')
    expect(result.format).toBe('mp4720')
    expect(result.headers.Referer).toBe(
      'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2'
    )
    expect(result.meta).toMatchObject({
      bvid: 'BV1GJ411x7h7',
      cid: 222,
      page: 2,
      part: '第二集',
      quality: 64,
    })
  })

  it('drops malformed backup URLs before the host re-validates them', async () => {
    const deps = makeDeps((url) => {
      if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
      return json(
        directPlayPayload({
          durl: [
            {
              order: 1,
              url: 'https://cdn.example/v.mp4',
              backup_url: ['not a url', 'ftp://example.com/x.mp4'],
            },
          ],
        })
      )
    })

    const result = (await resolveBilibili(VIDEO_URL, deps)) as DirectResolution
    expect(result.kind).toBe('direct')
    expect(result.url).toBe('https://cdn.example/v.mp4')
    expect(result.altUrls).toEqual([])
  })

  it('falls back to a lower quality when the preferred one has no MP4', async () => {
    const requestedQn: Array<string | null> = []
    const deps = makeDeps((url) => {
      if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
      const qn = param(url, 'qn')
      requestedQn.push(qn)
      if (qn === '80') {
        return json(directPlayPayload({ quality: 80, durl: [] }))
      }
      return json(directPlayPayload())
    }, { quality: '1080p' })

    const result = (await resolveBilibili(VIDEO_URL, deps)) as DirectResolution
    expect(requestedQn).toEqual(['80', '64'])
    expect(result.kind).toBe('direct')
    expect(result.quality).toBe(64)
  })

  it('skips a multi-segment MP4 response and retries a lower quality', async () => {
    const deps = makeDeps((url) => {
      if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
      const qn = param(url, 'qn')
      if (qn === '80') {
        return json(
          directPlayPayload({
            quality: 80,
            durl: [
              { order: 1, url: 'https://cdn.example/part1.mp4' },
              { order: 2, url: 'https://cdn.example/part2.mp4' },
            ],
          })
        )
      }
      return json(directPlayPayload())
    }, { quality: '1080p' })

    const result = (await resolveBilibili(VIDEO_URL, deps)) as DirectResolution
    expect(result.kind).toBe('direct')
    expect(result.url).toBe('https://cdn.example/v.mp4')
    expect(result.quality).toBe(64)
  })
})

describe('resolveBilibili DASH', () => {
  it('returns a mux result when allowed and no MP4 exists', async () => {
    const deps = makeDeps((url) => {
      if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
      if (param(url, 'fnval') === '4048') return json(DASH_PAYLOAD)
      return json(directPlayPayload({ durl: [] }))
    }, { quality: '1080p' })

    const result = (await resolveBilibili(VIDEO_URL, deps, {
      allowMux: true,
    })) as MuxResolution

    expect(result.kind).toBe('mux')
    expect(result.container).toBe('mp4')
    expect(result.video.url).toBe('https://cdn.example/v80-avc.m4s')
    expect(result.video.altUrls).toEqual(['https://cdn2.example/v80-avc.m4s'])
    expect(result.audio.url).toBe('https://cdn.example/a192.m4s')
    expect(result.quality).toBe(80)
    expect(result.filename).toBe('测试视频 - P2 第二集.mp4')

    const command = toCommandResult(result)
    expect(command).toEqual({
      kind: 'mux',
      video: {
        url: 'https://cdn.example/v80-avc.m4s',
        headers: result.video.headers,
      },
      audio: {
        url: 'https://cdn.example/a192.m4s',
        headers: result.audio.headers,
      },
      container: 'mp4',
      title: '测试视频 - P2 第二集',
    })
  })

  it('fails open with dash_only when the hook cannot mux', async () => {
    const deps = makeDeps((url) => {
      if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
      if (param(url, 'fnval') === '4048') return json(DASH_PAYLOAD)
      return json(directPlayPayload({ durl: [] }))
    })

    await expect(resolveBilibili(VIDEO_URL, deps)).rejects.toMatchObject({
      name: 'BilibiliError',
      code: 'dash_only',
    })
  })
})

describe('resolveBilibili quality and mux preference', () => {
  it.each([
    ['2160p', 120, '4K'],
    ['1440p', 120, '1440P'],
  ] as const)('selects actual %s dimensions ahead of lower AVC', async (quality, qn, label) => {
    const requests: string[] = []
    const deps = makeDeps((url) => {
      requests.push(url)
      if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
      return json({ code: 0, data: { quality: 120, durl: [], dash: {
        video: [
          { id: 80, baseUrl: 'https://cdn.example/1080.m4s', codecid: 7, width: 1920, height: 1080 },
          { id: 120, baseUrl: 'https://cdn.example/4k.m4s', codecid: 12, width: 3840, height: 2160 },
          { id: 120, baseUrl: 'https://cdn.example/2k.m4s', codecid: 12, width: 2560, height: 1440 },
        ],
        audio: [{ id: 30280, baseUrl: 'https://cdn.example/audio.m4s' }],
      } } })
    }, { quality })
    const result = await resolveBilibili(VIDEO_URL, deps, { forceMux: true }) as MuxResolution
    expect(result.video.url).toBe(`https://cdn.example/${quality === '2160p' ? '4k' : '2k'}.m4s`)
    expect(result.quality).toBe(qn)
    expect(result.qualityLabel).toBe(label)
    expect(requests.some((url) => param(url, 'qn') === '120' && param(url, 'fourk') === '1')).toBe(true)
  })

  it('falls back from 1440p to 1080p without mislabelling 1080P+ as 2K', async () => {
    const deps = makeDeps((url) => {
      if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
      return json({ code: 0, data: { quality: 120, durl: [], dash: {
        video: [
          { id: 120, baseUrl: 'https://cdn.example/4k.m4s', width: 3840, height: 2160 },
          { id: 112, baseUrl: 'https://cdn.example/1080plus.m4s', width: 1920, height: 1080 },
        ], audio: [{ id: 30280, baseUrl: 'https://cdn.example/audio.m4s' }],
      } } })
    }, { quality: '1440p' })
    const result = await resolveBilibili(VIDEO_URL, deps, { forceMux: true })
    expect(result.quality).toBe(112)
    expect(result.qualityLabel).toBe('1080P+')
  })

  it('unlocks 1080P DASH for anonymous requests with try_look=1', async () => {
    let dashUrl = ''
    const deps = makeDeps(
      (url) => {
        if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
        if (param(url, 'fnval') === '4048') {
          dashUrl = url
          return json(DASH_PAYLOAD)
        }
        return json(directPlayPayload({ quality: 64 }))
      },
      { quality: '1080p' }
    )

    const result = await resolveBilibili(VIDEO_URL, deps, {
      allowMux: true,
      preferMux: true,
    })

    expect(result.kind).toBe('mux')
    expect(result.quality).toBe(80)
    expect(dashUrl).toContain('try_look=1')
  })

  it('omits try_look=1 when a login cookie is configured', async () => {
    let dashUrl = ''
    const deps = makeDeps(
      (url) => {
        if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
        if (param(url, 'fnval') === '4048') {
          dashUrl = url
          return json(DASH_PAYLOAD)
        }
        return json(directPlayPayload({ quality: 64 }))
      },
      { quality: '1080p', cookie: 'SESSDATA=secret' }
    )

    await resolveBilibili(VIDEO_URL, deps, {
      allowMux: true,
      preferMux: true,
    })

    expect(dashUrl).toContain('/x/player/playurl')
    expect(dashUrl).not.toContain('try_look')
  })

  it('promotes a stable upos mirror over a PCDN primary URL', async () => {
    const dashWithUpos = {
      code: 0,
      data: {
        quality: 80,
        format: 'flv720',
        durl: [],
        dash: {
          video: [
            {
              id: 80,
              baseUrl: 'https://xy123.mcdn.bilivideo.cn/video.m4s',
              backupUrl: [
                'https://upos-sz-mirrorhwo1.bilivideo.com/video.m4s',
              ],
              codecid: 7,
              bandwidth: 1_000_000,
            },
          ],
          audio: [
            {
              id: 30280,
              baseUrl: 'https://xy456.mcdn.bilivideo.cn/audio.m4s',
              backupUrl: [
                'https://upos-sz-mirrorcoso1.bilivideo.com/audio.m4s',
              ],
              bandwidth: 192_000,
            },
          ],
        },
      },
    }
    const deps = makeDeps(
      (url) => {
        if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
        if (param(url, 'fnval') === '4048') return json(dashWithUpos)
        return json(directPlayPayload({ durl: [] }))
      },
      { quality: '1080p' }
    )

    const result = (await resolveBilibili(VIDEO_URL, deps, {
      allowMux: true,
    })) as MuxResolution

    expect(result.video.url).toBe(
      'https://upos-sz-mirrorhwo1.bilivideo.com/video.m4s'
    )
    expect(result.video.altUrls).toContain(
      'https://xy123.mcdn.bilivideo.cn/video.m4s'
    )
    expect(result.audio.url).toBe(
      'https://upos-sz-mirrorcoso1.bilivideo.com/audio.m4s'
    )
  })

  it('keeps the direct MP4 when it already meets the preferred quality', async () => {
    let dashCalls = 0
    const deps = makeDeps(
      (url) => {
        if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
        if (param(url, 'fnval') === '4048') {
          dashCalls += 1
          return json(DASH_PAYLOAD)
        }
        return json(directPlayPayload({ quality: 80 }))
      },
      { quality: '1080p' }
    )

    const result = await resolveBilibili(VIDEO_URL, deps, {
      allowMux: true,
      preferMux: true,
    })

    expect(result.kind).toBe('direct')
    expect(result.quality).toBe(80)
    expect(dashCalls).toBe(0)
  })
})

describe('resolveBilibili short links and WBI fallback', () => {
  it('follows a b23.tv redirect before resolving', async () => {
    const requests: string[] = []
    const deps = makeDeps((url, init) => {
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.startsWith('https://b23.tv/')) {
        return json(
          {},
          {
            status: 200,
            finalUrl:
              'https://www.bilibili.com/video/BV1GJ411x7h7/?p=1&share_source=copy',
          }
        )
      }
      if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
      return json(directPlayPayload())
    })

    const result = await resolveBilibili('https://b23.tv/AbCd123', deps)
    expect(result.kind).toBe('direct')
    expect(result.filename).toBe('测试视频 - P1 第一集.mp4')
    expect(requests[0]).toBe('HEAD https://b23.tv/AbCd123')
  })

  it('retries with a WBI-signed playurl URL when the unsigned one is rejected', async () => {
    let signedUrl = ''
    const deps = makeDeps((url) => {
      if (url.includes('/x/web-interface/view')) return json(VIEW_PAYLOAD)
      if (url.includes('/x/player/wbi/playurl')) {
        signedUrl = url
        return json(directPlayPayload())
      }
      if (url.includes('/x/player/playurl')) {
        return json({ code: -403, message: '访问权限不足' })
      }
      if (url.includes('/x/web-interface/nav')) {
        return json({
          code: -101,
          message: '账号未登录',
          data: {
            wbi_img: {
              img_url:
                'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url:
                'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        })
      }
      throw new Error(`unexpected request: ${url}`)
    })

    const result = await resolveBilibili(VIDEO_URL, deps)
    expect(result.kind).toBe('direct')
    expect(signedUrl).toContain('/x/player/wbi/playurl?')
    expect(signedUrl).toContain('wts=1700000000')
    expect(signedUrl).toContain('w_rid=deadbeef')
    expect(signedUrl).toContain('bvid=BV1GJ411x7h7')
  })

  it('does not leak the login cookie to the b23.tv redirector', async () => {
    let shortHeaders: Record<string, string> | undefined
    let viewHeaders: Record<string, string> | undefined
    const deps = makeDeps(
      (url, init) => {
        if (url.startsWith('https://b23.tv/')) {
          shortHeaders = init?.headers
          return json({}, {
            finalUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/',
          })
        }
        if (url.includes('/x/web-interface/view')) {
          viewHeaders = init?.headers
          return json(VIEW_PAYLOAD)
        }
        return json(directPlayPayload())
      },
      { cookie: 'SESSDATA=secret' }
    )

    await resolveBilibili('https://b23.tv/AbCd123', deps)
    expect(shortHeaders?.Cookie).toBeUndefined()
    expect(viewHeaders?.Cookie).toBe('SESSDATA=secret')
  })

  it('retries a transient 412 response when retry delays are configured', async () => {
    let viewCalls = 0
    const deps = makeDeps(
      (url) => {
        if (url.includes('/x/web-interface/view')) {
          viewCalls += 1
          if (viewCalls === 1) {
            return { status: 412, body: '<html>risk control</html>' }
          }
          return json(VIEW_PAYLOAD)
        }
        return json(directPlayPayload())
      },
      { retryDelaysMs: [1] }
    )

    const result = await resolveBilibili(VIDEO_URL, deps)
    expect(result.kind).toBe('direct')
    expect(viewCalls).toBe(2)
  })

  it('propagates cancellation as an aborted error', async () => {
    const deps = makeDeps(
      () => {
        throw new Error('should not run')
      },
      { signal: AbortSignal.abort() }
    )

    await expect(resolveBilibili(VIDEO_URL, deps)).rejects.toMatchObject({
      code: 'aborted',
    })
  })
})

describe('filename helpers', () => {
  it('removes unsafe characters and normalizes whitespace', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe(
      'a b c d e f g h i j'
    )
  })

  it('protects Windows reserved names', () => {
    expect(sanitizeFilename('CON')).toBe('_CON')
    expect(sanitizeFilename('nul.txt')).toBe('_nul.txt')
  })

  it('caps the filename by UTF-8 bytes, not only code points', () => {
    const value = sanitizeFilename('汉'.repeat(300))
    expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(200)
    expect(value.length).toBeGreaterThan(0)

    const emoji = sanitizeFilename('😀'.repeat(300))
    expect(Buffer.byteLength(emoji, 'utf8')).toBeLessThanOrEqual(200)
  })

  it('never returns an empty stem and caps length', () => {
    expect(sanitizeFilename('   ...   ')).toBe('bilibili-video')
    const capped = sanitizeFilename('😀'.repeat(300))
    expect(Array.from(capped).length).toBeLessThanOrEqual(180)
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(200)
  })

  it('builds multi-part display titles', () => {
    const info: VideoInfo = {
      bvid: 'BV1GJ411x7h7',
      aid: 1,
      title: '标题',
      duration: 1,
      pages: [
        { cid: 1, page: 1, part: '第一集', duration: 1 },
        { cid: 2, page: 2, part: '第二集', duration: 1 },
      ],
    }
    expect(buildDisplayTitle(info, info.pages[1]!)).toBe('标题 - P2 第二集')
    expect(
      buildDisplayTitle(
        { ...info, pages: [{ cid: 1, page: 1, part: '标题', duration: 1 }] },
        { cid: 1, page: 1, part: '标题', duration: 1 }
      )
    ).toBe('标题')
  })

  it('preserves distinct part numbers when the main title exceeds filesystem limits', () => {
    const pages = [
      { cid: 1, page: 1, part: '第一集', duration: 1 },
      { cid: 2, page: 2, part: '第二集', duration: 1 },
    ]
    const info: VideoInfo = {
      bvid: 'BV1GJ411x7h7', aid: 1, title: '长标题'.repeat(100), duration: 2, pages,
    }
    const first = buildDisplayTitle(info, pages[0]!)
    const second = buildDisplayTitle(info, pages[1]!)
    expect(first).toMatch(/ - P1 第一集$/)
    expect(second).toMatch(/ - P2 第二集$/)
    expect(first).not.toBe(second)
    expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(second, 'utf8')).toBeLessThanOrEqual(200)
  })

  it('wraps errors as BilibiliError with a code', () => {
    const error = new BilibiliError('no_stream', 'nope')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('no_stream')
  })
})
