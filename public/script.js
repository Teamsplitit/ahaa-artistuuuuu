const socket = io();

const state = {
  room: null,
  roomCode: null,
  playerId: null,
  boardStrokes: [],
  boardKey: null,
  canDraw: false,
  drawing: false,
  lastPoint: null,
  settingsDraftDirty: false,
  lastMovieDebugKey: null,
};

const qs = (id) => document.getElementById(id);

const homeView = qs('homeView');
const gameView = qs('gameView');
const homeError = qs('homeError');

const nameInput = qs('nameInput');
const codeInput = qs('codeInput');
const createBtn = qs('createBtn');
const joinBtn = qs('joinBtn');
const leaveBtn = qs('leaveBtn');

const roomTitle = qs('roomTitle');
const phaseText = qs('phaseText');
const myNameTop = qs('myNameTop');
const headerMovieText = qs('headerMovieText');
const inviteCode = qs('inviteCode');
const inviteLink = qs('inviteLink');
const copyInviteBtn = qs('copyInviteBtn');
const inviteCard = qs('inviteCard');
const hostTransferCard = qs('hostTransferCard');
const hostTransferSelect = qs('hostTransferSelect');
const transferHostBtn = qs('transferHostBtn');

const lobbySettingsCard = qs('lobbySettingsCard');
const roundsInput = qs('roundsInput');
const timeInput = qs('timeInput');
const hintRevealInput = qs('hintRevealInput');
const saveSettingsBtn = qs('saveSettingsBtn');
const startBtn = qs('startBtn');

const playCard = qs('playCard');
const roundText = qs('roundText');
const clueGiverText = qs('clueGiverText');
const timerText = qs('timerText');
const roleText = qs('roleText');
const movieText = qs('movieText');

const boardCanvas = qs('boardCanvas');
const drawControls = qs('drawControls');
const colorInput = qs('colorInput');
const sizeInput = qs('sizeInput');
const sizeValue = qs('sizeValue');
const clearBoardBtn = qs('clearBoardBtn');
const boardCtx = boardCanvas.getContext('2d');

const guessBox = qs('guessBox');
const guessInput = qs('guessInput');
const sendGuessBtn = qs('sendGuessBtn');
const guessFeedback = qs('guessFeedback');
const guessChatCard = qs('guessChatCard');

const guessesList = qs('guessesList');
const scoreboardCard = qs('scoreboardCard');
const playersList = qs('playersList');
const winnerCard = qs('winnerCard');
const winnerText = qs('winnerText');
const closeCountdownText = qs('closeCountdownText');
const rankingCard = qs('rankingCard');
const rankingNote = qs('rankingNote');
const rankingList = qs('rankingList');

let timerInterval = null;
let closeInterval = null;

function storageKeyForRoom(code) {
  return `tmg_player_${code}`;
}

function setError(text) {
  homeError.textContent = text || '';
}

function clearTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function clearCloseInterval() {
  if (closeInterval) {
    clearInterval(closeInterval);
    closeInterval = null;
  }
}

function formatMs(ms) {
  const secs = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderList(root, rows, fallback = 'No data') {
  root.innerHTML = '';
  if (!rows.length) {
    const div = document.createElement('div');
    div.className = 'item';
    div.textContent = fallback;
    root.appendChild(div);
    return;
  }
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = row;
    root.appendChild(div);
  }
}

function showGame() {
  homeView.classList.add('hidden');
  gameView.classList.remove('hidden');
}

function showHome() {
  gameView.classList.add('hidden');
  homeView.classList.remove('hidden');
}

function persistIdentity(roomCode, playerId) {
  localStorage.setItem(storageKeyForRoom(roomCode), playerId);
  state.roomCode = roomCode;
  state.playerId = playerId;
}

function clearIdentityForCurrentRoom() {
  if (state.roomCode) localStorage.removeItem(storageKeyForRoom(state.roomCode));
  state.playerId = null;
  state.roomCode = null;
}

function hydrateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = (params.get('code') || '').toUpperCase();
  if (code) codeInput.value = code;
}

function connectByStoredIdentity(code) {
  const storedId = localStorage.getItem(storageKeyForRoom(code));
  const name = nameInput.value.trim();
  if (!storedId || !name) return;
  socket.emit('room:join', { code, name, playerId: storedId });
}

function clearBoardCanvas() {
  boardCtx.fillStyle = '#ffffff';
  boardCtx.fillRect(0, 0, boardCanvas.width, boardCanvas.height);
}

