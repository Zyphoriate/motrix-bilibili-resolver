import {
  fetchPlayInfo,
  fetchVideoInfo,
  mediaHeaders,
  resolveShortLink,
  type DashStream,
  type PlayInfo,
  type VideoInfo,
  type VideoPage,
} from './api'
import {
  qualityCandidates,
  qualityLabel,
  qualityToQn,
} from './quality'
import {
  BilibiliError,
  isAbortError,
  type ResolverDeps,
  type Quality,
} from './types'
import { hostOf, parseBilibiliUrl, type VideoTarget } from './url'

export interface CommonResolution {
  /** Human-readable title stem, without the file extension. */
  title: string
  filename: string
  quality: number
  qualityLabel: string
  page: number
  pagePart: string
  bvid: string
  aid: number
  cid: number
  meta: Record<string, string | number>
}

export interface DirectResolution extends CommonResolution {
  kind: 'direct'
  url: string
  /** CDN mirrors; the hook offers them to Aria2 as fallback URIs. */
  altUrls: string[]
  headers: Record<string, string>
  format: string
}

export interface MuxResolution extends CommonResolution {
  kind: 'mux'
  video: { url: string; altUrls: string[]; headers: Record<string, string> }
  audio: { url: string; altUrls: string[]; headers: Record<string, string> }
  container: 'mp4'
}

export type Resolution = DirectResolution | MuxResolution

export type CommandResult =
  | {
      kind: 'direct'
      directUrl: string
      headers: Record<string, string>
      title?: string
    }
  | {
      kind: 'mux'
      video: { url: string; headers: Record<string, string> }
      audio: { url: string; headers: Record<string, string> }
      container: 'mp4' | 'mkv'
      title?: string
    }

export interface ResolveOptions {
  /**
   * The beforeCreate hook can only rewrite URIs, so it keeps `allowMux` false
   * and fails open when a video is DASH-only. The public resolve command allows
   * mux so a host with a mux seam can consume it.
   */
  allowMux?: boolean
  /**
   * When true, try a DASH video/audio pair if the progressive MP4 cannot reach
   * the preferred quality. Motrix's mux seam only consumes `kind: "mux"`, so
   * this is what unlocks 1080P without a login cookie (via `try_look=1`).
   */
  preferMux?: boolean
  /**
   * Always return a DASH mux pair for hosts that consume the public command.
   * This does not enable muxing on Web/NAS task paths without that host seam.
   */
  forceMux?: boolean
}

const MAX_FILENAME_CHARS = 180
// Keep the stem comfortably below common 255-byte filename limits even for
// CJK titles (3 bytes per character) and emoji (4 bytes per code point).
const MAX_FILENAME_BYTES = 200

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4
  }
  return bytes
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0
  let result = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    const size =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4
    if (bytes + size > maxBytes) break
    bytes += size
    result += character
  }
  return result
}

export function sanitizeFilename(name: string, maxChars = MAX_FILENAME_CHARS): string {
  let value = name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  value = value.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')

  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(value)) {
    value = `_${value}`
  }

  const characters = Array.from(value)
  if (characters.length > maxChars) {
    value = characters.slice(0, maxChars).join('')
  }
  if (utf8ByteLength(value) > MAX_FILENAME_BYTES) {
    value = truncateUtf8(value, MAX_FILENAME_BYTES)
  }
  value = value.replace(/[.\s]+$/, '')

  return value || 'bilibili-video'
}

export function buildDisplayTitle(
  info: VideoInfo,
  page: VideoPage
): string {
  const title = sanitizeFilename(info.title)
  if (info.pages.length <= 1) return title

  const part = truncateUtf8(sanitizeFilename(page.part), 96)
  const suffix =
    part && part !== title ? `P${page.page} ${part}` : `P${page.page}`
  // Reserve space for the part suffix so long titles do not make P1 and P2
  // indistinguishable after the final filesystem-safe truncation.
  const separator = ' - '
  const titleBudget = MAX_FILENAME_BYTES - utf8ByteLength(separator + suffix)
  const titleChars = Math.max(1, MAX_FILENAME_CHARS - Array.from(separator + suffix).length)
  const stem = truncateUtf8(Array.from(title).slice(0, titleChars).join(''), titleBudget)
  return sanitizeFilename(`${stem}${separator}${suffix}`)
}

export function pickPage(info: VideoInfo, requested: number): VideoPage {
  return (
    info.pages.find((page) => page.page === requested) ??
    info.pages[requested - 1] ??
    info.pages[0]!
  )
}

