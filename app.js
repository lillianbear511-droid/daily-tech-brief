/* Daily Tech Brief — PWA client
   No framework. One audio element, one recorder, localStorage state. */

const root = document.getElementById('root');
const tabsEl = document.getElementById('tabs');
const toastEl = document.getElementById('toast');

/* ---------------------------------------------------------------- utils */
const pad = n => String(n).padStart(2, '0');
const fmt = s => (isFinite(s) && s > 0) ? `${Math.floor(s / 60)}:${pad(Math.round(s % 60))}` : '0:00';
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dayDiff = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem('dtb.' + k)); return v ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem('dtb.' + k, JSON.stringify(v));
/* Anything the learner typed must never be interpolated into innerHTML raw. */
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1800);
}
function buzz(ms = 8) {
  // Chrome logs a console error when vibration is requested without a user
  // gesture (e.g. a scripted restore). It is harmless, but noisy.
  try {
    if (!navigator.vibrate) return;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate(ms);
  } catch { /* no-op */ }
}

/* ---------------------------------------------------------------- state */
const S = {
  day: null,
  index: [],
  progress: load('progress', {}),
  words: load('words', {}),
  needs: load('needs', []),
};

/* Two issues can share a date, so progress is keyed by issue id
   (2026-10-27-pm) and not by date. Files written before the second issue
   existed have no id/slot — for those the id falls back to the date, which is
   exactly the key their progress was already stored under. */
const SLOT_ZH = { am: '早间', pm: '晚间' };
function normalize(d) {
  d.id = d.id || d.date;
  d.slot = d.slot || '';
  return d;
}
const dp = id => {
  const p = (S.progress[id] ||= {});
  p.listen ||= {}; p.shadow ||= {}; p.recall ||= {}; p.auto ||= {}; p.done ??= false;
  return p;
};
const sameDay = date => S.index.filter(x => x.date === date);

/* ---------------------------------------------------------------- audio */
const audio = new Audio();
audio.preload = 'auto';
let speed = 1;
let waveBars = [];
let waveHost = null;
let timeHost = null;

audio.addEventListener('timeupdate', () => {
  if (waveHost && waveBars.length) {
    const p = audio.duration ? audio.currentTime / audio.duration : 0;
    const cut = Math.round(p * waveBars.length);
    waveBars.forEach((b, i) => b.classList.toggle('on', i < cut));
  }
  if (timeHost) timeHost.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
});
audio.addEventListener('pause', () => {
  document.querySelectorAll('.play').forEach(b => b.dataset.playing = '');
});

/* A truncated range response does NOT fire `error`: the player simply decides
   the file is shorter than it is and reports `ended` after a few seconds.
   Catch that too. Clear only media rows — the shell stays available offline —
   and make the next tap go to the network. One repair per page load. */
let audioRecovered = false;
async function clearMediaCache() {
  try {
    for (const k of await caches.keys()) {
      const ca = await caches.open(k);
      for (const r of await ca.keys()) {
        if (r.url.includes('/audio/')) await ca.delete(r);
      }
    }
  } catch { /* private mode */ }
}
function expectedDuration(src) {
  const d = S.day;
  if (!d) return 0;
  if (src.endsWith(d.audio)) return d.duration || 0;
  const s = (d.sentences || []).find(x => src.endsWith(x.audio));
  return s ? (s.duration || 0) : 0;
}
async function repairAudio(message) {
  if (audioRecovered) return;
  audioRecovered = true;
  await clearMediaCache();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (navigator.serviceWorker) {
    navigator.serviceWorker.getRegistrations()
      .then(rs => Promise.all(rs.map(r => r.update())))
      .catch(() => {});
  }
  toast(message);
}
audio.addEventListener('error', () => {
  if (audio.src) repairAudio('Audio cache reset — tap play again');
});
audio.addEventListener('ended', () => {
  const expected = expectedDuration(audio.src);
  if (expected > 10 && audio.duration && audio.duration < expected * 0.8) {
    repairAudio('Audio stopped early — cache cleared, tap play again');
  }
  document.querySelectorAll('.play').forEach(b => b.dataset.playing = '');
  if (typeof audio.onDone === 'function') { const f = audio.onDone; audio.onDone = null; f(); }
});

function togglePlay(src, btn) {
  const playing = !audio.paused && audio.src.endsWith(src);
  if (playing) { audio.pause(); return false; }
  if (!audio.src.endsWith(src)) audio.src = src;
  audio.playbackRate = speed;
  audio.play().catch(() => toast('Tap once more to start audio'));
  document.querySelectorAll('.play').forEach(b => b.dataset.playing = '');
  if (btn) btn.dataset.playing = '1';
  return true;
}

function makeWave(host, n = 34, seed = 7) {
  host.innerHTML = '';
  const bars = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 9301 + 49297) % 233280;
    const r = x / 233280;
    const h = 4 + Math.round(Math.sin(i * 0.7 + seed) * 0.5 * 14 + r * 22);
    const b = document.createElement('i');
    b.style.height = Math.min(38, Math.max(3, h)) + 'px';
    host.appendChild(b);
    bars.push(b);
  }
  return bars;
}

/* ---------------------------------------------------------------- recorder */
const REC = { mr: null, chunks: [], stream: null, url: null, ac: null, analyser: null, raf: 0 };

function pickMime() {
  const list = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm'];
  for (const m of list) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

async function recStart(onLevel) {
  if (!navigator.mediaDevices?.getUserMedia) { toast('Recording needs HTTPS'); return false; }
  try {
    REC.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    toast('Mic access denied. Settings › Safari › Microphone');
    return false;
  }
  REC.chunks = [];
  const mime = pickMime();
  REC.mr = new MediaRecorder(REC.stream, mime ? { mimeType: mime } : undefined);
  REC.mr.ondataavailable = e => { if (e.data && e.data.size) REC.chunks.push(e.data); };
  REC.mr.start();

  if (onLevel) {
    REC.ac = REC.ac || new (window.AudioContext || window.webkitAudioContext)();
    if (REC.ac.state === 'suspended') await REC.ac.resume();
    const src = REC.ac.createMediaStreamSource(REC.stream);
    REC.analyser = REC.ac.createAnalyser();
    REC.analyser.fftSize = 512;
    src.connect(REC.analyser);
    const buf = new Uint8Array(REC.analyser.fftSize);
    const tick = () => {
      REC.analyser.getByteTimeDomainData(buf);
      const levels = onLevel.bars || [];
      const step = Math.floor(buf.length / levels.length);
      levels.forEach((bar, i) => {
        let sum = 0;
        for (let j = 0; j < step; j++) {
          const v = (buf[i * step + j] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / step);
        bar.style.height = Math.max(2, Math.min(34, rms * 110)) + 'px';
      });
      onLevel.tick && onLevel.tick();
      REC.raf = requestAnimationFrame(tick);
    };
    tick();
  }
  return true;
}

function recStop() {
  return new Promise(resolve => {
    cancelAnimationFrame(REC.raf);
    if (!REC.mr) return resolve(null);
    REC.mr.onstop = () => {
      const type = REC.mr.mimeType || 'audio/mp4';
      const blob = new Blob(REC.chunks, { type });
      if (REC.url) URL.revokeObjectURL(REC.url);
      REC.url = URL.createObjectURL(blob);
      REC.stream.getTracks().forEach(t => t.stop());
      REC.mr = null;
      resolve({ url: REC.url, blob });
    };
    REC.mr.stop();
  });
}

/* ---------------------------------------------------------------- words */
/* One notebook for both single words and whole sentences. Cards written by
   older builds have no `kind` and are simply words — nothing to migrate. */
function addCard(o, quiet) {
  if (!o.word) return false;
  if (S.words[o.word]) { if (!quiet) toast('Already in your notebook'); return false; }
  S.words[o.word] = { ...o, added: todayISO(), last: todayISO(), box: 0 };
  save('words', S.words);
  if (!quiet) {
    buzz();
    toast(o.kind === 'sentence' ? '句子已收进单词本' : '已收进单词本 · 明天开始复习');
  }
  return true;
}
function addWords(day) {
  (day.terms || []).forEach(t =>
    addCard({ ...t, kind: 'word', auto: true, src: day.id }, true));
}
const hasCard = k => !!S.words[k];
function delCard(k) { delete S.words[k]; save('words', S.words); }
const INTERVALS = [1, 3, 7, 16, 35];
function isDue(w) {
  const gap = dayDiff(w.last || w.added, todayISO());
  return gap >= (INTERVALS[w.box] ?? 1);
}
const dueCards = () => Object.values(S.words).filter(isDue);

/* Small inline "+" next to anything worth keeping. */
function saveBtn(text, zh, kind, note) {
  const on = hasCard(text);
  return `<button class="save-btn${on ? ' on' : ''}" data-save="${esc(text)}"
    data-zh="${esc(zh || '')}" data-kind="${kind}" data-note="${esc(note || '')}"
    aria-label="Save to notebook">${on ? '✓' : '+'}</button>`;
}
function bindSave(scope = document) {
  scope.querySelectorAll('[data-save]').forEach(b => {
    b.onclick = e => {
      e.stopPropagation();
      addCard({ word: b.dataset.save, zh: b.dataset.zh, kind: b.dataset.kind,
                note: b.dataset.note, src: S.day?.id });
      b.textContent = '✓';
      b.classList.add('on');
    };
  });
}

/* Selecting any English text on a reading screen offers "save to notebook".
   Kept bottom-fixed rather than floating at the caret: on iOS the native
   selection menu already owns the space right above the highlight. */
function initSelectionSaver() {
  const bar = document.createElement('button');
  bar.className = 'sel-save';
  bar.hidden = true;
  bar.textContent = '+ 收进单词本';
  document.body.appendChild(bar);
  let timer = 0, pending = '';
  const check = () => {
    const sel = window.getSelection();
    const txt = (sel?.toString() || '').trim().replace(/\s+/g, ' ');
    const inField = sel?.anchorNode?.parentElement?.closest?.('textarea,input');
    pending = (!inField && txt.length >= 2 && txt.length < 300 && /[a-zA-Z]/.test(txt)) ? txt : '';
    bar.hidden = !pending;
  };
  document.addEventListener('selectionchange', () => { clearTimeout(timer); timer = setTimeout(check, 200); });
  bar.onclick = () => {
    if (!pending) return;
    addCard({ word: pending, zh: '', kind: pending.split(/\s+/).length > 5 ? 'sentence' : 'word',
              note: '', src: S.day?.id });
    bar.hidden = true;
    window.getSelection()?.removeAllRanges();
  };
}
function speak(text) {
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.85;
    speechSynthesis.speak(u);
  } catch { /* no-op */ }
}

/* ---------------------------------------------------------------- streak */
function streakInfo() {
  // One bar per day, not per issue: a day with a morning and an evening brief
  // is finished only when both are. Days that predate the second issue fall
  // back to the bare-date key their progress was written under.
  const idsByDate = {};
  for (const x of S.index) (idsByDate[x.date] ||= []).push(x.id);

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const ids = idsByDate[key] || [];
    const done = ids.length
      ? ids.every(id => !!S.progress[id]?.done)
      : !!S.progress[key]?.done;
    days.push({ date: key, done });
  }
  let n = 0;
  for (let i = days.length - 1; i >= 0; i--) { if (days[i].done) n++; else break; }
  return { days, count: n };
}

