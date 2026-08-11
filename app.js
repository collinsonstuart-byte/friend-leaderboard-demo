// app.js — live preview frontend.
// Talks to server.js which implements the same HMAC session-signing /
// nonce-consumption / server-computed-scoring flow described in the
// production design (functions/start-challenge-session.js, submit-score.js).

const API = 'https://daily-cryptogram-v4.pplx.app/port/8000';
const CHALLENGE_ID = 'demo-challenge-1';

// Every browser tab keeps its own in-memory identity for the life of the
// page. A Stripe Checkout navigation is a full top-level navigation away
// and back, so this ephemeral demo identity round-trips through the
// Checkout return URL (see server.js create-checkout-session) rather than
// any browser storage API — those are unavailable inside the sandboxed
// preview iframe and this app intentionally avoids them entirely.
const __returnParams = new URLSearchParams(window.location.search);
let VISITOR_ID = __returnParams.get('visitor_id') || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()));
let visitorAuthToken = __returnParams.get('auth_token') || null;

let session = null; // { nonce, issued_at, server_sig }
let myUserId = null;
let startTime = null;
let timerInterval = null;
let mistakes = 0;
let challengeCredits = 0;
let challengePrice = 0.99;
let stripeConfigured = true;
let liveMode = false; // true once the server is wired to real (sk_live_) Stripe keys

// Today's puzzle is fetched from the server (see fetchQuoteOfTheDay) so
// every visitor on the same calendar day gets the same hand-picked quote
// and the same substitution cipher — the server is the source of truth,
// this is just filled in once at load time before the start screen shows.
let PUZZLE = { plaintext: '', author: '', rows: [] };
let lastScoreResult = null;
let PLAIN_TO_CIPHER = {};
const solvedLetters = new Set();

// Builds a random letter->letter substitution cipher (no letter maps to
// itself) and the multiple-choice rows for one unique letter in `text`,
// mirroring the server's buildPuzzleRows/buildSubstitutionCipher used for
// friend messages — kept client-side here since the daily puzzle's own
// score-signing never depends on which letters were actually used.
function buildDailyPuzzle(text, author) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const usedLetters = [...new Set(text.toUpperCase().split('').filter((ch) => ALPHABET.includes(ch)))];
  // Assign each used plaintext letter a distinct cipher letter (never itself).
  const available = ALPHABET.filter((l) => !usedLetters.includes(l));
  const plainToCipher = {};
  const assigned = new Set();
  for (const letter of usedLetters) {
    let pick;
    const pool = available.filter((l) => !assigned.has(l));
    if (pool.length) {
      pick = pool[Math.floor(Math.random() * pool.length)];
    } else {
      // Fallback: extremely rare (25+ unique letters used) — reuse ALPHABET
      // minus letter itself and already-assigned cipher letters.
      const fallbackPool = ALPHABET.filter((l) => l !== letter && !assigned.has(l));
      pick = fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
    }
    assigned.add(pick);
    plainToCipher[letter] = pick;
  }
  const rows = usedLetters.map((correct) => {
    const cipher = plainToCipher[correct];
    const decoyPool = ALPHABET.filter((l) => l !== correct && l !== cipher);
    const decoys = [];
    while (decoys.length < 2 && decoyPool.length) {
      const idx = Math.floor(Math.random() * decoyPool.length);
      decoys.push(decoyPool.splice(idx, 1)[0]);
    }
    const choices = [correct, ...decoys];
    for (let i = choices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [choices[i], choices[j]] = [choices[j], choices[i]];
    }
    return { cipher, correct, choices };
  });
  return { plaintext: text.toUpperCase(), author: author || '', rows, plainToCipher };
}

