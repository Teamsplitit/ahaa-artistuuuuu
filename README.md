# ahaa artistuuu

A real-time multiplayer Telugu movie guessing game inspired by Skribbl-style turns.

## Features

- Up to **15 players** in one room.
- Join via **invite code** or share link.
- Host can set:
  - Number of rounds
  - Time limit per round
- Turn rotates in a circle each round.
- Only current clue giver sees the Telugu movie title.
- Clue giver draws in real-time board; others guess from drawing.
- Guesser side shows masked title letters and reveals up to configured letters over time.
- Others guess; points are Skribbl-like (first and faster correct guesses get more).
- Drawer points increase when guesses come quickly and everyone solves.
- Round auto-advances when all non-drawing players guess correctly.
- 10-second break between rounds before next round starts automatically.
- If time runs out, clue giver loses points.
- After final round, rankings are shown for 10 seconds, then room auto-closes for all players.
- Telugu movie names only.

## Reliability fixes included

- **Tab refresh/reopen reconnect**:
  - Player identity is stored in browser localStorage.
  - Rejoining with same code restores same player seat.
- **Host auto-transfer**:
  - If host disconnects/leaves, host role moves to another active player.

## Run

```bash
cd /Users/srinivas/Documents/games/telugu-movie-multiplayer
npm install
npm run dev
```

Open: [http://localhost:3001](http://localhost:3001)

## Project structure

- `server/index.js` - Socket.IO game server and room state
- `server/movies.js` - Telugu movie list
- `public/index.html` - UI
- `public/script.js` - Client game logic
- `public/styles.css` - Styles
