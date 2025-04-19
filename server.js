
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from /public
app.use(express.static('public'));

// Simple romantic-message endpoint (stub or connect to Redis/external API)
app.get('/api/romantic', (req, res) => {
  // In production, pull from Redis or another service
  res.json({ message: 'You are the sunshine of my life 🌹' });
});

// Socket.IO event handling
io.on('connection', socket => {
  socket.on('chat history', history => {
  history.forEach(({ name, msg }) => displayMessage(name, msg));
});
  socket.on('chat message', data => io.emit('chat message', data));
  socket.on('voice message', data => io.emit('voice message', data));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
