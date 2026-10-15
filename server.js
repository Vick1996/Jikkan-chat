const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');
const { randomUUID } = require('crypto');

const {
  SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
} = process.env;

// The service role key bypasses row-level security, so every read and write below is scoped to
// socket.data.roomId, which is only ever set from a verified login token + a members row.
// Local dev: node --env-file=.env server.js
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const app = express();
const server = http.createServer(app);
// Short disconnects (phone sleep, wifi blip) resume without losing events
const io = new Server(server, {
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  maxHttpBufferSize: 1e6   // a wallpaper upload is up to 600 KB
});

app.use(express.static('public'));

// Public values the browser needs (the publishable key is safe to expose; the row-level rules deny it everything).
app.get('/config', (req, res) => res.json({
  supabaseUrl: SUPABASE_URL,
  supabaseKey: SUPABASE_PUBLISHABLE_KEY,
  vapidPublicKey: VAPID_PUBLIC_KEY
}));

const MAX_HISTORY = 200;

// Every socket must present a valid Supabase login token AND belong to a Room.
// ponytail: a Member belongs to one Room here (first one found); add a room picker when multi-room is real.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('unauthorized'));
    const { data: { user }, error } = await db.auth.getUser(token);
    if (error || !user) return next(new Error('unauthorized'));
    const { data: member } = await db.from('members')
      .select('room_id, display_name, aliases').eq('user_id', user.id).limit(1).maybeSingle();
    if (!member) return next(new Error('forbidden'));
    socket.data = { userId: user.id, roomId: member.room_id, name: member.display_name, aliases: member.aliases };
    next();
  } catch (e) {
    console.error('auth failed', e.message);
    next(new Error('unauthorized'));
  }
});

async function notificationsEnabled(userId) {
  const { data } = await db.from('account_settings').select('notifications_enabled').eq('user_id', userId).maybeSingle();
  return data ? data.notifications_enabled : true; // default on until the account says otherwise
}

