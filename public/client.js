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
let jokerMode = false; // le neutre est en train de choisir la barre de son Joker
let jokerTarget = null;
let roleZoom = false; // fenêtre "ton rôle" ouverte
let historyOpen = false; // tiroir des cartes révélées ouvert
let endHidden = false; // fenêtre de fin masquée pour regarder la table
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
  neutral: { label: 'Neutre', icon: '🎭', goal: 'Tu joues seul. Fais révéler 3 ▫️ Vides avec ton ✂️, ou mets ton ✂️ sur la ☢️. 🃏 Joker : 1 fois, un 2e jeton.' },
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
  coin: () => { tone(988, 0.08, 'square', 0.05); tone(1319, 0.3, 'square', 0.05, null, 0.08); },
  joker: () => [330, 415, 494, 622].forEach((f, i) => tone(f, 0.18, 'triangle', 0.07, null, i * 0.05)),
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
  const target = app.querySelector(`.tslot[data-seat="${seatId}"]`);
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
// Illustrations des rôles (public/roles). Le neutre n'a pas encore d'illustration : il garde son icône.
const ROLE_ART = { good: ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'], bad: ['m0', 'm1', 'm2', 'm3'], neutral: [] };
function artUrl(role, idx) {
  const list = ROLE_ART[role];
  if (!list || !list.length || idx == null) return null;
  return `roles/${list[((idx % list.length) + list.length) % list.length]}.jpg`;
}
let artPreloaded = false;
function preloadArt() {
  if (artPreloaded) return;
  artPreloaded = true;
  Object.values(ROLE_ART).flat().forEach((n) => { new Image().src = `roles/${n}.jpg`; });
}
function roleCard(role, innerStyle = '', art = null, cls = '') {
  const url = artUrl(role, art);
  const front = url
    ? `<div class="face front art"><img src="${url}" alt="${ROLE[role].label}" draggable="false"></div>`
    : `<div class="face front">${ROLE[role].icon}</div>`;
  return `<div class="role-card ${cls}"><div class="inner" style="${innerStyle}">${front}<div class="face back"></div></div></div>`;
}
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
  if (key !== lastPhaseKey) { selectedTarget = null; jokerMode = false; jokerTarget = null; endHidden = false; lastPhaseKey = key; }
  localDeadline = g && g.timeLeftMs != null ? Date.now() + g.timeLeftMs : null;
  localTotal = g ? g.timeTotalMs : null;
  preloadArt();
  render();
  if (firstLobby && !store.get('rog-tuto-seen')) openTuto();
});
socket.on('errorMsg', (msg) => {
  toast(msg);
  if (!state) { store.del('rog-room'); render(); }
});

