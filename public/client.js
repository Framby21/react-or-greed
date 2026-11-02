/* global io */
const socket = io();
const app = document.getElementById('app');
const fxLayer = document.getElementById('fx');

// ============ Session persistante (reconnexion) ============
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
let token = store.get('rog-token');
if (!token) {
  token = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  store.set('rog-token', token);
}

let state = null;
let selectedTarget = null;
let selCount = 0;
let roleHidden = false;
let localDeadline = null;
let localTotal = null;
let lastPhaseKey = null;
let tutoStep = null;
let lastFound = {}; // gid -> dernière valeur affichée de la jauge

// ---- Icônes vectorielles (rendu identique sur tous les appareils) ----
function trefoil() {
  const P = (r, a) => `${(32 + r * Math.cos(a)).toFixed(2)} ${(32 + r * Math.sin(a)).toFixed(2)}`;
  const rad = (d) => (d * Math.PI) / 180;
  return [-90, 30, 150].map((c) => {
    const a1 = rad(c - 30); const a2 = rad(c + 30);
    return `<path d="M${P(9, a1)} L${P(27, a1)} A27 27 0 0 1 ${P(27, a2)} L${P(9, a2)} A9 9 0 0 0 ${P(9, a1)}Z" fill="currentColor"/>`;
  }).join('');
}
const SVG = {
  atomic: `<svg class="svg-atomic" viewBox="0 0 64 64" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="3.2">
    <ellipse cx="32" cy="32" rx="27" ry="10"/><ellipse cx="32" cy="32" rx="27" ry="10" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="27" ry="10" transform="rotate(120 32 32)"/></g>
    <circle cx="32" cy="32" r="5.5" fill="currentColor"/></svg>`,
  nuclear: `<svg class="svg-nuclear" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" stroke-width="2.5"/>${trefoil()}<circle cx="32" cy="32" r="5" fill="currentColor"/></svg>`,
  empty: '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="7 6"/></svg>',
};
// Remplace les emojis ⚛️ / ▫️ (rendu inégal selon l'OS) par les icônes vectorielles
const emo = (html) => html
  .replace(/⚛️/g, `<span class="ico atomic">${SVG.atomic}</span>`)
  .replace(/▫️/g, `<span class="ico empty">${SVG.empty}</span>`);

const CARD = {
  atomic: { icon: SVG.atomic, label: 'Atomique' },
  nuclear: { icon: SVG.nuclear, label: 'Nucléaire' },
  empty: { icon: SVG.empty, label: 'Vide' },
};
const ROLE = {
  good: { label: 'Gentil', icon: '🛡️', goal: 'Faites révéler les ⚛️ Atomiques.' },
  bad: { label: 'Méchant', icon: '💀', goal: 'Faites révéler la ☢️ Nucléaire… ou tenez 4 manches.' },
  neutral: { label: 'Neutre', icon: '🎭', goal: 'Ton ✂️ sur la ☢️ quand elle sort = victoire solo. Sinon tu gagnes avec les méchants.' },
};
const TEAM = { good: '🛡️ Les gentils gagnent !', bad: '💀 Les méchants gagnent !', neutral: '🎭 Le neutre gagne seul !' };
const TEAM_COLOR = { good: ['#4fa8ff', '#9fd0ff', '#ffffff'], bad: ['#ff5068', '#ff4d2e', '#ffcc33'], neutral: ['#c792ea', '#f0c6ff', '#ffcc33'] };
const PHASE = { insertion: 'Insertion', debate: 'Débat', cut: 'Coupe', reveal: 'Révélation', ended: 'Fin de partie' };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ============ Sons (générés, aucun fichier) ============
let muted = store.get('rog-muted') === '1';
let ac = null;
function audio() {
  if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
function tone(freq, dur = 0.12, type = 'sine', vol = 0.12, slideTo = null, when = 0) {
  if (muted) return;
  const c = audio(); if (!c) return;
  const t = c.currentTime + when;
  const o = c.createOscillator(); const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t); o.stop(t + dur + 0.05);
}
function noise(dur = 0.6, vol = 0.3, freq = 900) {
  if (muted) return;
  const c = audio(); if (!c) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const s = c.createBufferSource(); s.buffer = buf;
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
  const g = c.createGain(); g.gain.value = vol;
  s.connect(f).connect(g).connect(c.destination);
  s.start();
}
const SFX = {
  click: () => tone(620, 0.05, 'triangle', 0.06),
  deal: () => tone(1300, 0.05, 'triangle', 0.04, 700),
  insert: () => tone(240, 0.14, 'sine', 0.14, 110),
  snip: () => { tone(2000, 0.04, 'square', 0.04, 900); tone(1500, 0.05, 'square', 0.04, 700, 0.07); },
  pop: () => tone(900, 0.06, 'sine', 0.06, 1400),
  flip: () => tone(380, 0.14, 'triangle', 0.06, 950),
  atomic: () => [784, 988, 1319, 1568].forEach((f, i) => tone(f, 0.28, 'sine', 0.09, null, i * 0.06)),
  empty: () => tone(190, 0.2, 'sine', 0.09, 120),
  boom: () => { noise(1.6, 0.7, 600); tone(110, 1.2, 'sine', 0.35, 28); },
  whoosh: () => noise(0.35, 0.07, 2600),
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.32, 'triangle', 0.1, null, i * 0.11)),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.38, 'sawtooth', 0.05, null, i * 0.17)),
  tick: () => tone(1100, 0.03, 'square', 0.03),
};
document.addEventListener('click', (e) => { if (e.target.closest('button')) SFX.click(); }, true);

