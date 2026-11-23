import { describe, expect, it } from 'vitest'
import {
  isQuality,
  qualityCandidates,
  qualityLabel,
  qualityToQn,
} from '../src/bilibili/quality'

describe('quality mapping', () => {
  it('maps user-facing qualities to API qn values', () => {
    expect(qualityToQn('2160p')).toBe(120)
    expect(qualityToQn('1440p')).toBe(120)
    expect(qualityToQn('1080p')).toBe(80)
    expect(qualityToQn('720p')).toBe(64)
    expect(qualityToQn('480p')).toBe(32)
  })

  it('builds a descending, deduplicated fallback list', () => {
    expect(qualityCandidates('2160p')).toEqual([120, 116, 112, 80, 64, 32, 16])
    expect(qualityCandidates('1440p')).toEqual([116, 112, 80, 64, 32, 16])
    expect(qualityCandidates('1080p')).toEqual([80, 64, 32, 16])
    expect(qualityCandidates('720p')).toEqual([64, 32, 16])
    expect(qualityCandidates('480p')).toEqual([32, 16])
  })

  it('labels known and unknown qn values', () => {
    expect(qualityLabel(80)).toBe('1080P')
    expect(qualityLabel(64)).toBe('720P')
    expect(qualityLabel(999)).toBe('Q999')
  })

  it('validates quality config input', () => {
    expect(isQuality('2160p')).toBe(true)
    expect(isQuality('1440p')).toBe(true)
    expect(isQuality('1080p')).toBe(true)
    expect(isQuality('toString')).toBe(false)
    expect(isQuality('4k')).toBe(false)
    expect(isQuality(undefined)).toBe(false)
  })
})
