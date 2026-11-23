import { BilibiliError, type HttpResponse, type ResolverDeps } from './types'
import type { VideoTarget } from './url'
import { parseBilibiliUrl } from './url'
import { keyFromWbiUrl, mixinKey, signWbi } from './wbi'

export const API_BASE = 'https://api.bilibili.com'
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
export const WEB_REFERER = 'https://www.bilibili.com/'

const REQUEST_TIMEOUT_MS = 10_000
const VIEW_TTL_MS = 10 * 60 * 1000
const PLAY_TTL_MS = 2 * 60 * 1000
const WBI_TTL_MS = 30 * 60 * 1000
const CACHE_MAX_ENTRIES = 64

type JsonRecord = Record<string, unknown>

export interface VideoPage {
  cid: number
  page: number
  part: string
  duration: number
}

export interface VideoInfo {
  bvid: string
  aid: number
  title: string
  duration: number
  pages: VideoPage[]
}

export interface DurlSegment {
  url: string
  backupUrls: string[]
  size?: number
  length?: number
  order?: number
}

export interface DashStream {
  id: number
  url: string
  backupUrls: string[]
  bandwidth?: number
  codecid?: number
  mimeType?: string
  width?: number
  height?: number
}

export interface DashInfo {
  video: DashStream[]
  audio: DashStream[]
}

export interface PlayInfo {
  quality: number
  format: string
  durl: DurlSegment[]
  dash?: DashInfo
  acceptQuality: number[]
  supportFormats: Array<{ quality: number; description: string }>
}

export interface PlayOptions {
  bvid?: string
  aid?: number
  cid: number
  qn: number
  fnval: number
  /**
   * Bilibili's "试看" (trial look) flag. Anonymous web clients send it and,
   * when combined with DASH (`fnval` 16/4048), it unlocks 1080P streams that
   * would otherwise be login-only. It does not unlock a 1080P progressive MP4.
   */
  tryLook?: boolean
}

interface CacheEntry<T> {
  value: T
  expires: number
}

const viewCache = new Map<string, CacheEntry<VideoInfo>>()
const playCache = new Map<string, CacheEntry<PlayInfo>>()
let wbiCache: { imgKey: string; subKey: string; expires: number } | undefined

// Serialize API requests a little: Bilibili answers 412 when a burst of links
// is added at once. The hook runs per task, so a plugin-wide gate is needed.
const TRANSIENT_STATUS = new Set([412, 429, 500, 502, 503, 504])
let requestChain: Promise<void> = Promise.resolve()
let lastRequestAt = 0

export function clearApiCache(): void {
  viewCache.clear()
  playCache.clear()
  wbiCache = undefined
  requestChain = Promise.resolve()
  lastRequestAt = 0
}

function nowOf(deps: ResolverDeps): number {
  return deps.now?.() ?? Date.now()
}

function cacheGet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  now: number
): T | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expires <= now) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

function cacheSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  ttlMs: number,
  now: number
): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { value, expires: now + ttlMs })
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const code = typeof record.code === 'string' ? record.code : ''
    const message = typeof record.message === 'string' ? record.message : ''
    if (code || message) return [code, message].filter(Boolean).join(': ')
  }
  return String(error)
}

/** Accept a bare SESSDATA value as well as a full Cookie header. */
export function cookieHeader(raw?: string): string | undefined {
  if (!raw) return undefined
  const oneLine = raw.replace(/[\r\n]+/g, '; ').trim()
  if (!oneLine) return undefined
  return oneLine.includes('=') ? oneLine : `SESSDATA=${oneLine}`
}

export function apiHeaders(
  deps: ResolverDeps,
  referer: string = WEB_REFERER
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Referer: referer,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
  const cookie = cookieHeader(deps.cookie)
  if (cookie) headers.Cookie = cookie
  return headers
}

/**
 * Media CDN URLs are hotlink protected: they require a Bilibili Referer.
 * Cookies are deliberately not forwarded to third-party PCDN hosts.
 */
export function mediaHeaders(pageUrl: string): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Referer: pageUrl,
    Accept: '*/*',
  }
}

