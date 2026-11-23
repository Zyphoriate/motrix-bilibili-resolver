import { describe, expect, it } from 'vitest'
import {
  keyFromWbiUrl,
  mixinKey,
  signWbi,
  wbiQuery,
} from '../src/bilibili/wbi'

const IMG_KEY = '7cd084941338484aae1ad9425b84077c'
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45'

describe('WBI signing', () => {
  it('derives the documented mixin key', () => {
    // Example from SocialSisterYi/bilibili-API-collect.
    expect(mixinKey(IMG_KEY, SUB_KEY)).toBe(
      'ea1db124af3c7062474693fa704f4ff8'
    )
  })

  it('extracts a key from a wbi_img URL', () => {
    expect(
      keyFromWbiUrl(
        'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'
      )
    ).toBe(IMG_KEY)
    expect(
      keyFromWbiUrl(
        'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png?x=1'
      )
    ).toBe(IMG_KEY)
  })

  it('sorts keys and strips !\'()* from values', () => {
    expect(
      wbiQuery({ b: "hello!'()* world", a: '1', c: 3 })
    ).toBe('a=1&b=hello%20world&c=3')
  })

  it('appends wts and w_rid using the injected md5', async () => {
    let signedInput = ''
    const query = await signWbi(
      { bvid: 'BV1GJ411x7h7', cid: 123, qn: 64 },
      'mixin',
      async (text) => {
        signedInput = text
        return 'deadbeef'
      },
      1_700_000_000
    )
    expect(query).toBe(
      'bvid=BV1GJ411x7h7&cid=123&qn=64&wts=1700000000&w_rid=deadbeef'
    )
    expect(signedInput).toBe(
      'bvid=BV1GJ411x7h7&cid=123&qn=64&wts=1700000000mixin'
    )
  })
})
