const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

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
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 }
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

// Who is connected right now in a Room (display names, de-duplicated across a person's devices)
async function broadcastPresence(roomId) {
  const socks = await io.in(roomId).fetchSockets();
  io.to(roomId).emit('presence', { online: [...new Set(socks.map(s => s.data.name))] });
}

io.on('connection', socket => {
  const { userId, roomId, name, aliases } = socket.data;
  socket.join(roomId);

  // Handlers are registered synchronously, before any await, so nothing the client sends right after connecting is dropped.

  // Last arg is the ack callback: confirms the message is stored
  socket.on('chat message', async (data, ack) => {
    const id = data?.id, msg = typeof data?.msg === 'string' ? data.msg.trim().slice(0, 2000) : '';
    if (!id || !msg) return ack?.({ ok: false });
    const ts = new Date().toISOString();
    // upsert + ignoreDuplicates: a retried send with the same id is a no-op, never a duplicate
    const { error } = await db.from('messages')
      .upsert({ id, room_id: roomId, sender_id: userId, body: msg, created_at: ts }, { onConflict: 'id', ignoreDuplicates: true });
    if (error) { console.error('save failed', error.message); return ack?.({ ok: false }); }
    socket.to(roomId).emit('chat message', { id, name, msg, ts });
    ack?.({ ok: true, ts });
    pushToOthers(socket.data, msg);
  });

  // "I have the chat open and can see it": drives the other Member's read receipts and my own unread marker.
  socket.on('read', async () => {
    const ts = new Date().toISOString();
    const { error } = await db.from('members').update({ last_read_at: ts }).eq('room_id', roomId).eq('user_id', userId);
    if (!error) socket.to(roomId).emit('read', { name, ts });
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

  socket.on('disconnect', () => broadcastPresence(roomId));

  // Initial payload: who I am, my settings and read state, then history, then presence
  (async () => {
    const [settingOn, { data: rows }, { data: members }] = await Promise.all([
      notificationsEnabled(userId),
      db.from('messages').select('id, body, created_at, sender_id').eq('room_id', roomId)
        .order('created_at', { ascending: false }).limit(MAX_HISTORY),
      db.from('members').select('user_id, display_name, last_read_at').eq('room_id', roomId)
    ]);
    const names = Object.fromEntries((members || []).map(m => [m.user_id, m.display_name]));
    const mine = (members || []).find(m => m.user_id === userId);
    // latest time any other Member had the chat open: messages older than this show as read
    const othersReadAt = (members || []).filter(m => m.user_id !== userId && m.last_read_at)
      .map(m => m.last_read_at).sort().pop() || null;

    socket.emit('me', { name, aliases, notificationsEnabled: settingOn, lastReadAt: mine?.last_read_at || null, othersReadAt });
    socket.emit('chat history', (rows || []).reverse().map(r => (
      { id: r.id, name: names[r.sender_id] || 'Unknown', msg: r.body, ts: r.created_at }
    )));
    broadcastPresence(roomId);
  })().catch(e => console.error('initial payload failed', e.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));
