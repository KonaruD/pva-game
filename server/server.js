const http = require('http');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 8080;
const GAME_DURATION = 15 * 60 * 1000;
const TICK_MS = 1000;
const TRAIL_MAX = 600;
const INVESTIGATE_WINDOW_MS = 90 * 1000;
const HIDE_DURATION_MS = 30 * 1000;
const WRONG_ARREST_PENALTY_MS = 60 * 1000;
const WRONG_ARREST_MOVE_LOCK_MS = 30 * 1000;

const COOLDOWNS = {
  move: 4000,
  investigate: 12000,
  arrest: 30000,
  track: 15000,
  hide: 20000,
  changeAddress: 0,
  eliminate: 0,
};

const LOCATIONS = [
  { id: 'praca',        name: 'Praça Central', camera: false, neighbors: ['delegacia', 'bairro_norte'] },
  { id: 'delegacia',    name: 'Delegacia',     camera: true,  neighbors: ['praca', 'mercado', 'hospital'] },
  { id: 'mercado',      name: 'Mercado',       camera: true,  neighbors: ['delegacia', 'bairro_sul'] },
  { id: 'bairro_norte', name: 'Bairro Norte',  camera: false, neighbors: ['praca', 'hospital', 'estacao'] },
  { id: 'hospital',     name: 'Hospital',      camera: false, neighbors: ['bairro_norte', 'delegacia', 'bairro_sul', 'porto'] },
  { id: 'bairro_sul',   name: 'Bairro Sul',    camera: false, neighbors: ['mercado', 'hospital', 'suburbio'] },
  { id: 'estacao',      name: 'Estação',       camera: true,  neighbors: ['bairro_norte', 'porto'] },
  { id: 'porto',        name: 'Porto',         camera: true,  neighbors: ['estacao', 'hospital', 'suburbio'] },
  { id: 'suburbio',     name: 'Subúrbio',      camera: false, neighbors: ['porto', 'bairro_sul'] },
];

const LOC_MAP = Object.fromEntries(LOCATIONS.map(l => [l.id, l]));
const rand = arr => arr[Math.floor(Math.random() * arr.length)];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function bfsDist(start, goal) {
  if (start === goal) return 0;
  const seen = new Set([start]);
  const queue = [[start, 0]];
  while (queue.length) {
    const [node, d] = queue.shift();
    for (const nb of LOC_MAP[node].neighbors) {
      if (nb === goal) return d + 1;
      if (!seen.has(nb)) { seen.add(nb); queue.push([nb, d + 1]); }
    }
  }
  return Infinity;
}

function bfsNextHop(start, goal) {
  if (start === goal) return null;
  const prev = { [start]: null };
  const queue = [start];
  while (queue.length) {
    const node = queue.shift();
    for (const nb of LOC_MAP[node].neighbors) {
      if (nb in prev) continue;
      prev[nb] = node;
      if (nb === goal) {
        let cur = goal;
        while (prev[cur] !== start) cur = prev[cur];
        return cur;
      }
      queue.push(nb);
    }
  }
  return null;
}

class Game {
  constructor(id) {
    this.id = id;
    this.players = [];
    this.phase = 'lobby';
    this.startTime = 0;
    this.timer = null;
    this.trail = [];
  }

  send(player, msg) {
    if (player.ws.readyState === 1) player.ws.send(JSON.stringify(msg));
  }

  broadcast(msg) { this.players.forEach(p => this.send(p, msg)); }

  pushStates() {
    this.players.forEach(p => this.send(p, { type: 'state', state: this.publicState(p) }));
  }

  addPlayer(ws, name) {
    if (this.players.length >= 3) return null;
    const player = {
      id: randomUUID(),
      name: (name && String(name).trim().slice(0, 16)) || 'Anônimo',
      ws,
      role: null,
      position: null,
      cooldowns: {},
      clues: [],
      alive: true,
      changedAddress: false,
      hiddenUntil: 0,
    };
    this.players.push(player);
    return player;
  }

  remainingCooldowns(player) {
    const now = Date.now();
    const out = {};
    for (const [key, until] of Object.entries(player.cooldowns)) {
      const rem = until - now;
      if (rem > 0) out[key] = rem;
    }
    return out;
  }

