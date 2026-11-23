import { describe, expect, it } from 'vitest'
import { hostOf, parseBilibiliUrl, normalizeUrl } from '../src/bilibili/url'

describe('normalizeUrl', () => {
  it('keeps http(s) URLs and strips fragments', () => {
    expect(normalizeUrl('https://www.bilibili.com/video/BV1GJ411x7h7/#reply')).toBe(
      'https://www.bilibili.com/video/BV1GJ411x7h7/'
    )
  })

  it('adds https to scheme-relative and bare host URLs', () => {
    expect(normalizeUrl('//www.bilibili.com/video/BV1GJ411x7h7')).toBe(
      'https://www.bilibili.com/video/BV1GJ411x7h7'
    )
    expect(normalizeUrl('www.bilibili.com/video/BV1GJ411x7h7')).toBe(
      'https://www.bilibili.com/video/BV1GJ411x7h7'
    )
  })

  it('rejects non-http protocols and junk', () => {
    expect(normalizeUrl('magnet:?xt=urn:btih:abc')).toBeNull()
    expect(normalizeUrl('not a url')).toBeNull()
    expect(normalizeUrl('   ')).toBeNull()
  })
})

describe('parseBilibiliUrl', () => {
  it('parses a BV page with query and multi-part index', () => {
    const target = parseBilibiliUrl(
      'https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.999&p=2'
    )
    expect(target).toEqual({
      kind: 'video',
      bvid: 'BV1GJ411x7h7',
      aid: undefined,
      page: 2,
      pageUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2',
    })
  })

  it('parses av IDs on the mobile host', () => {
    const target = parseBilibiliUrl('https://m.bilibili.com/video/av170001')
    expect(target).toMatchObject({
      kind: 'video',
      aid: 170001,
      page: 1,
      pageUrl: 'https://www.bilibili.com/video/av170001/?p=1',
    })
  })

  it('parses b23.tv short links', () => {
    expect(parseBilibiliUrl('https://b23.tv/AbCd123')).toEqual({
      kind: 'short',
      shortUrl: 'https://b23.tv/AbCd123',
    })
  })

  it('accepts bare and scheme-relative links', () => {
    expect(parseBilibiliUrl('bilibili.com/video/BV1GJ411x7h7')?.kind).toBe(
      'video'
    )
    expect(
      parseBilibiliUrl('//www.bilibili.com/video/BV1GJ411x7h7')?.kind
    ).toBe('video')
  })

  it('ignores non-video Bilibili pages', () => {
    expect(parseBilibiliUrl('https://space.bilibili.com/2')).toBeNull()
    expect(parseBilibiliUrl('https://www.bilibili.com/read/cv123')).toBeNull()
    expect(parseBilibiliUrl('https://www.bilibili.com/video/online.html')).toBeNull()
  })

  it('ignores lookalike hosts and invalid IDs', () => {
    expect(parseBilibiliUrl('https://bilibili.com.evil.example/video/BV1GJ411x7h7')).toBeNull()
    expect(parseBilibiliUrl('https://www.bilibili.com/video/BV123')).toBeNull()
    expect(parseBilibiliUrl('https://b23.tv/')).toBeNull()
  })

  it('strips zero-width characters that copied links sometimes carry', () => {
    const target = parseBilibiliUrl(
      '\u200bhttps://www.bilibili.com/video/BV1GJ411x7h7/\u200b'
    )
    expect(target).toMatchObject({
      kind: 'video',
      bvid: 'BV1GJ411x7h7',
      page: 1,
    })
  })

  it('strips fragments before parsing', () => {
    expect(
      parseBilibiliUrl(
        'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2#reply'
      )
    ).toMatchObject({ kind: 'video', page: 2 })
  })

  it('extracts a lowercase host without a port', () => {
    expect(hostOf('https://WWW.Bilibili.com:443/video/BV1GJ411x7h7')).toBe(
      'www.bilibili.com'
    )
    expect(hostOf('not a url')).toBe('')
  })

  it('treats a non-numeric or zero p as page 1', () => {
    expect(
      parseBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=abc')?.page
    ).toBe(1)
    expect(
      parseBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=0')?.page
    ).toBe(1)
  })
})
