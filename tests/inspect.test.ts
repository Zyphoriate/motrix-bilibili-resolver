import { beforeEach, describe, expect, it } from 'vitest'
import { clearApiCache } from '../src/bilibili/api'
import { inspectBilibili } from '../src/bilibili/resolve'
import { VIEW_DATA, json, makeDeps } from './helpers'

const url = 'https://www.bilibili.com/video/BV1GJ411x7h7/'
beforeEach(clearApiCache)

describe('collection inspection provider boundaries', () => {
  it('rejects oversized collections instead of silently omitting pages', async () => {
    const pages = Array.from({ length: 501 }, (_, index) => ({ cid: index + 1, page: index + 1, part: 'Part', duration: 1 }))
    await expect(inspectBilibili(url, makeDeps(() => json({ code: 0, data: { ...VIEW_DATA, pages } })))).rejects.toThrow('500')
  })
  it.each([
    [{ cid: 1, page: 1 }, { cid: 1, page: 2 }],
    [{ cid: 1, page: 1 }, { cid: 2, page: 1 }],
    [{ cid: 1.5, page: 1 }],
    [{ cid: 1, page: 1.5 }],
  ])('rejects ambiguous part identifiers %j', async (...pages) => {
    await expect(inspectBilibili(url, makeDeps(() => json({ code: 0, data: { ...VIEW_DATA, pages } })))).rejects.toThrow('identifier')
  })
  it('handles a single video without pages and emits P1 metadata', async () => {
    const result = await inspectBilibili(url, makeDeps(() => json({ code: 0, data: { ...VIEW_DATA, pages: undefined } })))
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ id: '111', partNumber: 1, durationSeconds: 213, url: `${url}?p=1` })
    expect(result.entries[0]!.title).toContain('P1')
  })
  it('rejects provider identifiers that could inject a noncanonical URL', async () => {
    await expect(inspectBilibili(url, makeDeps(() => json({ code: 0, data: { ...VIEW_DATA, bvid: 'other/?token=secret' } })))).rejects.toThrow('canonical')
  })
})