  publicState(viewer) {
    const reveal = (p) => {
      if (p.id === viewer.id) return p.position;
      if (p.position !== null && p.position === viewer.position) return p.position;
      return null;
    };
    return {
      phase: this.phase,
      timeLeft: this.phase === 'playing'
        ? Math.max(0, GAME_DURATION - (Date.now() - this.startTime))
        : 0,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        position: reveal(p),
        alive: p.alive,
        role: p.id === viewer.id ? p.role : null,
      })),
      me: {
        id: viewer.id,
        role: viewer.role,
        position: viewer.position,
        cooldowns: this.remainingCooldowns(viewer),
        clues: viewer.clues.slice().reverse(),
        changedAddress: viewer.changedAddress,
      },
      locations: LOCATIONS,
    };
  }

  pushTrail(playerId, locationId, hidden) {
    this.trail.push({ playerId, locationId, time: Date.now(), hidden: !!hidden });
    if (this.trail.length > TRAIL_MAX) {
      this.trail.splice(0, this.trail.length - TRAIL_MAX);
    }
  }

  start() {
    this.phase = 'playing';
    this.startTime = Date.now();
    const roles = shuffle(['policia', 'assassino', 'vitima']);
    const startLocs = shuffle(LOCATIONS);
    this.players.forEach((p, i) => {
      p.role = roles[i];
      p.position = startLocs[i].id;
      this.pushTrail(p.id, p.position, false);
    });
    this.broadcast({ type: 'gameStart' });
    this.pushStates();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  tick() {
    if (this.phase !== 'playing') return;
    if (Date.now() - this.startTime >= GAME_DURATION) {
      return this.end('vitima', 'O tempo acabou. A vítima sobreviveu.');
    }
    this.pushStates();
  }

  end(winner, reason) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.broadcast({ type: 'gameEnd', winner, reason });
  }

  handleAction(player, msg) {
    if (this.phase !== 'playing') return;
    const now = Date.now();
    const can = (k) => !player.cooldowns[k] || player.cooldowns[k] <= now;
    const setCd = (k) => { player.cooldowns[k] = now + (COOLDOWNS[k] || 0); };
    const err = (m) => this.send(player, { type: 'error', message: m });

    switch (msg.action) {
      case 'move': {
        if (!can('move')) return err('Movimento em cooldown.');
        const target = msg.to;
        if (!LOC_MAP[target] || !LOC_MAP[player.position].neighbors.includes(target)) {
          return err('Local não adjacente.');
        }
        player.position = target;
        setCd('move');
        this.pushTrail(player.id, target, now < player.hiddenUntil);
        return this.pushStates();
      }

      case 'investigate': {
        if (player.role !== 'policia') return err('Apenas a polícia investiga.');
        if (!can('investigate')) return err('Investigação em cooldown.');
        setCd('investigate');
        const cutoff = now - INVESTIGATE_WINDOW_MS;
        const seen = this.trail
          .filter(t => t.locationId === player.position
            && t.time >= cutoff
            && t.playerId !== player.id
            && !t.hidden)
          .sort((a, b) => b.time - a.time);
        let clue;
        if (!seen.length) {
          clue = {
            type: 'investigate',
            at: player.position,
            text: 'Nenhum vestígio recente por aqui.',
          };
        } else {
          const t = seen[0];
          const suspect = this.players.find(p => p.id === t.playerId);
          const label = suspect.role === 'assassino'
            ? 'um suspeito com perfil compatível com o assassino'
            : suspect.role === 'vitima'
              ? 'alguém em fuga com perfil compatível com a vítima'
              : 'uma pessoa com perfil inconclusivo';
          clue = {
            type: 'investigate',
            at: player.position,
            text: `Testemunhas: ${label} passou por aqui há pouco.`,
            seenPlayerId: suspect.id,
            seenRole: suspect.role,
          };
        }
        player.clues.push(clue);
        this.send(player, { type: 'clue', clue });
        return this.pushStates();
      }

      case 'arrest': {
        if (player.role !== 'policia') return err('Apenas a polícia prende.');
        if (!can('arrest')) return err('Prisão em cooldown.');
        const target = this.players.find(p => p.id === msg.targetId);
        if (!target || !target.alive) return err('Alvo inválido.');
        if (target.position !== player.position) return err('Alvo não está aqui.');
        setCd('arrest');
        if (target.role === 'assassino') {
          return this.end('policia', 'A polícia prendeu o assassino.');
        }
        if (target.role === 'vitima') {
          player.cooldowns.arrest = now + WRONG_ARREST_PENALTY_MS;
          player.cooldowns.move = now + WRONG_ARREST_MOVE_LOCK_MS;
          this.broadcast({
            type: 'event',
            message: `A polícia deteve uma pessoa inocente em ${LOC_MAP[player.position].name}.`,
          });
          const killer = this.players.find(p => p.role === 'assassino');
          if (killer) {
            this.send(killer, {
              type: 'hint',
              message: `A vítima estava em ${LOC_MAP[target.position].name} há instantes.`,
            });
          }
        }
        return this.pushStates();
      }

      case 'track': {
        if (player.role !== 'assassino') return err('Apenas o assassino rastreia.');
        if (!can('track')) return err('Rastreamento em cooldown.');
        setCd('track');
        const vitima = this.players.find(p => p.role === 'vitima');
        if (!vitima) return err('Alvo perdido.');
        const dist = bfsDist(player.position, vitima.position);
        const hop = bfsNextHop(player.position, vitima.position);
        const proximity = dist === 0 ? 'na sua localização'
          : dist <= 1 ? 'muito perto'
            : dist <= 2 ? 'perto'
              : dist <= 4 ? 'a média distância'
                : 'longe';
        const clue = {
          type: 'track',
          text: dist === 0
            ? 'A vítima está na sua localização agora.'
            : `A vítima está ${proximity}. O rastro aponta para ${hop ? LOC_MAP[hop].name : '—'}.`,
          dist,
          nextHop: hop,
        };
        player.clues.push(clue);
        this.send(player, { type: 'clue', clue });
        return this.pushStates();
      }

      case 'hide': {
        if (player.role !== 'vitima') return err('Apenas a vítima se esconde.');
        if (!can('hide')) return err('Esconder-se em cooldown.');
        setCd('hide');
        player.hiddenUntil = now + HIDE_DURATION_MS;
        return this.pushStates();
      }

      case 'changeAddress': {
        if (player.role !== 'vitima') return err('Apenas a vítima muda de endereço.');
        if (player.changedAddress) return err('Você já mudou de endereço.');
        const killer = this.players.find(p => p.role === 'assassino');
        const candidates = LOCATIONS.filter(l =>
          l.id !== player.position && (!killer || l.id !== killer.position)
        );
        if (!candidates.length) return err('Não foi possível mudar.');
        player.changedAddress = true;
        this.trail.forEach(t => { if (t.playerId === player.id) t.hidden = true; });
        player.position = rand(candidates).id;
        this.pushTrail(player.id, player.position, true);
        this.broadcast({ type: 'event', message: 'Rumores de que alguém mudou de endereço.' });
        return this.pushStates();
      }

      case 'eliminate': {
        if (player.role !== 'assassino') return err('Apenas o assassino elimina.');
        const target = this.players.find(p => p.id === msg.targetId);
        if (!target || !target.alive) return err('Alvo inválido.');
        if (target.position !== player.position) return err('Alvo não está aqui.');
        if (target.role === 'vitima') {
          return this.end('assassino', 'A vítima foi eliminada.');
        }
        if (target.role === 'policia') {
          return this.end('policia', 'O assassino atacou a pessoa errada.');
        }
        return err('Nada a fazer.');
      }

      default:
        return err('Ação desconhecida.');
    }
  }
}

