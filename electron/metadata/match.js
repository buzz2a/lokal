// How well an online result fits a song of the library (0–100), and which
// song of a release is which song of a local album.

const plain = value => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()

/** The song's own name, without "(Remastered 2004)", "- Live" and the like. */
const bareTitle = title => String(title || '').replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim() || String(title || '')

const words = value => new Set(plain(value).split(' ').filter(Boolean))

/** Shared words, 0–1 (Dice). */
function similarity(left, right) {
  const a = words(left)
  const b = words(right)
  if (!a.size || !b.size) return 0
  let common = 0
  for (const word of a) if (b.has(word)) common += 1
  return (2 * common) / (a.size + b.size)
}

function titleScore(left, right) {
  if (plain(left) && plain(left) === plain(right)) return 1
  return Math.max(similarity(left, right), similarity(bareTitle(left), bareTitle(right)) * 0.9)
}

const leadArtist = artist => plain(String(artist || '').split(/,|&| x | feat\.? | ft\.? | and /i)[0])

function artistScore(local, found) {
  const a = plain(local)
  const b = plain(found)
  if (!a || !b) return 0
  if (a === b) return 1
  const lead = leadArtist(local)
  if (lead && (b.includes(lead) || lead.includes(leadArtist(found)))) return 0.9
  return similarity(local, found)
}

function durationScore(local, found) {
  const a = Number(local)
  const b = Number(found)
  if (!(a > 0) || !(b > 0)) return 0.5
  const diff = Math.abs(a - b)
  if (diff <= 2) return 1
  if (diff <= 5) return 0.7
  if (diff <= 10) return 0.3
  return 0
}

const sameIsrc = (left, right) => !!left && !!right && String(left).toUpperCase() === String(right).toUpperCase()

/** How well `fields` (a result) fit `query` ({ title, artist, duration, isrc }), 0–100. */
function scoreTrack(query = {}, fields = {}) {
  const score = 50 * titleScore(query.title, fields.title) + 35 * artistScore(query.artist, fields.artist) + 15 * durationScore(query.duration, fields.duration)
  if (sameIsrc(query.isrc, fields.isrc)) return Math.round(Math.max(score, 97))
  return Math.round(score)
}

/**
 * Which release track each local track is: [{ index, score }] (index into
 * `releaseTracks`, -1 when none fits), by track number, title and length.
 * Each release track is used once, best pairs first.
 */
function matchTracks(localTracks = [], releaseTracks = []) {
  const pairs = []
  localTracks.forEach((local, i) => {
    releaseTracks.forEach((found, j) => {
      const f = found.fields || found
      const sameNumber = local.track_num && f.track_num && Number(local.track_num) === Number(f.track_num)
        && (!local.disc || !found.disc || Number(local.disc) === Number(found.disc))
      const score = 45 * titleScore(local.title, f.title) + 15 * durationScore(local.duration, f.duration) + (sameNumber ? 40 : 0)
        + (sameIsrc(local.isrc, f.isrc) ? 100 : 0)
      pairs.push({ i, j, score })
    })
  })
  pairs.sort((a, b) => b.score - a.score)
  const result = localTracks.map(() => ({ index: -1, score: 0 }))
  const used = new Set()
  for (const pair of pairs) {
    if (pair.score < 40) break
    if (result[pair.i].index !== -1 || used.has(pair.j)) continue
    result[pair.i] = { index: pair.j, score: Math.min(100, Math.round(pair.score)) }
    used.add(pair.j)
  }
  return result
}

/** How well a release fits a local album: its name, artist, and how many of the songs it has (0–100). */
function scoreRelease(query = {}, release = {}, mapping = []) {
  const matched = mapping.filter(item => item.index !== -1).length
  const share = mapping.length ? matched / mapping.length : 0
  return Math.round(40 * titleScore(query.album, release.fields?.album) + 30 * artistScore(query.artist, release.fields?.album_artist) + 30 * share)
}

module.exports = { plain, bareTitle, similarity, titleScore, artistScore, scoreTrack, matchTracks, scoreRelease }
