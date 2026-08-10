// app.js — live preview frontend.
// Talks to server.js which implements the same HMAC session-signing /
// nonce-consumption / server-computed-scoring flow described in the
// production design (functions/start-challenge-session.js, submit-score.js).

// This is a static-only build deployed to Vercel. It calls the backend
// that's already running on the published pplx.app link — there is no
// server component in this Vercel deployment itself. pplx.app backend
// ports are reached via a /port/<port>/ prefix rather than at the root.
const API = 'https://daily-cryptogram.pplx.app/port/8000';
const CHALLENGE_ID = 'demo-challenge-1';

// No localStorage/cookies allowed in the sandboxed preview — this id is
// generated fresh per page load and kept only in memory, exactly the
// pattern used for visitor-scoped state in this environment.
const VISITOR_ID = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));

let session = null; // { nonce, issued_at, server_sig }
let myUserId = null;
let startTime = null;
let timerInterval = null;
let mistakes = 0;

const PUZZLE = {
  plaintext: 'KEEP GOING',
  // cipher letter -> { correct plaintext letter, choice order }
  rows: [
    { cipher: 'Q', correct: 'K', choices: ['M', 'K', 'Q'] },
    { cipher: 'Z', correct: 'E', choices: ['Z', 'S', 'E'] },
    { cipher: 'L', correct: 'P', choices: ['D', 'P', 'L'] },
    { cipher: 'V', correct: 'G', choices: ['R', 'G', 'V'] },
    { cipher: 'B', correct: 'O', choices: ['O', 'C', 'B'] },
    { cipher: 'Y', correct: 'I', choices: ['U', 'I', 'Y'] },
    { cipher: 'R', correct: 'N', choices: ['F', 'R', 'N'] },
  ],
};
const PLAIN_TO_CIPHER = Object.fromEntries(PUZZLE.rows.map((r) => [r.correct, r.cipher]));
const solvedLetters = new Set();

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-Visitor': VISITOR_ID,
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function initials(name) {
  return (name || '?').split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

// --- Puzzle rendering -----------------------------------------------

function renderCipherDisplay() {
  const el = document.getElementById('cipher-display');
  el.innerHTML = '';
  for (const ch of PUZZLE.plaintext) {
    if (ch === ' ') {
      const gap = document.createElement('div');
      gap.className = 'cipher-box space';
      el.appendChild(gap);
      continue;
    }
    const cipherChar = PLAIN_TO_CIPHER[ch];
    const box = document.createElement('div');
    box.className = 'cipher-box';
    box.dataset.plain = ch;
    const solved = solvedLetters.has(ch);
    if (solved) box.classList.add('solved');
    box.innerHTML = `
      <span class="plain">${solved ? ch : ''}</span>
      <span class="cipher">${cipherChar}</span>
    `;
    el.appendChild(box);
  }
}

function renderLetterRows() {
  const el = document.getElementById('letter-rows');
  el.innerHTML = '';
  for (const row of PUZZLE.rows) {
    const solved = solvedLetters.has(row.correct);
    const rowEl = document.createElement('div');
    rowEl.className = `letter-row${solved ? ' solved' : ''}`;
    rowEl.innerHTML = `
      <div class="row-cipher-letter">${row.cipher}</div>
      <div class="row-choices">
        ${row.choices
          .map((c) => `<button class="choice-btn" data-cipher="${row.cipher}" data-choice="${c}" ${solved ? 'disabled' : ''}>${c}</button>`)
          .join('')}
      </div>
    `;
    el.appendChild(rowEl);
  }

  el.querySelectorAll('.choice-btn').forEach((btn) => {
    btn.addEventListener('click', onChoiceClick);
  });
}

function onChoiceClick(e) {
  const btn = e.currentTarget;
  const cipher = btn.dataset.cipher;
  const choice = btn.dataset.choice;
  const row = PUZZLE.rows.find((r) => r.cipher === cipher);

  if (choice === row.correct) {
    solvedLetters.add(row.correct);
    renderCipherDisplay();
    renderLetterRows();
    if (solvedLetters.size === PUZZLE.rows.length) {
      onPuzzleComplete();
    }
  } else {
    mistakes += 1;
    document.getElementById('mistake-count').textContent = mistakes;
    btn.classList.add('wrong-flash');
    setTimeout(() => btn.classList.remove('wrong-flash'), 350);
  }
}

function startTimer() {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    document.getElementById('timer').textContent = formatElapsed(Date.now() - startTime);
  }, 250);
}

function stopTimer() {
  clearInterval(timerInterval);
}

