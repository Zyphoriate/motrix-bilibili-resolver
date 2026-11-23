/**
 * Minimal stand-in for the host-injected `motrix:plugin-api` module.
 * Vitest aliases the virtual specifier to this file so the real entry point can
 * be exercised in Node without Motrix installed.
 */
import { createHash } from 'node:crypto'

type BeforeCreateHandler = (ctx: unknown) => Promise<unknown>
type CommandHandler = (args: unknown) => Promise<unknown>

interface HostRequestOptions {
  method?: string
  url: string
  headers?: ReadonlyArray<{ name: string; value: string }>
  responseType?: 'text' | 'json' | 'bytes'
  timeoutMs?: number
  maxBodyBytes?: number
  redirect?: 'follow' | 'manual' | 'error'
  signal?: AbortSignal
}

interface HostResponse {
  status: number
  headers: Array<{ name: string; value: string }>
  body: string
  finalUrl: string
  redirected: boolean
}

export const hostState = {
  beforeCreate: undefined as BeforeCreateHandler | undefined,
  beforeFinalize: undefined as BeforeCreateHandler | undefined,
  commands: new Map<string, CommandHandler>(),
  config: {} as Record<string, unknown>,
  request: undefined as
    | ((options: HostRequestOptions) => Promise<HostResponse>)
    | undefined,
  deactivate: undefined as (() => Promise<void> | void) | undefined,
  ffmpegAvailable: true,
}

export const hooks = {
  beforeCreate(handler: BeforeCreateHandler): void {
    hostState.beforeCreate = handler
  },
  beforeFinalize(handler: BeforeCreateHandler): void {
    hostState.beforeFinalize = handler
  },
}

export const commands = {
  register(id: string, handler: CommandHandler): { dispose(): void } {
    hostState.commands.set(id, handler)
    return { dispose: () => hostState.commands.delete(id) }
  },
  async execute(id: string, args?: unknown): Promise<unknown> {
    const handler = hostState.commands.get(id)
    if (!handler) throw new Error(`unknown command: ${id}`)
    return handler(args)
  },
}

export const config = {
  available: true,
  async get<T>(key: string): Promise<T | undefined> {
    return hostState.config[key] as T | undefined
  },
  async getRaw<T>(key: string): Promise<T | undefined> {
    return hostState.config[key] as T | undefined
  },
  async getAll(): Promise<Record<string, unknown>> {
    return { ...hostState.config }
  },
  onChange(): () => void {
    return () => {}
  },
}

export const http = {
  available: true,
  async request(options: HostRequestOptions): Promise<HostResponse> {
    if (!hostState.request) throw new Error('hostState.request is not set')
    return hostState.request(options)
  },
  async get(url: string, options: Partial<HostRequestOptions> = {}) {
    return http.request({ ...options, url, method: 'GET' })
  },
  async post(url: string, _body: unknown, options: Partial<HostRequestOptions> = {}) {
    return http.request({ ...options, url, method: 'POST' })
  },
}

export const crypto = {
  available: true,
  async hash(algo: 'md5' | 'sha1' | 'sha256' | 'sha512', data: Uint8Array | string) {
    return new Uint8Array(createHash(algo).update(data).digest())
  },
  async hmac(): Promise<Uint8Array> {
    throw new Error('not implemented in mock')
  },
  randomBytes(size: number): Uint8Array {
    return new Uint8Array(size)
  },
  async aes(): Promise<Uint8Array> {
    throw new Error('not implemented in mock')
  },
}

export const log = {
  trace(): void {},
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
  fatal(): void {},
}

export const lifecycle = {
  available: true,
  onDeactivate(handler: () => Promise<void> | void): { dispose(): void } {
    hostState.deactivate = handler
    return { dispose: () => (hostState.deactivate = undefined) }
  },
  onActivate(): { dispose(): void } {
    return { dispose: () => {} }
  },
}

export const ffmpeg = {
  get available(): boolean {
    return hostState.ffmpegAvailable
  },
  version: '6.0.0',
  async probe(): Promise<unknown> {
    return {}
  },
}

export const app = {
  available: true,
  version: '2.0.0',
  platform: 'linux',
  runtime: 'electron',
  locale: 'zh-CN',
  arch: 'x64',
}

export const i18n = {
  language: 'zh-CN',
  dir: 'ltr',
  t(key: string): string {
    return key
  },
  on(): () => void {
    return () => {}
  },
}
