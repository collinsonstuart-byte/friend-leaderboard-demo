// app.js — live preview frontend.
// Talks to server.js which implements the same HMAC session-signing /
// nonce-consumption / server-computed-scoring flow described in the
// production design (functions/start-challenge-session.js, submit-score.js).

const API = 'https://daily-cryptogram.pplx.app/port/8000';
const CHALLENGE_ID = 'demo-challenge-1';

// No localStorage/cookies allowed in the sandboxed preview — this id is
// generated fresh per page load and kept only in memory, exactly the
// pattern used for visitor-scoped state in this environment.
//
// EXCEPTION: returning from Stripe Checkout is a full top-level navigation,
// which would otherwise wipe this identity and mint a brand new one,
// breaking the ownership check on checkout-session-status. When the
// backend's success/cancel redirect carries visitor_id + auth_token (see
// create-checkout-session), restore the exact same identity instead of
// generating a fresh one.
const __returnParams = new URLSearchParams(window.location.search);
let VISITOR_ID = __returnParams.get('visitor_id') || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));
let visitorAuthToken = __returnParams.get('auth_token') || null;

let session = null; // { nonce, issued_at, server_sig }
let myUserId = null;
let startTime = null;
let timerInterval = null;
let mistakes = 0;
let subscriptionActive = false;
let subscriptionPrice = 0.99;
let subscriptionPeriod = 'month';
let stripeConfigured = true;

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
      ...(visitorAuthToken ? { 'X-Demo-Auth': visitorAuthToken } : {}),
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
                ${isSelf ? '' : `<button class="msg-btn" type="button" data-user-id="${escapeHtml(row.user_id)}" data-display-name="${escapeHtml(row.display_name)}" aria-label="Message ${escapeHtml(row.display_name)}" title="Message ${escapeHtml(row.display_name)}">✉️</button>`}
              </li>
            `;
          })
          .join('')}
      </ol>
    </div>
  `;

  root.querySelectorAll('.msg-btn').forEach((btn) => {
    btn.addEventListener('click', () => openMessageModal(btn.dataset.userId, btn.dataset.displayName));
  });

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

async function connectLeaderboardStream() {
  const { stream_ticket } = await api('/api/stream-ticket', { method: 'POST' });
  const es = new EventSource(`${API}/api/stream?challenge_id=${CHALLENGE_ID}&stream_ticket=${encodeURIComponent(stream_ticket)}`);
  es.addEventListener('leaderboard', (evt) => {
    const payload = JSON.parse(evt.data);
    const updatedUserId = diffUpdatedUser(payload.leaderboard);
    renderLeaderboard(payload.leaderboard, updatedUserId);
  });
  es.addEventListener('friend-message', (evt) => {
    const message = JSON.parse(evt.data);
    showMessageToast(message);
  });
}

// --- Custom message-to-a-friend (gated by $0.99/month subscription) ----

