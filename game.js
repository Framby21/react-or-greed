// Logique pure du jeu "React or Greed" (aucune dépendance réseau).

const CONFIG = {
  minPlayers: 3,
  maxPlayers: 12,
  rounds: 4,
  handSize: 5,
  // Le neutre (Pilleur) gagne seul s'il fait révéler ce nombre de Vides avec ses jetons
  lootNeeded: 3,
  // Durées des phases en secondes (chrono + bouton "Prêt"). null = pas de chrono :
  // on attend que tous les joueurs connectés aient validé.
  timers: { insertion: null, debate: 180, cut: 45, reveal: 20 },
};

// [gentils, méchants, neutre] selon le nombre de joueurs
const ROLE_TABLE = {
  3: [2, 1, 0], 4: [2, 1, 1], 5: [2, 2, 1], 6: [3, 2, 1], 7: [4, 2, 1],
  8: [4, 3, 1], 9: [5, 3, 1], 10: [6, 3, 1], 11: [6, 4, 1], 12: [7, 4, 1],
};

const threshold = (n) => (n <= 4 ? 1 : n <= 9 ? 3 : 5);
const revealCap = (n) => Math.max(1, n - 2);

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class Game {
  constructor(playerIds) {
    const n = playerIds.length;
    if (n < CONFIG.minPlayers || n > CONFIG.maxPlayers) throw new Error('Nombre de joueurs invalide');
    this.id = Math.random().toString(36).slice(2, 8);
    this.ids = [...playerIds];
    this.n = n;
    this.round = 1;
    this.atomicsTotal = n;
    this.atomicsFound = 0;
    this.threshold = threshold(n);
    this.cap = revealCap(n);
    // Objectif calibré sur le nombre maximal de révélations possibles en 4 manches
    const maxReveals = CONFIG.rounds * Math.min(this.cap, Math.floor(n / this.threshold));
    this.atomicsNeeded = Math.max(2, Math.min(n - 1, Math.ceil(maxReveals / 2)));
    this.revealed = []; // { round, ownerId, card, tokens }
    this.lastResult = null; // { counts, revealedIds }
    this.winner = null; // { team: 'good'|'bad'|'neutral', reason }
    this.loot = 0; // Vides révélées avec un jeton du neutre
    this.lootNeeded = CONFIG.lootNeeded;
    this.joker = { usedRound: null, target: null }; // 2e jeton du neutre, une fois par partie

    // Rôles
    const [g, b, ne] = ROLE_TABLE[n];
    const roles = shuffle([
      ...Array(g).fill('good'), ...Array(b).fill('bad'), ...Array(ne).fill('neutral'),
    ]);
    this.roles = {};
    this.ids.forEach((id, i) => { this.roles[id] = roles[i]; });

    // Illustration de rôle : index différent pour chaque joueur d'un même camp
    // (le client fait index % nombre d'illustrations disponibles)
    const start = { good: Math.floor(Math.random() * 1000), bad: Math.floor(Math.random() * 1000), neutral: 0 };
    this.art = {};
    for (const id of shuffle([...this.ids])) this.art[id] = start[this.roles[id]]++;

    // Paquet
    let cid = 0;
    const mk = (type) => ({ id: `c${cid++}`, type });
    const total = n * CONFIG.handSize;
    const deck = [mk('nuclear')];
    for (let i = 0; i < this.atomicsTotal; i++) deck.push(mk('atomic'));
    while (deck.length < total) deck.push(mk('empty'));
    this.hands = {};
    this.deal(deck);
    this.startInsertion();
  }

  deal(cards) {
    shuffle(cards);
    this.ids.forEach((id) => { this.hands[id] = []; });
    const offset = Math.floor(Math.random() * this.n);
    cards.forEach((c, i) => this.hands[this.ids[(i + offset) % this.n]].push(c));
  }

  startInsertion() {
    this.phase = 'insertion';
    this.bars = {};
    this.tokens = {};
    this.acted = new Set();
    this.lastResult = null;
  }

  // ---- Actions joueurs ----

  // Proposer (ou changer) sa carte : non définitif tant que le joueur n'a pas validé
  insert(pid, cardId) {
    if (this.phase !== 'insertion' || this.acted.has(pid)) return false;
    const hand = this.hands[pid];
    const idx = hand ? hand.findIndex((c) => c.id === cardId) : -1;
    if (idx === -1) return false;
    const chosen = hand[idx];
    if (this.bars[pid]) hand[idx] = this.bars[pid]; // l'ancienne carte reprend sa place en main
    else hand.splice(idx, 1);
    this.bars[pid] = chosen;
    return true;
  }

  confirmInsert(pid) {
    if (this.phase !== 'insertion' || !this.bars[pid] || this.acted.has(pid)) return false;
    this.acted.add(pid);
    return true;
  }

  unconfirmInsert(pid) {
    if (this.phase !== 'insertion' || !this.acted.has(pid)) return false;
    this.acted.delete(pid);
    return true;
  }

  cut(pid, targetId, jokerTarget = null) {
    if (this.phase !== 'cut' || this.acted.has(pid)) return false;
    const valid = (t) => t !== pid && !!this.bars[t];
    if (targetId !== null && !valid(targetId)) return false;
    if (jokerTarget !== null) {
      if (this.roles[pid] !== 'neutral' || this.joker.usedRound !== null || !valid(jokerTarget)) return false;
      this.joker = { usedRound: this.round, target: jokerTarget };
    }
    this.tokens[pid] = targetId;
    this.acted.add(pid);
    return true;
  }

  ready(pid) {
    if (this.phase !== 'debate' && this.phase !== 'reveal') return false;
    this.acted.add(pid);
    return true;
  }

  // Tous les joueurs connectés ont agi ?
  isPhaseComplete(connectedIds) {
    if (this.phase === 'ended' || connectedIds.length === 0) return false;
    return connectedIds.every((id) => this.acted.has(id));
  }

  // ---- Passage à la phase suivante (remplit les actions manquantes) ----

  advance() {
    switch (this.phase) {
      case 'insertion':
        for (const id of this.ids) {
          if (!this.bars[id] && this.hands[id].length) {
            const h = this.hands[id];
            this.bars[id] = h.splice(Math.floor(Math.random() * h.length), 1)[0];
          }
        }
        this.phase = 'debate';
        this.acted = new Set();
        break;
      case 'debate':
        this.phase = 'cut';
        this.acted = new Set();
        break;
      case 'cut':
        this.resolveCut();
        this.phase = this.winner ? 'ended' : 'reveal';
        this.acted = new Set();
        break;
      case 'reveal':
        if (this.round >= CONFIG.rounds) {
          this.winner = { team: 'bad', reason: 'Les 4 manches sont écoulées sans que les gentils atteignent leur objectif.' };
          this.phase = 'ended';
          this.acted = new Set();
        } else {
          this.round++;
          const pool = [];
          for (const id of this.ids) {
            pool.push(...this.hands[id]);
            if (this.bars[id]) pool.push(this.bars[id]);
          }
          this.deal(pool);
          this.startInsertion();
        }
        break;
      default:
        break;
    }
  }

  resolveCut() {
    const counts = {};
    for (const id of this.ids) counts[id] = 0;
    for (const t of Object.values(this.tokens)) if (t) counts[t]++;
    const jokerNow = this.joker.usedRound === this.round ? this.joker.target : null;
    if (jokerNow) counts[jokerNow]++;

    // Barres éligibles : seuil atteint ET nombre impair. Égalités départagées au hasard.
    const eligible = shuffle(this.ids.filter((id) => this.bars[id]
      && counts[id] >= this.threshold && counts[id] % 2 === 1))
      .sort((a, b) => counts[b] - counts[a])
      .slice(0, this.cap);

    const neutralId = this.ids.find((id) => this.roles[id] === 'neutral');
    const neutralOn = (id) => !!neutralId && (this.tokens[neutralId] === id || jokerNow === id);

    let nuclearOwner = null;
    for (const id of eligible) {
      const card = this.bars[id];
      this.revealed.push({ round: this.round, ownerId: id, card, tokens: counts[id] });
      if (card.type === 'nuclear') nuclearOwner = id;
      if (card.type === 'atomic') this.atomicsFound++;
      if (card.type === 'empty' && neutralOn(id)) this.loot++;
      delete this.bars[id];
    }
    this.lastResult = { counts, revealedIds: eligible };

    // Priorité : Nucléaire > butin du Pilleur > Atomiques
    if (nuclearOwner) {
      if (neutralOn(nuclearOwner)) {
        this.winner = { team: 'neutral', reason: 'Le neutre avait un jeton sur la carte Nucléaire !' };
      } else {
        this.winner = { team: 'bad', reason: 'La carte Nucléaire a été révélée !' };
      }
    } else if (neutralId && this.loot >= this.lootNeeded) {
      this.winner = { team: 'neutral', reason: `Le Pilleur a fait révéler ${this.lootNeeded} cartes Vides avec ses jetons !` };
    } else if (this.atomicsFound >= this.atomicsNeeded) {
      this.winner = { team: 'good', reason: `${this.atomicsNeeded} cartes Atomiques ont été révélées !` };
    }
  }

  // ---- Vue filtrée pour un joueur (ne fuite aucune info cachée) ----

  viewFor(pid) {
    const ended = this.phase === 'ended';
    const showCounts = this.phase === 'reveal' || ended;
    return {
      id: this.id,
      phase: this.phase,
      round: this.round,
      rounds: CONFIG.rounds,
      atomicsTotal: this.atomicsTotal,
      atomicsNeeded: this.atomicsNeeded,
      atomicsFound: this.atomicsFound,
      threshold: this.threshold,
      cap: this.cap,
      me: {
        role: this.roles[pid],
        art: this.art[pid],
        hand: this.hands[pid] || [],
        bar: this.bars[pid] || null,
        acted: this.acted.has(pid),
        token: this.phase === 'cut' || showCounts ? (this.tokens[pid] ?? null) : null,
        // Infos propres au neutre (jamais envoyées aux autres joueurs)
        joker: this.roles[pid] === 'neutral' ? {
          available: this.joker.usedRound === null,
          usedRound: this.joker.usedRound,
          target: this.joker.usedRound === this.round && (this.phase === 'cut' || showCounts) ? this.joker.target : null,
        } : null,
        loot: this.roles[pid] === 'neutral' ? this.loot : null,
      },
      lootNeeded: this.lootNeeded,
      seats: this.ids.map((id) => ({
        id,
        handCount: (this.hands[id] || []).length,
        // Pendant l'insertion, la barre n'apparaît remplie aux autres qu'une fois validée
        hasBar: this.phase === 'insertion'
          ? this.acted.has(id)
          : !!this.bars[id] || (this.lastResult?.revealedIds.includes(id) ?? false),
        acted: this.acted.has(id),
        tokens: showCounts && this.lastResult ? this.lastResult.counts[id] : null,
        revealedCard: showCounts && this.lastResult?.revealedIds.includes(id)
          ? this.revealed.findLast((r) => r.ownerId === id && r.round === this.round).card
          : null,
      })),
      revealed: this.revealed,
      lastRevealedCount: this.lastResult ? this.lastResult.revealedIds.length : 0,
      winner: this.winner,
      roles: ended ? this.roles : null,
      arts: ended ? this.art : null,
      finalLoot: ended ? this.loot : null,
    };
  }
}

module.exports = { Game, CONFIG, ROLE_TABLE };
