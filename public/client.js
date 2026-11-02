/* global io */
const socket = io();
const app = document.getElementById('app');

// ---- Session persistante (reconnexion après rafraîchissement) ----
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
let token = store.get('rog-token');
if (!token) {
  token = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
  store.set('rog-token', token);
}

let state = null;
let selectedTarget = null; // barre choisie pendant la coupe
let roleHidden = false;
let localDeadline = null;
let lastPhaseKey = null;

const CARD = {
  atomic: { icon: '⚛️', label: 'Atomique' },
  nuclear: { icon: '☢️', label: 'Nucléaire' },
  empty: { icon: '▫️', label: 'Vide' },
};
const ROLE = {
  good: { label: 'Gentil', goal: 'Faites révéler les cartes Atomiques.' },
  bad: { label: 'Méchant', goal: 'Faites révéler la carte Nucléaire, ou tenez 4 manches.' },
  neutral: { label: 'Neutre', goal: 'Pose ton jeton sur la Nucléaire au moment où elle est révélée pour gagner seul. Tu gagnes aussi avec les méchants.' },
};
const TEAM = { good: 'Les gentils gagnent !', bad: 'Les méchants gagnent !', neutral: 'Le neutre gagne seul !' };
const PHASE = { insertion: 'Insertion', debate: 'Débat', cut: 'Coupe', reveal: 'Révélation', ended: 'Fin de partie' };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cardHtml = (c, extra = '') => `<div class="card ${c.type} ${extra}" data-card="${c.id}"><span class="icon">${CARD[c.type].icon}</span>${CARD[c.type].label}</div>`;
const miniCard = (c) => `<span class="card mini ${c.type}"><span class="icon">${CARD[c.type].icon}</span>${CARD[c.type].label}</span>`;

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---- Réseau ----
socket.on('connect', () => {
  const code = store.get('rog-room');
  if (code) socket.emit('join', { code, name: store.get('rog-name'), token });
  else render();
});
socket.on('state', (s) => {
  state = s;
  store.set('rog-room', s.code);
  const g = s.game;
  const key = g ? `${g.round}-${g.phase}` : 'lobby';
  if (key !== lastPhaseKey) { selectedTarget = null; lastPhaseKey = key; }
  localDeadline = g && g.timeLeftMs != null ? Date.now() + g.timeLeftMs : null;
  render();
});
socket.on('errorMsg', (msg) => {
  toast(msg);
  if (!state) { store.del('rog-room'); render(); }
});

// ---- Rendu ----
function render() {
  if (!state) return renderHome();
  if (!state.game) return renderLobby();
  return renderGame();
}