async function fetchQuoteOfTheDay() {
  try {
    const quote = await api('/api/quote-of-the-day');
    const built = buildDailyPuzzle(quote.text, quote.author);
    PUZZLE = { plaintext: built.plaintext, author: built.author, rows: built.rows };
    PLAIN_TO_CIPHER = built.plainToCipher;
  } catch (err) {
    // Fall back to a fixed phrase if the endpoint is unreachable, so the
    // puzzle still works even if quote fetching fails for some reason.
    const built = buildDailyPuzzle('KEEP GOING', 'Unknown');
    PUZZLE = { plaintext: built.plaintext, author: built.author, rows: built.rows };
    PLAIN_TO_CIPHER = built.plainToCipher;
  }
  const teaser = document.getElementById('quote-author-teaser');
  if (teaser) {
    teaser.textContent = PUZZLE.author ? `Today's quote is attributed to ${PUZZLE.author}.` : '';
  }
}

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
    // Punctuation (apostrophes, commas, etc.) is never assigned a cipher
    // letter — buildDailyPuzzle only maps A-Z. Render it plainly instead of
    // falling through to PLAIN_TO_CIPHER[ch], which is undefined for these
    // characters and previously rendered the literal text "undefined".
    if (!PLAIN_TO_CIPHER[ch]) {
      const box = document.createElement('div');
      box.className = 'cipher-box';
      box.innerHTML = `<span class="plain">${escapeHtml(ch)}</span>`;
      el.appendChild(box);
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
    const authorLine = PUZZLE.author ? `<br/><span class="result-quote-author">\u2014 ${escapeHtml(PUZZLE.author)}</span>` : '';
    resultCopy.innerHTML = `Solved in <strong>${formatElapsed(result.elapsed_ms)}</strong> with <strong>${result.mistakes}</strong> mistake${result.mistakes === 1 ? '' : 's'}.<br/>Server-verified score: <strong>${result.score.toLocaleString()} pts</strong>${authorLine}`;
    lastScoreResult = result;
    const shareBtn = document.getElementById('share-score-fb-btn');
    shareBtn.classList.remove('hidden');
    shareBtn.onclick = shareScoreToFacebook;
  } catch (err) {
    resultCopy.textContent = `Submission rejected: ${err.message}`;
  }
}

// --- Marketable pitch panel (replaces the visible friends/rankings list) --

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPitchPanel() {
  const root = document.getElementById('leaderboard-root');
  root.innerHTML = `
    <div class="pitch-card">
      <span class="pitch-eyebrow">Why players come back daily</span>
      <h2 class="pitch-headline">A puzzle worth bragging about.</h2>
      <p class="pitch-copy">Every score is cryptographically signed the moment you finish — no shortcuts, no console hacks, just a real time you actually earned. That's what makes beating a friend mean something.</p>
      <ul class="pitch-features">
        <li><span class="pitch-feature-icon">⚡</span><span>New hand-picked quote every day — 60 seconds to a genuine dopamine hit.</span></li>
        <li><span class="pitch-feature-icon">🔒</span><span>Server-verified scoring means your time can't be faked, only earned.</span></li>
        <li><span class="pitch-feature-icon">💬</span><span>Challenge one friend directly — send them your time and a dare, your way.</span></li>
      </ul>
      <button id="challenge-friend-btn" class="btn-primary pitch-cta" type="button">Challenge a Friend →</button>
      <p class="pitch-note">$${challengePrice.toFixed(2)} per challenge sent — pay only when you send one. <a href="#" id="pitch-terms-link" class="pitch-terms-link">Terms &amp; refund policy</a></p>
    </div>
  `;
  document.getElementById('challenge-friend-btn').addEventListener('click', () => openMessageModal());
  document.getElementById('pitch-terms-link').addEventListener('click', (e) => {
    e.preventDefault();
    openTermsModal();
  });
}

// --- Custom message-to-a-friend (pay $0.99 per challenge sent) ---------

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
  // Plain new-tab open (no custom popup window features) — fixed-size windows with
  // menubar/toolbar disabled are the classic "popup ad" fingerprint that ad blockers
  // and browser popup blockers target, even on a direct click. A normal target=_blank
  // style open is treated like any other link and is far less likely to be blocked.
  const popup = window.open(fbUrl, '_blank', 'noopener,noreferrer');
  verifyPopupOpened(popup, shareUrl, () => copyInviteLinkFallback(shareUrl));
}