function drawStroke(stroke) {
  boardCtx.strokeStyle = stroke.color || '#111111';
  boardCtx.lineWidth = stroke.size || 4;
  boardCtx.lineCap = 'round';
  boardCtx.lineJoin = 'round';
  boardCtx.beginPath();
  boardCtx.moveTo(stroke.x1 * boardCanvas.width, stroke.y1 * boardCanvas.height);
  boardCtx.lineTo(stroke.x2 * boardCanvas.width, stroke.y2 * boardCanvas.height);
  boardCtx.stroke();
}

function redrawBoard(strokes) {
  clearBoardCanvas();
  for (const stroke of strokes) drawStroke(stroke);
}

function getPointFromEvent(e) {
  const rect = boardCanvas.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
  const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
  return { x: x / rect.width, y: y / rect.height };
}

function setDrawingEnabled(enabled) {
  state.canDraw = enabled;
  boardCanvas.style.cursor = enabled ? 'crosshair' : 'not-allowed';
}

function syncBrushSizeLabel() {
  sizeValue.textContent = `${sizeInput.value}px`;
}

function syncBoardFromRoom(room) {
  const incomingStrokes = Array.isArray(room.boardStrokes) ? room.boardStrokes : [];
  const incomingKey = `${room.phase}:${room.roundNumber}:${room.currentClueGiverId || ''}`;

  if (state.boardKey !== incomingKey) {
    state.boardKey = incomingKey;
    state.boardStrokes = [...incomingStrokes];
    redrawBoard(state.boardStrokes);
    return;
  }

  if (incomingStrokes.length >= state.boardStrokes.length) {
    state.boardStrokes = [...incomingStrokes];
    redrawBoard(state.boardStrokes);
  }
}

