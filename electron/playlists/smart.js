// Smart playlists: a playlist made of rules ("genre is Jazz", "in the folder
// D:\Music\Live", "not played for 90 days"...) instead of a list. Its songs
// are worked out from the library each time it's opened, so it follows what
// you add, play and like. The rules live in playlists.smart_rules (JSON):
//
//   { match: 'all' | 'any', rules: [{ field, op, value }], sort, limit }
//
// Tempo, key and energy come from the files' tags or imports, else AutoMix's
// analysis (Analyse Library fills them in for the whole library); the
// "smooth" order is Magic Sort's (electron/mixing).
//
// Shared by the desktop app (electron/ipc/scanner.js) and the web server
// (server/routes/playlists.js).

const { tierFilter } = require('../quality')
const { parseCamelot, mixesWith, keyOf } = require('../mixing/camelot')
const { ensureTable } = require('../automix')

const DAY = 24 * 60 * 60
const SORTS = {
  added: 't.added_at DESC',
  plays: 't.play_count DESC, t.artist COLLATE NOCASE, t.title COLLATE NOCASE',
  played: '(SELECT MAX(ph.played_at) FROM play_history ph WHERE ph.track_id = t.id AND ph.user_id = @uid) DESC',
  title: 't.title COLLATE NOCASE',
  artist: 't.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.track_num, t.title COLLATE NOCASE',
  album: 't.album COLLATE NOCASE, t.track_num, t.title COLLATE NOCASE',
  year: 't.year DESC, t.album COLLATE NOCASE, t.track_num',
  tempo: 't.tempo IS NULL, t.tempo, t.artist COLLATE NOCASE, t.title COLLATE NOCASE',
  random: 'RANDOM()',
  // Magic Sort, after the query (smartTracks); the limit takes the first by artist.
  smooth: 't.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.track_num, t.title COLLATE NOCASE',
}
const MAX_LIMIT = 5000
const SOURCES = ['local', 'yt', 'sc', 'mono', 'soulseek', 'addon', 'web']
const TIERS = ['hires', 'lossless', 'high', 'low', 'suspect']

const like = (text) => `%${String(text).replace(/[\\%_]/g, char => `\\${char}`)}%`
const startsLike = (text) => `${String(text).replace(/[\\%_]/g, char => `\\${char}`)}%`

/** A folder as stored paths start with it: both slash styles, with a trailing separator. */
function folderPrefixes(folder) {
  const trimmed = String(folder || '').trim().replace(/[\\/]+$/, '')
  if (!trimmed) return []
  return [...new Set([`${trimmed.replace(/\//g, '\\')}\\`, `${trimmed.replace(/\\/g, '/')}/`])]
}

function textCondition(column, op, value, params) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (op === 'is') { params.push(text); return `LOWER(TRIM(${column})) = LOWER(?)` }
  if (op === 'not') { params.push(text); return `LOWER(TRIM(IFNULL(${column}, ''))) != LOWER(?)` }
  if (op === 'starts') { params.push(startsLike(text)); return `${column} LIKE ? ESCAPE '\\'` }
  if (op === 'excludes') { params.push(like(text)); return `IFNULL(${column}, '') NOT LIKE ? ESCAPE '\\'` }
  params.push(like(text)); return `${column} LIKE ? ESCAPE '\\'`
}

function numberCondition(column, op, value, params, scale = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  params.push(n * scale)
  if (op === 'lte') return `${column} <= ?`
  if (op === 'eq') return `${column} = ?`
  return `${column} >= ?`
}

