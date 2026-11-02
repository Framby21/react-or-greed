const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Game, CONFIG } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map(); // code -> room
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name, room) {
  let base = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 16) || 'Joueur';
  let candidate = base;
  let i = 2;
  while (room && room.players.some((p) => p.name.toLowerCase() === candidate.toLowerCase())) {
    candidate = `${base.slice(0, 13)} ${i++}`;
  }
  return candidate;
}

const connectedIds = (room) => room.players.filter((p) => p.socketId).map((p) => p.id);

function broadcast(room) {
  const base = {
    code: room.code,
    hostId: room.hostId,
    players: room.players.map((p) => ({ id: p.id, name: p.name, connected: !!p.socketId })),
    config: { minPlayers: CONFIG.minPlayers, maxPlayers: CONFIG.maxPlayers },
  };
  for (const p of room.players) {
    if (!p.socketId) continue;
    const timeLeftMs = room.deadline ? Math.max(0, room.deadline - Date.now()) : null;
    const timeTotalMs = room.game ? (CONFIG.timers[room.game.phase] || 0) * 1000 : null;
    io.to(p.socketId).emit('state', {
      ...base,
      myId: p.id,
      game: room.game ? { ...room.game.viewFor(p.id), timeLeftMs, timeTotalMs } : null,
    });
  }
}

function schedule(room) {
  clearTimeout(room.timer);
  room.deadline = null;
  const game = room.game;
  if (!game || game.phase === 'ended') return;
  const secs = CONFIG.timers[game.phase];
  room.deadline = Date.now() + secs * 1000;
  room.timer = setTimeout(() => {
    if (connectedIds(room).length === 0) { room.paused = true; return; }
    game.advance();
    schedule(room);
    broadcast(room);
  }, secs * 1000);
}

// Avance automatiquement si tous les joueurs connectés ont agi
function checkProgress(room) {
  const game = room.game;
  if (game && game.isPhaseComplete(connectedIds(room))) {
    game.advance();
    schedule(room);
  }
  broadcast(room);
}

function findPlayer(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return {};
  return { room, player: room.players.find((p) => p.id === socket.data.playerId) };
}

io.on('connection', (socket) => {
  const fail = (msg) => socket.emit('errorMsg', msg);

  function attach(room, player) {
    player.socketId = socket.id;
    socket.data.code = room.code;
    socket.data.playerId = player.id;
    socket.join(room.code);
    if (room.paused) { room.paused = false; schedule(room); }
  }

  socket.on('create', ({ name, token } = {}) => {
    if (!token) return fail('Session invalide.');
    const room = { code: newCode(), players: [], hostId: null, game: null, timer: null, deadline: null };
    const player = { id: crypto.randomUUID().slice(0, 8), token, name: cleanName(name), socketId: null };
    room.players.push(player);
    room.hostId = player.id;
    rooms.set(room.code, room);
    attach(room, player);
    broadcast(room);
  });

  socket.on('join', ({ code, name, token } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return fail('Salon introuvable.');
    if (!token) return fail('Session invalide.');
    let player = room.players.find((p) => p.token === token);
    if (!player) {
      if (room.game) return fail('Une partie est déjà en cours dans ce salon.');
      if (room.players.length >= CONFIG.maxPlayers) return fail('Le salon est plein (12 joueurs max).');
      player = { id: crypto.randomUUID().slice(0, 8), token, name: cleanName(name, room), socketId: null };
      room.players.push(player);
      if (!room.hostId) room.hostId = player.id;
    }
    attach(room, player);
    broadcast(room);
  });

  // L'hôte agit ; s'il est déconnecté, n'importe quel joueur peut le remplacer
  const canHost = (room, player) => room.hostId === player.id
    || !room.players.some((p) => p.id === room.hostId && p.socketId);

  socket.on('start', () => {
    const { room, player } = findPlayer(socket);
    if (!room || !player || !canHost(room, player) || room.game) return;
    room.hostId = player.id;
    room.players = room.players.filter((p) => p.socketId); // on retire les absents
    const n = room.players.length;
    if (n < CONFIG.minPlayers || n > CONFIG.maxPlayers) return fail(`Il faut entre ${CONFIG.minPlayers} et ${CONFIG.maxPlayers} joueurs.`);
    room.game = new Game(room.players.map((p) => p.id));
    schedule(room);
    broadcast(room);
  });

  socket.on('insert', (cardId) => {
    const { room, player } = findPlayer(socket);
    if (room?.game?.insert(player.id, cardId)) checkProgress(room);
  });

  socket.on('cut', (targetId) => {
    const { room, player } = findPlayer(socket);
    if (room?.game?.cut(player.id, targetId ?? null)) checkProgress(room);
  });

  socket.on('ready', () => {
    const { room, player } = findPlayer(socket);
    if (room?.game?.ready(player.id)) checkProgress(room);
  });

  socket.on('backToLobby', () => {
    const { room, player } = findPlayer(socket);
    if (!room || !player || !canHost(room, player) || room.game?.phase !== 'ended') return;
    room.hostId = player.id;
    clearTimeout(room.timer);
    room.game = null;
    room.deadline = null;
    room.players = room.players.filter((p) => p.socketId);
    if (!room.players.some((p) => p.id === room.hostId)) room.hostId = room.players[0]?.id ?? null;
    broadcast(room);
  });

  socket.on('leave', () => leave(true));
  socket.on('disconnect', () => leave(false));

  function leave(explicit) {
    const { room, player } = findPlayer(socket);
    if (!room || !player || player.socketId !== socket.id) return;
    player.socketId = null;
    socket.leave(room.code);
    socket.data.code = null;
    // Dans le salon d'attente, un départ volontaire retire le joueur
    if (!room.game && explicit) {
      room.players = room.players.filter((p) => p !== player);
    }
    if (explicit && room.hostId === player.id) {
      const next = room.players.find((p) => p.socketId);
      if (next) room.hostId = next.id;
    }
    if (room.players.length === 0) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
      return;
    }
    checkProgress(room);
  }
});

// Nettoyage des salons vides depuis plus de 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (connectedIds(room).length === 0) {
      room.emptySince ??= now;
      if (now - room.emptySince > 30 * 60 * 1000) {
        clearTimeout(room.timer);
        rooms.delete(code);
      }
    } else {
      room.emptySince = null;
    }
  }
}, 60 * 1000);

// En local : accessible uniquement depuis ce PC. Sur un hébergeur (qui définit PORT) : accessible publiquement.
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
server.listen(PORT, HOST, () => console.log(`React or Greed sur http://localhost:${PORT} (écoute sur ${HOST})`));