// Photos, videos and voice notes live in the private "media" bucket (<roomId>/<uuid>.<ext>). The browser uploads
// straight to Storage with a one-time signed URL from here; everyone reads through short-lived signed URLs.
const MEDIA_MIMES = {
  image: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' },
  video: { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' },
  audio: { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3' }
};
const MEDIA_MAX = 25 * 1024 * 1024;   // matches the bucket's file size limit
const MEDIA_LABEL = { image: '📷 Photo', video: '🎬 Video', audio: '🎤 Voice note' };
const SIGNED_SECONDS = 3600;          // ponytail: a tab left open > 1 h needs a reload to replay old media

// rows from the messages table -> what the browser gets (with signed URLs for any media)
async function toClient(rows, names) {
  const paths = rows.map(r => r.media_path).filter(Boolean);
  const urls = {};
  if (paths.length) {
    const { data } = await db.storage.from('media').createSignedUrls(paths, SIGNED_SECONDS);
    (data || []).forEach(d => { if (d.signedUrl) urls[d.path] = d.signedUrl; });
  }
  return rows.map(r => ({
    id: r.id, name: names[r.sender_id] || 'Unknown', msg: r.body, ts: r.created_at,
    media: r.media_path ? { url: urls[r.media_path] || null, kind: r.media_kind, secs: r.media_secs } : undefined
  }));
}

async function pushToOthers({ userId, roomId, name }, body) {
  const { data: others } = await db.from('members').select('user_id').eq('room_id', roomId).neq('user_id', userId);
  for (const { user_id } of others || []) {
    if (!(await notificationsEnabled(user_id))) continue;
    const { data: subs } = await db.from('push_subscriptions').select('*').eq('user_id', user_id);
    const payload = JSON.stringify({ title: name, body });
    for (const s of subs || []) {
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
        .catch(async err => {
          // 404/410 = the browser dropped this subscription; forget it
          if (err.statusCode === 404 || err.statusCode === 410) await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
          else console.error('push failed', err.statusCode || err.message);
        });
    }
  }
}

// Who is here right now in a Room: a Member is here while at least one of their devices has the chat visible
// (an app left open in a background tab does not count). Also sends everyone's last-seen time.
// justLeft = userId whose last visible device just went away: stamp their last_seen_at first.
async function broadcastPresence(roomId, justLeft) {
  const socks = await io.in(roomId).fetchSockets();
  const online = [...new Set(socks.filter(s => s.data.visible).map(s => s.data.name))];
  if (justLeft && !socks.some(s => s.data.visible && s.data.userId === justLeft)) {
    await db.from('members').update({ last_seen_at: new Date().toISOString() }).eq('room_id', roomId).eq('user_id', justLeft);
  }
  const { data: members } = await db.from('members').select('display_name, last_seen_at').eq('room_id', roomId);
  const lastSeen = Object.fromEntries((members || []).filter(m => m.last_seen_at).map(m => [m.display_name, m.last_seen_at]));
  io.to(roomId).emit('presence', { online, lastSeen });
}

io.on('connection', socket => {
  const { userId, roomId, name, aliases } = socket.data;
  socket.join(roomId);
  socket.join(`user:${userId}`);

  // Handlers are registered synchronously, before any await, so nothing the client sends right after connecting is dropped.

  // Last arg is the ack callback: confirms the message is stored
  // The browser asks for permission to upload one file; we check type/size and hand back a one-time upload token.
  socket.on('media:upload', async (d, ack) => {
    const ext = MEDIA_MIMES[d?.kind]?.[d?.mime];
    if (!ext || !(d.size > 0 && d.size <= MEDIA_MAX)) return ack?.({ ok: false, reason: 'type or size' });
    const path = `${roomId}/${randomUUID()}.${ext}`;
    const { data, error } = await db.storage.from('media').createSignedUploadUrl(path);
    if (error) { console.error('upload url failed', error.message); return ack?.({ ok: false }); }
    ack?.({ ok: true, path, token: data.token });
  });

  // Last arg is the ack callback: confirms the message is stored. A message is text, media (optionally with text), or both.
  socket.on('chat message', async (data, ack) => {
    const id = data?.id, msg = typeof data?.msg === 'string' ? data.msg.trim().slice(0, 2000) : '';
    const m = data?.media;
    // media must be one of this Room's own uploads (path begins with the Room id; the uuid+ext part is fixed-shape)
    const media = m && MEDIA_MIMES[m.kind]?.[m.mime] && new RegExp(`^${roomId}/[0-9a-f-]{36}\\.[a-z0-9]{2,4}$`).test(m.path)
      ? { path: m.path, kind: m.kind, mime: m.mime, secs: Number.isFinite(m.secs) ? Math.min(Math.round(m.secs), 3600) : null } : null;
    if (!id || (!msg && !media) || (m && !media)) return ack?.({ ok: false });
    const ts = new Date().toISOString();
    // upsert + ignoreDuplicates: a retried send with the same id is a no-op, never a duplicate
    const row = { id, room_id: roomId, sender_id: userId, body: msg, created_at: ts,
      media_path: media?.path ?? null, media_kind: media?.kind ?? null, media_mime: media?.mime ?? null, media_secs: media?.secs ?? null };
    const { error } = await db.from('messages').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
    if (error) { console.error('save failed', error.message); return ack?.({ ok: false }); }
    const [out] = await toClient([row], { [userId]: name });
    socket.to(roomId).emit('chat message', out);
    ack?.({ ok: true, ts });
    pushToOthers(socket.data, msg || MEDIA_LABEL[media.kind]);
  });

  // "I have the chat open and can see it": drives the other Member's read receipts and my own unread marker.
  // Reading implies delivered.
  socket.on('read', async () => {
    const ts = new Date().toISOString();
    const { error } = await db.from('members').update({ last_read_at: ts, delivered_at: ts }).eq('room_id', roomId).eq('user_id', userId);
    if (!error) { socket.to(roomId).emit('read', { name, ts }); socket.to(roomId).emit('delivered', { name, ts }); }
  });

  // "My app has received the messages" (open or not in view): drives the second grey tick on the sender's side.
  socket.on('delivered', async () => {
    const ts = new Date().toISOString();
    const { error } = await db.from('members').update({ delivered_at: ts }).eq('room_id', roomId).eq('user_id', userId);
    if (!error) socket.to(roomId).emit('delivered', { name, ts });
  });

  // The app says whether the chat is in view (tab/app in front). Drives "here" and last seen.
  // Typing: relayed live to the other Member, never stored
  socket.on('typing', on => socket.to(roomId).emit('typing', { name, on: !!on }));

  socket.on('visible', v => {
    const was = !!socket.data.visible;
    socket.data.visible = !!v;
    if (was !== socket.data.visible) broadcastPresence(roomId, was ? userId : null);
  });

  // Notifications: one switch per account (all devices); each device registers its own push subscription.
  socket.on('push:subscribe', async (sub, ack) => {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return ack?.({ ok: false });
    const { error } = await db.from('push_subscriptions')
      .upsert({ endpoint: sub.endpoint, user_id: userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth }, { onConflict: 'endpoint' });
    ack?.({ ok: !error });
  });

  socket.on('notifications:set', async (enabled, ack) => {
    const { error } = await db.from('account_settings')
      .upsert({ user_id: userId, notifications_enabled: !!enabled }, { onConflict: 'user_id' });
    ack?.({ ok: !error });
  });

  // My wallpaper (per account, so it follows me to every device): 'photo', 'plain', or a JPEG data URL (<= 600 KB).
  // My other devices get the change live; nobody else sees it.
  socket.on('wallpaper:set', async (v, ack) => {
    const ok = v === 'photo' || v === 'plain' || (typeof v === 'string' && v.startsWith('data:image/jpeg;base64,') && v.length <= 600000);
    if (!ok) return ack?.({ ok: false });
    const { error } = await db.from('account_settings').upsert({ user_id: userId, wallpaper: v }, { onConflict: 'user_id' });
    if (error) { console.error('wallpaper failed', error.message); return ack?.({ ok: false }); }
    io.to(`user:${userId}`).emit('wallpaper', v);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => broadcastPresence(roomId, socket.data.visible ? userId : null));

  // Initial payload: who I am, my settings and read state, then history, then presence
  (async () => {
    const [settingOn, { data: rows }, { data: members }, { data: room }] = await Promise.all([
      notificationsEnabled(userId),
      db.from('messages').select('id, body, created_at, sender_id, media_path, media_kind, media_secs').eq('room_id', roomId)
        .order('created_at', { ascending: false }).limit(MAX_HISTORY),
      db.from('members').select('user_id, display_name, last_read_at, delivered_at').eq('room_id', roomId),
      db.from('account_settings').select('wallpaper').eq('user_id', userId).maybeSingle()
    ]);
    const names = Object.fromEntries((members || []).map(m => [m.user_id, m.display_name]));
    const mine = (members || []).find(m => m.user_id === userId);
    // latest time any other Member had the chat open: messages older than this show as read
    const othersReadAt = (members || []).filter(m => m.user_id !== userId && m.last_read_at)
      .map(m => m.last_read_at).sort().pop() || null;

    const othersDeliveredAt = (members || []).filter(m => m.user_id !== userId && m.delivered_at)
      .map(m => m.delivered_at).sort().pop() || null;

    socket.emit('me', { name, aliases, notificationsEnabled: settingOn, lastReadAt: mine?.last_read_at || null, othersReadAt, othersDeliveredAt });
    socket.emit('wallpaper', room?.wallpaper ?? null);
    socket.emit('chat history', await toClient((rows || []).reverse(), names));
    broadcastPresence(roomId);
  })().catch(e => console.error('initial payload failed', e.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));
