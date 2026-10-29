'use strict'

/**
 * Find an existing indexed file matching the metadata AND physical audio
 * edition. Stereo and verified E-AC-3 JOC are independent library copies:
 * identical titles and durations are not enough to deduplicate them.
 *
 * Unknown/unverified media belongs to the ordinary (non-Atmos) edition.
 * Only the scanner's verified ffprobe result can select the Atmos edition.
 */
function findAudioEditionDuplicate(db, { title, artist, album, duration, atmosVerified } = {}) {
  return db.prepare("SELECT * FROM tracks WHERE LOWER(title) = ? AND LOWER(artist) = ? AND (album IS NULL OR album = ? OR ? IS NULL OR album IS NULL) AND ABS(duration - ?) < 2 AND file_path NOT LIKE 'ghost://%' AND COALESCE(atmos_verified, 0) = ?")
    .get(String(title || '').toLowerCase(), String(artist || '').toLowerCase(), album || null, album || null,
      Number(duration) || 0, atmosVerified === 1 ? 1 : 0)
}

module.exports = { findAudioEditionDuplicate }