// ============ Moteur d'animations (survit aux re-rendus) ============
// Chaque animation est identifiée par une clé : son heure de départ est mémorisée,
// donc un re-rendu la fait reprendre là où elle en était au lieu de recommencer.
const animStart = new Map();
function startOf(key, base) {
  if (!animStart.has(key)) animStart.set(key, base ?? performance.now());
  return animStart.get(key);
}
function A(key, name, dur, { delay = 0, ease = 'var(--ease-out)', base } = {}) {
  const t = performance.now() - startOf(key, base) - delay;
  if (t >= dur) return '';
  return `animation:${name} ${dur}ms ${ease} ${Math.round(-t)}ms both;`;
}
const fired = new Set();
function once(key, at, fn, base) {
  if (fired.has(key)) return;
  fired.add(key);
  const remaining = (base ?? performance.now()) + at - performance.now();
  if (remaining < -600) return; // événement déjà passé (reconnexion) : on ne le rejoue pas
  setTimeout(fn, Math.max(0, remaining));
}

// ============ Effets visuels ============
function flash() {
  const el = document.createElement('div');
  el.className = 'flash';
  el.style.animation = 'flash 1.3s ease-out both';
  fxLayer.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}
function shake() {
  app.style.animation = 'none';
  void app.offsetWidth;
  app.style.animation = 'shake .7s both';
  setTimeout(() => { app.style.animation = ''; }, 800);
}
function burst(seatId, color, count = 18) {
  const target = app.querySelector(`[data-seat="${seatId}"] .slot`);
  if (!target) return;
  const r = target.getBoundingClientRect();
  const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    const size = 4 + Math.random() * 6;
    Object.assign(p.style, {
      position: 'absolute', left: `${cx}px`, top: `${cy}px`, width: `${size}px`, height: `${size}px`,
      borderRadius: '50%', background: color, boxShadow: `0 0 10px ${color}`,
    });
    fxLayer.appendChild(p);
    const a = Math.random() * Math.PI * 2; const d = 40 + Math.random() * 90;
    p.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d}px)) scale(0)`, opacity: 0 },
    ], { duration: 700 + Math.random() * 400, easing: 'cubic-bezier(.2,.8,.2,1)' }).onfinish = () => p.remove();
  }
}
function confetti(colors) {
  for (let i = 0; i < 90; i++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    c.style.left = `${Math.random() * 100}vw`;
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--drift', `${(Math.random() - 0.5) * 200}px`);
    c.style.setProperty('--rot', `${Math.random() * 1080 - 540}deg`);
    c.style.animation = `confetti ${2.2 + Math.random() * 2}s cubic-bezier(.3,.6,.5,1) ${Math.random() * 0.8}s both`;
    fxLayer.appendChild(c);
    setTimeout(() => c.remove(), 5500);
  }
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ============ Composants ============
function hue(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }
const avatar = (p) => `<span class="avatar" style="background:hsl(${hue(p.id)} 75% 62%)">${esc((p.name || '?')[0].toUpperCase())}</span>`;

function card(c, { size = '', down = false, cls = '', style = '', innerStyle = '', attrs = '' } = {}) {
  const front = c ? `<div class="face front ${c.type}"><span class="icon">${CARD[c.type].icon}</span>${CARD[c.type].label}</div>` : '';
  return `<div class="card ${size} ${down ? 'down' : ''} ${cls}" style="${style}" ${attrs}><div class="inner" style="${innerStyle}">${front}<div class="face back"></div></div></div>`;
}
const roleCard = (role, innerStyle = '') => `<div class="role-card"><div class="inner" style="${innerStyle}"><div class="face front">${ROLE[role].icon}</div><div class="face back"></div></div></div>`;
const waiting = (n, total) => `<div class="waiting"><span class="dots"><span></span><span></span><span></span></span> En attente des autres (${n}/${total})</div>`;
const logo = () => '<h1 class="logo"><span class="react">React</span><span class="or">or</span><span class="greed">Greed</span></h1>';

// ============ Réseau ============
socket.on('connect', () => {
  const code = store.get('rog-room');
  if (code) socket.emit('join', { code, name: store.get('rog-name'), token });
  else render();
});
socket.on('state', (s) => {
  const firstLobby = !state && !s.game;
  state = s;
  store.set('rog-room', s.code);
  const g = s.game;
  const key = g ? `${g.id}-${g.round}-${g.phase}` : 'lobby';
  if (key !== lastPhaseKey) { selectedTarget = null; lastPhaseKey = key; }
  localDeadline = g && g.timeLeftMs != null ? Date.now() + g.timeLeftMs : null;
  localTotal = g ? g.timeTotalMs : null;
  render();
  if (firstLobby && !store.get('rog-tuto-seen')) openTuto();
});
socket.on('errorMsg', (msg) => {
  toast(msg);
  if (!state) { store.del('rog-room'); render(); }
});

// ============ Rendu ============
function render() {
  if (!state) renderHome();
  else if (!state.game) renderLobby();
  else renderGame();  const t = document.getElementById('tutoBtn');
  if (t) t.onclick = openTuto;
  const m = document.getElementById('muteBtn');
  if (m) m.onclick = () => { muted = !muted; store.set('rog-muted', muted ? '1' : '0'); render(); };
}
const iconButtons = () => `<div class="row" style="justify-content:flex-end">
  <button class="link" id="muteBtn" title="Son">${muted ? '🔇' : '🔊'}</button>
  <button class="link" id="tutoBtn">❓ Comment jouer</button></div>`;

function renderHome() {
  const code = new URLSearchParams(location.search).get('room') || '';
  app.innerHTML = `
    ${iconButtons()}
    <div class="home stack">
      <div class="center">
        <div class="reactor-icon">☢️</div>
        ${logo()}
        <div class="home-cards">
          ${card({ type: 'atomic' })}${card(null, { down: true })}${card({ type: 'nuclear' })}
        </div>
        <p class="tagline muted">Bluff · Trahison · Réacteur instable<br>3 à 12 joueurs</p>
      </div>
      <div class="panel stack">
        <input id="name" maxlength="16" placeholder="Ton pseudo" value="${esc(store.get('rog-name') || '')}">
        <button class="primary" id="create" style="width:100%">⚡ Créer un salon</button>
        <div class="row">
          <input id="code" class="code" maxlength="4" placeholder="CODE" value="${esc(code)}">
          <button id="join" style="flex:1">Rejoindre →</button>
        </div>
      </div>
    </div>`;
  const nameEl = document.getElementById('name');
  const getName = () => {
    const n = nameEl.value.trim();
    if (!n) { toast('Choisis un pseudo 🙂'); nameEl.focus(); return null; }
    store.set('rog-name', n);
    return n;
  };
  document.getElementById('create').onclick = () => { const name = getName(); if (name) socket.emit('create', { name, token }); };
  const join = () => {
    const name = getName();
    const c = document.getElementById('code').value.trim().toUpperCase();
    if (!name) return;
    if (c.length !== 4) return toast('Le code fait 4 lettres.');
    socket.emit('join', { code: c, name, token });
  };
  document.getElementById('join').onclick = join;
  document.getElementById('code').onkeydown = (e) => { if (e.key === 'Enter') join(); };
  if (code) nameEl.focus();
}

function isHost() {
  const host = state.players.find((p) => p.id === state.hostId);
  return state.hostId === state.myId || !host || !host.connected;
}
function leaveRoom() {
  socket.emit('leave');
  store.del('rog-room');
  state = null;
  history.replaceState(null, '', location.pathname);
  render();
}

function renderLobby() {
  const { players, config } = state;
  const connected = players.filter((p) => p.connected).length;
  const canStart = connected >= config.minPlayers && connected <= config.maxPlayers;
  const link = `${location.origin}${location.pathname}?room=${state.code}`;
  app.innerHTML = `
    ${iconButtons()}
    <div class="center" style="margin-bottom:16px">${logo()}</div>
    <div class="panel center stack">
      <div class="muted">Code du salon</div>
      <div class="big-code">${state.code}</div>
      <button id="copy">📋 Copier le lien d'invitation</button>
    </div>
    <div class="panel">
      <h2>Joueurs · ${connected}/${config.maxPlayers}</h2>
      <ul class="players">
        ${players.map((p) => `<li class="${p.connected ? '' : 'off'}" style="${A(`lob-${p.id}`, 'pop', 400, { ease: 'var(--ease-back)' })}">
          ${avatar(p)}<span>${esc(p.name)}${p.id === state.myId ? ' <span class="muted">(toi)</span>' : ''}</span>${p.id === state.hostId ? ' 👑' : ''}</li>`).join('')}
      </ul>
    </div>
    <div class="panel center stack">
      ${isHost()
        ? `<button class="primary ${canStart ? 'pulse' : ''}" id="start" ${canStart ? '' : 'disabled'}>🚀 Lancer la partie</button>
           ${canStart ? '' : `<div class="muted">Minimum ${config.minPlayers} joueurs</div>`}`
        : '<div class="waiting" style="justify-content:center"><span class="dots"><span></span><span></span><span></span></span> L\'hôte va lancer la partie…</div>'}
      <button class="link" id="leave">Quitter le salon</button>
    </div>`;
  document.getElementById('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Lien copié ! Envoie-le à tes potes 🎉'); } catch { prompt('Copie ce lien :', link); }
  };
  document.getElementById('leave').onclick = leaveRoom;
  const startBtn = document.getElementById('start');
  if (startBtn) startBtn.onclick = () => socket.emit('start');
  for (const p of players) once(`lobs-${p.id}`, 0, SFX.pop);
}

const nameOf = (id) => esc(state.players.find((p) => p.id === id)?.name ?? '?');
const playerOf = (id) => state.players.find((p) => p.id === id) || { id, name: '?' };

function renderGame() {
  const g = state.game;
  const me = g.me;
  const gid = g.id;
  const R = g.round;
  const now = performance.now();
  const connectedById = Object.fromEntries(state.players.map((p) => [p.id, p.connected]));
  const actedCount = g.seats.filter((s) => s.acted).length;
  const isRevealPhase = g.phase === 'reveal' || g.phase === 'ended';

  // --- Chronologie de la révélation ---
  const thisRound = isRevealPhase ? g.revealed.filter((r) => r.round === R) : [];
  const revealIdx = Object.fromEntries(thisRound.map((r, i) => [r.ownerId, i]));
  const FLIP0 = 900; const GAP = 1000;
  const rBase = isRevealPhase ? startOf(`${gid}-r${R}`) : now;
  const revealDone = FLIP0 + thisRound.length * GAP + 250;
  const hasNuke = thisRound.some((r) => r.card.type === 'nuclear');
  const endAt = revealDone + (hasNuke ? 1400 : 300);
  const revealOver = now >= rBase + revealDone;
  if (isRevealPhase) {
    once(`${gid}-rr${R}`, revealDone, render, rBase);
    once(`${gid}-re${R}`, endAt, render, rBase);
    once(`${gid}-tp${R}`, 150, SFX.pop, rBase);
  }

  // --- Bannière de phase ---
  let banner = '';
  if (['insertion', 'debate', 'cut'].includes(g.phase)) {
    const bKey = `${gid}-b${R}-${g.phase}`;
    const st = A(bKey, 'bannerInOut', 1700);
    if (st) {
      const sub = g.phase === 'insertion' ? `MANCHE ${R} / ${g.rounds}` : `MANCHE ${R}`;
      const icon = { insertion: '📥', debate: '🗣️', cut: '✂️' }[g.phase];
      banner = `<div class="phase-banner" style="${st}"><div class="sub">${sub}</div><div class="main">${icon} ${PHASE[g.phase]}</div></div>`;
    }
    once(bKey, 0, SFX.whoosh);
  }

  // --- Barres du réacteur ---
  const bars = g.seats.map((s) => {
    const p = playerOf(s.id);
    const isMe = s.id === state.myId;
    const cls = ['bar'];
    if (isMe) cls.push('me');
    if (!connectedById[s.id]) cls.push('off');
    const selectable = g.phase === 'cut' && !me.acted && !isMe && s.hasBar;
    if (selectable) cls.push('selectable');
    const target = g.phase === 'cut' ? (me.acted ? me.token : selectedTarget) : null;
    if (target === s.id) cls.push('selected');

    const rc = s.revealedCard;
    let slot;
    if (rc) {
      const flipAt = FLIP0 + (revealIdx[s.id] ?? 0) * GAP;
      if (now >= rBase + flipAt + 500) cls.push(`hit-${rc.type}`);
      slot = card(rc, { size: 'sm', innerStyle: A(`${gid}-f${R}-${s.id}`, 'flipUp', 650, { delay: flipAt, base: rBase, ease: 'var(--ease-back)' }) });
      once(`${gid}-sf${R}-${s.id}`, flipAt, SFX.flip, rBase);
      once(`${gid}-sx${R}-${s.id}`, flipAt + 380, () => {
        if (rc.type === 'atomic') { SFX.atomic(); burst(s.id, '#4dff8f'); render(); }
        else if (rc.type === 'nuclear') { SFX.boom(); flash(); shake(); burst(s.id, '#ff4d2e', 40); render(); }
        else { SFX.empty(); render(); }
      }, rBase);
    } else if (isMe && me.bar) {
      slot = card(me.bar, { size: 'sm', style: A(`${gid}-i${R}-${s.id}`, 'dropIn', 450) });
    } else if (s.hasBar || (g.phase === 'insertion' && s.acted)) {
      slot = card(null, { size: 'sm', down: true, style: A(`${gid}-i${R}-${s.id}`, 'dropIn', 450) });
      once(`${gid}-is${R}-${s.id}`, 0, SFX.insert);
    } else {
      slot = '<div class="slot-empty">?</div>';
    }

    let tokens = '';
    if (s.tokens !== null && s.tokens > 0) {
      const ok = s.tokens >= g.threshold && s.tokens % 2 === 1;
      const label = ok ? '✓ validée' : s.tokens < g.threshold ? 'trop peu' : 'pair ✗';
      const dots = Array.from({ length: s.tokens }, (_, j) => `<span class="tok" style="${A(`${gid}-t${R}-${s.id}-${j}`, 'pop', 300, { delay: 100 + j * 70, base: rBase, ease: 'var(--ease-back)' })}"></span>`).join('');
      tokens = `<div class="tokens ${ok ? 'ok' : ''}">${dots}</div><div class="tok-label">${label}</div>`;
    }
    const chip = target === s.id ? `<span class="chip-drop" style="${A(`${gid}-sel${selCount}`, 'chipDrop', 450, { ease: 'var(--ease-back)' })}">✂️</span>` : '';
    const check = ['debate', 'cut', 'reveal'].includes(g.phase) && s.acted && !chip
      ? `<span class="check" style="${A(`${gid}-ok${R}${g.phase}${s.id}`, 'pop', 350, { ease: 'var(--ease-back)' })}">✓</span>` : '';

    return `<div class="${cls.join(' ')}" data-seat="${s.id}">
      ${chip}${check}
      <div class="name">${avatar(p)}<span>${esc(p.name)}</span></div>
      <div class="meta">🂠 ${s.handCount}${isMe ? ' · <span class="my-tag">toi</span>' : ''}</div>
      <div class="info">${tokens}</div>
      <div class="slot">${slot}</div>
    </div>`;
  }).join('');

  // --- Zone d'action ---
  let action = '';
  switch (g.phase) {
    case 'insertion':
      action = me.acted ? waiting(actedCount, g.seats.length)
        : '<div class="action">👇 <b>Choisis une carte</b> à glisser dans ta barre</div>';
      break;
    case 'debate':
      action = `<div class="action">🗣️ <b>Bluffez !</b> Annoncez ce que vous avez mis… vrai ou faux.</div>
        ${me.acted ? waiting(actedCount, g.seats.length) : '<button class="primary pulse" id="ready">✅ Prêt pour la coupe</button>'}`;
      break;
    case 'cut':
      action = me.acted
        ? `<div class="action">${me.token ? `✂️ Ton jeton est sur <b>${nameOf(me.token)}</b>` : '🙅 Tu ne coupes pas'}</div>${waiting(actedCount, g.seats.length)}`
        : `<div class="action">✂️ <b>Touche une barre</b> pour y poser ton jeton</div>
           <div class="rule-chips">
             <span class="rchip">🎯 ${g.threshold}+ jeton${g.threshold > 1 ? 's' : ''}</span>
             <span class="rchip">🔢 nombre impair</span>
             <span class="rchip">📦 max ${g.cap} barre${g.cap > 1 ? 's' : ''}</span>
           </div>
           <div class="row">
             <button class="primary" id="confirmCut" ${selectedTarget ? '' : 'disabled'}>✂️ Couper${selectedTarget ? ` ${nameOf(selectedTarget)}` : ''}</button>
             <button id="skipCut">🙅 Ne pas couper</button>
           </div>`;
      break;
    case 'reveal':
      if (!revealOver) {
        action = `<div class="action">🎲 <b>Révélation…</b></div>`;
      } else {
        const counts = { atomic: 0, empty: 0 };
        thisRound.forEach((r) => { counts[r.card.type]++; });
        const summary = thisRound.length
          ? `${counts.atomic ? `<span class="rchip big atomic">⚛️ ×${counts.atomic}</span>` : ''}${counts.empty ? `<span class="rchip big">▫️ ×${counts.empty}</span>` : ''}`
          : '<span class="rchip big">😶 Rien de révélé</span>';
        action = `<div class="row" style="${A(`${gid}-sum${R}`, 'fadeUp', 400)}">${summary}
            <span class="muted">${R < g.rounds ? '🔀 Mélange puis manche suivante' : '⏳ Dernière manche terminée'}</span></div>
          ${me.acted ? waiting(actedCount, g.seats.length) : '<button class="primary pulse" id="ready">➡️ Continuer</button>'}`;
      }
      break;
    case 'ended': {
      const w = g.winner;
      if (now < rBase + endAt) {
        action = `<div class="action">🎲 <b>Révélation…</b></div>`;
      } else {
        const iWon = w.team === 'good' ? me.role === 'good' : w.team === 'bad' ? me.role !== 'good' : me.role === 'neutral';
        once(`${gid}-win`, 0, () => { confetti(TEAM_COLOR[w.team]); (iWon ? SFX.win : SFX.lose)(); });
        const isWinner = (id) => (w.team === 'good' ? g.roles[id] === 'good' : w.team === 'bad' ? g.roles[id] !== 'good' : g.roles[id] === 'neutral');
        action = `<div class="end-banner ${w.team}" style="${A(`${gid}-eb`, 'zoomIn', 600, { ease: 'var(--ease-back)' })}">${TEAM[w.team]}</div>
          <div style="${A(`${gid}-er`, 'fadeUp', 400, { delay: 300 })}">${esc(w.reason)} <b>${iWon ? '🎉 Victoire !' : '😵 Défaite…'}</b></div>
          <ul class="players">
            ${g.seats.map((s, i) => `<li class="${isWinner(s.id) ? 'winner' : ''}" style="${A(`${gid}-el${s.id}`, 'fadeUp', 400, { delay: 500 + i * 90 })}">
              ${avatar(playerOf(s.id))}<span style="flex:1">${nameOf(s.id)}</span><span class="role-pill ${g.roles[s.id]}">${ROLE[g.roles[s.id]].icon} ${ROLE[g.roles[s.id]].label}</span></li>`).join('')}
          </ul>
          <div class="row">
            ${isHost() ? '<button class="primary pulse" id="again">🔁 Nouvelle partie</button>' : '<span class="muted">L\'hôte peut relancer une partie.</span>'}
            <button class="link" id="leave">Quitter</button>
          </div>`;
      }
      break;
    }
  }

  // --- Jauge d'Atomiques (animée après les retournements) ---
  const pct = (v) => Math.round(100 * Math.min(1, v / g.atomicsNeeded));
  const mKey = `${gid}-m${g.atomicsFound}`;
  if (!animStart.has(mKey)) {
    meterFrom.set(mKey, lastFound[gid] ?? g.atomicsFound);
    startOf(mKey, isRevealPhase ? rBase + revealDone - 300 : now);
  }
  const from = meterFrom.get(mKey);
  const meterShown = isRevealPhase && !revealOver ? from : g.atomicsFound;
  lastFound[gid] = g.atomicsFound;

  // --- Main ---
  const canInsert = g.phase === 'insertion' && !me.acted;
  const hand = me.hand.length
    ? me.hand.map((c, i) => {
      const dKey = `${gid}-d${R}-${c.id}`;
      const delay = (R === 1 ? 1500 : 500) + i * 110;
      once(`${dKey}s`, delay, SFX.deal);
      return card(c, { cls: canInsert ? 'clickable' : '', attrs: `data-card="${c.id}"`, style: A(dKey, 'deal', 600, { delay, ease: 'var(--ease-back)' }) });
    }).join('')
    : '<span class="muted">Aucune carte.</span>';

  // --- Historique ---
  const byRound = {};
  for (const r of g.revealed) if (r.round < R || revealOver || !isRevealPhase) (byRound[r.round] ||= []).push(r);
  const historyHtml = Object.keys(byRound).length
    ? Object.entries(byRound).map(([round, list]) => `<div class="line"><span class="round-tag">Manche ${round}</span>
        ${list.map((r) => `<div>${card(r.card, { size: 'sm' })}<div class="who">${nameOf(r.ownerId)}</div></div>`).join('')}</div>`).join('')
    : '<div class="muted">Rien pour l\'instant…</div>';

  const role = ROLE[me.role];
  app.innerHTML = emo(`
    ${banner}
    <div class="panel topbar">
      <div>
        <div class="muted" style="font-size:.85rem">Manche ${Math.min(R, g.rounds)}/${g.rounds} · ${state.code}
          <button class="link" id="muteBtn" title="Son">${muted ? '🔇' : '🔊'}</button><button class="link" id="tutoBtn" title="Règles">❓</button></div>
        <div class="phase">${PHASE[g.phase]}</div>
      </div>
      <div class="meter-wrap">
        <div class="meter-label">⚛️ ${meterShown} / ${g.atomicsNeeded}</div>
        <div class="meter"><div class="fill" style="width:${pct(g.atomicsFound)}%;--from:${pct(from)}%;${A(mKey, 'fillGrow', 900)}"></div></div>
      </div>
      <div class="timer" id="timer"></div>
      <div class="timebar" id="timebar"></div>
    </div>

    <div class="panel role ${me.role} ${roleHidden ? 'hidden-role' : ''}">
      ${roleCard(me.role, A(`${gid}-role`, 'flipUp', 800, { delay: 1700, ease: 'var(--ease-back)' }))}
      <div style="flex:1">
        <div class="title">${role.label}</div>
        <div class="goal">${role.goal}</div>
      </div>
      <button class="link" id="toggleRole">${roleHidden ? '👁️ Afficher' : '🙈 Masquer'}</button>
    </div>

    <div class="panel stack" style="${A(`${gid}-a${R}${g.phase}`, 'fadeUp', 400)}">${action}</div>

    <div class="panel">
      <h2>☢️ Réacteur</h2>
      <div class="reactor">${bars}</div>
    </div>

    <div class="panel">
      <h2>Ta main</h2>
      <div class="hand">${hand}</div>
    </div>

    <div class="panel">
      <h2>Cartes révélées</h2>
      <div class="history">${historyHtml}</div>
      <div class="muted" style="margin-top:10px;font-size:.85rem">Paquet : ${g.atomicsTotal} ⚛️ · 1 ☢️ · le reste ▫️</div>
    </div>`);

  // --- Événements ---
  document.getElementById('toggleRole').onclick = () => { roleHidden = !roleHidden; render(); };
  app.querySelectorAll('.card.clickable').forEach((el) => {
    el.onclick = () => {
      el.style.transition = 'transform .25s, opacity .25s';
      el.style.transform = 'translateY(-80px) scale(.6)';
      el.style.opacity = '0';
      SFX.insert();
      socket.emit('insert', el.dataset.card);
    };
  });
  app.querySelectorAll('.bar.selectable').forEach((el) => {
    el.onclick = () => {
      selectedTarget = selectedTarget === el.dataset.seat ? null : el.dataset.seat;
      selCount++;
      if (selectedTarget) SFX.snip();
      render();
    };
  });
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('ready', () => socket.emit('ready'));
  on('confirmCut', () => { if (selectedTarget) { SFX.snip(); socket.emit('cut', selectedTarget); } });
  on('skipCut', () => socket.emit('cut', null));
  on('again', () => socket.emit('backToLobby'));
  on('leave', leaveRoom);
  updateTimer();
}
const meterFrom = new Map();

let lastTickSec = null;
function updateTimer() {
  const el = document.getElementById('timer');
  const bar = document.getElementById('timebar');
  if (!el) return;
  if (!localDeadline) { el.textContent = ''; if (bar) bar.style.width = '0'; return; }
  const ms = Math.max(0, localDeadline - Date.now());
  const s = Math.ceil(ms / 1000);
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const low = s <= 10;
  el.classList.toggle('low', low);
  if (bar) {
    bar.style.width = localTotal ? `${(100 * ms) / localTotal}%` : '0';
    bar.classList.toggle('low', low);
  }
  const g = state?.game;
  if (g && s <= 5 && s > 0 && !g.me.acted && s !== lastTickSec && ['insertion', 'cut'].includes(g.phase)) SFX.tick();
  lastTickSec = s;
}
setInterval(updateTimer, 200);

// ============ Tutoriel illustré ============
const TUTO = [
  {
    title: 'Qui es-tu ?',
    scene: `<div class="t-row">
      ${['good', 'bad', 'neutral'].map((r, i) => `<div class="t-col"><div class="role ${r} t-float" style="animation-delay:${-i * 0.7}s">${roleCard(r)}</div><b class="t-${r}">${ROLE[r].label}</b></div>`).join('')}
    </div>`,
    text: 'Chacun reçoit un <b>rôle secret</b>. Ne le montre à personne&nbsp;!',
  },
  {
    title: 'Les cartes',
    scene: `<div class="t-row">
      <div class="t-col"><div class="t-float">${card({ type: 'atomic' })}</div><span>À trouver&nbsp;!</span></div>
      <div class="t-col"><div class="t-float" style="animation-delay:-1s">${card({ type: 'nuclear' })}</div><span>💥 Boum</span></div>
      <div class="t-col"><div class="t-float" style="animation-delay:-2s">${card({ type: 'empty' })}</div><span>Rien</span></div>
    </div>`,
    text: 'Tout le monde reçoit <b>5 cartes</b>. Une seule ☢️ dans tout le paquet.',
  },
  {
    title: '1 · Insertion',
    scene: `<div class="t-insert">
      <div class="t-slot"><div class="slot-empty">?</div><div class="t-slot-back">${card(null, { size: 'sm', down: true })}</div><span>Ta barre</span></div>
      <div class="t-hand">${card({ type: 'empty' }, { size: 'sm' })}<div class="t-mover">${card({ type: 'atomic' }, { size: 'sm' })}</div>${card({ type: 'empty' }, { size: 'sm' })}</div>
    </div>`,
    text: 'Glisse <b>une carte</b> de ta main dans ta barre. <b>En secret.</b>',
  },
  {
    title: '2 · Débat',
    scene: `<div class="t-row t-debate">
      ${[['Léa', 'J\'ai mis ⚛️ !'], ['Max', 'Moi aussi…'], ['Sam', 'Menteur 🤨']].map(([n, b], i) => `
        <div class="t-col"><div class="t-bubble" style="animation-delay:${i * 1.4}s">${b}</div>${avatar({ id: n, name: n })}<span>${n}</span></div>`).join('')}
    </div>`,
    text: 'À l\'oral : annoncez ce que vous avez mis. <b>Vrai… ou bluff.</b>',
  },
  {
    title: '3 · Coupe',
    scene: `<div class="t-row t-cut">
      ${[[3, true, '✓ révélée'], [4, false, 'pair ✗'], [2, false, 'trop peu ✗']].map(([n, ok, l]) => `
        <div class="t-col"><div class="t-bar ${ok ? 'ok' : ''}">
          <div class="tokens ${ok ? 'ok' : ''}">${Array.from({ length: n }, (_, j) => `<span class="tok t-tok" style="animation-delay:${j * 0.35}s"></span>`).join('')}</div>
          ${card(null, { size: 'sm', down: true })}
        </div><span class="t-verdict ${ok ? 'ok' : ''}">${l}</span></div>`).join('')}
    </div>`,
    text: 'Pose ton ✂️ sur une barre (ou pas). Révélée si <b>assez de jetons</b> ET <b>nombre impair</b>.<br><span class="muted">Seuil : 1 (3-4 joueurs) · 3 (5-9) · 5 (10-12)</span>',
  },
  {
    title: '4 · Révélation',
    scene: `<div class="t-row">
      <div class="t-flip">${card({ type: 'atomic' })}</div>
      <div class="t-arrow">→</div>
      <div class="t-shuffle">${card(null, { size: 'sm', down: true })}${card(null, { size: 'sm', down: true })}${card(null, { size: 'sm', down: true })}</div>
    </div>`,
    text: 'Les barres validées se retournent. Le reste est <b>🔀 mélangé et redistribué</b>. <b>4 manches</b> max.',
  },
  {
    title: 'Qui gagne ?',
    scene: `<div class="t-wins">
      <div class="t-win good">🛡️ <span><b>Gentils</b> : assez de ⚛️ révélées</span></div>
      <div class="t-win bad">💀 <span><b>Méchants</b> : la ☢️ sort, ou 4 manches passent</span></div>
      <div class="t-win neutral">🎭 <span><b>Neutre</b> : ton ✂️ sur la ☢️ quand elle sort</span></div>
    </div>`,
    text: 'Le neutre gagne <b>aussi</b> avec les méchants. Bonne chance&nbsp;!',
  },
];

function openTuto() { tutoStep = 0; renderTuto(); }
function closeTuto() { tutoStep = null; store.set('rog-tuto-seen', '1'); renderTuto(); }
function renderTuto() {
  let el = document.getElementById('tuto');
  if (tutoStep === null) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'tuto';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('.tuto-close')) return closeTuto();
      if (e.target.closest('.tuto-next')) { if (tutoStep >= TUTO.length - 1) return closeTuto(); tutoStep++; SFX.whoosh(); renderTuto(); }
      if (e.target.closest('.tuto-prev') && tutoStep > 0) { tutoStep--; renderTuto(); }
      const dot = e.target.closest('[data-step]');
      if (dot) { tutoStep = Number(dot.dataset.step); renderTuto(); }
    });
  }
  const s = TUTO[tutoStep];
  const last = tutoStep === TUTO.length - 1;
  el.innerHTML = emo(`<div class="tuto-box">
    <button class="link tuto-close" aria-label="Fermer">✕</button>
    <div class="tuto-slide">
      <h3>${s.title}</h3>
      <div class="scene">${s.scene}</div>
      <p>${s.text}</p>
    </div>
    <div class="tuto-nav">
      <button class="tuto-prev" ${tutoStep === 0 ? 'disabled' : ''}>←</button>
      <div class="tuto-dots">${TUTO.map((_, i) => `<span data-step="${i}" class="${i === tutoStep ? 'on' : ''}"></span>`).join('')}</div>
      <button class="primary tuto-next">${last ? '🚀 C\'est parti !' : 'Suivant →'}</button>
    </div>
  </div>`);
}
document.addEventListener('keydown', (e) => {
  if (tutoStep === null) return;
  if (e.key === 'Escape') closeTuto();
  if (e.key === 'ArrowRight') document.querySelector('.tuto-next')?.click();
  if (e.key === 'ArrowLeft') document.querySelector('.tuto-prev')?.click();
});
