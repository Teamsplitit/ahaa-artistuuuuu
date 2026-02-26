import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { TELUGU_MOVIES } from './movies.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const PORT = process.env.PORT || 3001;
const MAX_PLAYERS = 15;
const MIN_PLAYERS = 2;
const DEFAULT_ROUNDS = 8;
const DEFAULT_TIME_LIMIT_SEC = 45;
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 30;
const MIN_TIME_LIMIT_SEC = 15;
const MAX_TIME_LIMIT_SEC = 180;
const DEFAULT_HINT_REVEAL_WORDS = 3;
const MIN_HINT_REVEAL_WORDS = 0;
const MAX_HINT_REVEAL_WORDS = 3;
const DISCONNECT_GRACE_MS = 90_000;
const GAME_CLOSE_DELAY_MS = 10_000;
const ROUND_BREAK_MS = 10 * 1000;
const RANDOM_MOVIE_API_URL = 'https://random-movie-api-872s.onrender.com/random-telugu-movie';
const RANDOM_MOVIE_API_TIMEOUT_MS = 8000;
const GUESSER_BASE_POINTS = 30;
const GUESSER_TIME_BONUS_MAX = 50;
const GUESSER_ORDER_BONUS_MAX = 35;
const DRAWER_BASE_POINTS = 25;
const DRAWER_AVG_GUESSER_WEIGHT = 0.45;
const DRAWER_TIME_BONUS_MAX = 35;
const DRAWER_ALL_GUESSED_BONUS = 10;

const PHASES = {
  LOBBY: 'lobby',
  PLAYING: 'playing',
  BREAK: 'break',
  ENDED: 'ended',
};