/* ---------------------------------------------------------------- router */
function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'today';
  const [name, arg] = hash.split('/');
  if (!S.day) return;
  render(name, arg);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

function go(path) { location.hash = '#/' + path; }

function setTab(name) {
  const practice = ['listen', 'shadow', 'recall', 'notes', 'detail'].includes(name);
  tabsEl.hidden = practice;
  tabsEl.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('on', t.dataset.tab === name));
  tabsEl.querySelector('[data-tab="words"]')
    ?.classList.toggle('has-due', dueCards().length > 0);
}
tabsEl.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => go(t.dataset.tab)));

/* ---------------------------------------------------------------- screens */
function render(name, arg) {
  audio.onDone = null;
  waveHost = null; waveBars = []; timeHost = null;
  setTab(name);
  const map = { today: sToday, listen: sListen, shadow: sShadow, recall: sRecall, progress: sProgress, words: sWords, notes: sNotes };
  (map[name] || sToday)(arg);
}

function dateLabel(iso) {
  const d = new Date(iso + 'T08:00:00');
  const wd = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()];
  const mo = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()];
  return `${wd} · ${mo} ${d.getDate()}`;
}

/* -------- TODAY -------- */
const hasNotes = d => !!(d.terms?.length || d.grammar?.length
  || d.sentences?.some(s => s.zh));