function showToast(html, duration = 4000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = html;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function showMessageToast(message) {
  showToast(`<strong>${escapeHtml(message.from_display_name)}</strong> sent you a message:<br/>${escapeHtml(message.text)}`, 6000);
}

// --- Facebook share / invite friends ------------------------------------

function getShareUrl() {
  // Share a clean link to the challenge (no visitor/auth params) so
  // invited friends land on a fresh page rather than inheriting this
  // visitor's identity or an expired session_id param.
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function openFacebookShare() {
  const shareUrl = getShareUrl();
  const quote = "I'm playing Friday's cryptogram challenge \u2014 think you can beat my score?";
  const fbUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}&quote=${encodeURIComponent(quote)}`;
  const popup = window.open(fbUrl, 'fb-share-dialog', 'width=626,height=436,menubar=no,toolbar=no,status=no');
  if (!popup) {
    // Popup blocked — fall back to copying the link so the user can still invite friends.
    copyInviteLinkFallback(shareUrl);
  }
}

async function copyInviteLinkFallback(shareUrl) {
  try {
    await navigator.clipboard.writeText(shareUrl);
    showToast('Popup blocked — invite link copied instead. Paste it anywhere to invite a friend!');
  } catch {
    showToast(`Copy this link to invite a friend: <br/><code>${escapeHtml(shareUrl)}</code>`, 8000);
  }
}

// --- Share a sent message as a link (works with any texting/messaging app) ---
// No login, no platform SDK — just a URL a friend can open to read the
// message. Uses the native share sheet on mobile (which lists Messages,
// WhatsApp, Messenger, Mail, etc. automatically) and falls back to
// copy-to-clipboard on desktop or when the user cancels the sheet.
async function shareMessageLink(shareUrl, toDisplayName) {
  const shareText = `I sent you a message on Daily Cryptogram — open it here:`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Daily Cryptogram', text: shareText, url: shareUrl });
      return;
    } catch (err) {
      // AbortError = user cancelled the share sheet; fall through to copy
      // for any other failure so the link isn't just lost.
      if (err && err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(shareUrl);
    showToast(`Link copied! Paste it into a text, WhatsApp, or Messenger chat with ${escapeHtml(toDisplayName)}.`);
  } catch {
    showToast(`Copy this link and send it to ${escapeHtml(toDisplayName)}: <br/><code>${escapeHtml(shareUrl)}</code>`, 10000);
  }
}

function closeMessageModal() {
  document.getElementById('message-modal').classList.add('hidden');
}

function renderSubscribeGate(toUserId, toDisplayName, onSubscribed) {
  const body = document.getElementById('message-modal-body');
  body.innerHTML = `
    <h2 class="modal-title">Message ${escapeHtml(toDisplayName)}</h2>
    <p class="modal-copy">Sending custom messages to friends is a subscriber feature — $${subscriptionPrice.toFixed(2)}/${subscriptionPeriod}.</p>
    <p class="modal-note">This charges a real card through Stripe's <strong>test mode</strong> — no actual money moves. Use test card <code>4242 4242 4242 4242</code>, any future expiry date, any CVC, any ZIP.</p>
    <button id="subscribe-stripe-btn" class="btn-primary" ${stripeConfigured ? '' : 'disabled'}>Subscribe with card — $${subscriptionPrice.toFixed(2)}/${subscriptionPeriod}</button>
    ${stripeConfigured ? '' : '<p class="modal-note">Stripe checkout isn\'t configured on this server right now.</p>'}
    <button id="subscribe-demo-btn" class="btn-secondary">Or simulate for testing (no card, no real activation)</button>
  `;
  document.getElementById('subscribe-stripe-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Redirecting to Stripe…';
    try {
      const result = await api('/api/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify({ to_user_id: toUserId, to_display_name: toDisplayName }),
      });
      window.location.href = result.checkout_url;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = `Subscribe with card — $${subscriptionPrice.toFixed(2)}/${subscriptionPeriod}`;
      alert(`Could not start checkout: ${err.message}`);
    }
  });
  document.getElementById('subscribe-demo-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Activating…';
    try {
      const result = await api('/api/subscribe-demo', { method: 'POST' });
      subscriptionActive = !!result.active;
      onSubscribed();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Or simulate for testing (no card, no real activation)';
      alert(`Could not activate: ${err.message}`);
    }
  });
}

function renderComposeForm(toUserId, toDisplayName) {
  const body = document.getElementById('message-modal-body');
  body.innerHTML = `
    <h2 class="modal-title">Message ${escapeHtml(toDisplayName)}</h2>
    <textarea id="message-text" class="message-textarea" maxlength="200" placeholder="Say something to ${escapeHtml(toDisplayName)}…"></textarea>
    <div class="message-footer">
      <span id="message-char-count" class="message-char-count">0/200</span>
      <button id="message-send-btn" class="btn-primary">Send</button>
    </div>
    <p id="message-status" class="modal-note"></p>
  `;
  const textarea = document.getElementById('message-text');
  const charCount = document.getElementById('message-char-count');
  textarea.addEventListener('input', () => {
    charCount.textContent = `${textarea.value.length}/200`;
  });
  document.getElementById('message-send-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const text = textarea.value.trim();
    const status = document.getElementById('message-status');
    if (!text) {
      status.textContent = 'Write something first.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const result = await api('/api/messages/send', {
        method: 'POST',
        body: JSON.stringify({ to_user_id: toUserId, text }),
      });
      status.innerHTML = `Sent to ${escapeHtml(toDisplayName)} in-app.`;
      if (result.share_url) {
        btn.textContent = 'Send';
        btn.disabled = false;
        const footer = btn.closest('.message-footer');
        let shareBtn = document.getElementById('message-share-link-btn');
        if (!shareBtn) {
          shareBtn = document.createElement('button');
          shareBtn.id = 'message-share-link-btn';
          shareBtn.type = 'button';
          shareBtn.className = 'btn-secondary';
          footer.insertBefore(shareBtn, btn);
        }
        shareBtn.textContent = 'Text/send this message →';
        shareBtn.onclick = () => shareMessageLink(result.share_url, toDisplayName);
        status.innerHTML = `Sent to ${escapeHtml(toDisplayName)} in-app. Want it delivered by text or messaging app too? Use the button above.`;
      } else {
        setTimeout(closeMessageModal, 1200);
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Send';
      status.textContent = err.message;
    }
  });
}

function openMessageModal(toUserId, toDisplayName) {
  const modal = document.getElementById('message-modal');
  modal.classList.remove('hidden');
  if (subscriptionActive) {
    renderComposeForm(toUserId, toDisplayName);
  } else {
    renderSubscribeGate(toUserId, toDisplayName, () => renderComposeForm(toUserId, toDisplayName));
  }
}

// --- Bootstrap ---------------------------------------------------------

// Shared-message links look like #/m/<token> and need no identity/auth —
// anyone with the link (a friend who got it by text, WhatsApp, etc.) can
// open it and read just that one message. Handled before the normal app
// boots so it works even for a first-time visitor with no session.
async function renderSharedMessageIfPresent() {
  const match = window.location.hash.match(/^#\/m\/([A-Za-z0-9_-]+)$/);
  if (!match) return false;
  const root = document.getElementById('leaderboard-root');
  const puzzlePanel = document.getElementById('puzzle-panel');
  if (puzzlePanel) puzzlePanel.style.display = 'none';
  root.innerHTML = `<div class="lb-card"><div class="lb-skeleton-row"></div></div>`;
  try {
    const res = await fetch(`${API}/api/messages/shared/${encodeURIComponent(match[1])}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'This message link is no longer valid.');
    root.innerHTML = `
      <div class="lb-card shared-message-card">
        <p class="modal-note">Message from</p>
        <h2 class="modal-title">${escapeHtml(data.from_display_name)}</h2>
        <p class="shared-message-text">${escapeHtml(data.text)}</p>
        <a href="${window.location.pathname}" class="btn-secondary shared-message-cta">Play Daily Cryptogram →</a>
      </div>`;
  } catch (err) {
    root.innerHTML = `<div class="lb-card"><p class="modal-note">${escapeHtml(err.message || 'This message link is no longer valid.')}</p><a href="${window.location.pathname}" class="btn-secondary">Go to Daily Cryptogram →</a></div>`;
  }
  return true;
}

