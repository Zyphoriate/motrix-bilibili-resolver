import { describe, expect, it } from 'vitest'
import manifest from '../motrix-plugin.json'
import en from '../locales/en-US.json'
import zh from '../locales/zh-CN.json'

describe('plugin manifest', () => {
  it('declares the permission required for persisted title metadata', () => {
    expect(manifest.permissions).toEqual(['http', 'metadata'])
    expect(manifest.permissions).not.toContain('fs.task.write')
    expect(manifest.optionalPermissions).toBeUndefined()
  })

  it('registers a site-resolver beforeCreate hook', () => {
    expect(manifest.categories).toContain('site-resolver')
    expect(manifest.contributes.hooks.beforeCreate.role).toBe('resolve')
    expect(manifest.contributes.hooks.beforeFinalize.role).toBe('post-process')
  })

  it('exposes the official-style public resolve command and a private cache command', () => {
    expect(manifest.contributes.commands).toHaveLength(3)
    const inspect = manifest.contributes.commands.find((command) => command.id.endsWith('.inspectMedia'))
    expect(inspect?.public).toBe(true)
    expect(inspect?.argsSchema.required).toEqual(['url'])
    expect(manifest.categories).toContain('post-action')
    const resolve = manifest.contributes.commands.find((command) =>
      command.id.endsWith('.resolve')
    )
    const flush = manifest.contributes.commands.find((command) =>
      command.id.endsWith('.flushCache')
    )
    expect(resolve?.public).toBe(true)
    expect(resolve?.argsSchema.properties.url.type).toBe('string')
    expect(resolve?.argsSchema.properties.cookies.type).toBe('string')
    expect(resolve?.resultSchema.properties.kind.enum).toEqual([
      'direct',
      'mux',
    ])
    expect(flush?.public).toBe(false)
  })

  it('keeps protocol concrete while exposing Highest and the single-part toggle in plugin settings', () => {
    const qualities = ['2160p', '1440p', '1080p', '720p', '480p']
    const inspect = manifest.contributes.commands.find((command) => command.id.endsWith('.inspectMedia'))
    const resolve = manifest.contributes.commands.find((command) => command.id.endsWith('.resolve'))
    expect(inspect?.resultSchema.properties.qualities.items.enum).toEqual(qualities)
    expect(resolve?.argsSchema.properties.quality.enum).toEqual(qualities)
    expect(inspect?.resultSchema.properties.defaultQuality.enum).toEqual(qualities)
    const settings = manifest.contributes.configuration.schema.properties
    expect(settings.preferredQuality.enum).toEqual(['highest', ...qualities])
    expect(settings.preferredQuality.default).toBe('highest')
    expect(Object.keys(settings.preferredQuality.enumLabels)).toHaveLength(6)
    expect(settings.preferredQuality.enumLabels.highest).toBe('%settings.quality.highest%')
    expect(zh['settings.quality.highest']).toBe('最高')
    expect(en['settings.quality.highest']).toBe('Highest')
    expect(settings.showSinglePartDialog).toMatchObject({ type: 'boolean', default: false })
    expect(zh['settings.showSinglePartDialog.title']).toContain('单 P')
    expect(en['settings.showSinglePartDialog.title']).toContain('single-part')
    expect(manifest.id).toBe('community.bilibili-resolver')
    expect(manifest.version).toBe('1.3.6')
  })

  it('can be selected for bilibili.com and b23.tv task URLs', () => {
    expect(
      manifest.hostPermissions.some((pattern) =>
        pattern.includes('*.bilibili.com')
      )
    ).toBe(true)
    expect(
      manifest.hostPermissions.some((pattern) => pattern.includes('b23.tv'))
    ).toBe(true)
  })
})
