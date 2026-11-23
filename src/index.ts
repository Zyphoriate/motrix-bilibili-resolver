import {
  commands,
  config,
  crypto,
  hooks,
  http,
  lifecycle,
  log,
  type BeforeCreateHttpContext,
  type BeforeFinalizeContext,
  type PluginMetadata,
  type JsonValue,
} from 'motrix:plugin-api'
import { clearApiCache } from './bilibili/api'
import { isQuality } from './bilibili/quality'
import {
  inspectBilibili,
  resolveBilibili,
  sanitizeFilename,
  toCommandResult,
  type Resolution,
} from './bilibili/resolve'
import {
  isAbortError,
  BilibiliError,
  type HttpRequestOptions,
  type HttpResponse,
  type Quality,
  type ResolverDeps,
} from './bilibili/types'
import { hostOf, isBilibiliUrl } from './bilibili/url'

const DEFAULT_QUALITY: Quality = '720p'
const PLUGIN_ID = 'community.bilibili-resolver'

// Diagnostic: proves the bundle was evaluated even if no hook is ever called.
try {
  log.info('bilibili: bundle evaluated')
} catch {
  // Never let a diagnostic log break module evaluation.
}

interface Settings {
  enabled: boolean
  preferredQuality: Quality
  cookie: string
}

interface ResolveArgs {
  url: string
  quality?: Quality
  /** Cookie header forwarded by the host's extension submit path. */
  cookies?: string
}


async function readSettings(): Promise<Settings> {
  const [enabled, quality, cookie] = await Promise.all([
    config.get<boolean>('enabled'),
    config.get<string>('preferredQuality'),
    config.get<string>('cookie'),
  ])

  return {
    enabled: enabled !== false,
    preferredQuality: isQuality(quality) ? quality : DEFAULT_QUALITY,
    cookie: typeof cookie === 'string' ? cookie : '',
  }
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

function createDeps(
  settings: Settings,
  signal?: AbortSignal
): ResolverDeps {
  return {
    quality: settings.preferredQuality,
    cookie: settings.cookie || undefined,
    signal,
    request: async (
      url: string,
      init?: HttpRequestOptions
    ): Promise<HttpResponse> => {
      const response = await http.request({
        method: init?.method ?? 'GET',
        url,
        headers: init?.headers
          ? Object.entries(init.headers).map(([name, value]) => ({
              name,
              value,
            }))
          : undefined,
        responseType: 'text',
        timeoutMs: init?.timeoutMs ?? 10_000,
        ...(init?.maxBodyBytes !== undefined
          ? { maxBodyBytes: init.maxBodyBytes }
          : {}),
        ...(init?.redirect !== undefined ? { redirect: init.redirect } : {}),
        signal: init?.signal ?? signal,
      })

      return {
        status: response.status,
        headers: response.headers,
        body: response.body as string,
        finalUrl: response.finalUrl,
      }
    },
    md5: async (text: string) => toHex(await crypto.hash('md5', text)),
    now: () => Date.now(),
    // Bursts of links trigger Bilibili's risk control; space API calls out and
    // retry transient 412/429/5xx responses with backoff.
    minRequestGapMs: 250,
    retryDelaysMs: [600, 1500],
    log: {
      debug: (message, fields) => log.debug(message, fields),
      info: (message, fields) => log.info(message, fields),
      warn: (message, fields) => log.warn(message, fields),
    },
  }
}

function mergeHeaders(
  current: ReadonlyArray<{ name: string; value: string }>,
  additions: Record<string, string>
): Array<{ name: string; value: string }> {
  const additionsByLowerName = new Map(
    Object.entries(additions).map(([name, value]) => [
      name.toLowerCase(),
      { name, value },
    ])
  )

  const merged: Array<{ name: string; value: string }> = []
  for (const header of current) {
    if (additionsByLowerName.has(header.name.toLowerCase())) continue
    merged.push({ name: header.name, value: header.value })
  }
  for (const header of additionsByLowerName.values()) merged.push(header)
  return merged
}

function errorSummary(error: unknown): { code: string; message: string } {
  if (error instanceof BilibiliError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof Error) {
    return { code: 'unknown', message: error.message }
  }
  return { code: 'unknown', message: String(error) }
}

function parseResolveArgs(raw: JsonValue): ResolveArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('invalid arguments: expected an object')
  }
  const record = raw as Record<string, JsonValue>
  const url = record.url
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error('invalid arguments: "url" must be a non-empty string')
  }
  const quality = record.quality
  if (quality !== undefined && !isQuality(quality)) {
    throw new Error('invalid arguments: unsupported quality')
  }
  const cookies = record.cookies
  if (cookies !== undefined && typeof cookies !== 'string') {
    throw new Error('invalid arguments: "cookies" must be a string')
  }
  if (typeof cookies === 'string' && cookies.length > 8192) {
    throw new Error('invalid arguments: "cookies" is too large')
  }
  return {
    url: url.trim(),
    quality: quality as Quality | undefined,
    cookies: typeof cookies === 'string' ? cookies : undefined,
  }
}

