/**
 * Bilibili WBI request signing.
 *
 * Some player APIs accept unsigned requests today, but the web client signs
 * them with a mixin key derived from two rotating keys. The resolver only needs
 * this as a fallback (and MD5 comes from Motrix's crypto capability), but
 * implementing it keeps downloads working when Bilibili tightens an endpoint.
 *
 * Reference: https://github.com/SocialSisterYi/bilibili-API-collect
 */

export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
] as const

/** The mixin key is always 32 characters: the first 32 entries of the table. */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = `${imgKey}${subKey}`
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '')
    .join('')
    .slice(0, 32)
}

/** Extract the file stem from a wbi_img URL, e.g. `.../7cd0...c.png` -> `7cd0...c`. */
export function keyFromWbiUrl(url: string): string {
  const path = url.split('?')[0] ?? ''
  const file = path.split('/').pop() ?? ''
  return file.replace(/\.(png|jpg|jpeg|webp)$/i, '')
}

/** Percent-encode like Bilibili's web client, dropping `!'()*` from values. */
function encodeWbiValue(value: string): string {
  return encodeURIComponent(value.replace(/[!'()*]/g, ''))
}

/** Build the canonical query string (sorted keys) before MD5. */
export function wbiQuery(params: Record<string, string | number>): string {
  return Object.keys(params)
    .sort()
    .map((key) => {
      const value = String(params[key] ?? '')
      return `${encodeURIComponent(key)}=${encodeWbiValue(value)}`
    })
    .join('&')
}

/**
 * Sign params and return the full query string including `wts` and `w_rid`.
 * `md5Hex` is injected so the same code runs in the Motrix sandbox and Node.
 */
export async function signWbi(
  params: Record<string, string | number>,
  mixin: string,
  md5Hex: (text: string) => Promise<string>,
  nowSeconds: number
): Promise<string> {
  const signed: Record<string, string | number> = {
    ...params,
    wts: nowSeconds,
  }
  const query = wbiQuery(signed)
  const rid = await md5Hex(`${query}${mixin}`)
  return `${query}&w_rid=${rid}`
}