function renderRoom(room) {
  state.room = room;
  syncBoardFromRoom(room);
  showGame();

  const myId = room.myPlayerId;
  const isHost = myId && room.hostId === myId;
  const isPlaying = room.phase === 'playing';
  const isBreak = room.phase === 'break';
  const isEnded = room.phase === 'ended';
  const isClueGiver = myId && room.currentClueGiverId === myId;
  const leaderboardOnly = isEnded;

  inviteCard.classList.toggle('hidden', room.phase !== 'lobby');
  lobbySettingsCard.classList.toggle('hidden', leaderboardOnly || room.phase !== 'lobby');
  playCard.classList.toggle('hidden', leaderboardOnly || room.phase === 'lobby');
  scoreboardCard.classList.toggle('hidden', leaderboardOnly);
  guessChatCard.classList.toggle('hidden', leaderboardOnly || room.phase === 'lobby');

  roomTitle.textContent = `Room ${room.code}`;
  phaseText.textContent = room.phase === 'lobby'
    ? 'Lobby'
    : room.phase === 'playing'
      ? 'Game in progress'
      : room.phase === 'break'
        ? 'Break before next round'
        : 'Game ended';
  myNameTop.textContent = room.myName ? `You: ${room.myName}` : '';
  headerMovieText.textContent = '';

  inviteCode.textContent = room.code;
  const link = `${window.location.origin}?code=${room.code}`;
  inviteLink.textContent = link;

  const transferOptions = room.players.filter((p) => p.connected && p.id !== myId);
  const canShowHostTransfer = (isPlaying || isBreak) && isHost && transferOptions.length > 0;
  hostTransferCard.classList.toggle('hidden', !canShowHostTransfer);
  hostTransferSelect.innerHTML = '';
  for (const p of transferOptions) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    hostTransferSelect.appendChild(opt);
  }
  transferHostBtn.disabled = transferOptions.length === 0;

  if (!state.settingsDraftDirty) {
    roundsInput.value = room.settings.rounds;
    timeInput.value = room.settings.timeLimitSec;
    hintRevealInput.value = room.settings.hintRevealWords;
  } else {
    const roundsVal = Number(roundsInput.value);
    const timeVal = Number(timeInput.value);
    const hintVal = Number(hintRevealInput.value);
    if (
      roundsVal === room.settings.rounds &&
      timeVal === room.settings.timeLimitSec &&
      hintVal === room.settings.hintRevealWords
    ) {
      state.settingsDraftDirty = false;
    }
  }

  saveSettingsBtn.disabled = !isHost;
  startBtn.disabled = !isHost || room.players.length < room.minPlayers;

  roundText.textContent = `${room.roundNumber} / ${room.settings.rounds}`;
  clueGiverText.textContent = room.currentClueGiverName || '-';

  if (isPlaying && room.roundEndsAt) {
    clearTimer();
    const update = () => {
      timerText.textContent = formatMs(room.roundEndsAt - Date.now());
    };
    update();
    timerInterval = setInterval(update, 500);
  } else if (isBreak && room.nextRoundStartsAt) {
    clearTimer();
    const update = () => {
      timerText.textContent = `Next round in ${formatMs(room.nextRoundStartsAt - Date.now())}`;
    };
    update();
    timerInterval = setInterval(update, 500);
  } else {
    clearTimer();
    timerText.textContent = isEnded ? 'Completed' : '-';
  }

  if (room.phase === 'lobby') {
    roleText.textContent = 'Waiting for host to start.';
    movieText.textContent = '';
    headerMovieText.textContent = '';
  } else if (isEnded) {
    const amWinner = room.winners.includes(myId);
    roleText.textContent = amWinner ? 'You finished as winner.' : 'Game over.';
    movieText.textContent = '';
    headerMovieText.textContent = '';
  } else if (isBreak) {
    roleText.textContent = 'Round completed. Relax, next round will start automatically.';
    movieText.textContent = '';
    headerMovieText.textContent = '';
  } else if (isClueGiver) {
    roleText.textContent = 'You are the clue giver. Draw on the board.';
    const clueMovieText = room.myMovie ? `Movie: ${room.myMovie}` : '';
    movieText.textContent = clueMovieText;
    headerMovieText.textContent = '';
  } else {
    roleText.textContent = 'Watch drawing and guess the Telugu movie.';
    const hintText = room.movieHint?.text || '';
    const totalLetters = room.movieHint?.totalLetters ?? 0;
    const lengthMeta = room.movieHint ? `(Length: ${totalLetters} letters)` : '';
    const guessHintText = hintText ? `Title hint: ${hintText} ${lengthMeta}` : '';
    movieText.textContent = guessHintText;
    headerMovieText.textContent = '';
  }
  if (isClueGiver || room.phase !== 'playing') guessFeedback.textContent = '';

  drawControls.classList.toggle('hidden', !isPlaying || !isClueGiver);
  guessBox.classList.toggle('hidden', !isPlaying || isClueGiver);
  setDrawingEnabled(isPlaying && isClueGiver);

  renderList(
    guessesList,
    (room.guesses || []).map((g) => {
      if (g.correct) {
        return `<strong>${g.name}</strong> guessed correctly ✅`;
      }
      return `<strong>${g.name}:</strong> ${g.text}`;
    }),
    'No guesses yet'
  );
  guessesList.scrollTop = guessesList.scrollHeight;

  renderList(
    playersList,
    (room.players || []).map((p) => {
      const host = p.id === room.hostId ? ' (Host)' : '';
      const me = p.id === myId ? ' (You)' : '';
      const online = p.connected ? 'Online' : 'Offline';
      return `<strong>${p.name}</strong>${host}${me} · Score: ${p.score} · ${online}`;
    }),
    'No players'
  );

  if (isEnded) {
    const winnerNames = (room.winners || [])
      .map((id) => room.players.find((p) => p.id === id)?.name)
      .filter(Boolean);
    winnerCard.classList.add('hidden');
    winnerText.textContent = winnerNames.length > 1
      ? `Winners: ${winnerNames.join(', ')}`
      : `Winner: ${winnerNames[0] || 'No winner'}`;

    rankingCard.classList.remove('hidden');
    const rankings = Array.isArray(room.rankings) ? room.rankings : room.players || [];
    renderList(
      rankingList,
      rankings.map((p, idx) => `${idx + 1}. <strong>${p.name}</strong> · ${p.score} pts`),
      'No rankings'
    );

    if (room.gameClosesAt) {
      clearCloseInterval();
      const updateClose = () => {
        const left = formatMs(room.gameClosesAt - Date.now());
        closeCountdownText.textContent = `Room closes in ${left}`;
        rankingNote.textContent = `Room closes in ${left}`;
      };
      updateClose();
      closeInterval = setInterval(updateClose, 500);
    } else {
      clearCloseInterval();
      closeCountdownText.textContent = '';
      rankingNote.textContent = '';
    }
  } else {
    winnerCard.classList.add('hidden');
    rankingCard.classList.add('hidden');
    winnerText.textContent = '';
    closeCountdownText.textContent = '';
    rankingNote.textContent = '';
    clearCloseInterval();
  }
}

function handleDrawMove(e) {
  if (!state.canDraw || !state.drawing) return;
  const point = getPointFromEvent(e);
  const prev = state.lastPoint;
  state.lastPoint = point;
  if (!prev) return;

  const stroke = {
    x1: prev.x,
    y1: prev.y,
    x2: point.x,
    y2: point.y,
    color: colorInput.value,
    size: Number(sizeInput.value),
  };

  state.boardStrokes.push(stroke);
  drawStroke(stroke);
  socket.emit('board:stroke', stroke);
}

boardCanvas.addEventListener('pointerdown', (e) => {
  if (!state.canDraw) return;
  state.drawing = true;
  state.lastPoint = getPointFromEvent(e);
  boardCanvas.setPointerCapture(e.pointerId);
});