async function onPuzzleComplete() {
  stopTimer();
  const elapsedMs = Date.now() - startTime;

  document.getElementById('puzzle-screen').classList.add('hidden');
  const resultScreen = document.getElementById('result-screen');
  const resultCopy = document.getElementById('result-copy');
  resultCopy.textContent = 'Submitting your result for server verification…';
  resultScreen.classList.remove('hidden');

  try {
    const result = await api('/api/submit-score', {
      method: 'POST',
      body: JSON.stringify({
        challenge_id: CHALLENGE_ID,
        nonce: session.nonce,
        issued_at: session.issued_at,
        server_sig: session.server_sig,
        elapsed_ms: elapsedMs,
        mistakes,
      }),
    });
    resultCopy.innerHTML = `Solved in <strong>${formatElapsed(result.elapsed_ms)}</strong> with <strong>${result.mistakes}</strong> mistake${result.mistakes === 1 ? '' : 's'}.<br/>Server-verified score: <strong>${result.score.toLocaleString()} pts</strong>`;
  } catch (err) {
    resultCopy.textContent = `Submission rejected: ${err.message}`;
  }
}

// --- Leaderboard rendering (mirrors production frontend/leaderboard.js) --

let lastRows = new Map();

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLeaderboard(rows, justUpdatedUserId) {
  const root = document.getElementById('leaderboard-root');
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);

  if (sorted.length === 0) {
    root.innerHTML = `<div class="lb-card"><div class="lb-header"><span class="lb-title">Friend Group Rankings</span></div><div class="lb-empty">No scores yet — be the first to finish.</div></div>`;
    return;
  }

  root.innerHTML = `
    <div class="lb-card">
      <div class="lb-header">
        <span class="lb-title">Friend Group Rankings</span>
        <span class="lb-count">${sorted[0].participant_count} playing</span>
      </div>
      <ol class="lb-list">
        ${sorted
          .map((row) => {
            const isSelf = row.user_id === myUserId;
            const medal = row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : null;
            return `
              <li class="lb-row ${isSelf ? 'lb-row-self' : ''}" data-user-id="${escapeHtml(row.user_id)}">
                <span class="lb-rank">${medal || `#${row.rank}`}</span>
                <span class="lb-avatar">${escapeHtml(row.avatar_emoji || initials(row.display_name))}</span>
                <span class="lb-name">${escapeHtml(row.display_name)}${isSelf ? ' (you)' : ''}</span>
                <span class="lb-time">${formatElapsed(row.elapsed_ms)}</span>
                <span class="lb-score">${row.score.toLocaleString()} pts</span>
              </li>
            `;
          })
          .join('')}
      </ol>
    </div>
  `;

  if (justUpdatedUserId) {
    const rowEl = root.querySelector(`[data-user-id="${justUpdatedUserId}"]`);
    if (rowEl) {
      rowEl.classList.add('lb-row-flash');
      setTimeout(() => rowEl.classList.remove('lb-row-flash'), 1200);
    }
  }
}

function diffUpdatedUser(newRows) {
  let updated = null;
  for (const row of newRows) {
    const prev = lastRows.get(row.user_id);
    if (!prev || prev.score !== row.score || prev.rank !== row.rank) updated = row.user_id;
  }
  lastRows = new Map(newRows.map((r) => [r.user_id, r]));
  return updated;
}

function connectLeaderboardStream() {
  const es = new EventSource(`${API}/api/stream?challenge_id=${CHALLENGE_ID}`);
  es.onmessage = (evt) => {
    const payload = JSON.parse(evt.data);
    const updatedUserId = diffUpdatedUser(payload.leaderboard);
    renderLeaderboard(payload.leaderboard, updatedUserId);
  };
}

// --- Bootstrap ---------------------------------------------------------

async function init() {
  document.getElementById('leaderboard-root').innerHTML = `<div class="lb-card"><div class="lb-skeleton-row"></div><div class="lb-skeleton-row"></div><div class="lb-skeleton-row"></div></div>`;

  const identity = await api('/api/identify', { method: 'POST' });
  myUserId = identity.user_id;

  const initial = await api(`/api/leaderboard?challenge_id=${CHALLENGE_ID}`);
  lastRows = new Map(initial.leaderboard.map((r) => [r.user_id, r]));
  renderLeaderboard(initial.leaderboard);

  connectLeaderboardStream();

  document.getElementById('start-btn').addEventListener('click', async () => {
    const btn = document.getElementById('start-btn');
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      session = await api('/api/start-challenge-session', {
        method: 'POST',
        body: JSON.stringify({ challenge_id: CHALLENGE_ID }),
      });
      document.getElementById('start-screen').classList.add('hidden');
      document.getElementById('puzzle-screen').classList.remove('hidden');
      renderCipherDisplay();
      renderLetterRows();
      startTimer();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Start Challenge';
      alert(`Could not start challenge: ${err.message}`);
    }
  });
}

init();
