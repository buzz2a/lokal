// The user's Shazams without Apple Music (see shazam.js), from two places:
//   - the data export of shazam.com/privacy ("Download your data"): a zip
//     with SyncedShazams.csv, or the CSV alone, imported into shazam_tags;
//   - the Shazam app for Mac, whose library (synced through iCloud) is a
//     Core Data store read in place: ShazamDataModel.sqlite.

const fs = require('fs')
const os = require('os')
const path = require('path')

const CORE_DATA_EPOCH_S = 978307200 // 2001-01-01, Core Data's day zero
const MAC_DB = 'ShazamDataModel.sqlite'

// ---------------------------------------------------------------- imported

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS shazam_tags (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT, tagged_at TEXT, track_key TEXT, url TEXT)`)
}

/** Rows of a CSV text, quoted fields (with commas, quotes, newlines) included. */
function csvRows(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  const input = String(text || '').replace(/^﻿/, '')
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.map(cells => cells.map(value => value.trim())).filter(cells => cells.some(Boolean))
}

/**
 * Shazams of a Shazam CSV (SyncedShazams.csv: "Index,TagTime,Title,Artist,URL,TrackKey",
 * after a title line). Columns are found by name, so other layouts work too.
 */
function parseTags(text) {
  const rows = csvRows(text)
  const headerAt = rows.findIndex(cells => cells.some(cell => /^(title|track ?name|song)$/i.test(cell)))
  if (headerAt === -1) return []
  const header = rows[headerAt].map(cell => cell.toLowerCase().replace(/[\s_]/g, ''))
  const col = (...names) => header.findIndex(cell => names.includes(cell))
  const title = col('title', 'trackname', 'song')
  const artist = col('artist', 'artistname', 'subtitle')
  const date = col('tagtime', 'date', 'datetime', 'timestamp', 'time')
  const key = col('trackkey', 'key', 'trackid')
  const url = col('url', 'link', 'shazamurl')
  return rows.slice(headerAt + 1).map(cells => ({
    title: cells[title] || '',
    artist: artist === -1 ? '' : cells[artist] || '',
    tagged_at: date === -1 ? '' : cells[date] || '',
    track_key: key === -1 ? '' : cells[key] || '',
    url: url === -1 ? '' : cells[url] || '',
  })).filter(tag => tag.title)
}

/** The CSV texts of an upload: the file itself, or the CSVs of a zip (SyncedShazams first). */
function csvTexts(name, buffer) {
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return [buffer.toString('utf8')]
  const AdmZip = require('adm-zip')
  const entries = new AdmZip(buffer).getEntries().filter(entry => !entry.isDirectory && /\.csv$/i.test(entry.entryName))
  const synced = entry => (/syncedshazams/i.test(entry.entryName) ? 0 : /shazam/i.test(entry.entryName) ? 1 : 2)
  return entries.sort((a, b) => synced(a) - synced(b)).map(entry => entry.getData().toString('utf8'))
}

const tagId = tag => [tag.title, tag.artist, tag.tagged_at].map(value => String(value || '').toLowerCase()).join('|')

/** Import a Shazam data export (zip or CSV, base64); answers { ok, added, total } or { ok: false, error }. */
function importExport(db, { name = '', data = '' } = {}) {
  const buffer = Buffer.from(String(data || ''), 'base64')
  if (!buffer.length) return { ok: false, error: 'Choose your Shazam data file first.' }
  let tags = []
  try {
    for (const text of csvTexts(name, buffer)) {
      tags = parseTags(text)
      if (tags.length) break
    }
  } catch (error) {
    return { ok: false, error: `Could not read ${name || 'this file'} (${error.message}).` }
  }
  if (!tags.length) return { ok: false, error: 'No Shazams found in this file. Choose the zip Shazam sent you, or the SyncedShazams.csv inside it.' }
  ensureTable(db)
  const insert = db.prepare('INSERT OR IGNORE INTO shazam_tags (id, title, artist, tagged_at, track_key, url) VALUES (?, ?, ?, ?, ?, ?)')
  let added = 0
  db.exec('BEGIN')
  try {
    for (const tag of tags) added += Number(insert.run(tagId(tag), tag.title, tag.artist, tag.tagged_at, tag.track_key, tag.url).changes) || 0
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    return { ok: false, error: error.message }
  }
  return { ok: true, added, total: importedCount(db) }
}

function importedCount(db) {
  try { ensureTable(db); return Number(db.prepare('SELECT COUNT(*) AS n FROM shazam_tags').get().n) || 0 } catch { return 0 }
}

function importedTags(db) {
  ensureTable(db)
  return db.prepare('SELECT title, artist, tagged_at, track_key, url FROM shazam_tags').all()
}

function clearImported(db) {
  ensureTable(db)
  db.exec('DELETE FROM shazam_tags')
}

// ---------------------------------------------------------------- shazam for mac

/** Where the Shazam app for Mac keeps its library, when it is installed. */
function macDatabase(home = os.homedir()) {
  if (process.platform !== 'darwin' && home === os.homedir()) return ''
  const candidates = [path.join(home, 'Library/Containers/com.shazam.mac.Shazam/Data/Documents', MAC_DB)]
  const groups = path.join(home, 'Library/Group Containers')
  try {
    for (const group of fs.readdirSync(groups)) {
      if (/group\.com\.shazam/i.test(group)) candidates.push(path.join(groups, group, 'com.shazam.mac.Shazam', MAC_DB), path.join(groups, group, MAC_DB))
    }
  } catch {}
  return candidates.find(file => { try { return fs.statSync(file).isFile() } catch { return false } }) || ''
}

function openReadOnly(file) {
  try {
    const Database = require('better-sqlite3')
    return new Database(file, { readonly: true, fileMustExist: true })
  } catch {
    const { DatabaseSync } = require('node:sqlite')
    return new DatabaseSync(file, { readOnly: true })
  }
}

/** The Mac app's Shazams, newest first. Read from a copy, so the app's own files are never locked. */
function macTags(file = macDatabase()) {
  if (!file) return []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lokal-shazam-'))
  const copy = path.join(dir, MAC_DB)
  let db = null
  try {
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix)
    db = openReadOnly(copy)
    const columns = new Set(db.prepare('PRAGMA table_info(ZSHTAGRESULTMO)').all().map(column => column.name))
    if (!columns.has('ZTRACKNAME')) return []
    const pick = name => (columns.has(name) ? `tag.${name}` : 'NULL')
    const rows = db.prepare(`
      SELECT tag.ZTRACKNAME AS title, ${pick('ZDATE')} AS date, ${pick('ZTRACKKEY')} AS track_key,
        (SELECT group_concat(artist.ZNAME, ', ') FROM ZSHARTISTMO artist WHERE artist.ZTAGRESULT = tag.Z_PK) AS artist
      FROM ZSHTAGRESULTMO tag WHERE tag.ZTRACKNAME IS NOT NULL AND tag.ZTRACKNAME != ''`).all()
    return rows.map(row => ({
      title: String(row.title),
      artist: String(row.artist || ''),
      tagged_at: row.date != null && Number.isFinite(Number(row.date)) ? new Date((Number(row.date) + CORE_DATA_EPOCH_S) * 1000).toISOString() : '',
      track_key: row.track_key ? String(row.track_key) : '',
      url: row.track_key ? `https://www.shazam.com/track/${row.track_key}` : '',
    }))
  } catch (error) {
    throw new Error(/EPERM|EACCES|operation not permitted/i.test(error.message)
      ? 'macOS did not let Lokal read the Shazam app\'s library. Allow Lokal in System Settings › Privacy & Security › Full Disk Access.'
      : `Could not read the Shazam app's library (${error.message}).`)
  } finally {
    try { db?.close() } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- shape

/** Shazams as online songs, newest first (see onlineBrowse.js). */
function songsOf(tags) {
  const time = tag => Date.parse(tag.tagged_at) || 0
  return [...tags].sort((a, b) => time(b) - time(a)).map(tag => ({
    title: tag.title,
    artist: tag.artist || '',
    artists: tag.artist ? [tag.artist] : [],
    album: '',
    duration: 0,
    artwork_url: '',
    shazamed_at: tag.tagged_at || '',
    shazam_url: tag.url || '',
  }))
}

module.exports = { csvRows, parseTags, importExport, importedCount, importedTags, clearImported, macDatabase, macTags, songsOf }