function abortError(cause?: unknown): BilibiliError {
  return new BilibiliError('aborted', 'request aborted', { cause })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function acquireRequestSlot(deps: ResolverDeps): Promise<void> {
  const gap = deps.minRequestGapMs ?? 0
  if (gap <= 0) return

  const previous = requestChain
  let release!: () => void
  requestChain = new Promise<void>((resolve) => {
    release = resolve
  })

  await previous
  try {
    const wait = gap - (Date.now() - lastRequestAt)
    if (wait > 0) await sleep(wait, deps.signal)
  } finally {
    lastRequestAt = Date.now()
    release()
  }
}

function isAbortLike(error: unknown): boolean {
  return (
    (error instanceof BilibiliError && error.code === 'aborted') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

async function requestText(
  deps: ResolverDeps,
  url: string,
  init?: Parameters<ResolverDeps['request']>[1]
): Promise<HttpResponse> {
  const retryDelays = deps.retryDelaysMs ?? []
  const attempts = retryDelays.length + 1
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (deps.signal?.aborted) throw abortError()
    await acquireRequestSlot(deps)
    if (deps.signal?.aborted) throw abortError()

    try {
      const response = await deps.request(url, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        redirect: 'follow',
        ...init,
        signal: init?.signal ?? deps.signal,
      })

      if (
        TRANSIENT_STATUS.has(response.status) &&
        attempt < attempts - 1
      ) {
        deps.log?.debug('bilibili: transient HTTP status, retrying', {
          status: response.status,
          attempt: attempt + 1,
        })
        await sleep(retryDelays[attempt] ?? 0, deps.signal)
        continue
      }
      return response
    } catch (error) {
      if (deps.signal?.aborted || isAbortLike(error)) throw abortError(error)
      lastError = error
      if (attempt < attempts - 1) {
        deps.log?.debug('bilibili: request failed, retrying', {
          attempt: attempt + 1,
        })
        await sleep(retryDelays[attempt] ?? 0, deps.signal)
        continue
      }
      throw new BilibiliError('http', describeError(error), { cause: error })
    }
  }

  throw new BilibiliError('http', describeError(lastError), {
    cause: lastError,
  })
}

async function requestJson(
  deps: ResolverDeps,
  url: string,
  headers: Record<string, string>
): Promise<JsonRecord> {
  const response = await requestText(deps, url, {
    method: 'GET',
    headers,
    timeoutMs: REQUEST_TIMEOUT_MS,
  })

  if (response.status < 200 || response.status >= 300) {
    throw new BilibiliError('http', `HTTP ${response.status}`, {
      status: response.status,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.body) as unknown
  } catch {
    throw new BilibiliError('invalid_response', 'response is not valid JSON')
  }

  const root = asRecord(parsed)
  const code = asNumber(root?.code) ?? -1
  const message =
    asString(root?.message) ?? asString(root?.msg) ?? 'unknown API error'
  if (code !== 0) {
    throw new BilibiliError('api', `API ${code}: ${message}`, { apiCode: code })
  }

  return asRecord(root?.data) ?? {}
}

function parsePages(data: JsonRecord, fallbackTitle: string): VideoPage[] {
  const pages: VideoPage[] = []
  for (const [index, raw] of asArray(data.pages).entries()) {
    const page = asRecord(raw)
    if (!page) continue
    const cid = asNumber(page.cid)
    if (cid === undefined || cid <= 0) continue
    pages.push({
      cid,
      page: asNumber(page.page) ?? index + 1,
      part: asString(page.part) ?? '',
      duration: asNumber(page.duration) ?? 0,
    })
  }

  if (pages.length === 0) {
    const cid = asNumber(data.cid)
    if (cid !== undefined && cid > 0) {
      pages.push({
        cid,
        page: 1,
        part: fallbackTitle,
        duration: asNumber(data.duration) ?? 0,
      })
    }
  }

  if (pages.length === 0) {
    throw new BilibiliError(
      'invalid_response',
      'video response has no playable pages'
    )
  }

  return pages
}

export async function fetchVideoInfo(
  deps: ResolverDeps,
  target: VideoTarget
): Promise<VideoInfo> {
  const id = target.bvid ?? `av${target.aid}`
  const cacheKey = `view:${id}`
  const now = nowOf(deps)
  const cached = cacheGet(viewCache, cacheKey, now)
  if (cached) return cached

  const query = target.bvid
    ? `bvid=${encodeURIComponent(target.bvid)}`
    : `aid=${target.aid}`
  const data = await requestJson(
    deps,
    `${API_BASE}/x/web-interface/view?${query}`,
    apiHeaders(deps, target.pageUrl)
  )

  const bvid = asString(data.bvid) ?? target.bvid
  const aid = asNumber(data.aid) ?? target.aid
  const title = asString(data.title) ?? ''
  if (!bvid || aid === undefined || !title) {
    throw new BilibiliError(
      'invalid_response',
      'video response is missing identity or title'
    )
  }

  const info: VideoInfo = {
    bvid,
    aid,
    title,
    duration: asNumber(data.duration) ?? 0,
    pages: parsePages(data, title),
  }
  cacheSet(viewCache, cacheKey, info, VIEW_TTL_MS, now)
  return info
}

function encodeQuery(
  params: ReadonlyArray<readonly [string, string | number]>
): string {
  return params
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
    )
    .join('&')
}

function playQueryParams(
  options: PlayOptions
): Array<[string, string | number]> {
  const params: Array<[string, string | number]> = []
  if (options.bvid) params.push(['bvid', options.bvid])
  else if (options.aid !== undefined) params.push(['aid', options.aid])
  params.push(['cid', options.cid])
  params.push(['qn', options.qn])
  params.push(['fnval', options.fnval])
  params.push(['fnver', 0])
  params.push(['fourk', 1])
  if (options.tryLook) params.push(['try_look', 1])
  return params
}

function buildPlayQuery(options: PlayOptions): string {
  return encodeQuery(playQueryParams(options))
}

async function fetchWbiKeys(
  deps: ResolverDeps
): Promise<{ imgKey: string; subKey: string }> {
  const now = nowOf(deps)
  if (wbiCache && wbiCache.expires > now) return wbiCache

  const response = await requestText(deps, `${API_BASE}/x/web-interface/nav`, {
    method: 'GET',
    headers: apiHeaders(deps),
    timeoutMs: REQUEST_TIMEOUT_MS,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new BilibiliError('http', `HTTP ${response.status}`, {
      status: response.status,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.body) as unknown
  } catch {
    throw new BilibiliError('invalid_response', 'nav response is not valid JSON')
  }

  const root = asRecord(parsed)
  const code = asNumber(root?.code) ?? -1
  // Not logged in returns -101 but still ships wbi_img.
  if (code !== 0 && code !== -101) {
    throw new BilibiliError(
      'api',
      `API ${code}: ${asString(root?.message) ?? 'nav failed'}`,
      { apiCode: code }
    )
  }

  const data = asRecord(root?.data)
  const wbi = asRecord(data?.wbi_img)
  const imgUrl = asString(wbi?.img_url)
  const subUrl = asString(wbi?.sub_url)
  if (!imgUrl || !subUrl) {
    throw new BilibiliError('invalid_response', 'nav response has no wbi_img')
  }

  const imgKey = keyFromWbiUrl(imgUrl)
  const subKey = keyFromWbiUrl(subUrl)
  if (imgKey.length < 32 || subKey.length < 32) {
    throw new BilibiliError('invalid_response', 'invalid WBI keys')
  }

  wbiCache = { imgKey, subKey, expires: now + WBI_TTL_MS }
  return wbiCache
}

async function signedPlayurlUrl(
  deps: ResolverDeps,
  options: PlayOptions
): Promise<string> {
  const { imgKey, subKey } = await fetchWbiKeys(deps)
  const params: Record<string, string | number> = {
    cid: options.cid,
    qn: options.qn,
    fnval: options.fnval,
    fnver: 0,
    fourk: 1,
  }
  if (options.bvid) params.bvid = options.bvid
  else if (options.aid !== undefined) params.aid = options.aid
  if (options.tryLook) params.try_look = 1

  const query = await signWbi(
    params,
    mixinKey(imgKey, subKey),
    (text) => deps.md5(text),
    Math.floor(nowOf(deps) / 1000)
  )
  return `${API_BASE}/x/player/wbi/playurl?${query}`
}

function parseDashStreams(value: unknown): DashStream[] {
  const streams: DashStream[] = []
  for (const raw of asArray(value)) {
    const stream = asRecord(raw)
    if (!stream) continue
    const url = asString(stream.baseUrl) ?? asString(stream.base_url)
    if (!url) continue
    const backups = asArray(stream.backupUrl ?? stream.backup_url)
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item))
    streams.push({
      id: asNumber(stream.id) ?? 0,
      url,
      backupUrls: backups,
      bandwidth: asNumber(stream.bandwidth),
      codecid: asNumber(stream.codecid),
      mimeType: asString(stream.mimeType) ?? asString(stream.mime_type),
      width: asNumber(stream.width),
      height: asNumber(stream.height),
    })
  }
  return streams
}

function parsePlayInfo(data: JsonRecord): PlayInfo {
  const durl: DurlSegment[] = []
  for (const raw of asArray(data.durl)) {
    const segment = asRecord(raw)
    if (!segment) continue
    const url = asString(segment.url)
    if (!url) continue
    const backups = asArray(segment.backup_url ?? segment.backupUrl)
      .map((item) => asString(item))
      .filter((item): item is string => Boolean(item))
    durl.push({
      url,
      backupUrls: backups,
      size: asNumber(segment.size),
      length: asNumber(segment.length),
      order: asNumber(segment.order),
    })
  }

  const dashRecord = asRecord(data.dash)
  const dash: DashInfo | undefined = dashRecord
    ? {
        video: parseDashStreams(dashRecord.video),
        audio: parseDashStreams(dashRecord.audio),
      }
    : undefined

  const supportFormats: Array<{ quality: number; description: string }> = []
  for (const raw of asArray(data.support_formats)) {
    const format = asRecord(raw)
    if (!format) continue
    const quality = asNumber(format.quality)
    if (quality === undefined) continue
    supportFormats.push({
      quality,
      description:
        asString(format.new_description) ??
        asString(format.description) ??
        `Q${quality}`,
    })
  }

  const acceptQuality: number[] = []
  for (const raw of asArray(data.accept_quality)) {
    const quality = asNumber(raw)
    if (quality !== undefined) acceptQuality.push(quality)
  }

  return {
    quality: asNumber(data.quality) ?? 0,
    format: asString(data.format) ?? '',
    durl,
    dash,
    acceptQuality,
    supportFormats,
  }
}

export async function fetchPlayInfo(
  deps: ResolverDeps,
  options: PlayOptions
): Promise<PlayInfo> {
  const id = options.bvid ?? `av${options.aid}`
  const tryLook = options.tryLook ?? !deps.cookie
  const effectiveOptions = { ...options, tryLook }
  const cacheKey = `play:${id}:${options.cid}:${options.qn}:${options.fnval}:${
    deps.cookie ? 'auth' : 'anon'
  }:${tryLook ? 'look' : 'plain'}`
  const now = nowOf(deps)
  const cached = cacheGet(playCache, cacheKey, now)
  if (cached) return cached

  let info: PlayInfo
  try {
    const data = await requestJson(
      deps,
      `${API_BASE}/x/player/playurl?${buildPlayQuery(effectiveOptions)}`,
      apiHeaders(deps)
    )
    info = parsePlayInfo(data)
  } catch (error) {
    if (!(error instanceof BilibiliError) || error.code !== 'api') throw error
    if (error.apiCode === -404) throw error
    deps.log?.debug('bilibili: unsigned playurl rejected, retrying with WBI', {
      apiCode: error.apiCode,
    })
    const data = await requestJson(
      deps,
      await signedPlayurlUrl(deps, effectiveOptions),
      apiHeaders(deps)
    )
    info = parsePlayInfo(data)
  }

  cacheSet(playCache, cacheKey, info, PLAY_TTL_MS, now)
  return info
}

/**
 * Resolve a b23.tv short link. HEAD is enough for Bilibili's redirector and
 * avoids downloading the full landing page.
 */
export async function resolveShortLink(
  deps: ResolverDeps,
  shortUrl: string
): Promise<string> {
  // Never attach the login cookie to a redirector: a compromised or unexpected
  // redirect could forward it to a third-party host. b23.tv does not need it.
  const headers = apiHeaders({ ...deps, cookie: undefined }, shortUrl)
  const response = await requestText(deps, shortUrl, {
    method: 'HEAD',
    headers,
    timeoutMs: 8_000,
    maxBodyBytes: 1024,
    redirect: 'follow',
  })

  if (response.status < 200 || response.status >= 400) {
    throw new BilibiliError(
      'short_link',
      `short link returned HTTP ${response.status}`,
      { status: response.status }
    )
  }

  const finalUrl = response.finalUrl ?? shortUrl
  const target = parseBilibiliUrl(finalUrl)
  if (!target || target.kind !== 'video') {
    throw new BilibiliError(
      'short_link',
      'short link did not resolve to a Bilibili video page'
    )
  }
  return target.pageUrl
}