const rooms = new Map();

function findOrCreateRoom() {
  for (const room of rooms.values()) {
    if (room.phase === 'lobby' && room.players.length < 3) return room;
  }
  const room = new Game(randomUUID());
  rooms.set(room.id, room);
  return room;
}

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('PVA server running\n');
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let player = null;
  let game = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join' && !player) {
      game = findOrCreateRoom();
      player = game.addPlayer(ws, msg.name);
      if (!player) {
        ws.send(JSON.stringify({ type: 'error', message: 'Sala cheia.' }));
        return;
      }
      ws.send(JSON.stringify({ type: 'welcome', playerId: player.id, roomId: game.id }));
      if (game.players.length === 3) {
        game.start();
      } else {
        game.broadcast({
          type: 'lobby',
          players: game.players.map(p => ({ id: p.id, name: p.name })),
        });
      }
      return;
    }

    if (player && game && msg.type === 'action') {
      game.handleAction(player, msg);
    }
  });

  ws.on('close', () => {
    if (!game || !player) return;
    game.players = game.players.filter(p => p.id !== player.id);
    if (game.phase === 'playing') {
      game.end('desconexao', 'Um jogador desconectou.');
    }
    if (game.players.length === 0) {
      if (game.timer) clearInterval(game.timer);
      rooms.delete(game.id);
    } else {
      game.broadcast({
        type: 'lobby',
        players: game.players.map(p => ({ id: p.id, name: p.name })),
      });
    }
  });

  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

httpServer.listen(PORT, () => {
  console.log(`PVA server on port ${PORT}`);
});