boardCanvas.addEventListener('pointermove', (e) => {
  handleDrawMove(e);
});

boardCanvas.addEventListener('pointerup', (e) => {
  state.drawing = false;
  state.lastPoint = null;
  try {
    boardCanvas.releasePointerCapture(e.pointerId);
  } catch {
    // ignore
  }
});

boardCanvas.addEventListener('pointerleave', () => {
  state.drawing = false;
  state.lastPoint = null;
});

createBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) return setError('Name is required');
  setError('');
  socket.emit('room:create', { name, code: codeInput.value.trim().toUpperCase() });
});

joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  const code = codeInput.value.trim().toUpperCase();
  if (!name || !code) return setError('Name and code are required');
  setError('');

  const existingId = localStorage.getItem(storageKeyForRoom(code));
  socket.emit('room:join', { code, name, playerId: existingId || undefined });
});

leaveBtn.addEventListener('click', () => {
  socket.emit('room:leave');
  clearTimer();
  clearCloseInterval();
  state.room = null;
  state.boardKey = null;
  state.boardStrokes = [];
  clearBoardCanvas();
  showHome();
});

transferHostBtn.addEventListener('click', () => {
  const targetPlayerId = hostTransferSelect.value;
  if (!targetPlayerId) return;
  socket.emit('room:transferHost', { targetPlayerId });
});

saveSettingsBtn.addEventListener('click', () => {
  state.settingsDraftDirty = false;
  socket.emit('room:updateSettings', {
    rounds: Number(roundsInput.value),
    timeLimitSec: Number(timeInput.value),
    hintRevealWords: Number(hintRevealInput.value),
  });
});

roundsInput.addEventListener('input', () => {
  state.settingsDraftDirty = true;
});

timeInput.addEventListener('input', () => {
  state.settingsDraftDirty = true;
});

hintRevealInput.addEventListener('input', () => {
  state.settingsDraftDirty = true;
});

startBtn.addEventListener('click', () => {
  socket.emit('room:start');
});

clearBoardBtn.addEventListener('click', () => {
  if (!state.canDraw) return;
  state.boardStrokes = [];
  clearBoardCanvas();
  socket.emit('board:clear');
});

sizeInput.addEventListener('input', () => {
  syncBrushSizeLabel();
});

function submitGuess() {
  const text = guessInput.value.trim();
  if (!text) return;
  guessFeedback.textContent = '';
  socket.emit('round:guess', { text });
  guessInput.value = '';
  guessInput.focus();
}

sendGuessBtn.addEventListener('click', () => {
  submitGuess();
});

guessInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitGuess();
  }
});

copyInviteBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteLink.textContent);
  } catch {
    // ignore
  }
});

socket.on('connect', () => {
  setError('');
  const code = codeInput.value.trim().toUpperCase();
  if (code) connectByStoredIdentity(code);
});

socket.on('room:joined', ({ roomCode, playerId }) => {
  persistIdentity(roomCode, playerId);
  const url = new URL(window.location.href);
  url.searchParams.set('code', roomCode);
  window.history.replaceState({}, '', url.toString());
});

socket.on('room:update', (room) => {
  renderRoom(room);
  if (room.phase === 'playing' && room.movieSource) {
    const debugKey = `${room.roundNumber}:${room.currentClueGiverId || ''}:${room.movieSource}`;
    if (state.lastMovieDebugKey !== debugKey) {
      state.lastMovieDebugKey = debugKey;
      console.log(`[movie] source=${room.movieSource} round=${room.roundNumber} room=${room.code}`);
    }
  } else if (room.phase !== 'playing') {
    state.lastMovieDebugKey = null;
  }
});

socket.on('board:stroke', (stroke) => {
  if (!state.room || state.room.phase !== 'playing') return;
  if (stroke.playerId && stroke.playerId === state.room.myPlayerId) return;
  state.boardStrokes.push(stroke);
  drawStroke(stroke);
});

socket.on('board:clear', () => {
  state.boardStrokes = [];
  clearBoardCanvas();
});

socket.on('room:error', ({ message }) => {
  setError(message || 'Something went wrong');
});

socket.on('guess:feedback', ({ type, message }) => {
  if (type === 'almost') {
    guessFeedback.textContent = message || 'Almost correct. Check spelling and try again.';
  }
});

socket.on('room:closed', ({ reason }) => {
  clearTimer();
  clearCloseInterval();
  clearIdentityForCurrentRoom();
  state.room = null;
  state.boardKey = null;
  state.boardStrokes = [];
  clearBoardCanvas();
  setError(reason || 'Game closed');
  showHome();
});

hydrateFromUrl();
syncBrushSizeLabel();
clearBoardCanvas();
showHome();
