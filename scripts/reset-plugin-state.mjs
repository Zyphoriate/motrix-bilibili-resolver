#!/usr/bin/env node
/**
 * Reset Motrix's persisted plugin state for community.bilibili-resolver.
 *
 * Motrix persists `enabled`/`status`/`last_error` in the `plugin_state` table
 * of its SQLite database. Its circuit breaker writes `enabled = 0` after three
 * consecutive hook failures; reinstalling or upgrading the same plugin ID does
 * NOT clear that row, so the host never loads the new bundle and the plugin
 * produces no logs.
 *
 * This script resets the row for the original plugin ID (not a new ID), clears
 * the post-hook breaker row if present, and backs up the database first.
 *
 * Usage:
 *   node scripts/reset-plugin-state.mjs            # auto-detect Motrix data dir
 *   node scripts/reset-plugin-state.mjs --inspect  # only print state
 *   node scripts/reset-plugin-state.mjs --db /path/to/motrix.db
 *
 * Quit Motrix before running, then start it again.
 */

import { copyFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const PLUGIN_ID = 'community.bilibili-resolver'

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const inspectOnly = process.argv.includes('--inspect')
const explicitDb = argValue('--db')

function candidateUserDataDirs() {
  const home = os.homedir()
  const platform = process.platform
  const dirs = []

  if (process.env.MOTRIX_USER_DATA) dirs.push(process.env.MOTRIX_USER_DATA)

  if (platform === 'darwin') {
    dirs.push(
      path.join(home, 'Library', 'Application Support', 'Motrix'),
      path.join(home, 'Library', 'Application Support', 'motrix')
    )
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA
    const localAppData = process.env.LOCALAPPDATA
    if (appData) {
      dirs.push(
        path.join(appData, 'Motrix'),
        path.join(appData, 'motrix')
      )
    }
    if (localAppData) {
      dirs.push(path.join(localAppData, 'Motrix'))
    }
  } else {
    const configHome =
      process.env.XDG_CONFIG_HOME || path.join(home, '.config')
    dirs.push(
      path.join(configHome, 'Motrix'),
      path.join(configHome, 'motrix'),
      path.join(home, 'snap', 'motrix', 'current', '.config', 'Motrix'),
      path.join(
        home,
        '.var',
        'app',
        'app.motrix.Motrix',
        'config',
        'Motrix'
      ),
      path.join(
        home,
        '.var',
        'app',
        'com.motrix.Motrix',
        'config',
        'Motrix'
      )
    )
  }

  return [...new Set(dirs)]
}

async function existingDbPath() {
  if (explicitDb) return explicitDb
  const { access } = await import('node:fs/promises')
  const candidates = candidateUserDataDirs().map((dir) =>
    path.join(dir, 'motrix.db')
  )
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

let DatabaseSync
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  console.error(
    'This script needs Node.js with node:sqlite (Node 22.5+).\n' +
      `Current Node: ${process.version}`
  )
  process.exit(1)
}

const dbPath = await existingDbPath()
if (!dbPath) {
  console.error('Could not find Motrix motrix.db. Tried:')
  for (const dir of candidateUserDataDirs()) {
    console.error(`  ${path.join(dir, 'motrix.db')}`)
  }
  console.error(
    '\nPass the path explicitly: node scripts/reset-plugin-state.mjs --db /path/to/motrix.db'
  )
  process.exit(1)
}

console.log(`Motrix database: ${dbPath}`)

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')

const stateTable = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_state'"
  )
  .get()
if (!stateTable) {
  console.error(
    'This database has no plugin_state table. Is it a Motrix 2.x database?'
  )
  db.close()
  process.exit(1)
}

const readState = () =>
  db
    .prepare('SELECT * FROM plugin_state WHERE plugin_id = ?')
    .get(PLUGIN_ID)

const before = readState()
console.log('Before:', before ?? '(no row)')

if (inspectOnly) {
  console.log('Inspect only; nothing changed.')
  db.close()
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupPath = `${dbPath}.bak-${stamp}`
await copyFile(dbPath, backupPath)
console.log(`Backup: ${backupPath}`)
for (const suffix of ['-wal', '-shm']) {
  try {
    await copyFile(`${dbPath}${suffix}`, `${backupPath}${suffix}`)
  } catch {
    // WAL/SHM are optional.
  }
}

db.exec('BEGIN IMMEDIATE')
try {
  if (before) {
    db.prepare(
      `UPDATE plugin_state
          SET enabled = 1,
              status = 'inactive',
              last_error = NULL,
              error_count = 0,
              last_activated_at = NULL
        WHERE plugin_id = ?`
    ).run(PLUGIN_ID)
  } else {
    db.prepare(
      `INSERT INTO plugin_state
         (plugin_id, enabled, status, last_error, error_count, installed_at, last_activated_at)
       VALUES (?, 1, 'inactive', NULL, 0, ?, NULL)`
    ).run(PLUGIN_ID, Date.now())
  }

  const breakerTable = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plugin_post_breakers'"
    )
    .get()
  if (breakerTable) {
    db.prepare('DELETE FROM plugin_post_breakers WHERE plugin_id = ?').run(
      PLUGIN_ID
    )
  }

  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  db.close()
  throw error
}

const after = readState()
console.log('After: ', after ?? '(no row)')
console.log(
  `\nReset ${PLUGIN_ID}. Quit Motrix completely if it is running, then start it again.`
)
db.close()
