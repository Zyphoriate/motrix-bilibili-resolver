import { describe, expect, it } from 'vitest'
import manifest from '../motrix-plugin.json'

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

  it('uses the same five quality choices for inspection, resolve and settings', () => {
    const qualities = ['2160p', '1440p', '1080p', '720p', '480p']
    const inspect = manifest.contributes.commands.find((command) => command.id.endsWith('.inspectMedia'))
    const resolve = manifest.contributes.commands.find((command) => command.id.endsWith('.resolve'))
    expect(inspect?.resultSchema.properties.qualities.items.enum).toEqual(qualities)
    expect(resolve?.argsSchema.properties.quality.enum).toEqual(qualities)
    expect(manifest.contributes.configuration.schema.properties.preferredQuality.enum).toEqual(qualities)
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
