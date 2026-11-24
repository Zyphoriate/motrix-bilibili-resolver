import { beforeEach, describe, expect, it } from 'vitest'
import { clearApiCache } from '../src/bilibili/api'
import { hostState } from './mocks/motrix-plugin-api'
import {
  DASH_PAYLOAD,
  VIEW_PAYLOAD,
  directPlayPayload,
  json,
  param,
} from './helpers'

// Importing the real entry point registers its hook/commands against the mock.
await import('../src/index')

interface Header {
  name: string
  value: string
}

interface Patch {
  uris?: string[]
  filename?: string
  headers?: Header[]
  connections?: number
  proxy?: string
}

function makeContext(url: string) {
  const patches: Patch[] = []
  const metadata = new Map<string, unknown>()
  const ctx = {
    schemaVersion: 1 as const,
    invocationId: 'inv-1',
    taskId: 'task-1',
    sourceUrl: url,
    createdBy: 'user' as const,
    requestedAt: Date.now(),
    signal: new AbortController().signal,
    type: 'http' as const,
    uris: [url],
    saveDir: '/downloads',
    headers: [] as Header[],
    metadata: {
      get: (key: string) => metadata.get(key),
      has: (key: string) => metadata.has(key),
      getAll: () => Object.fromEntries(metadata),
      keys: () => [...metadata.keys()],
      set: (key: string, value: unknown) => { metadata.set(key, value) },
      delete: (key: string) => { metadata.delete(key) },
    },
    update(patch: Patch) {
      patches.push(patch)
    },
  }
  return { ctx, patches }
}

function fakeHostRequest(
  handler: (url: string, options: { method?: string }) => unknown
) {
  hostState.request = async (options) => {
    const payload = handler(options.url, options)
    return {
      status: 200,
      headers: [{ name: 'content-type', value: 'application/json' }],
      body: JSON.stringify(payload),
      finalUrl: options.url,
      redirected: false,
    }
  }
}

function viewAndPlay() {
  fakeHostRequest((url) => {
    if (url.includes('/x/web-interface/view')) return VIEW_PAYLOAD
    if (url.includes('/x/player/playurl')) return directPlayPayload()
    throw new Error(`unexpected request: ${url}`)
  })
}

beforeEach(() => {
  clearApiCache()
  hostState.config = {
    enabled: true,
    preferredQuality: '720p',
    cookie: '',
  }
  hostState.request = undefined
})