async function resolveForCommand(
  url: string,
  quality: Quality,
  cookies?: string
): Promise<Resolution> {
  const settings = await readSettings()
  const cookie =
    typeof cookies === 'string' && cookies.trim().length > 0
      ? cookies.trim()
      : settings.cookie
  // Hosts with a mux seam consume DASH pairs from this public command.
  // Motrix 2.4.5 Web/NAS task creation only invokes beforeCreate; changing
  // this command cannot enable muxing on that entry point.
  return resolveBilibili(
    url,
    createDeps({ ...settings, preferredQuality: quality, cookie }),
    { allowMux: true, preferMux: true, forceMux: true }
  )
}

async function runBeforeCreate(
  ctx: BeforeCreateHttpContext
): Promise<BeforeCreateHttpContext> {
  if (ctx.type !== 'http') return ctx
  log.info('bilibili: beforeCreate hook invoked')

  const requestedUrl = ctx.uris[0]
  if (!requestedUrl) {
    log.info('bilibili: hook received no URL')
    return ctx
  }

  let matched = false
  try {
    matched = isBilibiliUrl(requestedUrl)
  } catch (error) {
    log.warn('bilibili: URL recognition threw', {
      message: errorSummary(error).message,
    })
    return ctx
  }
  if (!matched) {
    // JSON.stringify exposes zero-width/invisible characters that a copied
    // link may carry but a normal log line hides.
    log.info('bilibili: URL not recognized', {
      url: JSON.stringify(requestedUrl),
      length: requestedUrl.length,
      host: hostOf(requestedUrl),
    })
    return ctx
  }
  log.info('bilibili: beforeCreate matched a Bilibili URL', {
    host: hostOf(requestedUrl),
  })

  let settings: Settings
  try {
    settings = await readSettings()
  } catch (error) {
    const summary = errorSummary(error)
    log.warn('bilibili: could not read settings', {
      code: summary.code,
      message: summary.message,
    })
    return ctx
  }
  if (!settings.enabled) {
    log.info('bilibili: resolver is disabled in plugin settings')
    return ctx
  }

  try {
    const result = await resolveBilibili(
      requestedUrl,
      createDeps(settings, ctx.signal),
      { allowMux: false }
    )

    if (result.kind !== 'direct') {
      log.warn('bilibili: host mux seam unavailable in beforeCreate', {
        kind: result.kind,
      })
      return ctx
    }

    ctx.update({
      uris: [result.url, ...result.altUrls],
      headers: mergeHeaders(ctx.headers, result.headers),
    })
    // Motrix 2.4.5 ignores beforeCreate.filename when choosing the task's
    // final name. Persist the title and select it during beforeFinalize,
    // where the host sanitizes, deduplicates, and publishes the actual file.
    ;(ctx.metadata as PluginMetadata).set('filename', result.filename)
    log.info('bilibili: resolved video link', {
      bvid: result.bvid,
      cid: result.cid,
      page: result.page,
      quality: result.quality,
      qualityLabel: result.qualityLabel,
      format: result.format,
      filename: result.filename,
      mirrors: result.altUrls.length,
    })
  } catch (error) {
    if (isAbortError(error)) {
      log.debug('bilibili: resolution aborted')
      return ctx
    }
    const summary = errorSummary(error)
    log.warn('bilibili: resolution failed; keeping the original URL', {
      code: summary.code,
      message: summary.message,
    })
  }

  return ctx
}

