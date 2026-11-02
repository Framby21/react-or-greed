# React or Greed

Jeu de bluff multijoueur en ligne, de 3 à 12 joueurs, avec rôles cachés : gentils, méchants et neutre.

## Lancer en local

```bash
npm install
npm start        # ou: npm run dev (redémarre à chaque modification)
```

Ouvre ensuite http://localhost:3000. Pour tester seul, ouvre plusieurs onglets en navigation privée : chaque fenêtre privée compte comme un joueur différent.

## Fichiers

- `game.js` : règles du jeu (logique pure). Les réglages sont dans `CONFIG` et `ROLE_TABLE` : nombre de manches, taille des mains, chronos, rôles.
- `server.js` : salons, connexions et reconnexions, chronos (Express + Socket.IO).
- `public/` : interface web (HTML, CSS, JS sans framework).

## Connexions

- Un joueur déconnecté n'est jamais attendu : une phase avance dès que tous les joueurs connectés ont agi, ou à la fin du chrono.
- Pour un absent, le serveur insère une carte au hasard et ne pose pas de jeton.
- Un joueur qui rafraîchit la page ou revient par le lien retrouve sa place, grâce à un identifiant gardé dans le navigateur.
- Si l'hôte est absent, n'importe quel joueur peut lancer ou relancer la partie.