// One rule as SQL on `tracks t`, or null when it's incomplete (skipped).
const FIELDS = {
  title: (op, value, params) => textCondition('t.title', op, value, params),
  artist: (op, value, params) => textCondition('t.artist', op, value, params),
  album: (op, value, params) => textCondition('t.album', op, value, params),
  genre: (op, value, params) => {
    const text = String(value ?? '').trim()
    if (!text) return null
    // The main genre or one of the genres ("J-Pop, City Pop").
    const all = "(IFNULL(t.genre, '') || ',' || IFNULL(t.genres, ''))"
    if (op === 'is') {
      params.push(text, `%,${String(text).toLowerCase().replace(/[\\%_]/g, c => `\\${c}`)},%`)
      return "(LOWER(TRIM(t.genre)) = LOWER(?) OR (',' || REPLACE(REPLACE(LOWER(IFNULL(t.genres, '')), ', ', ','), ' ,', ',') || ',') LIKE ? ESCAPE '\\')"
    }
    if (op === 'excludes') { params.push(like(text)); return `${all} NOT LIKE ? ESCAPE '\\'` }
    params.push(like(text)); return `${all} LIKE ? ESCAPE '\\'`
  },
  folder: (op, value, params) => {
    const prefixes = folderPrefixes(value)
    if (!prefixes.length) return null
    params.push(...prefixes.map(startsLike))
    const inside = `(${prefixes.map(() => "t.file_path LIKE ? ESCAPE '\\'").join(' OR ')})`
    return op === 'not' ? `NOT ${inside}` : inside
  },
  year: (op, value, params) => numberCondition('t.year', op, value, params),
  plays: (op, value, params) => numberCondition('IFNULL(t.play_count, 0)', op, value, params),
  // Minutes in the editor, seconds in the library.
  duration: (op, value, params) => numberCondition('t.duration', op, value, params, 60),
  bpm: (op, value, params) => numberCondition('t.tempo', op, value, params),
  // A Camelot key ("8A"): that key, or the keys that mix with it (one step
  // round the wheel, the relative major/minor). "Is not" leaves out songs
  // whose key isn't known.
  key: (op, value, params) => {
    const key = parseCamelot(value)
    if (!key) return null
    const keys = op === 'mixes' ? mixesWith(key) : [key]
    const match = `(${keys.map(each => { const { root, mode } = keyOf(each); params.push(root, mode); return '(t.track_key = ? AND t.mode = ?)' }).join(' OR ')})`
    return op === 'not' ? `(t.track_key BETWEEN 0 AND 11 AND t.mode IN (0, 1) AND NOT ${match})` : match
  },
  // Percent in the editor, 0–1 in the library: imported energy, else the analysis' (from loudness).
  energy: (op, value, params, db) => {
    ensureTable(db)
    return numberCondition("COALESCE(t.energy, (SELECT json_extract(a.data, '$.energy') FROM track_analysis a WHERE a.key = t.id))", op, value, params, 0.01)
  },
  added: (op, value, params) => {
    const days = Number(value)
    if (!(days > 0)) return null
    params.push(Math.floor(Date.now() / 1000) - days * DAY)
    return op === 'before' ? 't.added_at < ?' : 't.added_at >= ?'
  },
  played: (op, value, params) => {
    const last = '(SELECT MAX(ph.played_at) FROM play_history ph WHERE ph.track_id = t.id AND ph.user_id = @uid)'
    if (op === 'never') return `${last} IS NULL`
    const days = Number(value)
    if (!(days > 0)) return null
    params.push(Math.floor(Date.now() / 1000) - days * DAY)
    // "Not in the last N days" includes the songs never played.
    return op === 'before' ? `(${last} IS NULL OR ${last} < ?)` : `${last} >= ?`
  },
  liked: (op) => {
    const liked = 'EXISTS (SELECT 1 FROM user_likes ul WHERE ul.track_id = t.id AND ul.user_id = @uid)'
    return op === 'not' ? `NOT ${liked}` : liked
  },
  quality: (op, value, params, db) => {
    if (!TIERS.includes(value)) return null
    const filter = tierFilter(db, value)
    if (!filter) return null
    params.push(...filter.params)
    // The tier's columns are unqualified; they're only on tracks.
    return op === 'not' ? `NOT ${filter.sql}` : filter.sql
  },
  source: (op, value) => {
    if (!SOURCES.includes(value)) return null
    const sql = value === 'local' ? 't.download_source IS NULL'
      : value === 'addon' ? "t.download_source LIKE 'a-%'"
        : `t.download_source = '${value}'`
    return op === 'not' ? `NOT (${sql})` : sql
  },
}