describe('plugin entry point (mocked host)', () => {
  it('registers the beforeCreate hook, public resolve command, and cache command', () => {
    expect(hostState.beforeCreate).toBeTypeOf('function')
    expect(
      hostState.commands.has('community.bilibili-resolver.resolve')
    ).toBe(true)
    expect(
      hostState.commands.has('community.bilibili-resolver.flushCache')
    ).toBe(true)
  })

  it('inspects every part without resolving media, then resolves the selected cid and quality', async () => {
    const requests: string[] = []
    fakeHostRequest((url) => {
      requests.push(url)
      if (url.includes('/x/web-interface/view')) return VIEW_PAYLOAD
      if (param(url, 'fnval') === '4048') return DASH_PAYLOAD
      throw new Error(`unexpected request: ${url}`)
    })
    const inspect = hostState.commands.get('community.bilibili-resolver.inspectMedia')!
    const result = await inspect({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2' }) as {
      entries: Array<{ id: string; title: string; url: string; partNumber: number; durationSeconds: number }>
      defaultQuality: string
    }
    expect(result.defaultQuality).toBe('720p')
    expect(result.entries.map((entry) => entry.id)).toEqual(['111', '222'])
    expect(result.entries[1]).toMatchObject({ partNumber: 2, durationSeconds: 113 })
    expect(result.entries[1]!.title).toContain('P2')
    expect(result.entries[1]!.url).toBe('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2')
    expect(requests).toHaveLength(1)
    const resolve = hostState.commands.get('community.bilibili-resolver.resolve')!
    const selected = await resolve({ url: result.entries[1]!.url, quality: '720p' }) as Record<string, unknown>
    expect(selected).toMatchObject({ kind: 'mux', video: { url: 'https://cdn.example/v64.m4s' } })
    expect(selected.title).toContain('P2')
    expect(requests.some((url) => param(url, 'cid') === '222' && param(url, 'qn') === '64')).toBe(true)
  })

  it.each([
    ['highest', 'highest', '127', 'v127.m4s'],
    [undefined, 'highest', '127', 'v127.m4s'],
    ['invalid-old-value', 'highest', '127', 'v127.m4s'],
    ['2160p', '2160p', '120', 'v120.m4s'],
    ['1440p', '1440p', '120', 'v80-avc.m4s'],
    ['1080p', '1080p', '80', 'v80-avc.m4s'],
    ['720p', '720p', '64', 'v64.m4s'],
    ['480p', '480p', '32', 'v32.m4s'],
  ])('uses preference %s through inspection, resolution and mock task creation', async (preference, expectedQuality, qn, videoFile) => {
    hostState.config.preferredQuality = preference
    const requests: string[] = []
    fakeHostRequest((url) => {
      requests.push(url)
      if (url.includes('/x/web-interface/view')) return VIEW_PAYLOAD
      if (param(url, 'fnval') === '4048') return {
        ...DASH_PAYLOAD,
        data: { ...DASH_PAYLOAD.data, dash: {
          ...DASH_PAYLOAD.data.dash,
          video: [
            ...DASH_PAYLOAD.data.dash.video,
            { id: 127, width: 7680, height: 4320, codecid: 12, baseUrl: 'https://cdn.example/v127.m4s' },
            { id: 120, width: 3840, height: 2160, codecid: 12, baseUrl: 'https://cdn.example/v120.m4s' },
            { id: 32, width: 854, height: 480, codecid: 7, baseUrl: 'https://cdn.example/v32.m4s' },
          ],
        } },
      }
      throw new Error(`unexpected request: ${url}`)
    })
    const inspect = hostState.commands.get('community.bilibili-resolver.inspectMedia')!
    const preview = await inspect({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7/' }) as {
      entries: Array<{ id: string; url: string }>; defaultQuality: string; qualities: string[]
    }
    expect(preview.defaultQuality).toBe(expectedQuality)
    expect(preview.qualities).toContain(preview.defaultQuality)
    expect(preview.qualities).toEqual(['highest', '2160p', '1440p', '1080p', '720p', '480p'])
    expect(requests).toHaveLength(1)
    const resolve = hostState.commands.get('community.bilibili-resolver.resolve')!
    // Model the host's visible task seam: the selected P uses the preview's
    // selected quality, and its downloaded streams become the mux task inputs.
    const tasks: Array<{ source: string; video: string; audio: string; output: string }> = []
    const selected = preview.entries[1]!
    const resolution = await resolve({ url: selected.url, quality: preview.defaultQuality }) as {
      kind: string; video: { url: string }; audio: { url: string }; title: string
    }
    expect(resolution.kind).toBe('mux')
    tasks.push({ source: selected.url, video: resolution.video.url, audio: resolution.audio.url, output: `${resolution.title}.mp4` })
    expect(tasks).toEqual([{
      source: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2',
      video: `https://cdn.example/${videoFile}`,
      audio: 'https://cdn.example/a192.m4s', output: '测试视频 - P2 第二集.mp4',
    }])
    expect(requests.some((url) => param(url, 'cid') === selected.id && param(url, 'qn') === qn)).toBe(true)
    expect(requests.every((url) => !url.includes('highest'))).toBe(true)
  })

  it.each(['highest', undefined])('requests highest ladder for %s and falls back to available DASH', async (preference) => {
    hostState.config.preferredQuality = preference
    let requestedQn: string | null = null
    fakeHostRequest((url) => {
      if (url.includes('/x/web-interface/view')) return VIEW_PAYLOAD
      requestedQn = param(url, 'qn')
      return DASH_PAYLOAD
    })
    const resolve = hostState.commands.get('community.bilibili-resolver.resolve')!
    const result = await resolve({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2' })
    expect(requestedQn).toBe('127')
    expect(result).toMatchObject({ kind: 'mux', video: { url: 'https://cdn.example/v80-avc.m4s' }, title: '测试视频 - P2 第二集' })
  })

  it('accepts highest in the public resolve protocol', async () => {
    fakeHostRequest((url) => url.includes('/x/web-interface/view') ? VIEW_PAYLOAD : DASH_PAYLOAD)
    const resolve = hostState.commands.get('community.bilibili-resolver.resolve')!
    await expect(resolve({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7/', quality: 'highest' })).resolves.toMatchObject({ kind: 'mux' })
  })

  it('starts the default progressive hook at QN127 but stages the available MP4 task', async () => {
    hostState.config.preferredQuality = undefined
    const qns: Array<string | null> = []
    fakeHostRequest((url) => {
      if (url.includes('/x/web-interface/view')) return VIEW_PAYLOAD
      qns.push(param(url, 'qn'))
      return directPlayPayload()
    })
    const { ctx, patches } = makeContext('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2')
    await hostState.beforeCreate!(ctx)
    expect(qns[0]).toBe('127')
    expect(patches[0]?.uris).toEqual(['https://cdn.example/v.mp4', 'https://cdn2.example/v.mp4'])
    expect(ctx.metadata.get('filename')).toBe('测试视频 - P2 第二集.mp4')
  })

  it('rejects malformed inspection arguments before making requests', async () => {
    const inspect = hostState.commands.get('community.bilibili-resolver.inspectMedia')!
    for (const raw of [null, {}, { url: 'file:///tmp/video' }, { url: 'https://user:secret@www.bilibili.com/video/BV1GJ411x7h7/' }, { url: 'https://www.bilibili.com', cookies: 'secret' }]) {
      await expect(inspect(raw)).rejects.toThrow('invalid arguments')
    }
  })

  it('declines unsupported Bilibili pages and disabled inspection without network access', async () => {
    hostState.request = async () => { throw new Error('must not request') }
    const inspect = hostState.commands.get('community.bilibili-resolver.inspectMedia')!
    await expect(inspect({ url: 'https://www.bilibili.com/' })).resolves.toBeNull()
    hostState.config.enabled = false
    await expect(inspect({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7/' })).resolves.toBeNull()
  })

  it('serves the public resolve command for the host mux seam', async () => {
    hostState.config = {
      enabled: true,
      preferredQuality: '1080p',
      cookie: '',
    }
    let dashUrl = ''
    fakeHostRequest((url) => {
      if (url.includes('/x/web-interface/view')) return VIEW_PAYLOAD
      if (param(url, 'fnval') === '4048') {
        dashUrl = url
        return DASH_PAYLOAD
      }
      return directPlayPayload({ quality: 64 })
    })

    const handler = hostState.commands.get(
      'community.bilibili-resolver.resolve'
    )!
    const result = (await handler({
      url: 'https://www.bilibili.com/video/BV1GJ411x7h7/',
      cookies: 'SESSDATA=from-extension',
    })) as Record<string, unknown>

    expect(result).toMatchObject({
      kind: 'mux',
      container: 'mp4',
      video: { url: 'https://cdn.example/v80-avc.m4s' },
      audio: { url: 'https://cdn.example/a192.m4s' },
    })
    expect(dashUrl).toContain('/x/player/playurl')
    expect(dashUrl).not.toContain('try_look')
  })

  it('rewrites a Bilibili page URL to a direct MP4', async () => {
    viewAndPlay()
    const { ctx, patches } = makeContext(
      'https://www.bilibili.com/video/BV1GJ411x7h7/'
    )

    const result = await hostState.beforeCreate!(ctx)

    expect(result).toBe(ctx)
    expect(patches).toHaveLength(1)
    expect(patches[0]).toMatchObject({
      uris: ['https://cdn.example/v.mp4', 'https://cdn2.example/v.mp4'],
    })
    expect(patches[0]?.headers).toEqual(
      expect.arrayContaining([
        {
          name: 'Referer',
          value: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=1',
        },
      ])
    )
    expect(patches[0]?.filename).toBeUndefined()
    expect(ctx.metadata.get('filename')).toBe('测试视频 - P1 第一集.mp4')
  })

  it('uses the selected part CID and title instead of downloading P1', async () => {
    let requestedCid: string | null = null
    fakeHostRequest((url) => {
      if (url.includes('/x/web-interface/view')) return VIEW_PAYLOAD
      requestedCid = param(url, 'cid')
      return directPlayPayload()
    })
    const { ctx, patches } = makeContext(
      'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2'
    )
    await hostState.beforeCreate!(ctx)
    expect(requestedCid).toBe('222')
    expect(ctx.metadata.get('filename')).toBe('测试视频 - P2 第二集.mp4')
    expect(patches[0]?.headers).toContainEqual({
      name: 'Referer',
      value: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2',
    })
  })

  it('keeps a user-supplied header unless the resolver deliberately replaces it', async () => {
    viewAndPlay()
    const { ctx, patches } = makeContext(
      'https://www.bilibili.com/video/BV1GJ411x7h7/'
    )
    ctx.headers.push({ name: 'Cookie', value: 'SESSDATA=secret' })
    ctx.headers.push({ name: 'Referer', value: 'https://evil.example/' })

    await hostState.beforeCreate!(ctx)

    expect(patches[0]?.headers).toEqual(
      expect.arrayContaining([
        { name: 'Cookie', value: 'SESSDATA=secret' },
        {
          name: 'Referer',
          value: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=1',
        },
      ])
    )
    expect(patches[0]?.headers).not.toEqual(
      expect.arrayContaining([{ name: 'Referer', value: 'https://evil.example/' }])
    )
  })

  it('leaves non-Bilibili URLs untouched without any network call', async () => {
    let calls = 0
    hostState.request = async () => {
      calls += 1
      throw new Error('should not be called')
    }
    const { ctx, patches } = makeContext('https://example.com/file.zip')

    const result = await hostState.beforeCreate!(ctx)

    expect(result).toBe(ctx)
    expect(patches).toHaveLength(0)
    expect(calls).toBe(0)
  })

  it('fails open when the API is unavailable', async () => {
    hostState.request = async () => {
      throw new Error('network down')
    }
    const { ctx, patches } = makeContext(
      'https://www.bilibili.com/video/BV1GJ411x7h7/'
    )

    const result = await hostState.beforeCreate!(ctx)

    expect(result).toBe(ctx)
    expect(patches).toHaveLength(0)
  })

  it('does nothing when disabled in settings', async () => {
    hostState.config = {
      enabled: false,
      preferredQuality: '1080p',
      cookie: '',
    }
    let calls = 0
    hostState.request = async () => {
      calls += 1
      throw new Error('should not be called')
    }
    const { ctx, patches } = makeContext(
      'https://www.bilibili.com/video/BV1GJ411x7h7/'
    )

    await hostState.beforeCreate!(ctx)
    expect(patches).toHaveLength(0)
    expect(calls).toBe(0)
  })

  it('fails open without throwing when ctx.update throws', async () => {
    viewAndPlay()
    const { ctx } = makeContext(
      'https://www.bilibili.com/video/BV1GJ411x7h7/'
    )
    ctx.update = () => {
      throw new Error('staged effect rejected')
    }

    await expect(hostState.beforeCreate!(ctx)).resolves.toBe(ctx)
  })

  it('uses persisted title metadata at finalization even after resolver cache loss', async () => {
    viewAndPlay()
    const { ctx } = makeContext('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2')
    await hostState.beforeCreate!(ctx)
    const persisted = JSON.parse(JSON.stringify(ctx.metadata.getAll()))
    clearApiCache()
    hostState.request = async () => { throw new Error('finalization must not use the network') }
    const targets: unknown[] = []
    const finalizeCtx = {
      task: { type: 'http', saveDir: '/downloads' },
      filePath: '/downloads/43823400977-1-192.mp4',
      metadata: { get: (key: string) => persisted[key] },
      update: (patch: unknown) => targets.push(patch),
    }
    await expect(hostState.beforeFinalize!(finalizeCtx)).resolves.toBe(finalizeCtx)
    expect(targets).toEqual([{ filePath: '测试视频 - P2 第二集.mp4' }])
  })

  it('leaves unrelated finalizations untouched and contains filename update failures', async () => {
    const update = () => { throw new Error('unexpected or rejected patch') }
    const unrelated = { task: { type: 'http' }, metadata: { get: () => undefined }, update }
    await expect(hostState.beforeFinalize!(unrelated)).resolves.toBe(unrelated)
    const rejected = { task: { type: 'http' }, metadata: { get: () => 'title.mp4' }, update }
    await expect(hostState.beforeFinalize!(rejected)).resolves.toBe(rejected)
  })

  it('flushes the resolver cache', async () => {
    const handler = hostState.commands.get(
      'community.bilibili-resolver.flushCache'
    )!
    await expect(handler({})).resolves.toBeUndefined()
  })
})