function describePlayQuality(play: PlayInfo): string {
  const match = play.supportFormats.find(
    (format) => format.quality === play.quality
  )
  return match?.description ?? qualityLabel(play.quality)
}

/**
 * Bilibili's DASH primary URLs are often third-party PCDN hosts
 * (`*.mcdn.bilivideo.cn`, `*.edge.*`) that can be unreachable or slow. The
 * `upos-*.bilivideo.com` mirrors are the stable origin CDN and are present in
 * `backupUrl`. Prefer a stable mirror as the primary URL when possible.
 */
const STABLE_MEDIA_HOST_RE = /^upos-[a-z0-9-]+\.bilivideo\.com$/i

function isStableMediaHost(url: string): boolean {
  return STABLE_MEDIA_HOST_RE.test(hostOf(url))
}

function preferStableMediaUrl(stream: DashStream): DashStream {
  if (isStableMediaHost(stream.url)) return stream
  const stable = stream.backupUrls.find((url) => isStableMediaHost(url))
  if (!stable) return stream
  return {
    ...stream,
    url: stable,
    backupUrls: [
      stream.url,
      ...stream.backupUrls.filter((url) => url !== stable),
    ],
  }
}

const HTTP_MEDIA_URL_RE = /^https?:\/\/[^/?#@\\\s]+(?:[/?#]|$)/i

export function isValidMediaUrl(url: string): boolean {
  return (
    HTTP_MEDIA_URL_RE.test(url) &&
    !/[\\\s\u0000-\u001f\u007f]/.test(url) &&
    !/%(?![0-9a-f]{2})/i.test(url)
  )
}

/**
 * Keep only absolute http(s) URLs. The host re-validates every staged URI with
 * `z.string().url()` after the hook returns; a malformed backup URL would make
 * that validation fail and roll the whole hook back, so filter here.
 */
function dedupeUrls(urls: ReadonlyArray<string>): string[] {
  const unique: string[] = []
  for (const url of urls) {
    if (
      typeof url === 'string' &&
      url.length > 0 &&
      isValidMediaUrl(url) &&
      !unique.includes(url)
    ) {
      unique.push(url)
    }
  }
  return unique
}

function streamResolution(stream: DashStream): number {
  if (Number.isFinite(stream.width) && Number.isFinite(stream.height) &&
      (stream.width ?? 0) > 0 && (stream.height ?? 0) > 0) {
    return Math.min(stream.width!, stream.height!)
  }
  // Only infer dimensions for known QNs; future QNs need actual dimensions.
  const known: Record<number, number> = {
    127: 4320, 126: 2160, 125: 2160, 120: 2160,
    116: 1080, 112: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360, 6: 240,
  }
  return known[stream.id] ?? 0
}

function pickDashVideo(
  streams: ReadonlyArray<DashStream>,
  quality: Quality
): DashStream | null {
  const ceiling = Number.parseInt(quality, 10)
  const pool = streams.filter((stream) =>
    isValidMediaUrl(stream.url) && (quality === 'highest' ||
      (stream.id <= qualityToQn(quality) && streamResolution(stream) <= ceiling))
  )
  // Prefer resolution before codec: a lower-resolution AVC must not hide 4K
  // HEVC/AV1. Ties: QN, AVC compatibility, bandwidth, then URL for stability.
  pool.sort((a, b) =>
    streamResolution(b) - streamResolution(a) || b.id - a.id ||
    Number(b.codecid === 7) - Number(a.codecid === 7) ||
    (b.bandwidth ?? 0) - (a.bandwidth ?? 0) || a.url.localeCompare(b.url)
  )
  return pool[0] ?? null
}

function pickDashAudio(streams: ReadonlyArray<DashStream>): DashStream | null {
  const playable = streams
    .filter((stream) => isValidMediaUrl(stream.url))
    .sort(
      (a, b) =>
        b.id - a.id || (b.bandwidth ?? 0) - (a.bandwidth ?? 0)
    )
  return playable[0] ?? null
}

async function resolveTarget(
  input: string,
  deps: ResolverDeps
): Promise<VideoTarget> {
  let target = parseBilibiliUrl(input)
  if (!target) {
    throw new BilibiliError('not_bilibili', 'not a Bilibili video URL')
  }
  if (target.kind === 'short') {
    const finalUrl = await resolveShortLink(deps, target.shortUrl)
    target = parseBilibiliUrl(finalUrl)
    if (!target || target.kind !== 'video') {
      throw new BilibiliError(
        'short_link',
        'short link did not resolve to a Bilibili video page'
      )
    }
  }
  return target
}

function baseMeta(
  info: VideoInfo,
  page: VideoPage,
  title: string,
  sourceUrl: string
): Record<string, string | number> {
  return {
    bvid: info.bvid,
    aid: info.aid,
    cid: page.cid,
    videoTitle: info.title,
    title,
    page: page.page,
    part: page.part,
    sourceUrl,
  }
}

interface DirectAttempt {
  result: DirectResolution | null
  lastError: unknown
}

async function tryDirect(
  info: VideoInfo,
  page: VideoPage,
  deps: ResolverDeps,
  title: string,
  filename: string,
  headers: Record<string, string>,
  meta: Record<string, string | number>
): Promise<DirectAttempt> {
  let lastError: unknown

  for (const qn of qualityCandidates(deps.quality)) {
    try {
      const play = await fetchPlayInfo(deps, {
        bvid: info.bvid,
        aid: info.aid,
        cid: page.cid,
        qn,
        fnval: 1,
      })

      if (play.durl.length === 1) {
        const segment = play.durl[0]!
        const quality = play.quality > 0 ? play.quality : qn
        const allUrls = dedupeUrls([segment.url, ...segment.backupUrls])
        const primary =
          allUrls.find((url) => isStableMediaHost(url)) ?? allUrls[0]
        if (!primary) {
          lastError = new BilibiliError(
            'invalid_response',
            'playurl returned no absolute http(s) media URL'
          )
          continue
        }
        return {
          result: {
            kind: 'direct',
            url: primary,
            altUrls: allUrls.filter((url) => url !== primary),
            headers,
            format: play.format || 'mp4',
            quality,
            qualityLabel: describePlayQuality(play),
            title,
            filename,
            page: page.page,
            pagePart: page.part,
            bvid: info.bvid,
            aid: info.aid,
            cid: page.cid,
            meta: {
              ...meta,
              quality,
              qualityLabel: describePlayQuality(play),
              format: play.format || 'mp4',
            },
          },
          lastError: null,
        }
      }

      if (play.durl.length > 1) {
        deps.log?.warn(
          'bilibili: video is split into multiple MP4 segments; trying a lower quality',
          { qn, segments: play.durl.length }
        )
      }
      lastError = new BilibiliError(
        'no_stream',
        `no single-file MP4 stream at qn ${qn}`
      )
    } catch (error) {
      if (isAbortError(error)) throw error
      lastError = error
      deps.log?.debug('bilibili: playurl attempt failed', {
        qn,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { result: null, lastError }
}

async function tryMux(
  info: VideoInfo,
  page: VideoPage,
  deps: ResolverDeps,
  title: string,
  filename: string,
  headers: Record<string, string>,
  meta: Record<string, string | number>
): Promise<MuxResolution | null> {
  const play = await fetchPlayInfo(deps, {
    bvid: info.bvid,
    aid: info.aid,
    cid: page.cid,
    qn: qualityToQn(deps.quality),
    fnval: 4048,
  })

  const pickedVideo = pickDashVideo(
    play.dash?.video ?? [],
    deps.quality
  )
  const pickedAudio = pickDashAudio(play.dash?.audio ?? [])
  if (!pickedVideo || !pickedAudio) return null
  const video = preferStableMediaUrl(pickedVideo)
  const audio = preferStableMediaUrl(pickedAudio)
  if (!isValidMediaUrl(video.url) || !isValidMediaUrl(audio.url)) return null

  const quality = video.id
  const label = streamResolution(video) > 1080 && streamResolution(video) <= 1440
    ? '1440P' : qualityLabel(quality)
  return {
    kind: 'mux',
    video: {
      url: video.url,
      altUrls: dedupeUrls(video.backupUrls).filter(
        (url) => url !== video.url
      ),
      headers,
    },
    audio: {
      url: audio.url,
      altUrls: dedupeUrls(audio.backupUrls).filter(
        (url) => url !== audio.url
      ),
      headers,
    },
    container: 'mp4',
    quality,
    qualityLabel: label,
    title,
    filename,
    page: page.page,
    pagePart: page.part,
    bvid: info.bvid,
    aid: info.aid,
    cid: page.cid,
    meta: {
      ...meta,
      quality,
      qualityLabel: label,
      format: 'dash',
    },
  }
}

/**
 * Resolve a Bilibili page URL into a downloadable result.
 *
 * Preference order:
 *   1. A single-file MP4 (`durl`), at the best quality available.
 *   2. A DASH video/audio pair when `allowMux` is set and either the MP4 is
 *      missing or `preferMux` asks for a higher quality than the MP4 provides.
 */
/** Inspect page metadata only; never request expiring media URLs here. */
export async function inspectBilibili(
  input: string,
  deps: ResolverDeps
): Promise<import('motrix:plugin-api').MediaCollection> {
  const target = await resolveTarget(input, deps)
  const info = await fetchVideoInfo(deps, target)
  if (!/^BV[0-9A-Za-z]{10}$/.test(info.bvid)) {
    throw new BilibiliError('invalid_response', 'invalid canonical video identifier')
  }
  if (info.pages.length > 500) {
    throw new BilibiliError('invalid_response', 'media collection exceeds 500 entries')
  }
  const ids = new Set<number>()
  const parts = new Set<number>()
  const entries = info.pages.map((page) => {
    if (!Number.isSafeInteger(page.cid) || page.cid <= 0 || ids.has(page.cid) ||
        !Number.isSafeInteger(page.page) || page.page <= 0 || parts.has(page.page)) {
      throw new BilibiliError('invalid_response', 'invalid or duplicate media page identifier')
    }
    ids.add(page.cid)
    parts.add(page.page)
    return {
      id: String(page.cid),
      title: `P${page.page} ${page.part || info.title}`.slice(0, 512),
      url: `https://www.bilibili.com/video/${info.bvid || `av${info.aid}`}/?p=${page.page}`,
      partNumber: page.page,
      ...(Number.isFinite(page.duration) && page.duration >= 0 && page.duration <= Number.MAX_SAFE_INTEGER
        ? { durationSeconds: page.duration } : {}),
    }
  })
  return {
    schemaVersion: 1,
    title: (info.title.trim() || info.bvid || `av${info.aid}`).slice(0, 512),
    entries,
    qualities: ['highest', '2160p', '1440p', '1080p', '720p', '480p'],
    defaultQuality: deps.quality,
  }
}

export async function resolveBilibili(
  input: string,
  deps: ResolverDeps,
  options: ResolveOptions = {}
): Promise<Resolution> {
  const target = await resolveTarget(input, deps)
  const info = await fetchVideoInfo(deps, target)
  const page = pickPage(info, target.page)
  const title = buildDisplayTitle(info, page)
  const filenameStem = sanitizeFilename(
    title.replace(/\.(mp4|flv|mkv|webm|m4s)$/i, '')
  )
  const filename = `${filenameStem}.mp4`
  const headers = mediaHeaders(target.pageUrl)
  const meta = baseMeta(info, page, title, target.pageUrl)

  if (options.forceMux) {
    const mux = await tryMux(
      info,
      page,
      deps,
      title,
      filename,
      headers,
      meta
    )
    if (mux) return mux
    throw new BilibiliError(
      'no_stream',
      'no DASH video/audio pair available for the mux seam'
    )
  }

  const direct = await tryDirect(
    info,
    page,
    deps,
    title,
    filename,
    headers,
    meta
  )

  const preferredQn = qualityToQn(deps.quality)
  const directMeetsPreferred =
    deps.quality !== 'highest' && direct.result !== null && direct.result.quality >= preferredQn

  if (direct.result && (!options.preferMux || directMeetsPreferred)) {
    return direct.result
  }

  if (options.allowMux) {
    try {
      const mux = await tryMux(
        info,
        page,
        deps,
        title,
        filename,
        headers,
        meta
      )
      if (mux) {
        // Concrete qualities keep the existing direct-vs-mux QN comparison.
        // Highest must inspect DASH: progressive QN cannot prove a resolution
        // ceiling, and future DASH resolutions may use unrelated QNs.
        if (
          deps.quality !== 'highest' && direct.result &&
          mux.quality <= direct.result.quality
        ) {
          return direct.result
        }
        return mux
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      if (direct.result) {
        deps.log?.warn('bilibili: mux attempt failed; using direct MP4', {
          error: error instanceof Error ? error.message : String(error),
        })
        return direct.result
      }
      throw error
    }
  }

  if (direct.result) return direct.result

  if (direct.lastError instanceof BilibiliError) {
    if (direct.lastError.code === 'no_stream') {
      throw new BilibiliError(
        'dash_only',
        'only DASH streams are available; the hook cannot mux, so the original URL is kept'
      )
    }
    throw direct.lastError
  }
  throw new BilibiliError('no_stream', 'no downloadable stream found')
}

export function toCommandResult(result: Resolution): CommandResult {
  if (result.kind === 'direct') {
    return {
      kind: 'direct',
      directUrl: result.url,
      headers: result.headers,
      title: result.title,
    }
  }
  return {
    kind: 'mux',
    video: { url: result.video.url, headers: result.video.headers },
    audio: { url: result.audio.url, headers: result.audio.headers },
    container: result.container,
    title: result.title,
  }
}