/** Rules as saved: unknown fields dropped, the rest kept as typed. */
function normalizeRules(input) {
  let rules = input
  if (typeof rules === 'string') { try { rules = JSON.parse(rules) } catch { return null } }
  if (!rules || typeof rules !== 'object') return null
  const list = (Array.isArray(rules.rules) ? rules.rules : [])
    .filter(rule => rule && FIELDS[rule.field])
    .map(rule => ({ field: rule.field, op: String(rule.op || ''), value: rule.value ?? '' }))
    .slice(0, 30)
  const limit = Math.min(Math.max(Math.floor(Number(rules.limit) || 0), 0), MAX_LIMIT)
  return { match: rules.match === 'any' ? 'any' : 'all', rules: list, sort: SORTS[rules.sort] ? rules.sort : 'artist', limit }
}

/** { sql, params } selecting the playlist's tracks (`columns` of them). */
function smartQuery(db, input, userId, columns = 't.*') {
  const rules = normalizeRules(input) || normalizeRules({})
  const params = []
  const conditions = rules.rules.map(rule => FIELDS[rule.field](rule.op, rule.value, params, db)).filter(Boolean)
  const where = conditions.length ? `AND (${conditions.join(rules.match === 'any' ? ' OR ' : ' AND ')})` : ''
  const sql = `SELECT ${columns} FROM tracks t WHERE t.file_path NOT LIKE 'ghost://%' ${where} ORDER BY ${SORTS[rules.sort]}${rules.limit ? ` LIMIT ${rules.limit}` : ''}`
  return { sql, params, named: { uid: userId || 'guest' } }
}

// better-sqlite3 takes positional and named parameters together, but only
// binds the named ones the statement uses.
function run(db, query, method) {
  const statement = db.prepare(query.sql)
  const named = query.sql.includes('@uid') ? [query.named] : []
  return statement[method](...query.params, ...named)
}

/** The tracks of a smart playlist, in its order. */
function smartTracks(db, rules, userId) {
  const rows = run(db, smartQuery(db, rules, userId), 'all')
  if (normalizeRules(rules)?.sort !== 'smooth') return rows
  const { magicSort } = require('../mixing/magicSort')
  const { withAnalyses } = require('../automix/library')
  return magicSort(withAnalyses(db, rows)).order.map(index => rows[index])
}

/**
 * What the rules give, for the editor: { count, duration, sample: first few
 * songs }. Asked for on every change, so only the totals and five songs are
 * read, from one selection (the same random draw for both).
 */
function smartPreview(db, rules, userId) {
  const query = smartQuery(db, rules, userId, 't.id, t.title, t.artist, t.duration')
  const row = run(db, {
    ...query,
    sql: `WITH picked AS MATERIALIZED (${query.sql})
      SELECT (SELECT COUNT(*) FROM picked) AS count,
             (SELECT IFNULL(SUM(duration), 0) FROM picked) AS duration,
             (SELECT json_group_array(json_object('id', id, 'title', title, 'artist', artist)) FROM (SELECT * FROM picked LIMIT 5)) AS sample`,
  }, 'get')
  let sample = []
  try { sample = JSON.parse(row?.sample || '[]') } catch {}
  return { count: row?.count || 0, duration: row?.duration || 0, sample }
}

/** The playlist's rules (parsed), or null for a regular playlist. */
function playlistRules(playlist) {
  return playlist?.smart_rules ? normalizeRules(playlist.smart_rules) : null
}

module.exports = { smartTracks, smartPreview, smartQuery, normalizeRules, playlistRules, folderPrefixes, FIELDS, SORTS }
