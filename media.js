const { randomUUID } = require('crypto');

// Media = a photo, video or voice note attached to a Message. Files live in a private store at <roomId>/<uuid>.<ext>;
// the browser uploads straight to it with a one-time token, and everyone reads through short-lived signed URLs.
//
// Seams (both injected, so tests use in-memory fakes):
//   storage.list(roomId)            -> [{ name, size }] oldest first
//   storage.remove(paths)           -> deletes files
//   storage.createUploadToken(path) -> one-time upload token
//   storage.signedUrls(paths, secs) -> { [path]: url }
//   forgetPaths(paths)              -> the caller clears the Message rows that pointed at those files
const MIMES = {
  image: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  video: { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' },
  audio: { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3' }
};
const LABEL = { image: '📷 Photo', video: '🎬 Video', audio: '🎤 Voice note' };
const MAX_BYTES = 25 * 1024 * 1024;   // matches the bucket's file size limit
const HIGH = 0.85, LOW = 0.70;

// Free plan = 1 GB of files. When this Room's media would pass 85% of the quota, delete the OLDEST files until it is
// back under 70% (so we don't delete on every upload). The messages stay; their media is replaced by a note.
// ponytail: counts only this Room's folder, capped at 1000 files; sum all folders / page the list if that stops being true.
function createMedia({ storage, forgetPaths, quota = 1024 ** 3, signedSeconds = 3600, log = console }) {
  async function trim(roomId, incoming) {
    const files = await storage.list(roomId);
    let used = files.reduce((n, f) => n + (f.size || 0), 0);
    if (used + incoming <= quota * HIGH) return;
    const gone = [];
    for (const f of files) {                      // oldest first
      if (used + incoming <= quota * LOW) break;
      gone.push(`${roomId}/${f.name}`); used -= f.size || 0;
    }
    if (!gone.length) return;
    await storage.remove(gone);
    await forgetPaths(gone);
    log.log(`media over ${HIGH * 100}% of quota: removed ${gone.length} oldest file(s)`);
  }

  return {
    // Check type/size, make room, and hand back a path + one-time upload token. { ok:false } on any refusal or failure.
    async authorizeUpload(roomId, { kind, mime, size } = {}) {
      const ext = MIMES[kind]?.[mime];
      if (!ext || !(size > 0 && size <= MAX_BYTES)) return { ok: false, reason: 'type or size' };
      try { await trim(roomId, size); } catch (e) { log.error('media trim failed', e.message); }
      const path = `${roomId}/${randomUUID()}.${ext}`;
      try { return { ok: true, path, token: await storage.createUploadToken(path) }; }
      catch (e) { log.error('upload url failed', e.message); return { ok: false }; }
    },

    // A Message's media must be one of this Room's own uploads. Returns the clean value to store, or null.
    attach(roomId, m) {
      if (!m || !MIMES[m.kind]?.[m.mime]) return null;
      if (!new RegExp(`^${roomId}/[0-9a-f-]{36}\\.[a-z0-9]{2,4}$`).test(m.path)) return null;
      return { path: m.path, kind: m.kind, mime: m.mime, secs: Number.isFinite(m.secs) ? Math.min(Math.round(m.secs), 3600) : null };
    },

    // paths -> { [path]: signed url }
    async sign(paths) {
      return paths.length ? storage.signedUrls(paths, signedSeconds) : {};
    },

    label: kind => LABEL[kind]
  };
}

module.exports = { createMedia };