const rooms = new Map();

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(cleanCode(req.params.code));
  if (!room) return res.status(404).json({ valid: false });
  return res.json({
    valid: true,
    phase: room.phase,
    canJoin: room.phase === PHASES.LOBBY && room.players.length < MAX_PLAYERS,
    players: room.players.length,
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

function cleanName(name) {
  return String(name || '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()
    .slice(0, 24);
}

function cleanCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

function normalizeGuess(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function isAlmostCorrectGuess(guess, answer) {
  if (!guess || !answer || guess === answer) return false;
  const maxLen = Math.max(guess.length, answer.length);
  if (maxLen < 4) return false;
  const distance = levenshteinDistance(guess, answer);
  const threshold = maxLen <= 6 ? 1 : 2;
  return distance > 0 && distance <= threshold;
}

function buildCode() {
  return nanoid(6).toUpperCase();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makePlayer(socket, name, id) {
  return {
    id: id || nanoid(),
    socketId: socket.id,
    name,
    score: 0,
    connected: true,
    disconnectedAt: null,
  };
}

function createRoom(hostSocket, hostName, inviteCode) {
  const code = inviteCode || buildCode();
  const host = makePlayer(hostSocket, hostName);
  const room = {
    code,
    hostId: host.id,
    players: [host],
    phase: PHASES.LOBBY,
    settings: {
      rounds: DEFAULT_ROUNDS,
      timeLimitSec: DEFAULT_TIME_LIMIT_SEC,
      hintRevealWords: DEFAULT_HINT_REVEAL_WORDS,
    },
    roundNumber: 0,
    turnOrder: [],
    turnIndex: -1,
    pendingClueGivers: new Set(),
    currentClueGiverId: null,
    currentMovie: null,
    roundEndsAt: null,
    guesses: [],
    boardStrokes: [],
    correctGuessers: new Set(),
    correctGuesserPoints: new Map(),
    firstCorrectGuesserId: null,
    usedMovies: new Set(),
    lastMovieSource: null,
    lastMovieTitle: null,
    history: [],
    timerHandle: null,
    breakHandle: null,
    nextRoundStartsAt: null,
    closeHandle: null,
    gameClosesAt: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return { room, player: host };
}

function getConnectedPlayers(room) {
  return room.players.filter((p) => p.connected);
}

function getEligibleGuessers(room) {
  return getConnectedPlayers(room).filter((p) => p.id !== room.currentClueGiverId);
}

function allEligibleGuessersCorrect(room) {
  const eligible = getEligibleGuessers(room);
  if (!eligible.length) return false;
  return eligible.every((p) => room.correctGuessers.has(p.id));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function getRemainingTimeRatio(room, now = Date.now()) {
  if (!room.roundEndsAt) return 0;
  const remainingMs = room.roundEndsAt - now;
  const totalMs = room.settings.timeLimitSec * 1000;
  if (totalMs <= 0) return 0;
  return clamp01(remainingMs / totalMs);
}

function calculateGuesserPoints({ eligibleCount, alreadyCorrectCount, remainingTimeRatio }) {
  const rank = alreadyCorrectCount + 1;
  const orderFactor = eligibleCount <= 1 ? 1 : (eligibleCount - rank) / (eligibleCount - 1);
  const timeBonus = Math.round(GUESSER_TIME_BONUS_MAX * clamp01(remainingTimeRatio));
  const orderBonus = Math.round(GUESSER_ORDER_BONUS_MAX * clamp01(orderFactor));
  return Math.max(20, GUESSER_BASE_POINTS + timeBonus + orderBonus);
}

function calculateDrawerPoints({ guesserPoints, remainingTimeRatio, allGuessed }) {
  const avgGuesserPoints = guesserPoints.length
    ? guesserPoints.reduce((sum, p) => sum + p, 0) / guesserPoints.length
    : 0;
  const timeBonus = Math.round(DRAWER_TIME_BONUS_MAX * clamp01(remainingTimeRatio));
  const avgBonus = Math.round(avgGuesserPoints * DRAWER_AVG_GUESSER_WEIGHT);
  const allGuessedBonus = allGuessed ? DRAWER_ALL_GUESSED_BONUS : 0;
  return Math.max(15, DRAWER_BASE_POINTS + avgBonus + timeBonus + allGuessedBonus);
}

function isHideableChar(ch) {
  return /[\p{L}\p{N}]/u.test(ch);
}

function buildWordRevealOrder(chars) {
  const hideable = chars
    .map((ch, idx) => ({ ch, idx }))
    .filter((x) => isHideableChar(x.ch))
    .map((x) => x.idx);
  if (!hideable.length) return [];

  const first = hideable[0];
  const second = hideable[1];
  const last = hideable[hideable.length - 1];

  const order = [];
  const add = (idx) => {
    if (idx == null) return;
    if (!order.includes(idx)) order.push(idx);
  };

  add(second ?? first);
  add(last);
  add(first);
  for (let i = 2; i < hideable.length; i += 1) add(hideable[i]);
  return order;
}

function getRevealLetterCount(room, revealCap) {
  if (!revealCap || !room.roundEndsAt) return 0;
  const totalMs = room.settings.timeLimitSec * 1000;
  if (!totalMs) return 0;
  const remainingMs = Math.max(0, room.roundEndsAt - Date.now());
  const elapsedRatio = clamp01(1 - remainingMs / totalMs);
  return Math.min(revealCap, Math.floor(elapsedRatio * (revealCap + 1)));
}

function buildMovieHint(room) {
  const rawWords = String(room.currentMovie || '').trim().split(/\s+/).filter(Boolean);
  const words = rawWords.map((word) => {
    const chars = [...word];
    return { chars, revealOrder: buildWordRevealOrder(chars), revealed: new Set() };
  });

  const configuredReveal = Math.min(
    MAX_HINT_REVEAL_WORDS,
    Math.max(MIN_HINT_REVEAL_WORDS, Number(room.settings.hintRevealWords) || 0)
  );
  const totalHideable = words.reduce((sum, w) => sum + w.revealOrder.length, 0);
  const revealCap = Math.min(configuredReveal, totalHideable);
  const revealLetters = getRevealLetterCount(room, revealCap);

  const globalOrder = [];
  let cursor = 0;
  while (globalOrder.length < totalHideable) {
    let progressed = false;
    for (let wi = 0; wi < words.length; wi += 1) {
      const idx = words[wi].revealOrder[cursor];
      if (idx != null) {
        globalOrder.push({ wi, idx });
        progressed = true;
      }
    }
    if (!progressed) break;
    cursor += 1;
  }

  for (let i = 0; i < revealLetters && i < globalOrder.length; i += 1) {
    const { wi, idx } = globalOrder[i];
    words[wi].revealed.add(idx);
  }

  const hintText = words
    .map((w) => w.chars.map((ch, idx) => (isHideableChar(ch) ? (w.revealed.has(idx) ? ch : '-') : ch)).join(' '))
    .join('   ');

  return {
    text: hintText,
    totalWords: words.length,
    totalLetters: totalHideable,
    revealedLetters: revealLetters,
    maxRevealLetters: revealCap,
  };
}

function getConnectedTurnOrderIds(room) {
  const ordered = room.turnOrder.filter((id) => room.players.some((p) => p.id === id && p.connected));
  if (ordered.length) return ordered;
  return room.players.filter((p) => p.connected).map((p) => p.id);
}

function getNextClueGiverId(room, allowedIds = null) {
  const ordered = room.turnOrder.filter((id) => room.players.some((p) => p.id === id));
  room.turnOrder = ordered;
  if (!room.turnOrder.length) room.turnOrder = room.players.map((p) => p.id);
  if (!room.turnOrder.length) return null;

  let tries = room.turnOrder.length;
  while (tries > 0) {
    room.turnIndex = (room.turnIndex + 1) % room.turnOrder.length;
    const candidateId = room.turnOrder[room.turnIndex];
    const candidate = room.players.find((p) => p.id === candidateId);
    if (!candidate || !candidate.connected) {
      tries -= 1;
      continue;
    }
    if (allowedIds && !allowedIds.has(candidate.id)) {
      tries -= 1;
      continue;
    }
    return candidate.id;
    tries -= 1;
  }
  return room.turnOrder[room.turnIndex] || null;
}

function pickMovieFromLocalList(room) {
  if (room.usedMovies.size >= TELUGU_MOVIES.length) room.usedMovies.clear();
  const available = TELUGU_MOVIES.filter((m) => !room.usedMovies.has(m));
  const movie = available[Math.floor(Math.random() * available.length)];
  room.usedMovies.add(movie);
  return movie;
}

function sanitizeMovieTitle(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 80);
  return cleaned || null;
}

function extractMovieTitle(payload) {
  if (typeof payload === 'string') return sanitizeMovieTitle(payload);
  if (!payload || typeof payload !== 'object') return null;
  return (
    sanitizeMovieTitle(payload.movie) ||
    sanitizeMovieTitle(payload.title) ||
    sanitizeMovieTitle(payload.name) ||
    null
  );
}

async function pickMovie(room) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), RANDOM_MOVIE_API_TIMEOUT_MS);

  try {
    const response = await fetch(RANDOM_MOVIE_API_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
    });
    if (response.ok) {
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const payload = contentType.includes('application/json')
        ? await response.json()
        : await response.text();
      const movieFromApi = extractMovieTitle(payload);
      if (movieFromApi) {
        room.lastMovieSource = 'api';
        room.lastMovieTitle = movieFromApi;
        console.log(`[movie] source=api room=${room.code} title="${movieFromApi}"`);
        return movieFromApi;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[movie] source=api error room=${room.code} message="${message}"`);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const fallbackMovie = pickMovieFromLocalList(room);
  room.lastMovieSource = 'fallback';
  room.lastMovieTitle = fallbackMovie;
  console.warn(`[movie] source=fallback room=${room.code} title="${fallbackMovie}"`);
  return fallbackMovie;
}

function clearTimer(room) {
  if (room.timerHandle) clearTimeout(room.timerHandle);
  room.timerHandle = null;
}

function clearBreakTimer(room) {
  if (room.breakHandle) clearTimeout(room.breakHandle);
  room.breakHandle = null;
}

function clearCloseTimer(room) {
  if (room.closeHandle) clearTimeout(room.closeHandle);
  room.closeHandle = null;
}

function scoreboard(room) {
  return [...room.players]
    .map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function closeRoom(roomCode, reason = 'Game ended') {
  const room = rooms.get(roomCode);
  if (!room) return;

  clearTimer(room);
  clearBreakTimer(room);
  clearCloseTimer(room);
  for (const p of room.players) {
    if (!p.socketId) continue;
    const s = io.sockets.sockets.get(p.socketId);
    if (!s) continue;
    s.emit('room:closed', { reason });
    s.leave(roomCode);
    s.data.roomCode = null;
    s.data.playerId = null;
  }
  rooms.delete(roomCode);
}

function scheduleRoomClosure(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  clearCloseTimer(room);
  room.gameClosesAt = Date.now() + GAME_CLOSE_DELAY_MS;
  room.closeHandle = setTimeout(() => closeRoom(roomCode, 'Game completed'), GAME_CLOSE_DELAY_MS);
}

function sanitizeSettings(settings = {}) {
  const rounds = Number(settings.rounds);
  const timeLimitSec = Number(settings.timeLimitSec);
  const hintRevealWords = Number(settings.hintRevealWords);
  return {
    rounds: Number.isFinite(rounds) ? Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, Math.floor(rounds))) : DEFAULT_ROUNDS,
    timeLimitSec: Number.isFinite(timeLimitSec)
      ? Math.min(MAX_TIME_LIMIT_SEC, Math.max(MIN_TIME_LIMIT_SEC, Math.floor(timeLimitSec)))
      : DEFAULT_TIME_LIMIT_SEC,
    hintRevealWords: Number.isFinite(hintRevealWords)
      ? Math.min(MAX_HINT_REVEAL_WORDS, Math.max(MIN_HINT_REVEAL_WORDS, Math.floor(hintRevealWords)))
      : DEFAULT_HINT_REVEAL_WORDS,
  };
}

function applyRoundTimeout(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.phase !== PHASES.PLAYING) return;
  if (room.roundEndsAt && Date.now() < room.roundEndsAt - 5) return;

  const clueGiver = room.players.find((p) => p.id === room.currentClueGiverId);
  if (clueGiver) clueGiver.score = Math.max(0, clueGiver.score - 2);

  room.history.push({
    roundNumber: room.roundNumber,
    clueGiverId: room.currentClueGiverId,
    movie: room.currentMovie,
    winnerId: room.firstCorrectGuesserId,
    timedOut: true,
    guessedAt: null,
    strokeCount: room.boardStrokes.length,
    correctGuessersCount: room.correctGuessers.size,
  });

  moveToNextRound(room, roomCode);
}

async function startRound(room, roomCode) {
  clearTimer(room);
  clearBreakTimer(room);
  room.phase = PHASES.PLAYING;
  if (!room.pendingClueGivers.size) {
    room.pendingClueGivers = new Set(getConnectedTurnOrderIds(room));
  }
  room.currentClueGiverId = getNextClueGiverId(room, room.pendingClueGivers);
  if (!room.currentClueGiverId) {
    room.phase = PHASES.ENDED;
    room.roundEndsAt = null;
    room.nextRoundStartsAt = null;
    room.currentMovie = null;
    room.gameClosesAt = Date.now() + GAME_CLOSE_DELAY_MS;
    scheduleRoomClosure(roomCode);
    return;
  }
  room.currentMovie = await pickMovie(room);
  room.guesses = [];
  room.boardStrokes = [];
  room.correctGuessers = new Set();
  room.correctGuesserPoints = new Map();
  room.firstCorrectGuesserId = null;
  room.nextRoundStartsAt = null;
  room.roundEndsAt = Date.now() + room.settings.timeLimitSec * 1000;

  room.timerHandle = setTimeout(() => {
    applyRoundTimeout(roomCode);
    emitRoom(roomCode);
  }, room.settings.timeLimitSec * 1000 + 50);
}

function moveToNextRound(room, roomCode) {
  clearTimer(room);
  clearBreakTimer(room);

  if (room.currentClueGiverId) room.pendingClueGivers.delete(room.currentClueGiverId);
  const connectedThisRound = new Set(getConnectedTurnOrderIds(room));
  room.pendingClueGivers = new Set(
    [...room.pendingClueGivers].filter((id) => connectedThisRound.has(id))
  );

  if (!room.pendingClueGivers.size) {
    if (room.roundNumber >= room.settings.rounds) {
      room.phase = PHASES.ENDED;
      room.roundEndsAt = null;
      room.nextRoundStartsAt = null;
      room.currentMovie = null;
      room.currentClueGiverId = null;
      room.boardStrokes = [];
      room.lastMovieSource = null;
      room.lastMovieTitle = null;
      scheduleRoomClosure(roomCode);
      return;
    }
    room.roundNumber += 1;
    room.pendingClueGivers = new Set(getConnectedTurnOrderIds(room));
  }

  if (!room.pendingClueGivers.size) {
    room.phase = PHASES.ENDED;
    room.roundEndsAt = null;
    room.nextRoundStartsAt = null;
    room.currentMovie = null;
    room.currentClueGiverId = null;
    room.boardStrokes = [];
    room.lastMovieSource = null;
    room.lastMovieTitle = null;
    scheduleRoomClosure(roomCode);
    return;
  }

  room.phase = PHASES.BREAK;
  room.roundEndsAt = null;
  room.currentMovie = null;
  room.currentClueGiverId = null;
  room.boardStrokes = [];
  room.lastMovieSource = null;
  room.lastMovieTitle = null;
  room.nextRoundStartsAt = Date.now() + ROUND_BREAK_MS;
  room.breakHandle = setTimeout(() => {
    const latest = rooms.get(roomCode);
    if (!latest || latest.phase !== PHASES.BREAK) return;
    startRound(latest, roomCode)
      .then(() => emitRoom(roomCode))
      .catch(() => emitRoom(roomCode));
  }, ROUND_BREAK_MS);
}

function resolveHost(room) {
  const host = room.players.find((p) => p.id === room.hostId);
  if (host && host.connected) return;
  const connected = room.players.find((p) => p.connected);
  room.hostId = connected ? connected.id : room.players[0]?.id || null;
}

function removePlayer(room, playerId) {
  room.players = room.players.filter((p) => p.id !== playerId);
  room.turnOrder = room.turnOrder.filter((id) => id !== playerId);
  room.pendingClueGivers.delete(playerId);
  resolveHost(room);
}

function cleanDisconnected() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const stale = room.players.filter((p) => !p.connected && p.disconnectedAt && now - p.disconnectedAt > DISCONNECT_GRACE_MS);
    for (const p of stale) removePlayer(room, p.id);

    if (room.phase === PHASES.PLAYING) {
      const clueGiver = room.players.find((p) => p.id === room.currentClueGiverId);
      if (!clueGiver || !clueGiver.connected) {
        room.history.push({
          roundNumber: room.roundNumber,
          clueGiverId: room.currentClueGiverId,
          movie: room.currentMovie,
          winnerId: room.firstCorrectGuesserId,
          timedOut: true,
          guessedAt: null,
          strokeCount: room.boardStrokes.length,
          correctGuessersCount: room.correctGuessers.size,
          reason: 'Clue giver disconnected',
        });
        moveToNextRound(room, code);
      }
    }

    if (!room.players.length) {
      clearTimer(room);
      clearBreakTimer(room);
      clearCloseTimer(room);
      rooms.delete(code);
    }
  }
}

setInterval(() => {
  cleanDisconnected();
  for (const code of rooms.keys()) emitRoom(code);
}, 1000);

function buildPublicRoom(room, viewerId) {
  const viewer = room.players.find((p) => p.id === viewerId);
  const isClueGiver = viewerId && room.currentClueGiverId === viewerId;
  const movieHint = room.phase === PHASES.PLAYING && !isClueGiver ? buildMovieHint(room) : null;
  const topScore = Math.max(0, ...room.players.map((p) => p.score));
  const winners = room.phase === PHASES.ENDED ? room.players.filter((p) => p.score === topScore).map((p) => p.id) : [];

  return {
    code: room.code,
    hostId: room.hostId,
    players: scoreboard(room),
    rankings: scoreboard(room),
    phase: room.phase,
    settings: room.settings,
    roundNumber: room.roundNumber,
    currentClueGiverId: room.currentClueGiverId,
    currentClueGiverName: room.players.find((p) => p.id === room.currentClueGiverId)?.name || null,
    roundEndsAt: room.roundEndsAt,
    nextRoundStartsAt: room.nextRoundStartsAt,
    guesses: room.guesses.slice(-15),
    boardStrokes: room.boardStrokes,
    correctGuesserIds: [...room.correctGuessers],
    history: room.history.slice(-8),
    myPlayerId: viewer?.id || null,
    myName: viewer?.name || null,
    myMovie: isClueGiver ? room.currentMovie : null,
    movieSource: room.phase === PHASES.PLAYING ? room.lastMovieSource : null,
    movieHint,
    maxPlayers: MAX_PLAYERS,
    minPlayers: MIN_PLAYERS,
    settingsBounds: {
      minRounds: MIN_ROUNDS,
      maxRounds: MAX_ROUNDS,
      minTimeLimitSec: MIN_TIME_LIMIT_SEC,
      maxTimeLimitSec: MAX_TIME_LIMIT_SEC,
      minHintRevealWords: MIN_HINT_REVEAL_WORDS,
      maxHintRevealWords: MAX_HINT_REVEAL_WORDS,
    },
    gameClosesAt: room.gameClosesAt,
    winners,
  };
}

function emitRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  for (const p of room.players) {
    if (!p.socketId) continue;
    const socket = io.sockets.sockets.get(p.socketId);
    if (socket) socket.emit('room:update', buildPublicRoom(room, p.id));
  }
}

function handlePlayerLeave(room, playerId, reason = 'Player left room') {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return;

  removePlayer(room, player.id);
  if (room.phase === PHASES.PLAYING && room.currentClueGiverId === player.id) {
    room.history.push({
      roundNumber: room.roundNumber,
      clueGiverId: player.id,
      movie: room.currentMovie,
      winnerId: room.firstCorrectGuesserId,
      timedOut: true,
      guessedAt: null,
      strokeCount: room.boardStrokes.length,
      correctGuessersCount: room.correctGuessers.size,
      reason,
    });
    moveToNextRound(room, room.code);
  }

  if (!room.players.length) {
    clearTimer(room);
    clearBreakTimer(room);
    clearCloseTimer(room);
    rooms.delete(room.code);
    return;
  }
  emitRoom(room.code);
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name, code }) => {
    const cleanedName = cleanName(name);
    const inviteCode = cleanCode(code);
    if (!cleanedName) {
      socket.emit('room:error', { message: 'Name is required' });
      return;
    }

    let finalCode = inviteCode;
    if (finalCode && rooms.has(finalCode)) {
      socket.emit('room:error', { message: 'Code already exists. Try another code.' });
      return;
    }
    while (!finalCode || rooms.has(finalCode)) finalCode = buildCode();

    const { room, player } = createRoom(socket, cleanedName, finalCode);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.emit('room:joined', { roomCode: room.code, playerId: player.id });
    emitRoom(room.code);
  });

  socket.on('room:join', ({ code, name, playerId }) => {
    const roomCode = cleanCode(code);
    const cleanedName = cleanName(name);
    if (!roomCode || !cleanedName) {
      socket.emit('room:error', { message: 'Code and name are required' });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room) {
      socket.emit('room:error', { message: 'Room not found' });
      return;
    }

    let player = null;

    if (playerId) {
      player = room.players.find((p) => p.id === playerId);
      if (player) {
        player.socketId = socket.id;
        player.connected = true;
        player.disconnectedAt = null;
      }
    }

    if (!player) {
      const sameName = room.players.find((p) => p.name.toLowerCase() === cleanedName.toLowerCase());
      if (sameName && !sameName.connected) {
        sameName.socketId = socket.id;
        sameName.connected = true;
        sameName.disconnectedAt = null;
        player = sameName;
      }
    }

    if (!player) {
      if (room.phase !== PHASES.LOBBY) {
        socket.emit('room:error', { message: 'Game already started. Reconnect using your previous browser.' });
        return;
      }
      if (room.players.length >= MAX_PLAYERS) {
        socket.emit('room:error', { message: 'Room is full (15 max)' });
        return;
      }
      if (room.players.some((p) => p.name.toLowerCase() === cleanedName.toLowerCase())) {
        socket.emit('room:error', { message: 'Name already taken in this room' });
        return;
      }
      player = makePlayer(socket, cleanedName);
      room.players.push(player);
    }

    resolveHost(room);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    socket.emit('room:joined', { roomCode: room.code, playerId: player.id });
    emitRoom(room.code);
  });

  socket.on('room:updateSettings', ({ rounds, timeLimitSec, hintRevealWords }) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room || room.hostId !== socket.data.playerId || room.phase !== PHASES.LOBBY) return;
    room.settings = sanitizeSettings({ rounds, timeLimitSec, hintRevealWords });
    emitRoom(room.code);
  });

  socket.on('room:transferHost', ({ targetPlayerId }) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room || room.hostId !== socket.data.playerId) return;

    const target = room.players.find((p) => p.id === targetPlayerId);
    if (!target || !target.connected || target.id === room.hostId) {
      socket.emit('room:error', { message: 'Choose a valid online player for host transfer.' });
      return;
    }

    room.hostId = target.id;
    emitRoom(room.code);
  });

  socket.on('room:transferAndLeave', ({ targetPlayerId }) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    const playerId = socket.data.playerId;
    if (!room || room.hostId !== playerId) return;

    const target = room.players.find((p) => p.id === targetPlayerId);
    if (!target || !target.connected || target.id === room.hostId) {
      socket.emit('room:error', { message: 'Choose a valid online player for host transfer.' });
      return;
    }

    room.hostId = target.id;
    handlePlayerLeave(room, playerId, 'Previous host transferred and left');
  });

  socket.on('room:start', async () => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room || room.hostId !== socket.data.playerId || room.phase !== PHASES.LOBBY) return;
    if (room.players.length < MIN_PLAYERS) {
      socket.emit('room:error', { message: 'Need at least 2 players to start.' });
      return;
    }

    room.roundNumber = 1;
    room.turnOrder = shuffle(room.players.map((p) => p.id));
    room.turnIndex = -1;
    room.pendingClueGivers = new Set(room.turnOrder);
    await startRound(room, room.code);
    emitRoom(room.code);
  });

  socket.on('board:stroke', (payload) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room || room.phase !== PHASES.PLAYING) return;
    if (room.currentClueGiverId !== socket.data.playerId) return;
    if (!payload || typeof payload !== 'object') return;

    const x1 = Number(payload.x1);
    const y1 = Number(payload.y1);
    const x2 = Number(payload.x2);
    const y2 = Number(payload.y2);
    const size = Number(payload.size);
    const color = String(payload.color || '#111111').slice(0, 16);

    if (![x1, y1, x2, y2].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return;
    if (!Number.isFinite(size) || size < 1 || size > 24) return;

    const stroke = { x1, y1, x2, y2, size, color, playerId: socket.data.playerId };
    room.boardStrokes.push(stroke);
    if (room.boardStrokes.length > 4000) room.boardStrokes = room.boardStrokes.slice(-3000);
    io.to(room.code).emit('board:stroke', stroke);
  });

  socket.on('board:clear', () => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room || room.phase !== PHASES.PLAYING) return;
    if (room.currentClueGiverId !== socket.data.playerId) return;
    room.boardStrokes = [];
    io.to(room.code).emit('board:clear');
  });

  socket.on('round:guess', ({ text }) => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room || room.phase !== PHASES.PLAYING) return;

    const playerId = socket.data.playerId;
    if (!playerId || room.currentClueGiverId === playerId) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player || !player.connected) return;

    const guess = String(text || '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 60);
    if (!guess) return;

    const normalizedGuess = normalizeGuess(guess);
    const normalizedMovie = normalizeGuess(room.currentMovie);
    const correct = normalizedGuess === normalizedMovie;
    room.guesses.push({ playerId, name: player.name, text: guess, correct, at: Date.now() });

    if (correct) {
      if (!room.correctGuessers.has(player.id)) {
        const eligibleGuessers = getEligibleGuessers(room);
        const remainingTimeRatio = getRemainingTimeRatio(room);
        const guesserPoints = calculateGuesserPoints({
          eligibleCount: eligibleGuessers.length,
          alreadyCorrectCount: room.correctGuessers.size,
          remainingTimeRatio,
        });
        room.correctGuessers.add(player.id);
        room.correctGuesserPoints.set(player.id, guesserPoints);
        player.score += guesserPoints;
        if (!room.firstCorrectGuesserId) room.firstCorrectGuesserId = player.id;
      }

      if (allEligibleGuessersCorrect(room)) {
        const clueGiver = room.players.find((p) => p.id === room.currentClueGiverId);
        const remainingTimeRatio = getRemainingTimeRatio(room);
        const awardedGuesserPoints = [...room.correctGuesserPoints.values()];
        const drawerPoints = calculateDrawerPoints({
          guesserPoints: awardedGuesserPoints,
          remainingTimeRatio,
          allGuessed: true,
        });
        if (clueGiver) clueGiver.score += drawerPoints;

        room.history.push({
          roundNumber: room.roundNumber,
          clueGiverId: room.currentClueGiverId,
          movie: room.currentMovie,
          winnerId: room.firstCorrectGuesserId,
          timedOut: false,
          guessedAt: Date.now(),
          strokeCount: room.boardStrokes.length,
          correctGuessersCount: room.correctGuessers.size,
          drawerPoints,
        });

        moveToNextRound(room, room.code);
      }
    } else if (isAlmostCorrectGuess(normalizedGuess, normalizedMovie)) {
      socket.emit('guess:feedback', {
        type: 'almost',
        message: 'Almost correct. Please check spelling and try again.',
      });
    }

    emitRoom(room.code);
  });

  socket.on('room:leave', () => {
    const roomCode = socket.data.roomCode;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room) return;

    const playerId = socket.data.playerId;
    if (!playerId) return;
    handlePlayerLeave(room, playerId, 'Clue giver left room');
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const playerId = socket.data.playerId;
    const room = roomCode ? rooms.get(roomCode) : null;
    if (!room || !playerId) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();

    resolveHost(room);
    emitRoom(room.code);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Telugu Movie Multiplayer running at http://localhost:${PORT}`);
});