// ============ Rendu ============
function render() {
  document.body.classList.toggle('in-game', !!state?.game);
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

  // --- Grande révélation du rôle (début de partie) ---
  const intro = R === 1 && g.phase === 'insertion';
  const INTRO = intro ? 3600 : 0;
  let roleReveal = '';
  if (intro) {
    const st = A(`${gid}-bigrole`, 'roleOverlay', 3600);
    if (st) {
      roleReveal = `<div class="role-reveal" style="${st}">
        <div class="rr-sub">TON RÔLE SECRET</div>
        ${roleCard(me.role, A(`${gid}-bigflip`, 'flipUp', 900, { delay: 500, ease: 'var(--ease-back)' }), me.art, 'big')}
        <div class="rr-title ${me.role}" style="${A(`${gid}-bigt`, 'fadeUp', 400, { delay: 1300 })}">${ROLE[me.role].icon} ${ROLE[me.role].label}</div>
        <div class="rr-goal" style="${A(`${gid}-bigg`, 'fadeUp', 400, { delay: 1500 })}">${ROLE[me.role].goal}</div>
      </div>`;
    }
    once(`${gid}-bigflip-s`, 500, SFX.flip);
    once(`${gid}-bigrole-s`, 1300, () => {
      if (me.role === 'good') [523, 659, 784].forEach((f, i) => tone(f, 0.4, 'triangle', 0.09, null, i * 0.09));
      else if (me.role === 'bad') [196, 233, 175].forEach((f, i) => tone(f, 0.5, 'sawtooth', 0.05, null, i * 0.14));
      else [440, 554, 415, 523].forEach((f, i) => tone(f, 0.35, 'sine', 0.08, null, i * 0.1));
    });
  }

  // --- Bannière de phase ---
  let banner = '';
  if (['insertion', 'debate', 'cut'].includes(g.phase)) {
    const bKey = `${gid}-b${R}-${g.phase}`;
    const st = A(bKey, 'bannerInOut', 1700, { delay: INTRO });
    if (st) {
      const sub = g.phase === 'insertion' ? `MANCHE ${R} / ${g.rounds}` : `MANCHE ${R}`;
      const icon = { insertion: '📥', debate: '🗣️', cut: '✂️' }[g.phase];
      banner = `<div class="phase-banner" style="${st}"><div class="sub">${sub}</div><div class="main">${icon} ${PHASE[g.phase]}</div></div>`;
    }
    once(bKey, INTRO, SFX.whoosh);
  }

  // --- Géométrie de la table : toi en bas, les autres tout autour ---
  const n = g.seats.length;
  const myIdx = Math.max(0, g.seats.findIndex((s) => s.id === state.myId));
  const portrait = window.innerWidth < 700;
  const tw = portrait ? (n <= 5 ? 66 : n <= 8 ? 54 : 44) : (n <= 5 ? 92 : n <= 8 ? 78 : 64);
  // fx / fy : rayon horizontal / vertical relatif à l'ovale de la table
  const place = (k, fx, fy = fx) => {
    const a = ((90 + (k * 360) / n) * Math.PI) / 180;
    return `left:${(50 + 50 * fx * Math.cos(a)).toFixed(2)}%;top:${(50 + 50 * fy * Math.sin(a)).toFixed(2)}%;`;
  };
  // En portrait, on écarte les cartes sur les côtés pour libérer le centre
  const [cardFx, cardFy] = portrait ? [0.7, 0.6] : [0.64, 0.6];
  const target = g.phase === 'cut' ? (me.acted ? me.token : selectedTarget) : null;
  const jTarget = g.phase === 'cut' ? (me.acted ? me.joker?.target : jokerTarget) : null;

  let seatsHtml = '';
  let slotsHtml = '';
  for (let k = 0; k < n; k++) {
    const s = g.seats[(myIdx + k) % n];
    const p = playerOf(s.id);
    const isMe = s.id === state.myId;
    const selectable = g.phase === 'cut' && !me.acted && !isMe && s.hasBar;
    const cls = [];
    if (selectable) cls.push('selectable');
    if (target === s.id) cls.push('selected');
    if (jTarget === s.id) cls.push('joker-selected');
    if (!connectedById[s.id]) cls.push('off');
    if (isMe) cls.push('me');

    // Carte posée devant le joueur
    const rc = s.revealedCard;
    let slot;
    let lootBadge = '';
    let hit = '';
    if (rc) {
      const flipAt = FLIP0 + (revealIdx[s.id] ?? 0) * GAP;
      if (now >= rBase + flipAt + 500) hit = `hit-${rc.type}`;
      slot = card(rc, { size: 't', innerStyle: A(`${gid}-f${R}-${s.id}`, 'flipUp', 650, { delay: flipAt, base: rBase, ease: 'var(--ease-back)' }) });
      const myLoot = me.role === 'neutral' && rc.type === 'empty' && (me.token === s.id || me.joker?.target === s.id);
      if (myLoot) lootBadge = `<span class="loot-badge" style="${A(`${gid}-lb${R}-${s.id}`, 'lootPop', 700, { delay: flipAt + 450, base: rBase, ease: 'var(--ease-back)' })}">+💰</span>`;
      once(`${gid}-sf${R}-${s.id}`, flipAt, SFX.flip, rBase);
      once(`${gid}-sx${R}-${s.id}`, flipAt + 380, () => {
        if (rc.type === 'atomic') { SFX.atomic(); burst(s.id, '#4dff8f'); render(); }
        else if (rc.type === 'nuclear') { SFX.boom(); flash(); shake(); burst(s.id, '#ff4d2e', 40); render(); }
        else if (myLoot) { SFX.coin(); burst(s.id, '#ffcc33', 22); render(); }
        else { SFX.empty(); render(); }
      }, rBase);
    } else if (isMe && me.bar) {
      const pending = g.phase === 'insertion' && !me.acted;
      slot = card(me.bar, { size: 't', cls: pending ? 'pending' : '' });
    } else if (s.hasBar) {
      slot = card(null, { size: 't', down: true, style: A(`${gid}-i${R}-${s.id}`, 'dropIn', 450) });
      once(`${gid}-is${R}-${s.id}`, 0, SFX.insert);
    } else {
      slot = '<div class="tslot-empty"></div>';
    }

    // Jetons (visibles à la révélation)
    let tokens = '';
    if (s.tokens !== null && s.tokens > 0) {
      const ok = s.tokens >= g.threshold && s.tokens % 2 === 1;
      const label = ok ? '✓' : s.tokens < g.threshold ? 'trop peu' : 'pair ✗';
      const dots = Array.from({ length: s.tokens }, (_, j) => `<span class="tok" style="${A(`${gid}-t${R}-${s.id}-${j}`, 'pop', 300, { delay: 100 + j * 70, base: rBase, ease: 'var(--ease-back)' })}"></span>`).join('');
      tokens = `<div class="tchips ${ok ? 'ok' : ''}"><div class="tokens ${ok ? 'ok' : ''}">${dots}</div><span class="tok-label">${label}</span></div>`;
    }
    const chip = target === s.id ? `<span class="chip-drop" style="${A(`${gid}-sel${selCount}`, 'chipDrop', 450, { ease: 'var(--ease-back)' })}">✂️</span>` : '';
    const jChip = jTarget === s.id ? `<span class="chip-drop joker" style="${A(`${gid}-jk${selCount}`, 'chipDrop', 450, { ease: 'var(--ease-back)' })}">🃏</span>` : '';
    const showCheck = g.phase !== 'ended' && s.acted;
    const check = showCheck ? `<span class="check-b" style="${A(`${gid}-ok${R}${g.phase}${s.id}`, 'pop', 350, { ease: 'var(--ease-back)' })}">✓</span>` : '';

    const pick = selectable ? 'data-pick' : '';
    seatsHtml += `<div class="seat ${cls.join(' ')}" data-seat="${s.id}" ${pick} style="${place(k, 1)}">
        <div class="seat-av">${avatar(p)}${check}</div>
        <div class="seat-name">${esc(p.name)}</div>
        <div class="seat-meta">🂠 ${s.handCount}</div>
      </div>`;
    slotsHtml += `<div class="tslot ${cls.join(' ')} ${hit} ${isMe ? 'mine' : ''}" data-seat="${s.id}" ${pick} style="${place(k, cardFx, cardFy)}">
        ${tokens}${chip}${jChip}${lootBadge}${slot}
      </div>`;
  }

  // --- Centre de la table : phase, consigne courte, chrono, jauge ---
  const glyph = { atomic: '⚛️', nuclear: '☢️', empty: '▫️' };
  let hint = '';
  switch (g.phase) {
    case 'insertion':
      hint = me.acted ? `✅ Validé · ${actedCount}/${n}` : me.bar ? `Tu proposes ${glyph[me.bar.type]} · change ou valide` : 'Choisis une carte 👇';
      break;
    case 'debate':
      hint = 'Bluffez ! Annoncez votre carte… vrai ou faux';
      break;
    case 'cut':
      hint = me.acted ? `En attente · ${actedCount}/${n}`
        : jokerMode ? '🃏 Touche une carte pour ton Joker'
          : `Touche une carte pour la couper<div class="tc-rules">🎯 ${g.threshold}+ · 🔢 impair · 📦 max ${g.cap}</div>`;
      break;
    case 'reveal': {
      if (!revealOver) { hint = 'Révélation…'; break; }
      const c = { atomic: 0, empty: 0 };
      thisRound.forEach((r) => { c[r.card.type]++; });
      hint = thisRound.length
        ? `${c.atomic ? `<span class="rchip atomic">⚛️ ×${c.atomic}</span>` : ''} ${c.empty ? `<span class="rchip">▫️ ×${c.empty}</span>` : ''}`
        : '😶 Rien de révélé';
      break;
    }
    case 'ended':
      hint = now < rBase + endAt ? 'Révélation…' : '';
      break;
  }

  // Jauge d'Atomiques (animée après les retournements)
  const pct = (v) => Math.round(100 * Math.min(1, v / g.atomicsNeeded));
  const mKey = `${gid}-m${g.atomicsFound}`;
  if (!animStart.has(mKey)) {
    meterFrom.set(mKey, lastFound[gid] ?? g.atomicsFound);
    startOf(mKey, isRevealPhase ? rBase + revealDone - 300 : now);
  }
  const from = meterFrom.get(mKey);
  const meterShown = isRevealPhase && !revealOver ? from : g.atomicsFound;
  lastFound[gid] = g.atomicsFound;

  const PH_ICON = { insertion: '📥', debate: '🗣️', cut: '✂️', reveal: '🎲', ended: '🏁' };
  const center = `<div class="table-center">
      <div class="tc-phase">${PH_ICON[g.phase]} ${PHASE[g.phase]}</div>
      <div class="tc-hint" style="${A(`${gid}-h${R}${g.phase}${me.acted}${!!me.bar}${revealOver}`, 'fadeUp', 350)}">${hint}</div>
      <div class="tc-timer" id="timer"></div>
      <div class="tc-timebar"><div class="timebar" id="timebar"></div></div>
      <div class="tc-meter"><span>⚛️ ${meterShown}/${g.atomicsNeeded}</span>
        <div class="meter"><div class="fill" style="width:${pct(g.atomicsFound)}%;--from:${pct(from)}%;${A(mKey, 'fillGrow', 900)}"></div></div></div>
    </div>`;

  // --- Boutons d'action (sous la table) ---
  const wait = `<div class="waiting"><span class="dots"><span></span><span></span><span></span></span> ${actedCount}/${n}</div>`;
  let dock = '';
  switch (g.phase) {
    case 'insertion':
      if (me.acted) dock = `${wait}<button id="unconfirmInsert">↩️ Changer d'avis</button>`;
      else if (me.bar) dock = '<button class="primary pulse big" id="confirmInsert">✅ Valider ma carte</button>';
      if (isHost() && actedCount < n) dock += '<button class="link" id="forceAdvance">⏩ Forcer</button>';
      break;
    case 'debate':
      dock = me.acted ? wait : '<button class="primary pulse big" id="ready">✅ Prêt</button>';
      break;
    case 'cut':
      if (me.acted) {
        dock = wait;
      } else {
        const jk = me.joker;
        const jBtn = jk?.available
          ? `<button id="jokerToggle" class="joker-btn ${jokerMode ? 'on' : ''}">🃏 ${jokerMode ? 'Choisis…' : jokerTarget ? 'Retirer Joker' : 'Joker'}</button>` : '';
        const canConfirm = selectedTarget || jokerTarget;
        const label = [selectedTarget && `✂️ ${nameOf(selectedTarget)}`, jokerTarget && `🃏 ${nameOf(jokerTarget)}`].filter(Boolean).join(' + ');
        dock = `${jBtn}<button class="primary big" id="confirmCut" ${canConfirm ? '' : 'disabled'}>${canConfirm ? label : '✂️ Couper'}</button>
          <button id="skipCut">🙅 Passer</button>`;
      }
      break;
    case 'reveal':
      dock = !revealOver ? '' : me.acted ? wait : '<button class="primary pulse big" id="ready">➡️ Continuer</button>';
      break;
    case 'ended':
      if (now >= rBase + endAt && endHidden) dock = '<button class="primary big" id="showEnd">🏁 Résultats</button>';
      break;
  }

  // --- Main en éventail ---
  const canInsert = g.phase === 'insertion' && !me.acted;
  const mid = (me.hand.length - 1) / 2;
  const hand = me.hand.map((c, i) => {
    const off = i - mid;
    const fan = `--r:${(off * 6).toFixed(1)}deg;--y:${(Math.abs(off) ** 1.6 * 5).toFixed(1)}px;`;
    const dKey = `${gid}-d${R}-${c.id}`;
    const delay = (intro ? INTRO + 600 : 500) + i * 110;
    once(`${dKey}s`, delay, SFX.deal);
    return card(c, { cls: canInsert ? 'clickable' : '', attrs: `data-card="${c.id}"`, style: fan + A(dKey, 'deal', 600, { delay, ease: 'var(--ease-back)' }) });
  }).join('');

  // --- Mini carte de rôle (coin bas-gauche) ---
  const neutralChips = me.role === 'neutral'
    ? `<div class="mini-stats"><span>💰${Math.min(me.loot, g.lootNeeded)}/${g.lootNeeded}</span><span class="${me.joker?.available ? 'on' : 'off'}">🃏</span></div>` : '';
  const roleInner = roleHidden ? 'transform:rotateY(180deg)' : A(`${gid}-role`, 'flipUp', 800, { delay: intro ? 3300 : 0, ease: 'var(--ease-back)' });
  const roleMini = `<div class="role-mini ${me.role}" id="roleMini" title="Ton rôle">${roleCard(me.role, roleInner, me.art)}${neutralChips}</div>`;

  // --- Fenêtres (rôle agrandi, historique, fin de partie) ---
  let overlay = '';
  if (roleZoom) {
    overlay = `<div class="overlay" data-close="role"><div class="overlay-box center stack">
      <button class="link ov-close" data-close="role">✕</button>
      <div class="role ${me.role}" style="justify-content:center">${roleCard(me.role, roleHidden ? 'transform:rotateY(180deg)' : '', me.art, 'big')}</div>
      <div class="rr-title ${me.role}">${ROLE[me.role].icon} ${ROLE[me.role].label}</div>
      <div class="muted">${ROLE[me.role].goal}</div>
      ${me.role === 'neutral' ? `<div class="row" style="justify-content:center"><span class="rchip loot">💰 Butin ${Math.min(me.loot, g.lootNeeded)}/${g.lootNeeded}</span><span class="rchip ${me.joker?.available ? 'joker-ready' : 'used'}">🃏 Joker ${me.joker?.available ? 'dispo' : 'utilisé'}</span></div>` : ''}
      <button id="toggleRole">${roleHidden ? '👁️ Montrer ma carte' : '🙈 Retourner ma carte'}</button>
    </div></div>`;
  } else if (historyOpen) {
    const byRound = {};
    for (const r of g.revealed) if (r.round < R || revealOver || !isRevealPhase) (byRound[r.round] ||= []).push(r);
    const list = Object.keys(byRound).length
      ? Object.entries(byRound).map(([round, l]) => `<div class="line"><span class="round-tag">Manche ${round}</span>
          ${l.map((r) => `<div>${card(r.card, { size: 'sm' })}<div class="who">${nameOf(r.ownerId)}</div></div>`).join('')}</div>`).join('')
      : '<div class="muted">Rien pour l\'instant…</div>';
    overlay = `<div class="overlay" data-close="hist"><div class="overlay-box stack">
      <button class="link ov-close" data-close="hist">✕</button>
      <h2>📜 Cartes révélées</h2><div class="history">${list}</div>
      <div class="muted" style="font-size:.85rem">Paquet : ${g.atomicsTotal} ⚛️ · 1 ☢️ · le reste ▫️</div>
    </div></div>`;
  } else if (g.phase === 'ended' && now >= rBase + endAt && !endHidden) {
    const w = g.winner;
    const iWon = me.role === w.team;
    once(`${gid}-win`, 0, () => { confetti(TEAM_COLOR[w.team]); (iWon ? SFX.win : SFX.lose)(); });
    const isWinner = (id) => g.roles[id] === w.team;
    overlay = `<div class="overlay end"><div class="overlay-box stack center">
      <div class="end-banner ${w.team}" style="${A(`${gid}-eb`, 'zoomIn', 600, { ease: 'var(--ease-back)' })}">${TEAM[w.team]}</div>
      <div style="${A(`${gid}-er`, 'fadeUp', 400, { delay: 300 })}">${esc(w.reason)}<br><b class="big-result">${iWon ? '🎉 Victoire !' : '😵 Défaite…'}</b></div>
      <ul class="players end-list">
        ${g.seats.map((s, i) => `<li class="${isWinner(s.id) ? 'winner' : ''}" style="${A(`${gid}-el${s.id}`, 'fadeUp', 400, { delay: 500 + i * 90 })}">
          ${artUrl(g.roles[s.id], g.arts?.[s.id]) ? `<img class="thumb ${g.roles[s.id]}" src="${artUrl(g.roles[s.id], g.arts[s.id])}" alt="">` : avatar(playerOf(s.id))}
          <span style="flex:1;text-align:left">${nameOf(s.id)}</span>
          <span class="role-pill ${g.roles[s.id]}">${ROLE[g.roles[s.id]].icon} ${ROLE[g.roles[s.id]].label}${g.roles[s.id] === 'neutral' ? ` · 💰${g.finalLoot}/${g.lootNeeded}` : ''}</span></li>`).join('')}
      </ul>
      <div class="row" style="justify-content:center">
        ${isHost() ? '<button class="primary pulse" id="again">🔁 Nouvelle partie</button>' : '<span class="muted">L\'hôte peut relancer.</span>'}
        <button id="hideEnd">👀 Voir la table</button>
        <button class="link" id="leave">Quitter</button>
      </div>
    </div></div>`;
  }

  const histCount = g.revealed.filter((r) => r.round < R || revealOver || !isRevealPhase).length;
  app.innerHTML = emo(`
    ${roleReveal}
    ${banner}
    <div class="game">
      <div class="gtop">
        <div class="gt-left"><b>Manche ${Math.min(R, g.rounds)}/${g.rounds}</b> <span class="muted">· ${state.code}</span></div>
        <div class="gt-right">
          <button class="icon-btn" id="histBtn" title="Cartes révélées">📜${histCount ? `<span class="badge">${histCount}</span>` : ''}</button>
          <button class="icon-btn" id="muteBtn" title="Son">${muted ? '🔇' : '🔊'}</button>
          <button class="icon-btn" id="tutoBtn" title="Règles">❓</button>
        </div>
      </div>
      <div class="table-wrap ${portrait ? 'portrait' : ''}">
        <div class="table ${jokerMode ? 'joker-mode' : ''}" style="--tw:${tw}px">${center}${slotsHtml}${seatsHtml}</div>
      </div>
      <div class="dock" style="${A(`${gid}-dk${R}${g.phase}${me.acted}`, 'fadeUp', 300)}">${dock}</div>
      <div class="bottom">
        ${roleMini}
        <div class="hand-fan">${hand || '<span class="muted">Aucune carte</span>'}</div>
      </div>
    </div>
    ${overlay}`);

  // --- Événements ---
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  app.querySelectorAll('.hand-fan .card.clickable').forEach((el) => {
    el.onclick = () => {
      flyCard(el, app.querySelector(`.tslot[data-seat="${state.myId}"]`), tw);
      el.style.visibility = 'hidden';
      SFX.insert();
      socket.emit('insert', el.dataset.card);
    };
  });
  app.querySelectorAll('[data-pick]').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.seat;
      if (jokerMode) {
        jokerTarget = jokerTarget === id ? null : id;
        jokerMode = false;
        if (jokerTarget) SFX.joker();
      } else {
        selectedTarget = selectedTarget === id ? null : id;
        if (selectedTarget) SFX.snip();
      }
      selCount++;
      render();
    };
  });
  app.querySelectorAll('[data-close]').forEach((el) => {
    el.onclick = (e) => {
      if (e.target !== el) return;
      roleZoom = false; historyOpen = false; render();
    };
  });
  on('roleMini', () => { roleZoom = true; render(); });
  on('histBtn', () => { historyOpen = true; render(); });
  on('toggleRole', () => { roleHidden = !roleHidden; render(); });
  on('ready', () => socket.emit('ready'));
  on('confirmInsert', () => socket.emit('confirmInsert'));
  on('unconfirmInsert', () => socket.emit('unconfirmInsert'));
  on('confirmCut', () => {
    if (!selectedTarget && !jokerTarget) return;
    SFX.snip();
    socket.emit('cut', selectedTarget, jokerTarget);
  });
  on('jokerToggle', () => {
    if (jokerTarget && !jokerMode) jokerTarget = null; else jokerMode = !jokerMode;
    render();
  });
  on('forceAdvance', () => {
    if (confirm('Passer à la suite ? Les joueurs qui n\'ont pas validé joueront une carte (leur proposition, sinon au hasard).')) socket.emit('forceAdvance');
  });
  on('skipCut', () => socket.emit('cut', null));
  on('again', () => socket.emit('backToLobby'));
  on('hideEnd', () => { endHidden = true; render(); });
  on('showEnd', () => { endHidden = false; render(); });
  on('leave', leaveRoom);
  updateTimer();
}

