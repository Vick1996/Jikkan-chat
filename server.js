const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
// Short disconnects (phone sleep, wifi blip) resume without losing events
const io = new Server(server, {
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 }
});

app.use(express.static('public'));

app.get('/api/romantic', (req, res) => {
  res.json({ message: 'You are the sunshine of my life 🌹' });
});

// One private room for the two of you.
// ponytail: single fixed room; add a join code / per-pair room when more than 2 people use it.
const ROOM = 'jikkan';
const MAX_HISTORY = 200;
// Point HISTORY_FILE at a Railway volume path to survive redeploys.
const HISTORY_FILE = process.env.HISTORY_FILE || './history.json';

let history = [];
try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}

function save(entry) {
  history.push(entry);
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history)); } catch (e) { console.error('history save failed', e.message); }
}

io.on('connection', socket => {
  // Client calls this after entering a name (and again after every reconnect)
  socket.on('join', () => {
    socket.join(ROOM);
    socket.emit('chat history', history);
  });

  // Last arg is the ack callback: confirms the server stored + relayed it
  socket.on('chat message', (data, ack) => {
    if (!socket.rooms.has(ROOM) || typeof data?.msg !== 'string' || !data.msg.trim()) return ack?.({ ok: false });
    const entry = { id: data.id, name: String(data.name).slice(0, 40), msg: data.msg.slice(0, 2000), ts: Date.now() };
    save(entry);
    socket.to(ROOM).emit('chat message', entry);
    ack?.({ ok: true, ts: entry.ts });
  });

  socket.on('voice message', data => socket.to(ROOM).emit('voice message', data));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server listening on http://localhost:${PORT}`));