async function init() {
  if (await renderSharedMessageIfPresent()) return;

  document.getElementById('leaderboard-root').innerHTML = `<div class="lb-card"><div class="lb-skeleton-row"></div><div class="lb-skeleton-row"></div><div class="lb-skeleton-row"></div></div>`;

  const identity = await api('/api/identify', { method: 'POST' });
  myUserId = identity.user_id;
  visitorAuthToken = identity.auth_token;

  const subStatus = await api('/api/subscription-status').catch(() => null);
  if (subStatus) {
    subscriptionActive = !!subStatus.active;
    subscriptionPrice = subStatus.price_usd;
    subscriptionPeriod = subStatus.period;
    stripeConfigured = !!subStatus.stripe_configured;
  }

  // Returning from Stripe Checkout: verify the session immediately instead
  // of waiting on webhook delivery timing, then resume the compose modal
  // for whichever friend the visitor was messaging before they subscribed.
  const returnParams = new URLSearchParams(window.location.search);
  if (returnParams.has('subscribed')) {
    const sessionId = returnParams.get('session_id');
    if (returnParams.get('subscribed') === '1' && sessionId) {
      try {
        const statusResult = await api(`/api/checkout-session-status?session_id=${encodeURIComponent(sessionId)}`);
        subscriptionActive = !!statusResult.active;
      } catch (err) {
        console.error('Could not verify checkout session:', err);
      }
    }
    const toUserId = returnParams.get('to_user_id');
    const toDisplayName = returnParams.get('to_display_name');
    history.replaceState({}, '', window.location.pathname);
    if (toUserId && toDisplayName) {
      window.__pendingMessageTarget = { toUserId, toDisplayName };
    }
  }

  const initial = await api(`/api/leaderboard?challenge_id=${CHALLENGE_ID}`);
  lastRows = new Map(initial.leaderboard.map((r) => [r.user_id, r]));
  renderLeaderboard(initial.leaderboard);

  connectLeaderboardStream().catch((err) => console.error('Could not connect to leaderboard updates:', err));

  if (window.__pendingMessageTarget) {
    const { toUserId, toDisplayName } = window.__pendingMessageTarget;
    delete window.__pendingMessageTarget;
    openMessageModal(toUserId, toDisplayName);
  }

  document.getElementById('message-modal-close').addEventListener('click', closeMessageModal);
  document.getElementById('message-modal').addEventListener('click', (e) => {
    if (e.target.id === 'message-modal') closeMessageModal();
  });

  document.getElementById('share-fb-btn').addEventListener('click', openFacebookShare);

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
