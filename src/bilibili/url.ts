/**
 * URL recognition for Bilibili video pages and b23.tv short links.
 *
 * Implemented with plain string/regex parsing on purpose: Motrix plugins run
 * in QuickJS with a host-provided subset of Web APIs, so the resolver does not
 * depend on `URL` / `URLSearchParams` being present or behaving exactly like a
 * browser. This also makes the parser tolerant of invisible zero-width
 * characters that sometimes travel with copied links.
 *
 * Supported forms:
 *   https://www.bilibili.com/video/BV1xx411c7mD
 *   https://m.bilibili.com/video/BV1xx411c7mD/?p=2
 *   https://www.bilibili.com/video/av170001
 *   https://b23.tv/abc123
 */

export interface VideoTarget {
  kind: 'video'
  /** Canonical page URL, also used as the media CDN Referer. */
  pageUrl: string
  bvid?: string
  aid?: number
  page: number
}

export interface ShortTarget {
  kind: 'short'
  shortUrl: string
}

export type ParsedTarget = VideoTarget | ShortTarget

const BV_ID_RE = /^BV[0-9A-Za-z]{10}$/
const AV_ID_RE = /^av(\d+)$/i
const VIDEO_HOST_RE = /(^|\.)bilibili\.com$/i
const SHORT_HOST_RE = /(^|\.)b23\.tv$/i
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const BARE_HOST_RE = /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|$)/i
const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/gi
const CONTROL_RE = /[\u0000-\u001f\u007f]/g

/** Host (lowercase, without port) from an absolute http(s) URL. */
export function hostOf(rawUrl: string): string {
  const match = /^https?:\/\/([^/?#]+)/i.exec(rawUrl.trim())
  return match?.[1]?.toLowerCase().split(':')[0] ?? ''
}

/** Tolerate links without a scheme (some tools add bare page URLs). */
export function normalizeUrl(input: string): string | null {
  let candidate = input.replace(ZERO_WIDTH_RE, '').replace(CONTROL_RE, '').trim()
  if (!candidate) return null

  if (candidate.slice(0, 2) === '//') {
    candidate = `https:${candidate}`
  } else if (!SCHEME_RE.test(candidate)) {
    if (!BARE_HOST_RE.test(candidate)) return null
    candidate = `https://${candidate}`
  }

  if (!/^https?:\/\//i.test(candidate)) return null

  const hashIndex = candidate.indexOf('#')
  if (hashIndex >= 0) candidate = candidate.slice(0, hashIndex)
  return candidate
}

function parsePageNumber(query: string): number {
  for (const pair of query.split('&')) {
    const separator = pair.indexOf('=')
    const rawKey = separator >= 0 ? pair.slice(0, separator) : pair
    if (rawKey !== 'p') continue
    const rawValue = separator >= 0 ? pair.slice(separator + 1) : ''
    let value = rawValue
    try {
      value = decodeURIComponent(rawValue)
    } catch {
      // Keep the raw value; parseInt below will reject it if invalid.
    }
    const page = parseInt(value, 10)
    return isFinite(page) && page > 0 && Math.floor(page) === page ? page : 1
  }
  return 1
}

export function parseBilibiliUrl(input: string): ParsedTarget | null {
  const normalized = normalizeUrl(input)
  if (!normalized) return null

  const afterScheme = normalized.replace(/^https?:\/\//i, '')
  const pathStart = afterScheme.indexOf('/')
  if (pathStart < 0) return null

  const host = afterScheme.slice(0, pathStart).toLowerCase().split(':')[0] ?? ''
  const pathAndQuery = afterScheme.slice(pathStart)

  if (SHORT_HOST_RE.test(host)) {
    const path = pathAndQuery.split('?')[0] ?? ''
    if (path === '/' || path.length < 2) return null
    return { kind: 'short', shortUrl: normalized }
  }

  if (!VIDEO_HOST_RE.test(host)) return null

  const match = /^\/video\/([^/?#]+)/i.exec(pathAndQuery)
  const rawId = match?.[1]
  if (!rawId) return null

  let id: string
  try {
    id = decodeURIComponent(rawId)
  } catch {
    id = rawId
  }

  const bvid = BV_ID_RE.test(id) ? id : undefined
  const avMatch = AV_ID_RE.exec(id)
  const aid = avMatch?.[1] ? parseInt(avMatch[1], 10) : undefined
  if (
    !bvid &&
    (aid === undefined ||
      !isFinite(aid) ||
      Math.floor(aid) !== aid ||
      aid <= 0 ||
      aid > 9_007_199_254_740_991)
  ) {
    return null
  }

  const queryIndex = pathAndQuery.indexOf('?')
  const query = queryIndex >= 0 ? pathAndQuery.slice(queryIndex + 1) : ''
  const page = parsePageNumber(query)
  const idPart = bvid ?? `av${aid}`
  const pageUrl = `https://www.bilibili.com/video/${idPart}/?p=${page}`

  return { kind: 'video', pageUrl, bvid, aid, page }
}

export function isBilibiliUrl(input: string): boolean {
  try {
    return parseBilibiliUrl(input) !== null
  } catch {
    return false
  }
}
