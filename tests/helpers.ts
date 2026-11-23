import type {
  HttpRequestOptions,
  HttpResponse,
  ResolverDeps,
} from '../src/bilibili/types'

export function json(
  payload: unknown,
  init: Partial<HttpResponse> = {}
): HttpResponse {
  return { status: 200, body: JSON.stringify(payload), ...init }
}

export function param(url: string, name: string): string | null {
  try {
    return new URL(url).searchParams.get(name)
  } catch {
    return null
  }
}

export function makeDeps(
  handler: (url: string, init?: HttpRequestOptions) => HttpResponse | Promise<HttpResponse>,
  overrides: Partial<ResolverDeps> = {}
): ResolverDeps {
  return {
    quality: '720p',
    now: () => 1_700_000_000_000,
    md5: async () => 'deadbeef',
    request: handler,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
    },
    ...overrides,
  }
}

export const VIEW_DATA = {
  bvid: 'BV1GJ411x7h7',
  aid: 80433022,
  title: '测试视频',
  duration: 213,
  cid: 111,
  pages: [
    { cid: 111, page: 1, part: '第一集', duration: 100 },
    { cid: 222, page: 2, part: '第二集', duration: 113 },
  ],
}

export const VIEW_PAYLOAD = { code: 0, data: VIEW_DATA }

export function directPlayPayload(
  overrides: Record<string, unknown> = {}
): unknown {
  return {
    code: 0,
    data: {
      quality: 64,
      format: 'mp4720',
      durl: [
        {
          order: 1,
          size: 123,
          url: 'https://cdn.example/v.mp4',
          backup_url: ['https://cdn2.example/v.mp4'],
        },
      ],
      accept_quality: [64, 16],
      support_formats: [
        { quality: 64, new_description: '720P 准高清' },
        { quality: 16, new_description: '360P 流畅' },
      ],
      ...overrides,
    },
  }
}

export const DASH_PAYLOAD = {
  code: 0,
  data: {
    quality: 80,
    format: 'flv720',
    durl: [],
    accept_quality: [112, 80, 64, 32, 16],
    support_formats: [
      { quality: 112, new_description: '1080P 高码率' },
      { quality: 80, new_description: '1080P 高清' },
      { quality: 64, new_description: '720P 准高清' },
    ],
    dash: {
      video: [
        {
          id: 80,
          baseUrl: 'https://cdn.example/v80-hevc.m4s',
          backupUrl: [],
          codecid: 12,
          bandwidth: 1_000_000,
        },
        {
          id: 80,
          baseUrl: 'https://cdn.example/v80-avc.m4s',
          backupUrl: ['https://cdn2.example/v80-avc.m4s'],
          codecid: 7,
          bandwidth: 900_000,
        },
        {
          id: 64,
          baseUrl: 'https://cdn.example/v64.m4s',
          codecid: 7,
          bandwidth: 600_000,
        },
      ],
      audio: [
        {
          id: 30232,
          baseUrl: 'https://cdn.example/a132.m4s',
          bandwidth: 132_000,
        },
        {
          id: 30280,
          baseUrl: 'https://cdn.example/a192.m4s',
          bandwidth: 192_000,
        },
      ],
    },
  },
}