async function runBeforeFinalize(
  ctx: BeforeFinalizeContext
): Promise<BeforeFinalizeContext> {
  if (ctx.task.type !== 'http') return ctx
  const filename = ctx.metadata.get<string>('filename')
  if (typeof filename !== 'string' || !filename) return ctx
  const safeName = `${sanitizeFilename(filename.replace(/\.mp4$/i, ''))}.mp4`
  // A relative basename is resolved inside task.saveDir by the host. Let the
  // host's final publisher handle collisions and the actual filesystem rename.
  ctx.update({ filePath: safeName })
  log.info('bilibili: final filename selected', { filename: safeName })
  return ctx
}

function safeWarn(
  message: string,
  fields?: Record<string, unknown>
): void {
  try {
    log.warn(message, fields)
  } catch {
    // Logging must never make module evaluation fail.
  }
}

try {
  log.info('bilibili: registering beforeCreate hook')
  hooks.beforeCreate(async (ctx) => {
    try {
      return await runBeforeCreate(ctx)
    } catch (error) {
      // Never throw out of a hook: Motrix disables a plugin after consecutive
      // hook failures (circuit breaker), and a failed hook also rolls back the
      // staged URL rewrite. Any unexpected error must fail open instead.
      const summary = errorSummary(error)
      safeWarn('bilibili: hook failed open', {
        code: summary.code,
        message: summary.message,
      })
      return ctx
    }
  })
  log.info('bilibili: beforeCreate hook registered')
} catch (error) {
  const summary = errorSummary(error)
  safeWarn('bilibili: beforeCreate registration failed', {
    code: summary.code,
    message: summary.message,
  })
}

try {
  hooks.beforeFinalize(async (ctx) => {
    try {
      return await runBeforeFinalize(ctx)
    } catch (error) {
      safeWarn('bilibili: filename selection failed; keeping the host target', {
        message: errorSummary(error).message,
      })
      return ctx
    }
  })
  log.info('bilibili: beforeFinalize hook registered')
} catch (error) {
  safeWarn('bilibili: beforeFinalize registration failed', {
    message: errorSummary(error).message,
  })
}

try {
  log.info('bilibili: registering commands')
  commands.register(`${PLUGIN_ID}.inspectMedia`, async (raw: JsonValue): Promise<JsonValue> => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) ||
        Object.keys(raw).some((key) => key !== 'url') ||
        typeof raw.url !== 'string' || raw.url.length > 8192 ||
        (!/^https?:\/\/[^/?#@\\\s]+(?:[/?#]|$)/i.test(raw.url) || /[\\\s]/.test(raw.url))) {
      throw new Error('invalid arguments: expected {url} with an absolute HTTP(S) URL without credentials')
    }
    const settings = await readSettings()
    if (!settings.enabled || !isBilibiliUrl(raw.url)) return null
    return await inspectBilibili(raw.url, createDeps(settings)) as unknown as JsonValue
  })
  commands.register(
    `${PLUGIN_ID}.resolve`,
    async (raw: JsonValue): Promise<JsonValue> => {
      const args = parseResolveArgs(raw)
      const settings = await readSettings()
      const quality = args.quality ?? settings.preferredQuality
      log.info('bilibili: resolve command invoked', {
        quality,
        hasCookies: Boolean(args.cookies),
      })
      try {
        const result = await resolveForCommand(
          args.url,
          quality,
          args.cookies
        )
        log.info('bilibili: resolve command result', {
          kind: result.kind,
          quality: result.quality,
        })
        return toCommandResult(result) as unknown as JsonValue
      } catch (error) {
        const summary = errorSummary(error)
        safeWarn('bilibili: resolve command failed', {
          code: summary.code,
          message: summary.message,
        })
        throw new Error(`bilibili: ${summary.code}: ${summary.message}`)
      }
    }
  )

  commands.register(`${PLUGIN_ID}.flushCache`, async () => {
    clearApiCache()
    log.debug('bilibili: resolver cache cleared')
  })
  log.info('bilibili: commands registered')
} catch (error) {
  const summary = errorSummary(error)
  safeWarn('bilibili: command registration failed', {
    code: summary.code,
    message: summary.message,
  })
}

try {
  log.info('bilibili: all registrations complete')
} catch {
  // diagnostic only
}

lifecycle.onDeactivate(async () => {
  clearApiCache()
  log.info('bilibili: shutting down resolver')
})
