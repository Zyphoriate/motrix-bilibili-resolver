/** Pure types shared by the Bilibili resolver modules (no host imports). */

export type Quality = 'highest' | '2160p' | '1440p' | '1080p' | '720p' | '480p'

export type HttpMethod = 'GET' | 'HEAD' | 'POST'

export interface HttpRequestOptions {
  method?: HttpMethod
  headers?: Record<string, string>
  timeoutMs?: number
  maxBodyBytes?: number
  redirect?: 'follow' | 'manual' | 'error'
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  headers?: ReadonlyArray<{ name: string; value: string }>
  body: string
  finalUrl?: string
}

export interface ResolverLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

/**
 * Everything the resolver needs from its environment. The Motrix entry point
 * adapts the host's `http`, `crypto` and `log` capabilities to this shape, so
 * the whole resolver can be unit-tested and exercised live without the app.
 */
export interface ResolverDeps {
  quality: Quality
  /** Raw Cookie request header or a bare SESSDATA value. Never logged. */
  cookie?: string
  signal?: AbortSignal
  request(url: string, init?: HttpRequestOptions): Promise<HttpResponse>
  /** Lower-case hex MD5, used only for WBI request signing. */
  md5(text: string): Promise<string>
  now?(): number
  log?: ResolverLogger
  /** Minimum gap between API requests; 0 disables throttling (tests). */
  minRequestGapMs?: number
  /** Backoff delays for transient HTTP/network failures; empty disables retry. */
  retryDelaysMs?: ReadonlyArray<number>
}

export type BilibiliErrorCode =
  | 'not_bilibili'
  | 'short_link'
  | 'http'
  | 'api'
  | 'invalid_response'
  | 'no_stream'
  | 'dash_only'
  | 'aborted'

export class BilibiliError extends Error {
  readonly code: BilibiliErrorCode
  readonly status?: number
  readonly apiCode?: number

  constructor(
    code: BilibiliErrorCode,
    message: string,
    options: { status?: number; apiCode?: number; cause?: unknown } = {}
  ) {
    super(message)
    this.name = 'BilibiliError'
    this.code = code
    this.status = options.status
    this.apiCode = options.apiCode
    if (options.cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof BilibiliError && error.code === 'aborted') return true
  if (error instanceof Error && error.name === 'AbortError') return true
  return false
}
