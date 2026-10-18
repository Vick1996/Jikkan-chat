const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');
const { createMedia } = require('./media');

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

// Photos, videos and voice notes: the rules live in media.js; this wires it to Supabase Storage and the messages table.
const bucket = db.storage.from('media');
const media = createMedia({
  quota: Number(process.env.MEDIA_QUOTA_BYTES) || undefined,
  storage: {
    async list(roomId) {
      const { data, error } = await bucket.list(roomId, { limit: 1000, sortBy: { column: 'created_at', order: 'asc' } });
      if (error) throw error;
      return data.map(f => ({ name: f.name, size: f.metadata?.size || 0 }));
    },
    async remove(paths) { const { error } = await bucket.remove(paths); if (error) throw error; },
    async createUploadToken(path) { const { data, error } = await bucket.createSignedUploadUrl(path); if (error) throw error; return data.token; },
    async signedUrls(paths, secs) {
      const { data } = await bucket.createSignedUrls(paths, secs);
      return Object.fromEntries((data || []).filter(d => d.signedUrl).map(d => [d.path, d.signedUrl]));
    }
  },
  async forgetPaths(gone) {
    await db.from('messages').update({ body: '(photo/video/voice note removed to free space)' }).in('media_path', gone).eq('body', '');
    await db.from('messages').update({ media_path: null, media_kind: null, media_mime: null, media_secs: null }).in('media_path', gone);
  }
});

// The messages being replied to, as { id, name, snip } keyed by id (snip = short text, or "Photo" etc. for media)
async function quotes(rows) {
  const ids = [...new Set(rows.map(r => r.reply_to).filter(Boolean))];
  if (!ids.length) return {};
  const { data } = await db.from('messages').select('id, body, sender_id, media_kind').in('id', ids);
  const { data: ms } = await db.from('members').select('user_id, display_name').in('user_id', [...new Set((data || []).map(q => q.sender_id))]);
  const who = Object.fromEntries((ms || []).map(m => [m.user_id, m.display_name]));
  return Object.fromEntries((data || []).map(q =>
    [q.id, { id: q.id, name: who[q.sender_id] || 'Unknown', snip: (q.body || media.label(q.media_kind)).slice(0, 100) }]));
}

// rows from the messages table -> what the browser gets (with signed URLs for any media)
async function toClient(rows, names) {
  const urls = await media.sign(rows.map(r => r.media_path).filter(Boolean));
  const quoted = await quotes(rows);
  return rows.map(r => ({
    id: r.id, name: names[r.sender_id] || 'Unknown', msg: r.body, ts: r.created_at, replyTo: quoted[r.reply_to],
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
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { urgency: 'high', TTL: 3600 })
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
    ack?.(await media.authorizeUpload(roomId, d || {}));
  });

  // Last arg is the ack callback: confirms the message is stored. A message is text, media (optionally with text), or both.
  socket.on('chat message', async (data, ack) => {
    const id = data?.id, msg = typeof data?.msg === 'string' ? data.msg.trim().slice(0, 2000) : '';
    const m = data?.media, att = m && media.attach(roomId, m);
    if (!id || (!msg && !att) || (m && !att)) return ack?.({ ok: false });
    const ts = new Date().toISOString();
    // a reply must point at a message in this Room, otherwise it is sent as a plain message
    let reply_to = typeof data.replyTo === 'string' ? data.replyTo : null;
    if (reply_to) {
      const { data: q } = await db.from('messages').select('id').eq('id', reply_to).eq('room_id', roomId).maybeSingle();
      if (!q) reply_to = null;
    }
    // upsert + ignoreDuplicates: a retried send with the same id is a no-op, never a duplicate
    const row = { id, room_id: roomId, sender_id: userId, body: msg, created_at: ts, reply_to,
      media_path: att?.path ?? null, media_kind: att?.kind ?? null, media_mime: att?.mime ?? null, media_secs: att?.secs ?? null };
    const { error } = await db.from('messages').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
    if (error) { console.error('save failed', error.message); return ack?.({ ok: false }); }
    const [out] = await toClient([row], { [userId]: name });
    socket.to(roomId).emit('chat message', out);
    ack?.({ ok: true, ts });
    pushToOthers(socket.data, msg || media.label(att.kind));
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
      db.from('messages').select('id, body, created_at, sender_id, reply_to, media_path, media_kind, media_secs').eq('room_id', roomId)
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