function renderHome() {
  const params = new URLSearchParams(location.search);
  const code = params.get('room') || '';
  app.innerHTML = `
    <div class="home stack">
      <div class="center">
        <h1><span class="react">React</span> <span class="or">or</span> <span class="greed">Greed</span></h1>
        <p class="tagline muted">Bluff, réacteur et trahison — de 3 à 12 joueurs.</p>
      </div>
      <div class="panel stack">
        <input id="name" maxlength="16" placeholder="Ton pseudo" value="${esc(store.get('rog-name') || '')}">
        <button class="primary" id="create" style="width:100%">Créer un salon</button>
        <div class="row">
          <input id="code" class="code" maxlength="4" placeholder="CODE" value="${esc(code)}">
          <button id="join" style="flex:1">Rejoindre</button>
        </div>
      </div>
    </div>`;
  const nameEl = document.getElementById('name');
  const getName = () => {
    const n = nameEl.value.trim();
    if (!n) { toast('Choisis un pseudo.'); nameEl.focus(); return null; }
    store.set('rog-name', n);
    return n;
  };
  document.getElementById('create').onclick = () => {
    const name = getName();
    if (name) socket.emit('create', { name, token });
  };
  document.getElementById('join').onclick = () => {
    const name = getName();
    const c = document.getElementById('code').value.trim().toUpperCase();
    if (!name) return;
    if (c.length !== 4) return toast('Le code fait 4 lettres.');
    socket.emit('join', { code: c, name, token });
  };
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
    <div class="center" style="margin-bottom:16px">
      <h1><span class="react">React</span> <span class="or">or</span> <span class="greed">Greed</span></h1>
    </div>
    <div class="panel center stack">
      <div class="muted">Code du salon</div>
      <div class="big-code">${state.code}</div>
      <div class="row" style="justify-content:center">
        <button id="copy">📋 Copier le lien d'invitation</button>
      </div>
    </div>
    <div class="panel">
      <h2>Joueurs (${connected}/${config.maxPlayers})</h2>
      <ul class="players">
        ${players.map((p) => `<li class="${p.connected ? '' : 'off'}">${p.id === state.hostId ? '👑 ' : ''}${esc(p.name)}${p.id === state.myId ? ' <span class="muted">(toi)</span>' : ''}</li>`).join('')}
      </ul>
    </div>
    <div class="panel center stack">
      ${isHost()
        ? `<button class="primary" id="start" ${canStart ? '' : 'disabled'}>Lancer la partie</button>
           ${canStart ? '' : `<div class="muted">Il faut au moins ${config.minPlayers} joueurs connectés.</div>`}`
        : '<div class="muted">En attente du lancement par l\'hôte…</div>'}
      <button class="link" id="leave">Quitter le salon</button>
    </div>
    ${rulesHtml()}`;
  document.getElementById('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Lien copié !'); } catch { prompt('Copie ce lien :', link); }
  };
  document.getElementById('leave').onclick = leaveRoom;
  const startBtn = document.getElementById('start');
  if (startBtn) startBtn.onclick = () => socket.emit('start');
}

function rulesHtml() {
  return `
    <details class="panel">
      <summary>📖 Règles</summary>
      <ul>
        <li><b>Rôles cachés</b> : gentils, méchants et (dès 4 joueurs) un neutre.</li>
        <li><b>Paquet</b> : 5 cartes par joueur. Autant de cartes Atomiques que de joueurs, 1 Nucléaire, le reste Vides.</li>
        <li><b>Insertion</b> : chacun place en secret une carte de sa main dans sa barre du Réacteur.</li>
        <li><b>Débat</b> : à l'oral, chacun annonce (vrai ou faux) ce qu'il a inséré. Bouton « Prêt » pour passer à la suite.</li>
        <li><b>Coupe</b> : chacun peut poser en secret un jeton sur la barre d'un autre joueur, ou s'abstenir.</li>
        <li><b>Révélation</b> : une barre est révélée si son nombre de jetons atteint le seuil <b>et</b> est impair (seuil : 1 à 3–4 joueurs, 3 à 5–9 joueurs, 5 à 10–12 joueurs). Au maximum (joueurs − 2) barres par manche, celles avec le plus de jetons d'abord.</li>
        <li><b>Mélange</b> : toutes les cartes non révélées sont mélangées et redistribuées.</li>
        <li><b>Victoire</b> : les gentils gagnent en révélant le nombre d'Atomiques indiqué en haut de l'écran. Les méchants gagnent si la Nucléaire est révélée ou après 4 manches. Le neutre gagne seul s'il avait un jeton sur la Nucléaire révélée, sinon il gagne avec les méchants.</li>
      </ul>
    </details>`;
}

const nameOf = (id) => esc(state.players.find((p) => p.id === id)?.name ?? '?');

function renderGame() {
  const g = state.game;
  const me = g.me;
  const role = ROLE[me.role];
  const connectedById = Object.fromEntries(state.players.map((p) => [p.id, p.connected]));
  const actedCount = g.seats.filter((s) => s.acted).length;

  // Barres du réacteur
  const bars = g.seats.map((s) => {
    const isMe = s.id === state.myId;
    const cls = ['bar'];
    if (isMe) cls.push('me');
    if (!connectedById[s.id]) cls.push('off');
    const selectable = g.phase === 'cut' && !me.acted && !isMe && s.hasBar;
    if (selectable) cls.push('selectable');
    if (selectable && selectedTarget === s.id) cls.push('selected');
    if (g.phase === 'cut' && me.acted && me.token === s.id) cls.push('selected');
    if (s.revealedCard) cls.push(`revealed-${s.revealedCard.type}`);

    let slot;
    if (s.revealedCard) slot = miniCard(s.revealedCard);
    else if (isMe && me.bar) slot = `<span class="muted">Ta carte :</span> ${miniCard(me.bar)}`;
    else if (g.phase === 'insertion') slot = s.acted ? '🔒 Carte insérée' : '<span class="muted">…</span>';
    else slot = s.hasBar ? '🔒 Carte cachée' : '<span class="muted">—</span>';

    let tokens = '';
    if (s.tokens !== null) {
      const ok = s.tokens >= g.threshold && s.tokens % 2 === 1;
      tokens = `<div class="tokens ${ok ? 'ok' : ''}">✂️ ${s.tokens} jeton${s.tokens > 1 ? 's' : ''}</div>`;
    }
    const check = (g.phase !== 'insertion' && g.phase !== 'ended' && s.acted) ? '<span class="check">✓</span>' : '';
    return `<div class="${cls.join(' ')}" data-seat="${s.id}">
      ${check}
      <div class="name">${nameOf(s.id)}${isMe ? ' <span class="muted">(toi)</span>' : ''}</div>
      <div class="meta">🂠 ${s.handCount} en main</div>
      ${tokens}
      <div class="slot">${slot}</div>
    </div>`;
  }).join('');

  // Zone d'action selon la phase
  let action = '';
  const waiting = `<div class="muted">En attente des autres joueurs (${actedCount}/${g.seats.length})…</div>`;
  switch (g.phase) {
    case 'insertion':
      action = me.acted ? waiting : '<div><b>Clique sur une carte de ta main</b> pour l\'insérer dans ta barre.</div>';
      break;
    case 'debate':
      action = `<div>🗣️ <b>Débattez à l'oral</b> : annoncez ce que vous avez inséré (vrai ou faux).</div>
        ${me.acted ? waiting : '<button class="primary" id="ready">Prêt pour la coupe</button>'}`;
      break;
    case 'cut':
      action = me.acted
        ? `<div>${me.token ? `Ton jeton est sur la barre de <b>${nameOf(me.token)}</b>.` : 'Tu ne coupes pas cette manche.'}</div>${waiting}`
        : `<div><b>Clique sur la barre d'un joueur</b> pour y poser ton jeton, ou abstiens-toi.
             <span class="muted">Révélée si ≥ ${g.threshold} jeton${g.threshold > 1 ? 's' : ''} et nombre impair · max ${g.cap} barre${g.cap > 1 ? 's' : ''}.</span></div>
           <div class="row">
             <button class="primary" id="confirmCut" ${selectedTarget ? '' : 'disabled'}>Couper${selectedTarget ? ` ${nameOf(selectedTarget)}` : ''}</button>
             <button id="skipCut">Ne pas couper</button>
           </div>`;
      break;
    case 'reveal':
      action = `<div>${g.lastRevealedCount
        ? `💥 <b>${g.lastRevealedCount} barre${g.lastRevealedCount > 1 ? 's' : ''} révélée${g.lastRevealedCount > 1 ? 's' : ''}</b>.`
        : '😶 <b>Aucune barre révélée</b> cette manche.'}
        ${g.round < g.rounds ? 'Les cartes vont être mélangées et redistribuées.' : 'C\'était la dernière manche.'}</div>
        ${me.acted ? waiting : '<button class="primary" id="ready">Continuer</button>'}`;
      break;
    case 'ended': {
      const w = g.winner;
      action = `<div class="end-banner ${w.team}">${TEAM[w.team]}</div>
        <div>${esc(w.reason)}</div>
        <ul class="players" style="margin-top:10px">
          ${g.seats.map((s) => `<li><span class="badge ${g.roles[s.id]}" style="padding:2px 8px;border-radius:999px;color:#0d1117;font-weight:800">${ROLE[g.roles[s.id]].label}</span> ${nameOf(s.id)}</li>`).join('')}
        </ul>
        <div class="row" style="margin-top:10px">
          ${isHost() ? '<button class="primary" id="again">Nouvelle partie</button>' : '<span class="muted">L\'hôte peut relancer une partie.</span>'}
          <button class="link" id="leave">Quitter</button>
        </div>`;
      break;
    }
  }

  // Historique
  const byRound = {};
  for (const r of g.revealed) (byRound[r.round] ||= []).push(r);
  const historyHtml = Object.keys(byRound).length
    ? Object.entries(byRound).map(([round, list]) => `<div class="line"><b>Manche ${round}</b> ${list.map((r) => `${miniCard(r.card)} <span class="muted">(${nameOf(r.ownerId)}, ${r.tokens} ✂️)</span>`).join(' ')}</div>`).join('')
    : '<div class="muted">Aucune carte révélée pour l\'instant.</div>';

  app.innerHTML = `
    <div class="panel topbar">
      <div>
        <div class="muted">Manche ${Math.min(g.round, g.rounds)}/${g.rounds} · Salon ${state.code}</div>
        <div class="phase">${PHASE[g.phase]}</div>
      </div>
      <div class="progress">⚛️ ${g.atomicsFound}/${g.atomicsNeeded} Atomiques</div>
      <div class="timer" id="timer"></div>
    </div>

    <div class="panel role ${roleHidden ? 'hidden-role' : ''}">
      <span class="badge ${me.role}">${role.label}</span>
      <span class="muted" style="flex:1">${roleHidden ? 'Rôle masqué' : role.goal}</span>
      <button class="link" id="toggleRole">${roleHidden ? 'Afficher' : 'Masquer'}</button>
    </div>

    <div class="panel stack">${action}</div>

    <div class="panel">
      <h2>☢️ Réacteur</h2>
      <div class="reactor">${bars}</div>
    </div>

    <div class="panel">
      <h2>Ta main</h2>
      <div class="hand">${me.hand.length
        ? me.hand.map((c) => cardHtml(c, g.phase === 'insertion' && !me.acted ? 'clickable' : '')).join('')
        : '<span class="muted">Aucune carte.</span>'}</div>
    </div>

    <div class="panel">
      <h2>Cartes révélées</h2>
      <div class="history">${historyHtml}</div>
      <div class="muted" style="margin-top:8px">Paquet : ${g.atomicsTotal} Atomiques, 1 Nucléaire, le reste Vides.</div>
    </div>
    ${rulesHtml()}`;

  // Événements
  document.getElementById('toggleRole').onclick = () => { roleHidden = !roleHidden; render(); };
  app.querySelectorAll('.card.clickable').forEach((el) => {
    el.onclick = () => socket.emit('insert', el.dataset.card);
  });
  app.querySelectorAll('.bar.selectable').forEach((el) => {
    el.onclick = () => { selectedTarget = selectedTarget === el.dataset.seat ? null : el.dataset.seat; render(); };
  });
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('ready', () => socket.emit('ready'));
  on('confirmCut', () => selectedTarget && socket.emit('cut', selectedTarget));
  on('skipCut', () => socket.emit('cut', null));
  on('again', () => socket.emit('backToLobby'));
  on('leave', leaveRoom);
  updateTimer();
}

function updateTimer() {
  const el = document.getElementById('timer');
  if (!el) return;
  if (!localDeadline) { el.textContent = ''; return; }
  const s = Math.max(0, Math.ceil((localDeadline - Date.now()) / 1000));
  el.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  el.classList.toggle('low', s <= 10);
}
setInterval(updateTimer, 250);
