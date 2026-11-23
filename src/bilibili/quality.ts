import type { Quality } from './types'

const QN_BY_QUALITY: Record<Quality, number> = {
  '2160p': 120,
  // Bilibili has no 1440p QN. Request the 4K ladder, then cap DASH dimensions.
  '1440p': 120,
  '1080p': 80,
  '720p': 64,
  '480p': 32,
}

const QUALITY_LABELS: Record<number, string> = {
  127: '8K',
  126: 'Dolby Vision',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
  6: '240P',
}

export function isQuality(value: unknown): value is Quality {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(QN_BY_QUALITY, value)
}

export function qualityToQn(quality: Quality): number {
  return QN_BY_QUALITY[quality]
}

/**
 * Qualities the resolver may request, best first. Trying a lower quality is
 * how the hook recovers when the preferred quality is account-only and only
 * DASH would be available.
 */
export function qualityCandidates(quality: Quality): number[] {
  const preferred = qualityToQn(quality)
  // Progressive responses do not carry dimensions to distinguish 2K from 4K.
  const ceiling = quality === '1440p' ? 116 : preferred
  return [120, 116, 112, 80, 64, 32, 16].filter(
    (qn, index, all) => qn <= ceiling && all.indexOf(qn) === index
  )
}

export function qualityLabel(qn: number): string {
  return QUALITY_LABELS[qn] ?? `Q${qn}`
}