// Shares the player's just-earned, server-verified score — distinct from the
// generic "invite a friend" share above, since this brags about an actual
// result (time + mistakes + points) rather than pitching the game cold.
function shareScoreToFacebook() {
  if (!lastScoreResult) return;
  const shareUrl = getShareUrl();
  const { elapsed_ms, mistakes: mistakeCount, score } = lastScoreResult;
  const mistakeText = `${mistakeCount} mistake${mistakeCount === 1 ? '' : 's'}`;
  const quote = `I solved today's Daily Cryptogram in ${formatElapsed(elapsed_ms)} with ${mistakeText} \u2014 server-verified score: ${score.toLocaleString()} pts. Think you can beat me?`;
  const fbUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}&quote=${encodeURIComponent(quote)}`;
  // Plain new-tab open (no custom popup window features) — see comment in
  // openFacebookShare above for why this avoids being silently blocked.
  const popup = window.open(fbUrl, '_blank', 'noopener,noreferrer');
  verifyPopupOpened(popup, shareUrl, () => copyScoreShareFallback(shareUrl, quote));
}

// window.open() can return a non-null object even when the browser or an
// extension silently blocks the popup, so `if (!popup)` alone misses real
// blocks. Re-check `.closed` a beat later (after the blocker has had a
// chance to act) and only then fall back to a clipboard copy.
function verifyPopupOpened(popup, shareUrl, onBlocked) {
  if (!popup) {
    onBlocked();
    return;
  }
  setTimeout(() => {
    if (popup.closed || typeof popup.closed === 'undefined') {
      onBlocked();
    }
  }, 300);
}

async function copyScoreShareFallback(shareUrl, quote) {
  const text = `${quote} ${shareUrl}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast('Popup blocked — your score brag was copied instead. Paste it anywhere to share!');
  } catch {
    showToast(`Copy this to share your score: <br/><code>${escapeHtml(text)}</code>`, 8000);
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

function renderSubscribeGate(prefillName, onSubscribed, initialStatus) {
  const body = document.getElementById('message-modal-body');
  const modeNote = liveMode
    ? `<p class="modal-note">This charges your card <strong>$${escapeHtml(challengePrice.toFixed(2))}</strong> for real, billed once by Stripe for this one challenge. Read the <a href="#" id="gate-terms-link">terms &amp; refund policy</a> before paying.</p>`
    : `<p class="modal-note">This charges a real card through Stripe's <strong>test mode</strong> — no actual money moves. Use test card <code>4242 4242 4242 4242</code>, any future expiry date, any CVC, any ZIP.</p>`;
  const statusNote = initialStatus ? `<p class="modal-note">${escapeHtml(initialStatus)}</p>` : '';
  body.innerHTML = `
    <h2 class="modal-title">Challenge a Friend</h2>
    <p class="modal-copy">Sending a challenge link to a friend costs $${challengePrice.toFixed(2)} per challenge — pay only for the ones you send.</p>
    ${statusNote}
    ${modeNote}
    <button id="subscribe-stripe-btn" class="btn-primary" ${stripeConfigured ? '' : 'disabled'}>Pay $${challengePrice.toFixed(2)} to send this challenge</button>
    <p class="modal-note">After you pay, Stripe will bring you right back to this page to finish writing and sending your message — no need to click Pay again.</p>
    ${stripeConfigured ? '' : '<p class="modal-note">Stripe checkout isn\'t configured on this server right now.</p>'}
    ${liveMode ? '' : '<button id="subscribe-demo-btn" class="btn-secondary">Or simulate for testing (no card, no real charge)</button>'}
  `;
  const gateTermsLink = document.getElementById('gate-terms-link');
  if (gateTermsLink) {
    gateTermsLink.addEventListener('click', (e) => {
      e.preventDefault();
      openTermsModal(() => renderSubscribeGate(prefillName, onSubscribed));
    });
  }
  document.getElementById('subscribe-stripe-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Redirecting to Stripe…';
    try {
      const result = await api('/api/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify({ to_display_name: prefillName || '' }),
      });
      window.location.href = result.checkout_url;
    } catch (err) {
      btn.disabled = false;
      btn.textContent = `Pay $${challengePrice.toFixed(2)} to send this challenge`;
      alert(`Could not start checkout: ${err.message}`);
    }
  });
  const demoBtn = document.getElementById('subscribe-demo-btn');
  if (demoBtn) {
    demoBtn.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Activating…';
      try {
        const result = await api('/api/subscribe-demo', { method: 'POST' });
        challengeCredits = result.credits || 0;
        onSubscribed();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Or simulate for testing (no card, no real charge)';
        alert(`Could not activate: ${err.message}`);
      }
    });
  }
}