// Fait voler une carte de la main jusqu'à sa place sur la table
function flyCard(fromEl, toEl, tw) {
  if (!fromEl || !toEl) return;
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  const clone = fromEl.cloneNode(true);
  clone.classList.remove('clickable');
  Object.assign(clone.style, {
    position: 'fixed', left: `${a.left}px`, top: `${a.top}px`, margin: '0', zIndex: '65',
    transform: 'none', animation: 'none', visibility: 'visible', pointerEvents: 'none',
  });
  clone.style.setProperty('--card-w', `${a.width}px`);
  clone.style.setProperty('--card-h', `${a.height}px`);
  fxLayer.appendChild(clone);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const sc = tw / a.width;
  clone.animate([
    { transform: 'translate(0,0) rotate(0) scale(1)' },
    { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 40}px) rotate(-8deg) scale(${(1 + sc) / 2 + 0.1})`, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) rotate(0) scale(${sc})` },
  ], { duration: 450, easing: 'cubic-bezier(.3,.7,.3,1)' }).onfinish = () => clone.remove();
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

// La table se réorganise (paysage / portrait) quand la fenêtre change de taille
let resizeT = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (state?.game) render(); }, 150);
});

// ============ Tutoriel illustré ============
const TUTO = [
  {
    title: 'Qui es-tu ?',
    scene: `<div class="t-row">
      ${['good', 'bad', 'neutral'].map((r, i) => `<div class="t-col"><div class="role ${r} t-float" style="animation-delay:${-i * 0.7}s">${roleCard(r, '', 0, 'tuto')}</div><b class="t-${r}">${ROLE[r].label}</b></div>`).join('')}
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
    text: 'Glisse <b>une carte</b> dans ta barre, <b>en secret</b>. Tu peux changer, puis tu <b>valides ✅</b>.',
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
    title: '🎭 Le Neutre',
    scene: `<div class="t-row t-neutral">
      <div class="t-col">
        <div class="t-loot">
          ${[0, 1, 2].map((i) => `<div class="t-loot-card" style="animation-delay:${i * 0.6}s">${card({ type: 'empty' }, { size: 'sm' })}<span class="t-coin" style="animation-delay:${i * 0.6}s">+💰</span></div>`).join('')}
        </div>
        <span>Pilleur : 3 ▫️ = victoire</span>
      </div>
      <div class="t-col">
        <div class="t-joker">🃏</div>
        <span>Joker : 1 fois</span>
      </div>
    </div>`,
    text: 'Il joue <b>seul</b>. Une ▫️ révélée là où il a mis son ✂️ = 💰. À <b>3 💰</b>, il gagne. Une fois par partie, son <b>🃏 Joker</b> pose un <b>2e jeton secret</b>.',
  },
  {
    title: 'Qui gagne ?',
    scene: `<div class="t-wins">
      <div class="t-win good">🛡️ <span><b>Gentils</b> : assez de ⚛️ révélées</span></div>
      <div class="t-win bad">💀 <span><b>Méchants</b> : la ☢️ sort, ou 4 manches passent</span></div>
      <div class="t-win neutral">🎭 <span><b>Neutre</b> : 3 ▫️ avec son ✂️, ou son ✂️ sur la ☢️</span></div>
    </div>`,
    text: 'Chaque camp gagne <b>seul</b>. Bonne chance&nbsp;!',
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
