const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { ANSWERS, VALID } = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.send('ok'));

const MAX_ROWS = 6;
const rooms = {};

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms[code]);
  return code;
}

function pickWord(room) {
  let w;
  do {
    w = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
  } while (room.used.has(w) && room.used.size < ANSWERS.length);
  room.used.add(w);
  return w;
}

// Standard Wordle scoring, handles double letters properly
function score(guess, word) {
  const res = Array(5).fill('grey');
  const left = {};
  for (let i = 0; i < 5; i++) {
    if (guess[i] === word[i]) res[i] = 'green';
    else left[word[i]] = (left[word[i]] || 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (res[i] === 'green') continue;
    if (left[guess[i]] > 0) {
      res[i] = 'yellow';
      left[guess[i]]--;
    }
  }
  return res;
}

function playerList(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, wins: p.wins, connected: p.connected }));
}

// What each player is allowed to see
function viewFor(room, viewerId) {
  const base = {
    code: room.code,
    mode: room.mode,
    status: room.status,
    hostId: room.hostId,
    players: playerList(room),
    round: room.round,
    message: room.message || '',
    winnerId: room.winnerId || null,
    word: room.status === 'over' ? room.word : null,
  };
  const coop = room.coop || { rows: [], turn: 0 };
  const vs = room.vs || {};
  if (room.mode === 'coop') {
    base.board = coop.rows;
    base.turnId = room.players.length ? room.players[coop.turn % room.players.length].id : null;
  } else {
    base.boards = {};
    for (const p of room.players) {
      const rows = vs[p.id] || [];
      if (p.id === viewerId || room.status === 'over') {
        base.boards[p.id] = rows;
      } else {
        // Hide the letters, only show the colours
        base.boards[p.id] = rows.map(r => ({ colors: r.colors, letters: null }));
      }
    }
  }
  return base;
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.connected) io.to(p.id).emit('state', viewFor(room, p.id));
  }
}

function startRound(room) {
  room.word = pickWord(room);
  room.status = 'playing';
  room.round += 1;
  room.winnerId = null;
  room.message = '';
  room.coop = { rows: [], turn: room.round - 1 };
  room.vs = {};
  room.done = {};
  for (const p of room.players) room.vs[p.id] = [];
  broadcast(room);
}

io.on('connection', socket => {
  let room = null;

  socket.on('create', ({ name, mode }) => {
    const code = makeCode();
    room = {
      code,
      mode: mode === 'versus' ? 'versus' : 'coop',
      hostId: socket.id,
      players: [],
      status: 'lobby',
      round: 0,
      used: new Set(),
    };
    rooms[code] = room;
    room.players.push({ id: socket.id, name: cleanName(name), wins: 0, connected: true });
    socket.join(code);
    broadcast(room);
  });

  socket.on('join', ({ name, code }) => {
    const r = rooms[(code || '').toUpperCase().trim()];
    if (!r) return socket.emit('errorMsg', 'No room with that code');
    const active = r.players.filter(p => p.connected);
    if (active.length >= 2) return socket.emit('errorMsg', 'That room is full');
    // drop any disconnected seat so a rejoin takes it
    r.players = r.players.filter(p => p.connected);
    room = r;
    room.players.push({ id: socket.id, name: cleanName(name), wins: 0, connected: true });
    if (!room.players.find(p => p.id === room.hostId)) room.hostId = socket.id;
    socket.join(room.code);
    if (room.status === 'playing') {
      // someone left mid game, restart cleanly
      room.status = 'lobby';
      room.message = 'New player joined. Host can start a round.';
    }
    broadcast(room);
  });

  socket.on('setMode', mode => {
    if (!room || socket.id !== room.hostId || room.status === 'playing') return;
    room.mode = mode === 'versus' ? 'versus' : 'coop';
    room.status = 'lobby';
    room.message = '';
    broadcast(room);
  });

  socket.on('start', () => {
    if (!room || socket.id !== room.hostId) return;
    if (room.players.filter(p => p.connected).length < 2) {
      return socket.emit('errorMsg', 'Need 2 players to start');
    }
    startRound(room);
  });

  socket.on('typing', payload => {
    if (!room || room.status !== 'playing') return;
    // Co-op: send the actual letters. Versus: only how many boxes are filled.
    if (room.mode === 'coop') {
      const letters = String(payload.letters || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
      socket.to(room.code).emit('peerTyping', { id: socket.id, letters });
    } else {
      const count = Math.max(0, Math.min(5, Number(payload.count) || 0));
      socket.to(room.code).emit('peerTyping', { id: socket.id, count });
    }
  });

  socket.on('guess', raw => {
    if (!room || room.status !== 'playing') return;
    const guess = String(raw || '').toLowerCase();
    if (!/^[a-z]{5}$/.test(guess)) return socket.emit('errorMsg', 'Need 5 letters');
    if (!VALID.has(guess)) return socket.emit('badWord', 'Not in word list');

    if (room.mode === 'coop') {
      const turnPlayer = room.players[room.coop.turn % room.players.length];
      if (turnPlayer.id !== socket.id) return socket.emit('errorMsg', "Not your turn");
      const colors = score(guess, room.word);
      room.coop.rows.push({ letters: guess, colors, by: socket.id });
      room.coop.turn += 1;
      if (guess === room.word) {
        room.status = 'over';
        room.winnerId = 'team';
        room.players.forEach(p => p.wins++);
        room.message = `You got it together in ${room.coop.rows.length}!`;
      } else if (room.coop.rows.length >= MAX_ROWS) {
        room.status = 'over';
        room.message = 'Out of guesses';
      }
      broadcast(room);
      return;
    }

    // Versus
    const rows = room.vs[socket.id];
    if (!rows || room.done[socket.id]) return;
    const colors = score(guess, room.word);
    rows.push({ letters: guess, colors });
    if (guess === room.word) {
      room.status = 'over';
      room.winnerId = socket.id;
      const me = room.players.find(p => p.id === socket.id);
      me.wins++;
      room.message = `${me.name} got it first in ${rows.length}!`;
    } else if (rows.length >= MAX_ROWS) {
      room.done[socket.id] = true;
      const allDone = room.players.every(p => room.done[p.id]);
      if (allDone) {
        room.status = 'over';
        room.message = 'Nobody got it. Draw!';
      }
    }
    broadcast(room);
  });

  socket.on('disconnect', () => {
    if (!room) return;
    const me = room.players.find(p => p.id === socket.id);
    if (me) me.connected = false;
    const still = room.players.filter(p => p.connected);
    if (still.length === 0) {
      const code = room.code;
      setTimeout(() => {
        if (rooms[code] && rooms[code].players.every(p => !p.connected)) delete rooms[code];
      }, 60000);
      return;
    }
    if (room.hostId === socket.id) room.hostId = still[0].id;
    if (room.status === 'playing') {
      room.status = 'lobby';
      room.message = `${me ? me.name : 'Your friend'} left. Waiting for someone to join.`;
    }
    broadcast(room);
  });
});

function cleanName(n) {
  return String(n || 'Player').trim().slice(0, 14) || 'Player';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('CoWordle running on ' + PORT));