function renderComposeForm(prefillName, initialStatus) {
  const body = document.getElementById('message-modal-body');
  body.innerHTML = `
    <h2 class="modal-title">Challenge a Friend</h2>
    <input id="message-friend-name" class="message-name-input" type="text" maxlength="40" placeholder="Friend's name" value="${escapeHtml(prefillName || '')}" />
    <textarea id="message-text" class="message-textarea" maxlength="200" placeholder="Think you can beat my time?…"></textarea>
    <div class="message-footer">
      <span id="message-char-count" class="message-char-count">0/200</span>
      <button id="message-send-btn" class="btn-primary">Create Challenge Link</button>
    </div>
    <p id="message-status" class="modal-note">${escapeHtml(initialStatus || '')}</p>
  `;
  const nameInput = document.getElementById('message-friend-name');
  const textarea = document.getElementById('message-text');
  const charCount = document.getElementById('message-char-count');
  textarea.addEventListener('input', () => {
    charCount.textContent = `${textarea.value.length}/200`;
  });
  (nameInput.value ? textarea : nameInput).focus();
  let justSent = false;
  document.getElementById('message-send-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (justSent) {
      openMessageModal(); // re-checks credits: composes again if any remain, otherwise shows the paywall
      return;
    }
    const toDisplayName = nameInput.value.trim();
    const text = textarea.value.trim();
    const status = document.getElementById('message-status');
    if (!toDisplayName) {
      status.textContent = "Enter your friend's name first.";
      nameInput.focus();
      return;
    }
    if (!text) {
      status.textContent = 'Write something first.';
      textarea.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const result = await api('/api/messages/send', {
        method: 'POST',
        body: JSON.stringify({ to_display_name: toDisplayName, text }),
      });
      btn.disabled = false;
      if (result.share_url) {
        justSent = true;
        challengeCredits = typeof result.credits === 'number' ? result.credits : 0;
        nameInput.disabled = true;
        textarea.disabled = true;
        const footer = btn.closest('.message-footer');
        let shareBtn = document.getElementById('message-share-link-btn');
        if (!shareBtn) {
          shareBtn = document.createElement('button');
          shareBtn.id = 'message-share-link-btn';
          shareBtn.type = 'button';
          shareBtn.className = 'btn-secondary';
          footer.insertBefore(shareBtn, btn);
        }
        shareBtn.textContent = 'Send it →';
        shareBtn.onclick = () => shareMessageLink(result.share_url, toDisplayName);
        btn.textContent = challengeCredits > 0 ? 'Send Another Message' : `Pay $${challengePrice.toFixed(2)} to Send Another`;
        status.innerHTML = `Challenge ready for ${escapeHtml(toDisplayName)}. Tap "Send it" to deliver it by text, WhatsApp, Messenger, or however you like.`;
      } else {
        btn.textContent = 'Create Challenge Link';
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Create Challenge Link';
      status.textContent = err.message;
    }
  });
}

function openMessageModal(prefillName, initialStatus) {
  const modal = document.getElementById('message-modal');
  modal.classList.remove('hidden');
  if (challengeCredits > 0) {
    renderComposeForm(prefillName, initialStatus);
  } else {
    renderSubscribeGate(prefillName, () => renderComposeForm(prefillName), initialStatus);
  }
}

// --- Terms & refund policy ----------------------------------------------
// Plain-language summary shown before anyone is asked to pay. Reuses the
// same modal shell as the subscribe/compose flow; "Back" returns to
// whatever was showing before (the subscribe gate, most commonly).
function openTermsModal(onBack) {
  const modal = document.getElementById('message-modal');
  modal.classList.remove('hidden');
  const body = document.getElementById('message-modal-body');
  body.innerHTML = `
    <h2 class="modal-title">Terms &amp; refund policy</h2>
    <div class="terms-copy">
      <p><strong>What you're buying.</strong> $${challengePrice.toFixed(2)}, billed once by Stripe, gets you exactly one friend-challenge send on Daily Cryptogram. It's a one-time charge, not a subscription — nothing renews and there's nothing to cancel.</p>
      <p><strong>Refunds.</strong> If you're charged in error, or something about the feature didn't work as described, email us within 14 days of the charge and we'll refund it in full, no questions asked. After 14 days we'll still hear you out, but refunds aren't guaranteed.</p>
      <p><strong>Contact.</strong> <a href="mailto:collinson.stuart@gmail.com">collinson.stuart@gmail.com</a></p>
      <p class="terms-note">Daily Cryptogram is an independent hobby project, not a company with a support team — email response times are best-effort.</p>
    </div>
    <button id="terms-back-btn" class="btn-secondary">← Back</button>
  `;
  document.getElementById('terms-back-btn').addEventListener('click', () => {
    if (onBack) {
      onBack();
    } else {
      closeMessageModal();
    }
  });
}

