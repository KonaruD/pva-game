// ============================================================
// CONFIG — altere SERVER_HOST para o host do seu Render
// (sem "https://" e sem barra no final)
// ============================================================
const CONFIG = {
  SERVER_HOST: 'pva-server.onrender.com',
  LOCAL_PORT: 8080,
};

const ROLE_LABELS = {
  policia: 'Polícia',
  assassino: 'Assassino',
  vitima: 'Vítima',
};

const LAYOUT = {
  praca:        [0, 0], delegacia: [1, 0], mercado:    [2, 0],
  bairro_norte: [0, 1], hospital:  [1, 1], bairro_sul: [2, 1],
  estacao:      [0, 2], porto:     [1, 2], suburbio:   [2, 2],
};

// ---------- Estado global ----------
let ws = null;
let myId = null;
let state = null;

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);

function setScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

function buildServerUrl() {
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (isLocal) return `ws://localhost:${CONFIG.LOCAL_PORT}`;
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + CONFIG.SERVER_HOST;
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- Conexão ----------
function connect(name) {
  const url = buildServerUrl();
  ws = new WebSocket(url);

  ws.onopen = () => {
    send({ type: 'join', name });
  };

  ws.onclose = () => {
    const onGame = document.getElementById('game').classList.contains('active');
    if (onGame) {
      showEnd('desconexao', 'Você perdeu a conexão.');
    } else {
      $('#status').textContent = 'Desconectado. Toque em "Entrar na fila" para tentar novamente.';
      $('#joinBtn').disabled = false;
    }
  };

  ws.onerror = () => {
    $('#status').textContent = 'Falha ao conectar. O servidor pode estar iniciando (aguarde ~30s) e tente de novo.';
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
  };
}

// ---------- Mensagens do servidor ----------
function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = msg.playerId;
      $('#status').textContent = 'Conectado. Aguardando…';
      break;

    case 'lobby': {
      setScreen('lobby');
      const items = msg.players
        .map(p => `<li>${escapeHtml(p.name)}${p.id === myId ? ' <em>(você)</em>' : ''}</li>`)
        .join('');
      $('#lobbyList').innerHTML = items;
      break;
    }

    case 'gameStart':
      setScreen('game');
      break;

    case 'state':
      state = msg.state;
      render();
      break;

    case 'clue':
      toast('📌 Nova pista registrada');
      break;

    case 'event':
      toast(msg.message);
      break;

    case 'hint':
      toast('👁️ ' + msg.message);
      break;

    case 'error':
      toast('⚠️ ' + msg.message);
      break;

    case 'gameEnd':
      showEnd(msg.winner, msg.reason);
      break;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---------- Fim de jogo ----------
function showEnd(winner, reason) {
  const labels = {
    policia: '🚔 Polícia venceu',
    assassino: '🔪 Assassino venceu',
    vitima: '🕊️ Vítima sobreviveu',
    desconexao: '🔌 Partida encerrada',
  };
  $('#endTitle').textContent = labels[winner] || 'Fim de jogo';
  $('#endReason').textContent = reason || '';
  $('#endOverlay').classList.add('show');
}

// ---------- Render ----------
function render() {
  if (!state) return;
  const me = state.me;

  const roleEl = $('#roleLabel');
  roleEl.textContent = ROLE_LABELS[me.role] || '—';
  roleEl.className = 'role ' + (me.role || '');

  $('#timer').textContent = fmtTime(state.timeLeft);

  const loc = state.locations.find(l => l.id === me.position);
  if (loc) {
    $('#locName').textContent = loc.name;
  } else {
    $('#locName').textContent = '—';
  }

  const here = state.players.filter(p => p.id !== me.id && p.position === me.position);
  $('#here').textContent = here.length
    ? 'Aqui também: ' + here.map(p => p.name).join(', ')
    : '';

  renderMap();
  renderActions(loc, here, me);
  renderClues(me.clues);
}

function renderMap() {
  const locs = state.locations;
  const PAD = 8, CELL = 100;
  const w = 3 * CELL + 2 * PAD;
  const h = 3 * CELL + 2 * PAD;

  let edges = '';
  const seen = new Set();
  locs.forEach(l => {
    const [x, y] = LAYOUT[l.id];
    l.neighbors.forEach(n => {
      const key = [l.id, n].sort().join('-');
      if (seen.has(key)) return;
      seen.add(key);
      const [nx, ny] = LAYOUT[n];
      edges += `<line x1="${PAD + x * CELL + CELL / 2}" y1="${PAD + y * CELL + CELL / 2}"
        x2="${PAD + nx * CELL + CELL / 2}" y2="${PAD + ny * CELL + CELL / 2}"
        stroke="#1f2a36" stroke-width="2"/>`;
    });
  });

  let nodes = '';
  locs.forEach(l => {
    const [x, y] = LAYOUT[l.id];
    const isMe = state.me.position === l.id;
    const cx = PAD + x * CELL + CELL / 2;
    const cy = PAD + y * CELL + CELL / 2;
    const fill = isMe ? '#3b82f6' : '#131a23';
    const stroke = l.camera ? '#f59e0b' : '#1f2a36';
    nodes += `
      <circle cx="${cx}" cy="${cy}" r="22" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
      ${l.camera ? `<circle cx="${cx + 14}" cy="${cy - 14}" r="4" fill="#f59e0b"/>` : ''}
      <text x="${cx}" y="${cy + 34}" fill="#8b9bb0" font-size="9" text-anchor="middle">
        ${escapeHtml(l.name)}
      </text>`;
  });

  $('#mapWrap').innerHTML = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${edges}${nodes}</svg>`;
}

function renderActions(loc, here, me) {
  const el = $('#actions');
  el.innerHTML = '';
  if (!loc) return;

  const role = me.role;

  const makeBtn = (label, cls, onClick, disabled) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.classList.add(cls);
    if (disabled) b.disabled = true;
    else b.addEventListener('click', onClick);
    el.appendChild(b);
  };

  // Mover
  loc.neighbors.forEach(n => {
    const cdn = cdKey(me, 'move');
    const name = state.locations.find(l => l.id === n).name;
    makeBtn(`→ ${name}`, '', () => send({ action: 'move', to: n }), cdn > 0);
  });

  // Ações por papel
  if (role === 'policia') {
    const cdn = cdKey(me, 'investigate');
    makeBtn(cdn ? `Investigar (${cdn}s)` : '🔍 Investigar', 'primary',
      () => send({ action: 'investigate' }), cdn > 0);

    here.forEach(p => {
      const ca = cdKey(me, 'arrest');
      makeBtn(ca ? `Prender ${p.name} (${ca}s)` : `Prender ${p.name}`, 'danger',
        () => send({ action: 'arrest', targetId: p.id }), ca > 0);
    });
  }

  if (role === 'assassino') {
    const ct = cdKey(me, 'track');
    makeBtn(ct ? `Rastrear (${ct}s)` : '🩸 Rastrear', 'danger',
      () => send({ action: 'track' }), ct > 0);

    here.forEach(p => {
      makeBtn(`Eliminar ${p.name}`, 'danger',
        () => send({ action: 'eliminate', targetId: p.id }), false);
    });
  }

  if (role === 'vitima') {
    const ch = cdKey(me, 'hide');
    makeBtn(ch ? `Esconder (${ch}s)` : '🌫️ Esconder-se', 'safe',
      () => send({ action: 'hide' }), ch > 0);

    makeBtn(me.changedAddress ? 'Endereço já trocado' : '🏠 Mudar de endereço', 'safe',
      () => send({ action: 'changeAddress' }), !!me.changedAddress);
  }
}

function renderClues(clues) {
  $('#clueCount').textContent = `(${clues.length})`;
  $('#clueList').innerHTML = clues.length
    ? clues.map(c => `<li>${escapeHtml(c.text)}</li>`).join('')
    : '<li>Nenhuma pista ainda.</li>';
}

// ---------- Utilitários ----------
function cdKey(me, key) {
  if (!me.cooldowns || !me.cooldowns[key]) return 0;
  return Math.max(0, Math.ceil(me.cooldowns[key] / 1000));
}

function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

// ---------- Boot ----------
$('#joinBtn').addEventListener('click', () => {
  const name = $('#nameInput').value.trim();
  if (!name) {
    $('#status').textContent = 'Digite um nome para entrar.';
    return;
  }
  $('#joinBtn').disabled = true;
  $('#status').textContent = 'Conectando… (se o servidor estiver dormindo, pode levar ~30s)';
  connect(name);
});

$('#nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#joinBtn').disabled) $('#joinBtn').click();
});

// PWA Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('Service worker não registrado:', err);
    });
  });
}