function sToday() {
  const d = S.day, p = dp(d.id);
  const st = streakInfo();
  const rated = Object.keys(p.shadow || {}).length;
  const steps = [
    ['01', 'Warm up', !!p.warm],
    ['02', 'Listen', !!p.listen?.answered],
    ['03', 'Shadow', rated > 0 && rated >= d.sentences.length],
    ['04', 'Recall', !!p.recall?.done],
  ];
  const nextLabel = !p.listen?.answered ? 'Start with listening'
    : (rated < d.sentences.length ? `Shadow · sentence ${rated + 1} of ${d.sentences.length}`
    : (!p.recall?.done ? 'Finish with recall' : 'Practice again'));

  // The other issue of the same day, if the evening brief has been built yet.
  const dueN = dueCards().length;
  const sibs = sameDay(d.date).filter(x => x.id !== d.id);
  const slotZh = SLOT_ZH[d.slot] || '';
  const title = d.slot === 'am' ? 'Morning brief'
    : (d.slot === 'pm' ? 'Evening brief' : "Today's brief");

  root.innerHTML = `
  <div class="screen">
    <div class="hd">
      <div class="stack gap-6">
        <div class="row" style="align-items:center;gap:8px;justify-content:flex-start">
          <span class="eyebrow">${dateLabel(d.date)}${slotZh ? ` · ${slotZh}` : ''}</span>
          ${sibs.length ? `<button class="swap" data-sib="${sibs[0].id}">看${SLOT_ZH[sibs[0].slot] || '另一期'}</button>` : ''}
        </div>
        <h1 class="h1">${title}</h1>
      </div>
      <div class="chip"><i class="dot"></i>${st.count > 0 ? `${st.count} DAY${st.count > 1 ? 'S' : ''}` : 'DAY 1'}</div>
    </div>

    ${dueN ? `<button class="review-banner" id="reviewBanner">
      <div style="text-align:left">
        <div class="eyebrow" style="color:var(--accent)">DUE TODAY</div>
        <div class="t">${dueN} 张卡待复习 · 约 2 分钟</div>
      </div>
      <span class="arrow">→</span>
    </button>` : ''}

    <div class="card stack gap-16" style="margin-top:22px">
      <div class="meta">
        <span class="src">${d.source}</span>
        <span class="dur">${fmt(d.duration)}</span>
      </div>
      <h2 class="h2">${d.headline}</h2>
      <div class="wave" id="wave1"></div>
      <div class="row">
        <button class="play" id="bigplay" aria-label="Play">
          <svg width="15" height="17" viewBox="0 0 15 17"><path d="M1.5 1.6a1 1 0 0 1 1.5-.86l11 6.9a1 1 0 0 1 0 1.72l-11 6.9a1 1 0 0 1-1.5-.86V1.6z" fill="#fff"/></svg>
        </button>
        <span class="timecode" id="tc">0:00 / ${fmt(d.duration)}</span>
        <button class="pill" id="spd">1.0x</button>
      </div>
    </div>

    <div class="stack gap-10" style="margin-top:18px">
      <div class="eyebrow">Key terms</div>
      <div class="chips" id="terms">
        ${d.terms.map(t => `<button class="tchip" data-w="${t.word}">${t.word}</button>`).join('')}
      </div>
    </div>

    <div class="stack gap-10" style="margin-top:18px">
      <div class="eyebrow">Today's practice</div>
      <div class="steps">
        ${steps.map(([n, label, done]) => `<div class="step${done ? ' done' : ''}"><b>${n}</b><span>${label}</span></div>`).join('')}
      </div>
    </div>

    ${hasNotes(d) ? `<button class="row-item" style="margin-top:14px" id="notes">
      <div style="flex:1">
        <div class="t">Language notes · 中文对照</div>
        <div class="d">${d.terms.length} 个词汇 · ${(d.grammar || []).length} 条语法 · ${d.sentences.length} 句译文</div>
      </div>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 1.5L8.5 6 4 10.5" stroke="#C4C0B8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    </button>` : ''}

    ${st.count > 1 ? `<div class="row-item" style="margin-top:18px" id="recap">
      <div><div class="sub" style="font-size:9px;letter-spacing:1.4px;font-weight:600;color:var(--faint)">YESTERDAY</div>
      <div class="t" style="margin-top:4px;font-weight:400;color:#4A4744">${st.days[st.days.length - 2].done ? 'Completed' : 'Missed'} · ${S.needs.length} word${S.needs.length === 1 ? '' : 's'} to retry</div></div>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 1.5L8.5 6 4 10.5" stroke="#C4C0B8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    </div>` : ''}

    <div class="dock">
      <div class="loadline">
        <span>${d.sentences.length} sentences</span><i></i>
        <span>${d.terms.length} key terms</span><i></i>
        <span>about 5 min</span>
      </div>
      <button class="btn" id="start">
        ${nextLabel}
        <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2.5 7h9M8 3.5L11.5 7 8 10.5" stroke="#FAF9F7" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      </button>
    </div>
  </div>`;

  const wave = document.getElementById('wave1');
  waveBars = makeWave(wave, 34, 11);
  waveHost = wave;
  timeHost = document.getElementById('tc');

  const big = document.getElementById('bigplay');
  big.onclick = () => {
    const playing = togglePlay(d.audio, big);
    if (playing && !p.warm) {
      p.warm = true;
      save('progress', S.progress);
      document.querySelector('.step')?.classList.add('done');
    }
  };
  document.getElementById('spd').onclick = e => {
    speed = speed >= 1.25 ? 0.75 : Math.round((speed + 0.25) * 100) / 100;
    audio.playbackRate = speed;
    e.currentTarget.textContent = speed.toFixed(1) + 'x';
  };
  document.querySelectorAll('#terms .tchip').forEach(b => b.onclick = () => speak(b.dataset.w));
  document.getElementById('recap')?.addEventListener('click', () => go('progress'));
  document.getElementById('reviewBanner')?.addEventListener('click', () => go('words/review'));
  document.getElementById('notes')?.addEventListener('click', () => go('notes'));
  document.querySelector('[data-sib]')?.addEventListener('click',
    e => switchIssue(e.currentTarget.dataset.sib));

  document.getElementById('start').onclick = () => {
    if (!p.listen?.answered) go('listen');
    else if (rated < d.sentences.length) go('shadow/' + (rated + 1));
    else if (!p.recall?.done) go('recall');
    else go('progress');
  };
}

/* -------- LISTEN -------- */
function sListen() {
  const d = S.day, p = dp(d.id);
  const plays = p.listen?.plays || 0;
  const answered = !!p.listen?.answered;
  const picked = p.listen?.picks || [];
  const total = d.questions.length;
  const picks = d.questions.map((_, i) => picked[i] ?? -1);
  let qi = 0;

  root.innerHTML = `
  <div class="screen solo">
    <div class="topbar">
      <button class="back" data-go="today">
        <svg viewBox="0 0 18 18"><path d="M11 3.5L5.5 9 11 14.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        Listen
      </button>
      <div class="eyebrow">${answered ? 'ANSWERED' : `${Math.max(0, 3 - plays)} PLAYS LEFT`}</div>
    </div>

    <div class="card stack gap-12 center" style="margin-top:18px;align-items:center;padding:20px 18px">
      <div class="eyebrow">Blind listen · no text</div>
      <button class="play" id="lplay" style="width:64px;height:64px;border-radius:32px">
        <svg width="18" height="21" viewBox="0 0 20 23"><path d="M2 2.1a1.3 1.3 0 0 1 2-1.1l14.3 9a1.3 1.3 0 0 1 0 2.2L4 21.2a1.3 1.3 0 0 1-2-1.1V2.1z" fill="#fff"/></svg>
      </button>
      <div class="wave" id="wave2" style="width:100%;max-width:260px"></div>
      <div class="timecode" id="tc2">0:00 / ${fmt(d.duration)}</div>
      <div class="rec-hint">${answered ? 'Answer locked in' : 'Transcript unlocks after you answer'}</div>
    </div>

    <div id="qhost"></div>
    <div id="after"></div>

    <div class="dock">
      <div class="row" id="dots" style="justify-content:center;gap:6px;margin-bottom:12px"></div>
      <button class="btn" id="check" disabled>Next question</button>
    </div>
  </div>`;

  const wave = document.getElementById('wave2');
  waveBars = makeWave(wave, 34, 5);
  waveHost = wave;
  timeHost = document.getElementById('tc2');

  const playBtn = document.getElementById('lplay');
  playBtn.onclick = () => {
    if (!answered && (p.listen.plays || 0) >= 3 && audio.paused) {
      return toast('Out of plays. Answer to unlock replay.');
    }
    const started = togglePlay(d.audio, playBtn);
    if (started && !answered) {
      dp(d.id).listen.plays = (p.listen.plays || 0) + 1;
      save('progress', S.progress);
    }
  };

  function paintDots() {
    document.getElementById('dots').innerHTML = d.questions.map((_, i) => {
      const on = i === qi;
      const filled = picks[i] >= 0;
      return `<i style="width:${on ? 18 : 6}px;height:6px;border-radius:3px;transition:width .18s;background:${on ? 'var(--accent)' : (filled ? '#C4C0B8' : '#E7E4DD')}"></i>`;
    }).join('');
  }

  function renderOne() {
    const q = d.questions[qi];
    document.getElementById('qhost').innerHTML = `
      <div class="stack gap-10" style="margin-top:22px">
        <div class="eyebrow">Question ${qi + 1} of ${total}</div>
        <div style="font-size:16px;font-weight:600;line-height:1.5">${q.q}</div>
        <div class="stack gap-8" id="q${qi}">
          ${q.options.map((o, i) => `<button class="opt${picks[qi] === i ? ' sel' : ''}" data-q="${qi}" data-i="${i}"><i class="r"></i>${o}</button>`).join('')}
        </div>
      </div>`;
    document.querySelectorAll('.opt').forEach(b => {
      b.onclick = () => {
        if (answered) return;
        const qn = +b.dataset.q, i = +b.dataset.i;
        picks[qn] = i;
        document.querySelectorAll(`#q${qn} .opt`).forEach(o => o.classList.toggle('sel', +o.dataset.i === i));
        document.getElementById('check').disabled = false;
        paintDots();
        buzz();
      };
    });
    paintDots();
    const c = document.getElementById('check');
    c.textContent = qi === total - 1 ? 'Check answers' : 'Next question';
    c.disabled = picks[qi] < 0;
  }

  function renderReview() {
    document.getElementById('qhost').innerHTML = d.questions.map((q, i) => `
      <div class="stack gap-10" style="margin-top:20px">
        <div class="eyebrow">Question ${i + 1} of ${total}</div>
        <div style="font-size:15px;font-weight:600;line-height:1.5">${q.q}</div>
        <div class="stack gap-8" id="q${i}">
          ${q.options.map((o, k) => {
            const cls = k === q.answer ? ' right' : (k === picks[i] ? ' wrong' : '');
            return `<button class="opt${cls}" data-q="${i}" data-i="${k}" disabled><i class="r"></i>${o}</button>`;
          }).join('')}
        </div>
        <div class="fb${picks[i] === q.answer ? ' ok' : ''}">
          <div class="v">${picks[i] === q.answer ? 'Correct' : 'Not quite'}</div>
          <div class="tip">${q.explain}</div>
        </div>
      </div>`).join('');

    const correct = d.questions.filter((q, i) => picks[i] === q.answer).length;
    document.getElementById('after').innerHTML = `
      <button class="btn ghost sm" id="reveal" style="margin-top:18px">Show transcript</button>
      <div id="trans"></div>`;
    document.getElementById('reveal').onclick = () => {
      document.getElementById('trans').innerHTML = `<div class="card flat stack gap-8" style="margin-top:10px"><div class="eyebrow">Transcript</div><div style="font-size:13px;line-height:1.7;color:#4A4744">${d.script}</div></div>`;
      document.getElementById('reveal').remove();
    };

    document.getElementById('dots').innerHTML = `<span class="sub" style="font-size:11px">${correct} of ${total} correct</span>`;
    const c = document.getElementById('check');
    c.textContent = 'Now shadow it, sentence by sentence';
    c.disabled = false;
    c.onclick = () => go('shadow/1');
  }

  document.getElementById('check').onclick = () => {
    if (answered) return go('shadow/1');
    if (picks[qi] < 0) return toast('Pick an answer first');
    if (qi < total - 1) { qi++; renderOne(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    const correct = d.questions.filter((q, i) => picks[i] === q.answer).length;
    dp(d.id).listen = { ...p.listen, answered: true, picks, correct, plays: p.listen.plays || 0 };
    save('progress', S.progress);
    buzz(12);
    renderReview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (answered) renderReview(); else renderOne();
}

/* ---------------------------------------------------------- assessment */
// Comparing a take with the original reading happens entirely on the device:
// decode both, resample to 16 kHz mono, hand the samples to assess.js.
const PCM = new Map();                      // reference url -> Float32Array
const BAND = { g: 'Clear', a: 'Close', r: 'Retry' };

async function toPcm(input) {
  const blob = input instanceof Blob ? input : await fetch(input).then(r => r.blob());
  const bytes = await blob.arrayBuffer();
  const ac = REC.ac || new (window.AudioContext || window.webkitAudioContext)();
  const buf = await new Promise((ok, no) => ac.decodeAudioData(bytes, ok, no));
  const OFF = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OFF(1, Math.max(1, Math.ceil(buf.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

async function refPcm(url) {
  if (!PCM.has(url)) {
    const pcm = await toPcm(url);
    PCM.set(url, pcm);
    if (PCM.size > 3) PCM.delete(PCM.keys().next().value);
  }
  return PCM.get(url);
}

const meterHTML = p => [
  ['Sounds', p.match], ['Whole', p.completeness],
  ['Rhythm', p.pace], ['Endings', p.clarity],
].map(([label, v]) => {
  const col = v >= 75 ? 'var(--green)' : v >= 55 ? 'var(--amber)' : '#C4573A';
  return `<div class="meter"><span class="ml">${label}</span>
      <span class="mt"><i style="width:${v}%;background:${col}"></i></span>
      <span class="mv">${v}</span></div>`;
}).join('');
/* -------- SHADOW -------- */
function sShadow(arg) {
  const d = S.day, p = dp(d.id);
  const idx = Math.min(Math.max(1, +arg || 1), d.sentences.length);
  const s = d.sentences[idx - 1];
  const rating = p.shadow?.[s.id];
  const gram = (d.grammar || []).filter(x => x.line === s.id);

  root.innerHTML = `
  <div class="screen solo">
    <div class="topbar">
      <button class="back" data-go="today">
        <svg viewBox="0 0 18 18"><path d="M11 3.5L5.5 9 11 14.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        Shadow
      </button>
      <div class="eyebrow">${idx} of ${d.sentences.length}</div>
    </div>

    <div class="progress-line" style="margin-top:12px">
      ${d.sentences.map((_, i) => `<i class="${i < idx - 1 ? 'on' : ''}"></i>`).join('')}
    </div>

    <div class="card stack gap-14" style="margin-top:18px">
      <div class="row">
        <div class="eyebrow">Sentence ${pad(s.id)} · ${fmt(s.duration)}</div>
        ${saveBtn(s.text, s.zh, 'sentence', `第 ${s.id} 句 · ${S.day.headline}`)}
      </div>
      <div class="sentence">${s.text}</div>
      ${s.zh ? `<div class="zh">${s.zh}</div>` : ''}
      ${s.focus ? `<div class="focus"><i class="d"></i><span>${s.focus}</span></div>` : ''}
      ${gram.map(g => `<div class="lang-item" style="padding-top:11px;border-top:1px dashed var(--line)">
        <div class="at">语法</div>
        <div class="k" style="margin-top:3px">${g.point}</div>
        <div class="n">${g.note}</div>
      </div>`).join('')}
    </div>

    <div class="row" style="margin-top:14px;justify-content:flex-start;gap:10px">
      <button class="play sm" id="splay">
        <svg width="12" height="14" viewBox="0 0 12 14"><path d="M1.2 1.4a.8.8 0 0 1 1.2-.7l9 5.3a.8.8 0 0 1 0 1.4l-9 5.3a.8.8 0 0 1-1.2-.7V1.4z" fill="#fff"/></svg>
      </button>
      <div class="wave small" id="wave3" style="flex:1"></div>
      <span class="timecode" id="tc3">0:00</span>
    </div>

    <div class="rec-wrap" style="margin-top:18px">
      <div class="live-wave" id="live">${'<i></i>'.repeat(24)}</div>
      <button class="rec-btn" id="rec">
        <svg width="24" height="24" viewBox="0 0 24 24" id="recIcon">
          <rect x="9" y="2.5" width="6" height="11" rx="3" fill="#fff"/>
          <path d="M5.5 10.5a6.5 6.5 0 0 0 13 0M12 17.5v3" stroke="#fff" stroke-width="1.9" stroke-linecap="round" fill="none"/>
        </svg>
      </button>
      <div class="timer" id="timer">0:00</div>
      <div class="rec-hint" id="hint">Tap to record · stay on this screen</div>
    </div>

    <div id="own"></div>
    <div id="rateArea"></div>

    <div class="dock">
      <div class="row" id="nav" style="gap:10px">
        <button class="btn ghost sm" id="prev" style="flex:1" ${idx === 1 ? 'disabled' : ''}>Previous</button>
        <button class="btn sm" id="next" style="flex:1">${idx === d.sentences.length ? 'Finish' : 'Next sentence'}</button>
      </div>
    </div>
  </div>`;

  const wave = document.getElementById('wave3');
  waveBars = makeWave(wave, 28, 3 + idx);
  waveHost = wave;
  timeHost = document.getElementById('tc3');
  document.getElementById('splay').onclick = e => togglePlay(s.audio, e.currentTarget);
  bindSave();

  let recording = false, t0 = 0, tickTimer = 0;
  const liveBars = [...document.getElementById('live').children];
  const timerEl = document.getElementById('timer');
  const recBtn = document.getElementById('rec');
  const hintEl = document.getElementById('hint');

  recBtn.onclick = async () => {
    if (!recording) {
      audio.pause();
      const ok = await recStart({ bars: liveBars, tick: () => {
        const sec = (Date.now() - t0) / 1000;
        timerEl.textContent = fmt(sec);
      } });
      if (!ok) return;
      t0 = Date.now();
      recording = true;
      recBtn.classList.add('live');
      document.getElementById('live').classList.add('on');
      hintEl.textContent = 'Recording · tap to stop';
      buzz();
    } else {
      recording = false;
      clearInterval(tickTimer);
      recBtn.classList.remove('live');
      liveBars.forEach(b => b.style.height = '2px');
      document.getElementById('live').classList.remove('on');
      hintEl.textContent = 'Compare your version with the original';
      timerEl.textContent = fmt((Date.now() - t0) / 1000);
      const rec = await recStop();
      if (rec) checkTake(rec);
    }
  };

  let lastTake = null;                      // object URL of the latest take
  let cur = rating || '';                   // manual override, if used

  function paintTake({ score, band, parts, notes }) {
    document.getElementById('own').innerHTML = `
      <div class="card flat" style="margin-top:14px">
        <div class="row" style="align-items:baseline">
          <div class="stack gap-6">
            <div class="eyebrow">Your take</div>
            <div class="score"><span class="n">${score}</span><span class="u">/100</span></div>
          </div>
          <span class="verdict ${band}">${BAND[band] || ''}</span>
        </div>
        <div class="stack gap-8" style="margin-top:16px">${meterHTML(parts)}</div>
        ${notes && notes.length ? `<div class="stack gap-8" style="margin-top:14px">
          ${notes.map(n => `<div class="note"><span>${n.t}</span></div>`).join('')}
        </div>` : ''}
        <div class="row" style="margin-top:16px;gap:10px">
          <button class="btn ghost sm" id="ownPlay" style="flex:1">Play back</button>
          <button class="btn sm" id="ownRec" style="flex:1">Try again</button>
        </div>
        <button class="link" id="override">Machine got it wrong? Rate it yourself</button>
      </div>`;
    const play = document.getElementById('ownPlay');
    if (lastTake) play.onclick = () => { new Audio(lastTake).play().catch(() => toast('Tap to play')); };
    else play.style.display = 'none';
    document.getElementById('ownRec').onclick = () => recBtn.click();
    document.getElementById('override').onclick = () => showManual(true);
  }

  function endTake(reason) {
    const msg = {
      silent: 'Nothing audible in that take. Check the mic and go once more.',
      'too-short': 'That take was too short to compare with the original.',
      manual: 'Scoring needs one visit with a connection to warm up. Rate this one by ear.',
      error: 'Could not compare that take.',
    }[reason] || 'Could not compare that take.';
    document.getElementById('own').innerHTML = `
      <div class="card flat stack gap-10" style="margin-top:14px">
        <div class="eyebrow">Your take</div>
        <div class="sub" style="font-size:11px">${msg}</div>
        <div class="row" style="gap:10px">
          <button class="btn ghost sm" id="ownPlay" style="flex:1">Play back</button>
          <button class="btn sm" id="ownRec" style="flex:1">Try again</button>
        </div>
      </div>`;
    document.getElementById('ownPlay').onclick = () => {
      if (lastTake) new Audio(lastTake).play().catch(() => toast('Tap to play'));
    };
    document.getElementById('ownRec').onclick = () => recBtn.click();
    showManual(true);
  }

  async function checkTake(rec) {
    lastTake = rec.url;
    document.getElementById('own').innerHTML = `
      <div class="card flat stack gap-10" style="margin-top:14px">
        <div class="eyebrow">Your take</div>
        <div class="sub" style="font-size:11px">Comparing with the original…</div>
      </div>`;
    if (!window.DTBAssess) return endTake('manual');
    try {
      const [ref, mine] = await Promise.all([refPcm(s.audio), toPcm(rec.blob)]);
      const r = window.DTBAssess.compare(ref, mine);
      if (!r.ok) return endTake(r.reason === 'silent' ? 'silent' : 'too-short');
      cur = r.band;
      showManual(false);                  // the score replaces the self-rating
      dp(d.id).shadow[s.id] = r.band;
      dp(d.id).auto[s.id] = { s: r.score, b: r.band, m: r.parts, t: r.notes.map(n => n.t) };
      save('progress', S.progress);
      flagNeed(r.band === 'r');
      buzz();
      paintTake(r);
    } catch (e) {
      endTake('error');
    }
  }

  function flagNeed(bad) {
    const has = S.needs.some(n => (n.id || n.date) === d.id && n.sid === s.id);
    if (bad && !has) {
      S.needs.unshift({ id: d.id, date: d.date, sid: s.id, text: s.text.slice(0, 70), focus: s.focus || '' });
      S.needs = S.needs.slice(0, 40);
    } else if (!bad && has) {
      S.needs = S.needs.filter(n => !((n.id || n.date) === d.id && n.sid === s.id));
    } else return;
    save('needs', S.needs);
  }

  function showManual(open) {
    const area = document.getElementById('rateArea');
    if (!open) { area.innerHTML = ''; return; }
    area.innerHTML = `
      <div class="stack gap-8" style="margin-top:14px">
        <div class="eyebrow">Your call</div>
        <div class="rate-row">
          ${['g', 'a', 'r'].map(k => `<button class="rate ${k} ${cur === k ? 'sel' : ''}" data-r="${k}"><i class="c"></i>${BAND[k]}</button>`).join('')}
        </div>
      </div>`;
    area.querySelectorAll('.rate').forEach(b => {
      b.onclick = () => {
        cur = b.dataset.r;
        dp(d.id).shadow[s.id] = cur;
        save('progress', S.progress);
        flagNeed(cur === 'r');
        area.querySelectorAll('.rate').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
        buzz();
      };
    });
  }

  if (rating) {
    const saved = p.auto?.[s.id];
    if (saved) {
      paintTake({ score: saved.s, band: saved.b, parts: saved.m, notes: (saved.t || []).map(t => ({ t })) });
    } else {
      document.getElementById('own').innerHTML = `
        <div class="card flat stack gap-10" style="margin-top:14px">
          <div class="eyebrow">Rated: ${BAND[rating].toLowerCase()}</div>
          <div class="sub" style="font-size:11px">Record a take to have it scored.</div>
        </div>`;
      showManual(true);
    }
  }

  document.getElementById('prev').onclick = () => go('shadow/' + (idx - 1));
  document.getElementById('next').onclick = () => {
    if (idx === d.sentences.length) {
      addWords(d);
      dp(d.id).done = true;
      save('progress', S.progress);
      go('recall');
      toast('Day marked complete');
    } else {
      go('shadow/' + (idx + 1));
    }
  };
}

/* -------- RECALL -------- */
function sRecall() {
  const d = S.day, p = dp(d.id);
  const saved = p.recall || {};
  const Coach = window.DTBCoach;
  const canASR = !!Coach?.dictationSupported();

  root.innerHTML = `
  <div class="screen solo">
    <div class="topbar">
      <button class="back" data-go="today">
        <svg viewBox="0 0 18 18"><path d="M11 3.5L5.5 9 11 14.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        Recall
      </button>
      <div class="eyebrow">30 SEC</div>
    </div>

    <div class="card stack gap-14" style="margin-top:18px">
      <div class="eyebrow">Your turn · no script</div>
      <div class="h2" style="font-size:22px">Explain today's story in three sentences.</div>
      <div class="stack gap-8">
        ${d.recall_prompts.map((t, i) => `<div class="row" style="justify-content:flex-start;gap:8px">
          <span class="eyebrow" style="color:var(--accent)">0${i + 1}</span>
          <span style="font-size:12px;color:#4A4744">${t}</span></div>`).join('')}
      </div>
    </div>

    <div class="rec-wrap" style="margin-top:18px">
      <div class="live-wave" id="live">${'<i></i>'.repeat(24)}</div>
      <button class="rec-btn" id="rec">
        <svg width="24" height="24" viewBox="0 0 24 24"><rect x="9" y="2.5" width="6" height="11" rx="3" fill="#fff"/><path d="M5.5 10.5a6.5 6.5 0 0 0 13 0M12 17.5v3" stroke="#fff" stroke-width="1.9" stroke-linecap="round" fill="none"/></svg>
      </button>
      <div class="timer"><span id="timer">0:00</span> <span style="font-size:10px;color:var(--faint);font-weight:400">/ 0:30</span></div>
      <div class="rec-hint" id="hint">Tap to record · stay on this screen</div>
    </div>

    <div id="own"></div>

    <div class="card flat stack gap-10" style="margin-top:14px">
      <div class="row">
        <div class="eyebrow">Feedback · 可选</div>
        ${canASR ? '<button class="link sm" id="asr" style="margin:0">🎤 自动转写</button>' : ''}
      </div>
      <div class="sub">把刚才说的英文打下来，就能看到漏了什么、哪里换种说法更地道。不打字也能完成今天练习。</div>
      <textarea id="recallText" class="recall-input" rows="4"
        placeholder="Type what you just said…">${esc(saved.text || '')}</textarea>
      <button class="btn ghost sm" id="evaluate" ${saved.text ? '' : 'disabled'}>评价我的总结</button>
      <div id="coachOut"></div>
      <div id="aiBox"></div>
    </div>

    <div class="dock">
      <button class="btn" id="finish" ${saved.done ? '' : 'disabled'}>
        ${saved.done ? 'Save & finish' : 'Record first, then save'}
      </button>
    </div>
  </div>`;

  const liveBars = [...document.getElementById('live').children];
  const timerEl = document.getElementById('timer');
  const recBtn = document.getElementById('rec');
  const hintEl = document.getElementById('hint');
  const textEl = document.getElementById('recallText');
  const evalBtn = document.getElementById('evaluate');
  const fin = document.getElementById('finish');
  const coachOut = document.getElementById('coachOut');
  const aiBox = document.getElementById('aiBox');
  let recording = false, t0 = 0, autoStop = 0, asrRec = null, saveTimer = 0;

  const asText = v => esc(typeof v === 'string' ? v : JSON.stringify(v ?? ''));

  /* Keep the draft even if the learner leaves before finishing. */
  textEl.addEventListener('input', () => {
    evalBtn.disabled = textEl.value.trim().length < 8;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      p.recall = { ...(p.recall || {}), text: textEl.value.trim() };
      save('progress', S.progress);
    }, 500);
  });

  if (canASR) {
    document.getElementById('asr').onclick = e => {
      const btn = e.currentTarget;
      if (asrRec) { try { asrRec.stop(); } catch { /* no-op */ } asrRec = null; btn.textContent = '🎤 自动转写'; return; }
      asrRec = Coach.dictate(
        t => { textEl.value = t; textEl.dispatchEvent(new Event('input')); },
        () => { asrRec = null; btn.textContent = '🎤 自动转写'; });
      if (!asrRec) toast('这个浏览器用不了自动转写，直接打字吧');
      else btn.textContent = '■ 停止转写';
    };
  }

  function renderCoach(r, text) {
    const bar = (label, v, color) => `<div class="meter">
      <span class="ml">${label}</span>
      <span class="mt"><i style="width:${v}%;background:${color}"></i></span>
      <span class="mv">${v}</span></div>`;
    const vc = r.score >= 78 ? 'g' : (r.score >= 55 ? 'a' : 'r');
    coachOut.innerHTML = `
      <div class="card flat stack gap-10" style="margin-top:12px">
        <div class="row" style="align-items:baseline">
          <div class="score"><span class="n">${r.score}</span><span class="u">/100</span></div>
          <span class="verdict ${vc}">${r.band}</span>
        </div>
        ${bar('覆盖', r.parts.coverage, 'var(--accent)')}
        ${bar('结构', r.parts.structure, 'var(--amber)')}
        ${bar('表达', r.parts.expression, 'var(--green)')}
        <div class="stack gap-8" style="margin-top:6px">
          ${r.tips.map(t => `<div class="coach-tip">
            <div class="ct">${esc(t.title)}</div>
            <div class="note">${esc(t.body)}</div>
          </div>`).join('')}
        </div>
        <div class="stack gap-8" style="margin-top:8px;border-top:1px dashed var(--line);padding-top:12px">
          <div class="eyebrow">三句骨架 · 练「怎么说」</div>
          <div class="sub">下面是从原文挑出的三句骨架，不是标准答案。用自己的话把它们连起来，就是一篇合格总结。</div>
          ${r.model.map(m => `<div class="model-line"><span>${esc(m.tag)}</span><p>${esc(m.text)}</p></div>`).join('')}
        </div>
        <button class="link" id="aiGo">用 AI 逐句精修（可选）</button>
      </div>`;
    document.getElementById('aiGo').onclick = () => aiPolish(text);
  }

  function aiPolish(text) {
    const key = Coach.getKey();
    if (!key) {
      aiBox.innerHTML = `
        <div class="card flat stack gap-8" style="margin-top:10px">
          <div class="eyebrow">第一次用 · 填一次就好</div>
          <input id="llmkey" class="recall-input" type="password"
            placeholder="DeepSeek API key（sk-…）" style="min-height:42px">
          <div class="sub">只存在这个浏览器里，直接发给 DeepSeek，不经过任何服务器，也不会写进仓库。不想填就跳过，上面的反馈照常能用。</div>
          <div class="row" style="gap:8px">
            <button class="btn ghost sm" id="skipKey" style="flex:1">跳过</button>
            <button class="btn sm" id="saveKey" style="flex:1">保存并精修</button>
          </div>
        </div>`;
      document.getElementById('skipKey').onclick = () => { aiBox.innerHTML = ''; };
      document.getElementById('saveKey').onclick = () => {
        const k = document.getElementById('llmkey').value.trim();
        if (!k) return toast('先填 key');
        Coach.setKey(k);
        aiPolish(text);
      };
      return;
    }
    aiBox.innerHTML = `<div class="sub" style="margin-top:10px">正在精修…</div>`;
    Coach.polish(text, d, key).then(j => {
      aiBox.innerHTML = `
        <div class="card flat stack gap-10" style="margin-top:10px">
          <div class="eyebrow">更地道的版本</div>
          <div style="font-size:13px;line-height:1.7">${asText(j.rewritten)}</div>
          ${(j.changes || []).length ? `<div class="stack gap-6">
            <div class="eyebrow">改了什么</div>
            ${j.changes.map(c => `<div class="note">· ${asText(c)}</div>`).join('')}
          </div>` : ''}
          ${j.missed ? `<div class="note"><b>漏了：</b>${asText(j.missed)}</div>` : ''}
          ${j.phrase ? `<div class="note"><b>值得记住：</b>${asText(j.phrase)}</div>` : ''}
          <button class="link" id="clearKey" style="margin-top:0">清除本机 key</button>
        </div>`;
      document.getElementById('clearKey').onclick = () => { Coach.setKey(''); aiBox.innerHTML = ''; toast('已清除'); };
    }).catch(e => {
      aiBox.innerHTML = `<div class="sub" style="margin-top:10px;color:#C4573A">
        精修失败（${esc(e.message || 'network')}）。检查 key 或网络；上面的反馈不受影响。</div>`;
    });
  }

  evalBtn.onclick = () => {
    if (!Coach) return toast('评价模块没加载，刷新一下');
    const text = textEl.value.trim();
    const r = Coach.evaluate(text, d);
    if (!r.ok) return toast('写得太短了，至少说一句完整的');
    p.recall = { ...(p.recall || {}), text, score: r.score, band: r.band };
    save('progress', S.progress);
    renderCoach(r, text);
    buzz();
    setTimeout(() => coachOut.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 80);
  };

  recBtn.onclick = async () => {
    if (!recording) {
      audio.pause();
      const ok = await recStart({ bars: liveBars, tick: () => {
        const sec = (Date.now() - t0) / 1000;
        timerEl.textContent = fmt(sec);
      } });
      if (!ok) return;
      t0 = Date.now();
      recording = true;
      recBtn.classList.add('live');
      hintEl.textContent = 'Recording · tap to stop';
      autoStop = setTimeout(() => recBtn.click(), 31000);
      document.getElementById('live').classList.add('on');
      buzz();
    } else {
      clearTimeout(autoStop);
      recording = false;
      recBtn.classList.remove('live');
      document.getElementById('live').classList.remove('on');
      liveBars.forEach(b => b.style.height = '2px');
      const secs = (Date.now() - t0) / 1000;
      const rec = await recStop();
      if (rec) {
        hintEl.textContent = 'Done · ' + Math.round(secs) + 's';
        document.getElementById('own').innerHTML = `
          <div class="card flat stack gap-8" style="margin-top:14px">
            <div class="eyebrow">Your recording</div>
            <button class="btn ghost sm" id="ownPlay" style="margin-top:2px">Play back</button>
          </div>`;
        document.getElementById('ownPlay').onclick = () => new Audio(rec.url).play();
        p.recall = { ...(p.recall || {}), done: true, secs: Math.round(secs), text: textEl.value.trim() };
        p.done = true;
        save('progress', S.progress);
        addWords(d);
        fin.disabled = false;
        fin.textContent = 'Save & finish';
      } else {
        hintEl.textContent = 'Out loud beats perfect';
      }
    }
  };

  fin.onclick = () => {
    if (asrRec) { try { asrRec.stop(); } catch { /* no-op */ } }
    p.recall = { ...(p.recall || {}), done: true, text: textEl.value.trim() };
    p.done = true;
    save('progress', S.progress);
    addWords(d);
    buzz(14);
    go('progress');
  };
}

/* -------- PROGRESS -------- */
function sProgress() {
  const st = streakInfo();
  const daysPracticed = Object.keys(S.progress).filter(k => S.progress[k].done).length;
  const all = Object.values(S.progress).flatMap(p => Object.values(p.shadow || {}));
  const clear = all.filter(r => r === 'g').length;
  const close = all.filter(r => r === 'a').length;
  const retry = all.filter(r => r === 'r').length;
  const total = all.length || 1;
  const scored = Object.values(S.progress).flatMap(p => Object.values(p.auto || {}));
  const avg = scored.length ? Math.round(scored.reduce((a, x) => a + (x.s || 0), 0) / scored.length) : 0;
  const recalls = Object.values(S.progress).map(p => p.recall?.score).filter(x => typeof x === 'number');
  const recallAvg = recalls.length ? Math.round(recalls.reduce((a, b) => a + b, 0) / recalls.length) : null;

  const todayP = S.progress[S.day?.id || todayISO()] || {};
  const startedToday = !!todayP.listen?.answered || Object.keys(todayP.shadow || {}).length > 0;
  const headline = st.count > 0 ? `${st.count} day${st.count > 1 ? 's' : ''} in`
    : (startedToday ? 'Finish day one' : 'Day one starts now');

  root.innerHTML = `
  <div class="screen">
    <div class="stack gap-6">
      <div class="eyebrow">Progress</div>
      <h1 class="h1">${headline}</h1>
    </div>

    <div class="stack gap-10" style="margin-top:22px">
      <div class="row">
        <span class="eyebrow">Streak · last 14 days</span>
        <span style="font-size:11px;font-weight:600;color:var(--accent)">${st.count} day${st.count === 1 ? '' : 's'}</span>
      </div>
      <div class="streak">${st.days.map(d => `<i class="${d.done ? 'on' : ''}"></i>`).join('')}</div>
    </div>

    <div class="card stack gap-12" style="margin-top:20px">
      <div class="row">
        <span class="eyebrow">Shadowing quality</span>
        <span style="font-size:10px;font-weight:600;color:var(--green)">${all.length} sentence${all.length === 1 ? '' : 's'}</span>
      </div>
      <div class="row" style="gap:6px;align-items:flex-end">
        <span style="font-family:var(--serif);font-size:40px;font-weight:600;line-height:1">${avg || (all.length ? Math.round(clear / total * 100) + '%' : '—')}</span>
        <span class="sub" style="padding-bottom:6px">${avg ? 'average take' : (all.length ? 'rated clear' : 'no takes yet')}</span>
      </div>
      <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--line)">
        <div style="width:${clear / total * 100}%;background:var(--green)"></div>
        <div style="width:${close / total * 100}%;background:var(--amber)"></div>
        <div style="width:${retry / total * 100}%;background:#C4573A"></div>
      </div>
      <div class="sub">${clear} clear · ${close} close · ${retry} to retry</div>
    </div>

    <div class="stack gap-10" style="margin-top:20px">
      <div class="eyebrow">Needs work</div>
      ${S.needs.length ? `<div class="rows">${S.needs.slice(0, 4).map(n => `
        <div class="row-item">
          <div><div class="t">${n.text}${n.text.length >= 70 ? '…' : ''}</div><div class="d">${n.date}</div></div>
          <span class="badge">RETRY</span>
        </div>`).join('')}</div>`
      : `<div class="empty">Nothing flagged. Sentences you rate “retry” land here.</div>`}
    </div>

    <div class="stack gap-10" style="margin-top:20px">
      <div class="eyebrow">Issues</div>
      ${S.index.length ? `<div class="rows">${S.index.slice(0, 8).map(d => {
        const done = S.progress[d.id]?.done;
        const tag = SLOT_ZH[d.slot];
        return `<button class="row-item" style="width:100%" data-open="${d.id}">
          <div style="flex:1;text-align:left"><div class="t">${d.headline}</div>
          <div class="d">${d.date}${tag ? ` · ${tag}` : ''} · ${fmt(d.duration)} · ${d.sentences} sentences</div></div>
          <span class="badge ${done ? 'ok' : ''}">${done ? 'DONE' : 'OPEN'}</span>
        </button>`;
      }).join('')}</div>` : `<div class="empty">No issues yet.</div>`}
    </div>

    <div class="row-item" style="margin-top:22px" id="toWords">
      <div>
        <div class="eyebrow">单词本</div>
        <div class="t" style="margin-top:5px;font-weight:400;color:#4A4744">${Object.keys(S.words).length} 张卡 · ${dueCards().length} 张待复习</div>
      </div>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 1.5L8.5 6 4 10.5" stroke="#C4C0B8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    </div>

    ${recallAvg !== null ? `<div class="card flat stack gap-8" style="margin-top:20px">
      <div class="eyebrow">Summary feedback</div>
      <div class="row" style="align-items:baseline;justify-content:flex-start;gap:10px">
        <span class="score"><span class="n" style="font-size:30px">${recallAvg}</span><span class="u">/100</span></span>
        <span class="sub">${recalls.length} 次口语总结的平均分</span>
      </div>
    </div>` : ''}

    <div class="stack gap-8" style="margin-top:22px">
      <div class="eyebrow">How this is measured</div>
      <div class="sub">跟读分是本机把你的录音和原音做声学比对得出的，不上传。总结分看你覆盖了几个要点、有没有逻辑连接、有没有中式直译——先打分，再给具体改法。</div>
    </div>
  </div>`;

  document.getElementById('toWords').onclick = () => go('words');
  document.querySelectorAll('[data-open]').forEach(b =>
    b.onclick = () => switchIssue(b.dataset.open, 'today'));
}
/* -------- WORDS -------- */
let wordFilter = 'all';
function sWords(arg) {
  if (arg === 'review') return sReview();
  const all = Object.values(S.words);
  const due = dueCards();
  const sentenceCount = all.filter(w => w.kind === 'sentence').length;
  const shown = all.filter(w =>
    wordFilter === 'all' ? true
      : wordFilter === 'due' ? isDue(w)
        : wordFilter === 'sentence' ? w.kind === 'sentence'
          : w.kind !== 'sentence');
  const chip = (k, label, n) =>
    `<button class="tchip${wordFilter === k ? ' on' : ''}" data-filter="${k}">${label} ${n}</button>`;

  root.innerHTML = `
  <div class="screen">
    <div class="stack gap-6">
      <div class="eyebrow">Words & lines</div>
      <div class="row" style="align-items:flex-end">
        <h1 class="h1">单词本</h1>
        <span style="font-family:var(--serif);font-size:22px;font-weight:500;color:#C4C0B8">${all.length}</span>
      </div>
    </div>

    <div class="chips" style="margin-top:18px">
      ${chip('all', 'All', all.length)}
      ${chip('due', 'Due', due.length)}
      ${chip('word', 'Words', all.length - sentenceCount)}
      ${chip('sentence', 'Sentences', sentenceCount)}
    </div>

    ${due.length ? `<button class="btn" id="drill" style="margin-top:18px">
        Review ${due.length} due card${due.length > 1 ? 's' : ''} · 2 min
      </button>` : `<div class="card flat" style="margin-top:18px">
        <div class="sub">今天没有到期的卡。收藏后第二天开始出现，答「记得」会把间隔拉长到 3 / 7 / 16 / 35 天。</div>
      </div>`}

    <div class="rows" style="margin-top:14px">
      ${shown.length ? shown.map(w => {
        const long = w.kind === 'sentence';
        const label = w.word.length > 78 ? w.word.slice(0, 78) + '…' : w.word;
        return `<div class="row-item" data-card="${esc(w.word)}">
          <div style="flex:1;min-width:0">
            <div class="t" style="${long ? 'font-weight:400;line-height:1.5' : ''}">${esc(label)}</div>
            <div class="d">${esc(w.zh || (long ? '整句卡 · 自己回想意思' : '—'))}${w.src ? ' · ' + esc(w.src) : ''}</div>
          </div>
          ${isDue(w) ? '<span class="badge">DUE</span>' : ''}
          <button class="card-del" data-del="${esc(w.word)}" aria-label="Remove">×</button>
        </div>`;
      }).join('') : `<div class="empty" style="padding:18px 0">
        ${all.length ? '这个分类下还没有卡。' : `还没收过卡。<br><br>跟读页句子右上角的 +、语言点页每条词句旁边的 +，或者直接选中任意英文，都能收进来。`}
      </div>`}
    </div>

    <div class="stack gap-8" style="margin-top:22px">
      <div class="eyebrow">怎么复习</div>
      <div class="sub">到期卡会翻牌：先看英文回想，再看释义，然后选「记得 / 忘了」。忘了就回到明天再来，记得就逐步拉长间隔。首页和 WORDS 标签上的红点是到期提醒。</div>
    </div>
  </div>`;

  document.querySelectorAll('[data-filter]').forEach(b => {
    b.onclick = () => { wordFilter = b.dataset.filter; sWords(); };
  });
  document.querySelectorAll('[data-card]').forEach(el => {
    el.onclick = e => {
      if (e.target.closest('[data-del]')) return;
      const w = S.words[el.dataset.card];
      if (!w) return;
      speak(w.word);
      toast(w.zh || w.note || '回想一下这句话的意思');
    };
  });
  document.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = e => {
      e.stopPropagation();
      delCard(b.dataset.del);
      sWords();
      toast('已移除');
    };
  });
  document.getElementById('drill')?.addEventListener('click', () => go('words/review'));
}

/* Real active recall: see the line, retrieve the meaning, then grade yourself.
   The grade moves the card through 1 / 3 / 7 / 16 / 35-day intervals. */
function sReview() {
  const queue = dueCards().slice(0, 12);
  let i = 0, flipped = false, forgot = 0;

  function finish() {
    root.innerHTML = `
    <div class="screen">
      <div class="stack gap-6" style="margin-top:40px">
        <div class="eyebrow">Review done</div>
        <h1 class="h1">${i} 张卡过完了</h1>
      </div>
      <div class="card stack gap-10" style="margin-top:24px">
        <div class="sub">忘了 ${forgot} 张，明天会再出现；其余的按 3 / 7 / 16 / 35 天逐步拉开。</div>
        <div class="sub">间隔重复的关键不是多刷，是在快忘的时候再想一次。</div>
      </div>
      <div class="dock"><button class="btn" id="back">回到单词本</button></div>
    </div>`;
    document.getElementById('back').onclick = () => go('words');
  }

  function paint() {
    if (i >= queue.length) return finish();
    const w = queue[i];
    const long = w.kind === 'sentence';
    root.innerHTML = `
    <div class="screen">
      <div class="topbar">
        <button class="back" data-go="words">
          <svg viewBox="0 0 18 18"><path d="M11 3.5L5.5 9 11 14.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          Review
        </button>
        <div class="eyebrow">${i + 1} / ${queue.length}</div>
      </div>
      <div class="progress-line" style="margin-top:12px">
        ${queue.map((_, k) => `<i class="${k < i ? 'on' : ''}"></i>`).join('')}
      </div>

      <div class="card stack gap-14" style="margin-top:22px">
        <div class="eyebrow">${long ? 'SENTENCE' : 'WORD'}${w.src ? ' · ' + esc(w.src) : ''}</div>
        <div class="${long ? 'revfront long' : 'revfront'}">${esc(w.word)}</div>
        <div class="revback${flipped ? ' on' : ''}">
          <div style="font-size:13px;line-height:1.6">${esc(w.zh || '自己回想一下这句话在说什么')}</div>
          ${w.note ? `<div class="note" style="margin-top:8px">${esc(w.note)}</div>` : ''}
        </div>
        ${flipped
          ? `<div class="row" style="gap:10px;margin-top:4px">
              <button class="btn ghost" id="forgot" style="flex:1">忘了</button>
              <button class="btn" id="got" style="flex:1">记得</button>
            </div>`
          : `<button class="btn ghost" id="flip">Show meaning</button>`}
      </div>

      <button class="link" id="say">🔊 听发音</button>
      <div class="dock"><button class="btn ghost sm" id="quit">退出复习</button></div>
    </div>`;

    document.getElementById('say').onclick = () => speak(w.word);
    document.getElementById('quit').onclick = () => go('words');
    document.getElementById('flip')?.addEventListener('click', () => { flipped = true; paint(); });
    const grade = ok => {
      w.box = ok ? Math.min((w.box || 0) + 1, INTERVALS.length - 1) : 0;
      w.last = todayISO();
      if (!ok) forgot++;
      save('words', S.words);
      buzz(ok ? 8 : 14);
      i++; flipped = false;
      paint();
    };
    document.getElementById('forgot')?.addEventListener('click', () => grade(false));
    document.getElementById('got')?.addEventListener('click', () => grade(true));
  }
  paint();
}

/* ---------------------------------------------------------------- notes */
function sNotes() {
  const d = S.day;
  const terms = d.terms || [];
  const grammar = d.grammar || [];

  root.innerHTML = `
  <div class="screen solo">
    <div class="topbar">
      <button class="back" data-go="today">
        <svg viewBox="0 0 18 18"><path d="M11 3.5L5.5 9 11 14.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
        Notes
      </button>
      <div class="eyebrow">${d.sentences.length} 句 · ${fmt(d.duration)}</div>
    </div>

    <h1 class="h1" style="margin-top:16px">语言点</h1>
    <div class="sub" style="margin-top:8px">先盲听，再对照。第一遍就看中文，练不出耳朵。</div>

    <div class="stack gap-10" style="margin-top:26px">
      <div class="eyebrow">词汇 · ${terms.length}</div>
      <div class="card flat stack gap-14">
        ${terms.map(t => `<div class="lang-item">
          <div class="row" style="align-items:flex-start">
            <div class="k" style="flex:1">${t.word}<em>${t.zh || ''}</em></div>
            ${saveBtn(t.word, t.zh, 'word', t.note || t.gloss || '')}
          </div>
          <div class="n">${t.note || t.gloss || ''}</div>
        </div>`).join('') || '<div class="sub">今天没有词汇。</div>'}
      </div>
    </div>

    <div class="stack gap-10" style="margin-top:22px">
      <div class="eyebrow">语法 · ${grammar.length}</div>
      <div class="card flat stack gap-14">
        ${grammar.map(g => `<div class="lang-item">
          <div class="at">第 ${pad(g.line)} 句</div>
          <div class="k">${g.point}</div>
          <div class="n">${g.note}</div>
        </div>`).join('') || '<div class="sub">今天没有语法点。</div>'}
      </div>
    </div>

    <div class="stack gap-10" style="margin-top:22px">
      <div class="row">
        <div class="eyebrow">全文对照</div>
      </div>
      <div class="card flat stack gap-14">
        ${d.sentences.map(s => `<div class="pair">
          <div class="row" style="align-items:flex-start">
            <div class="e" style="flex:1">${s.text}</div>
            ${saveBtn(s.text, s.zh, 'sentence', `第 ${s.id} 句 · ${d.headline}`)}
          </div>
          <div class="c">${s.zh || ''}</div>
        </div>`).join('')}
      </div>
    </div>
  </div>`;
  bindSave();
}

/* Progress used to be keyed by date. Now that a day can hold two issues it is
   keyed by issue id, so any progress recorded before this change gets moved
   onto that day's morning issue once — otherwise today would look untouched. */
function migrateProgress() {
  let moved = 0;
  for (const d of S.index) {
    if (d.slot !== 'am') continue;
    const legacy = S.progress[d.date];
    if (legacy && !S.progress[d.id]) {
      S.progress[d.id] = legacy;
      delete S.progress[d.date];
      moved++;
    }
  }
  if (moved) save('progress', S.progress);
}

/* ---------------------------------------------------------------- boot */
const fetchIssue = id => fetch(`data/${id}.json`, { cache: 'no-store' })
  .then(r => { if (!r.ok) throw 0; return r.json(); });

/* Swap between the two issues of one day without leaving the app. The URL
   keeps ?d= pointed at whatever is on screen, so a reload or a shared link
   opens the issue being read rather than the newest one. */
async function switchIssue(id, then) {
  if (!id || id === S.day?.id) { if (then) go(then); return; }
  try {
    S.day = normalize(await fetchIssue(id));
  } catch {
    toast('That issue is not available');
    return;
  }
  document.title = S.day.headline;
  const url = new URL(location.href);
  url.searchParams.set('d', S.day.id);
  history.replaceState(null, '', url);
  dp(S.day.id);
  if (then) go(then); else route();
  prefetchAudio(S.day);
}

async function boot() {
  try {
    const idx = await fetch('data/index.json', { cache: 'no-store' }).then(r => r.json());
    S.index = (idx.days || []).map(normalize);
  } catch { S.index = []; }
  migrateProgress();

  const q = new URLSearchParams(location.search).get('d');
  const fallback = S.index[0]?.id || todayISO();
  let target = q || fallback;
  let loaded = null;
  try {
    loaded = await fetchIssue(target);
  } catch {
    // A card for an issue that was never published (or a stale link) should
    // still land somewhere readable rather than on a dead page.
    if (q && fallback !== q) {
      try { target = fallback; loaded = await fetchIssue(target); } catch { /* stay */ }
    }
  }
  if (!loaded) {
    root.innerHTML = `<div class="empty">No brief for ${target} yet.<br><br>Run <code>python3 pipeline/daily.py</code> and reload.</div>`;
    return;
  }

  S.day = normalize(loaded);
  document.title = S.day.headline;
  dp(S.day.id);
  bindBack();
  initSelectionSaver();
  route();
  prefetchAudio(S.day);
}

/* Warm the cache so the next session works offline. Skipped on cellular. */
function prefetchAudio(day) {
  const conn = navigator.connection || {};
  if (conn.type === 'cellular' || conn.saveData) return;
  const files = [day.audio, ...day.sentences.map(s => s.audio)];
  let i = 0;
  const step = () => {
    if (i >= files.length) return;
    // Consume the body. Abandoning a response mid-stream can leave a partial
    // row in the SW's media cache, which later yields a short Content-Range.
    fetch(files[i++]).then(r => r.arrayBuffer())
      .then(() => setTimeout(step, 260)).catch(() => {});
  };
  setTimeout(step, 1200);
}

function bindBack() {
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-go]');
    if (b) go(b.dataset.go);
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
boot();