// --- Bootstrap ---------------------------------------------------------

// Shared-message links look like #/m/<token> and need no identity/auth —
// anyone with the link (a friend who got it by text, WhatsApp, etc.) can
// open it and read just that one message. Handled before the normal app
// boots so it works even for a first-time visitor with no session.
// A shared friend message arrives as ciphertext + puzzle rows only —
// the plaintext is never in this payload. The recipient solves the
// substitution cipher letter-by-letter (same mechanic as the daily
// puzzle) and the server reveals the plaintext only once every row is
// verified solved server-side.
function renderMessagePuzzle(root, token, data) {
  const solvedCipherLetters = new Set();
  const solveToken = data.solve_token;

  function cipherBoxesHtml() {
    return data.cipher_text
      .split('')
      .map((ch) => {
        const upper = ch.toUpperCase();
        if (upper === ' ') return `<div class="cipher-box space"></div>`;
        if (!/[A-Z]/.test(upper)) {
          return `<div class="cipher-box"><span class="plain">${escapeHtml(ch)}</span></div>`;
        }
        const solved = solvedCipherLetters.has(upper);
        return `
          <div class="cipher-box${solved ? ' solved' : ''}">
            <span class="plain">${solved ? escapeHtml(ch) : ''}</span>
            <span class="cipher">${escapeHtml(upper)}</span>
          </div>`;
      })
      .join('');
  }

  function letterRowsHtml() {
    return data.puzzle_rows
      .map((row) => {
        const solved = solvedCipherLetters.has(row.cipher);
        return `
          <div class="letter-row${solved ? ' solved' : ''}">
            <div class="row-cipher-letter">${escapeHtml(row.cipher)}</div>
            <div class="row-choices">
              ${row.choices
                .map((c) => `<button class="choice-btn" data-cipher="${escapeHtml(row.cipher)}" data-choice="${escapeHtml(c)}" ${solved ? 'disabled' : ''}>${escapeHtml(c)}</button>`)
                .join('')}
            </div>
          </div>`;
      })
      .join('');
  }

  function renderPuzzle() {
    root.innerHTML = `
      <div class="lb-card shared-message-card">
        <p class="modal-note">Encrypted message from</p>
        <h2 class="modal-title">${escapeHtml(data.from_display_name)}</h2>
        <p class="shared-message-hint">Solve the cryptogram to reveal it — same cipher as the daily puzzle.</p>
        <div class="cipher-display" id="msg-cipher-display">${cipherBoxesHtml()}</div>
        <div class="letter-rows" id="msg-letter-rows">${letterRowsHtml()}</div>
        <div id="msg-reveal-slot"></div>
      </div>`;

    root.querySelectorAll('.choice-btn').forEach((btn) => {
      btn.addEventListener('click', onGuess);
    });
  }

  async function onGuess(e) {
    const btn = e.currentTarget;
    const cipher = btn.dataset.cipher;
    const choice = btn.dataset.choice;
    btn.disabled = true;
    try {
      const res = await fetch(`${API}/api/messages/shared/${encodeURIComponent(solveToken)}/guess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cipher, guess: choice }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || 'Could not check that guess.');

      if (result.correct) {
        solvedCipherLetters.add(cipher);
        renderPuzzle();
        if (result.solved) {
          const slot = document.getElementById('msg-reveal-slot');
          if (slot) {
            slot.innerHTML = `<p class="shared-message-text">${escapeHtml(result.text)}</p>`;
          }
        }
      } else {
        btn.disabled = false;
        btn.classList.add('wrong-flash');
        setTimeout(() => btn.classList.remove('wrong-flash'), 350);
      }
    } catch (err) {
      btn.disabled = false;
      alert(err.message || 'Could not check that guess.');
    }
  }

  renderPuzzle();

  // Append the "play the daily puzzle" CTA below the cryptogram once,
  // outside the re-rendered puzzle card so it survives every re-render.
  const cta = document.createElement('a');
  cta.href = window.location.pathname;
  cta.className = 'btn-secondary shared-message-cta';
  cta.textContent = 'Play Daily Cryptogram →';
  root.appendChild(cta);
}

async function renderSharedMessageIfPresent() {
  const match = window.location.hash.match(/^#\/m\/([A-Za-z0-9_-]+)$/);
  if (!match) return false;
  const token = match[1];
  const root = document.getElementById('leaderboard-root');
  const puzzlePanel = document.getElementById('puzzle-panel');
  if (puzzlePanel) puzzlePanel.style.display = 'none';
  root.innerHTML = `<div class="lb-card"><div class="lb-skeleton-row"></div></div>`;
  try {
    const res = await fetch(`${API}/api/messages/shared/${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'This message link is no longer valid.');
    renderMessagePuzzle(root, token, data);
  } catch (err) {
    root.innerHTML = `<div class="lb-card"><p class="modal-note">${escapeHtml(err.message || 'This message link is no longer valid.')}</p><a href="${window.location.pathname}" class="btn-secondary">Go to Daily Cryptogram →</a></div>`;
  }
  return true;
}

async function init() {
  if (await renderSharedMessageIfPresent()) return;

  const identity = await api('/api/identify', { method: 'POST' });
  myUserId = identity.user_id;
  visitorAuthToken = identity.auth_token;

  if (identity.quote_of_the_day) {
    const built = buildDailyPuzzle(identity.quote_of_the_day.text, identity.quote_of_the_day.author);
    PUZZLE = { plaintext: built.plaintext, author: built.author, rows: built.rows };
    PLAIN_TO_CIPHER = built.plainToCipher;
    const teaser = document.getElementById('quote-author-teaser');
    if (teaser) teaser.textContent = PUZZLE.author ? `Today's quote is attributed to ${PUZZLE.author}.` : '';
  } else {
    await fetchQuoteOfTheDay();
  }

  const subStatus = await api('/api/subscription-status').catch(() => null);
  if (subStatus) {
    challengeCredits = subStatus.credits || 0;
    challengePrice = subStatus.price_usd;
    stripeConfigured = !!subStatus.stripe_configured;
    liveMode = !!subStatus.live_mode;
  }
  const footer = document.getElementById('page-footer');
  if (footer) {
    footer.innerHTML = liveMode
      ? 'Every score is signed and verified server-side — no editing your time from the console. Friend challenges are billed for real via Stripe, $0.99 per send. <a href="#" id="footer-terms-link">Terms &amp; refund policy</a>.'
      : 'Every score is signed and verified server-side — no editing your time from the console. Friend challenges run on Stripe in test mode for this preview, so checkout is real but no money moves.';
    const footerTermsLink = document.getElementById('footer-terms-link');
    if (footerTermsLink) {
      footerTermsLink.addEventListener('click', (e) => {
        e.preventDefault();
        openTermsModal();
      });
    }
  }

  // Returning from Stripe Checkout: verify the session immediately instead
  // of waiting on webhook delivery timing, then resume the compose modal
  // for whichever friend the visitor was messaging before they subscribed.
  const returnParams = new URLSearchParams(window.location.search);
  let returnStatus = null;
  if (returnParams.has('subscribed')) {
    const sessionId = returnParams.get('session_id');
    if (returnParams.get('subscribed') === '1' && sessionId) {
      try {
        const statusResult = await api(`/api/checkout-session-status?session_id=${encodeURIComponent(sessionId)}`);
        challengeCredits = statusResult.credits || 0;
        returnStatus = challengeCredits > 0
          ? 'Payment received! Write your message below, then press "Create Challenge Link" to send it.'
          : "Payment didn't go through — please try paying again below.";
      } catch (err) {
        console.error('Could not verify checkout session:', err);
        returnStatus = "Couldn't confirm your payment — if you were charged, refresh this page before trying again.";
      }
    } else if (returnParams.get('subscribed') === '0') {
      returnStatus = 'Checkout was cancelled — no charge was made. Pay below whenever you\'re ready to send.';
    }
    const toDisplayName = returnParams.get('to_display_name');
    history.replaceState({}, '', window.location.pathname);
    if (toDisplayName) {
      window.__pendingMessageTarget = toDisplayName;
      window.__pendingMessageStatus = returnStatus;
    }
  }

  renderPitchPanel();

  if (window.__pendingMessageTarget) {
    const pendingName = window.__pendingMessageTarget;
    const pendingStatus = window.__pendingMessageStatus;
    delete window.__pendingMessageTarget;
    delete window.__pendingMessageStatus;
    openMessageModal(pendingName, pendingStatus);
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
      btn.textContent = "Start Today's Puzzle";
      alert(`Could not start challenge: ${err.message}`);
    }
  });
}

init();
