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
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1800);
}
function buzz(ms = 8) { if (navigator.vibrate) navigator.vibrate(ms); }

/* ---------------------------------------------------------------- state */
const S = {
  day: null,
  index: [],
  progress: load('progress', {}),
  words: load('words', {}),
  needs: load('needs', []),
};
const dp = date => {
  const p = (S.progress[date] ||= {});
  p.listen ||= {}; p.shadow ||= {}; p.recall ||= {}; p.done ??= false;
  return p;
};

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
audio.addEventListener('ended', () => {
  document.querySelectorAll('.play').forEach(b => b.dataset.playing = '');
  if (typeof audio.onDone === 'function') { const f = audio.onDone; audio.onDone = null; f(); }
});
audio.addEventListener('pause', () => {
  document.querySelectorAll('.play').forEach(b => b.dataset.playing = '');
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
function addWords(day) {
  (day.terms || []).forEach(t => {
    if (!S.words[t.word]) {
      S.words[t.word] = { ...t, added: day.date, last: day.date, box: 0 };
    }
  });
  save('words', S.words);
}
const INTERVALS = [1, 3, 7, 16, 35];
function isDue(w) {
  const gap = dayDiff(w.last || w.added, todayISO());
  return gap >= (INTERVALS[w.box] ?? 1);
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
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    days.push({ date: key, done: !!S.progress[key]?.done });
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
  const practice = ['listen', 'shadow', 'recall'].includes(name);
  tabsEl.hidden = practice;
  tabsEl.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('on', t.dataset.tab === name));
}
tabsEl.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => go(t.dataset.tab)));

/* ---------------------------------------------------------------- screens */
function render(name, arg) {
  audio.onDone = null;
  waveHost = null; waveBars = []; timeHost = null;
  setTab(name);
  const map = { today: sToday, listen: sListen, shadow: sShadow, recall: sRecall, progress: sProgress, words: sWords };
  (map[name] || sToday)(arg);
}

function dateLabel(iso) {
  const d = new Date(iso + 'T08:00:00');
  const wd = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()];
  const mo = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getMonth()];
  return `${wd} · ${mo} ${d.getDate()}`;
}

/* -------- TODAY -------- */
function sToday() {
  const d = S.day, p = dp(d.date);
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

  root.innerHTML = `
  <div class="screen">
    <div class="hd">
      <div class="stack gap-6">
        <div class="eyebrow">${dateLabel(d.date)}</div>
        <h1 class="h1">Today's brief</h1>
      </div>
      <div class="chip"><i class="dot"></i>${st.count > 0 ? `${st.count} DAY${st.count > 1 ? 'S' : ''}` : 'DAY 1'}</div>
    </div>

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

  document.getElementById('start').onclick = () => {
    if (!p.listen?.answered) go('listen');
    else if (rated < d.sentences.length) go('shadow/' + (rated + 1));
    else if (!p.recall?.done) go('recall');
    else go('progress');
  };
}

/* -------- LISTEN -------- */
function sListen() {
  const d = S.day, p = dp(d.date);
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
      dp(d.date).listen.plays = (p.listen.plays || 0) + 1;
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
    dp(d.date).listen = { ...p.listen, answered: true, picks, correct, plays: p.listen.plays || 0 };
    save('progress', S.progress);
    buzz(12);
    renderReview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (answered) renderReview(); else renderOne();
}

/* -------- SHADOW -------- */
function sShadow(arg) {
  const d = S.day, p = dp(d.date);
  const idx = Math.min(Math.max(1, +arg || 1), d.sentences.length);
  const s = d.sentences[idx - 1];
  const rating = p.shadow?.[s.id];

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
      <div class="eyebrow">Sentence ${pad(s.id)} · ${fmt(s.duration)}</div>
      <div class="sentence">${s.text}</div>
      ${s.focus ? `<div class="focus"><i class="d"></i><span>${s.focus}</span></div>` : ''}
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
      if (rec) showOwn(rec.url);
    }
  };

  function showOwn(url) {
    document.getElementById('own').innerHTML = `
      <div class="card flat stack gap-10" style="margin-top:14px">
        <div class="eyebrow">Your take</div>
        <div class="sub" id="ownTip" style="font-size:11px;display:none"></div>
        <div class="row" style="justify-content:flex-start;gap:10px">
          <button class="btn ghost sm" id="ownPlay" style="width:auto;padding:0 16px;height:42px">Play back</button>
          <button class="btn ghost sm" id="ownRec" style="width:auto;padding:0 16px;height:42px">Record again</button>
        </div>
      </div>`;
    const url2 = url;
    document.getElementById('ownPlay').onclick = () => {
      const a = new Audio(url2);
      a.play().catch(() => toast('Tap to play'));
    };
    document.getElementById('ownRec').onclick = () => recBtn.click();
    showRate();
  }

  function showRate() {
    document.getElementById('rateArea').innerHTML = `
      <div class="stack gap-8" style="margin-top:14px">
        <div class="eyebrow">How close was it?</div>
        <div class="rate-row">
          <button class="rate g ${rating === 'g' ? 'sel' : ''}" data-r="g"><i class="c"></i>Clear</button>
          <button class="rate a ${rating === 'a' ? 'sel' : ''}" data-r="a"><i class="c"></i>Close</button>
          <button class="rate r ${rating === 'r' ? 'sel' : ''}" data-r="r"><i class="c"></i>Retry</button>
        </div>
      </div>`;
    document.querySelectorAll('.rate').forEach(b => {
      b.onclick = () => {
        const r = b.dataset.r;
        dp(d.date).shadow[s.id] = r;
        save('progress', S.progress);
        if (r === 'r') {
          if (!S.needs.some(n => n.date === d.date && n.sid === s.id)) {
            S.needs.unshift({ date: d.date, sid: s.id, text: s.text.slice(0, 70), focus: s.focus || '' });
            S.needs = S.needs.slice(0, 40);
            save('needs', S.needs);
          }
        } else {
          S.needs = S.needs.filter(n => !(n.date === d.date && n.sid === s.id));
          save('needs', S.needs);
        }
        document.querySelectorAll('.rate').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
        buzz();
      };
    });
  }

  if (rating) {
    showOwn(null);
    document.getElementById('ownPlay').style.display = 'none';
    document.getElementById('ownRec').textContent = 'Record again';
    document.querySelector('.card.flat .eyebrow').textContent = 'Rated: ' + ({ g: 'clear', a: 'close', r: 'retry' })[rating];
    const tip = document.getElementById('ownTip');
    if (tip) {
      const nudge = {
        g: 'Locked in. Say the next one.',
        a: 'One more pass at 0.75x, then move on.',
        r: 'Drop to 0.75x and copy the rhythm before the words.',
      }[rating];
      tip.style.display = 'block';
      tip.textContent = nudge;
    }
    showRate();
  }

  document.getElementById('prev').onclick = () => go('shadow/' + (idx - 1));
  document.getElementById('next').onclick = () => {
    if (idx === d.sentences.length) {
      addWords(d);
      dp(d.date).done = true;
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
  const d = S.day, p = dp(d.date);
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
    <div class="dock">
      <button class="btn" id="finish" disabled>Record first, then save</button>
    </div>
  </div>`;

  const liveBars = [...document.getElementById('live').children];
  const timerEl = document.getElementById('timer');
  const recBtn = document.getElementById('rec');
  const hintEl = document.getElementById('hint');
  let recording = false, t0 = 0, autoStop = 0;

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
      hintEl.textContent = 'Out loud beats perfect';
      if (rec) {
        hintEl.textContent = 'Done · ' + Math.round(secs) + 's';
        document.getElementById('own').innerHTML = `
          <div class="card flat stack gap-8" style="margin-top:14px">
            <div class="eyebrow">Your recording</div>
            <button class="btn ghost sm" id="ownPlay" style="margin-top:2px">Play back</button>
          </div>`;
        const u = rec.url;
        document.getElementById('ownPlay').onclick = () => new Audio(u).play();
        dp(d.date).recall = { done: true, secs: Math.round(secs) };
        dp(d.date).done = true;
        save('progress', S.progress);
        addWords(d);
        const fin = document.getElementById('finish');
        fin.disabled = false;
        fin.textContent = 'Save & finish';
      }
    }
  };

  document.getElementById('finish').onclick = () => {
    dp(d.date).done = true;
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

  const todayP = S.progress[S.day?.date || todayISO()] || {};
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
        <span style="font-size:10px;font-weight:600;color:var(--green)">${all.length} sentences</span>
      </div>
      <div class="row" style="gap:6px;align-items:flex-end">
        <span style="font-family:var(--serif);font-size:40px;font-weight:600;line-height:1">${all.length ? Math.round(clear / total * 100) + '%' : '—'}</span>
        <span class="sub" style="padding-bottom:6px">${all.length ? 'rated clear' : 'no ratings yet'}</span>
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
      <div class="eyebrow">Days practiced</div>
      ${S.index.length ? `<div class="rows">${S.index.slice(0, 6).map(d => {
        const done = S.progress[d.date]?.done;
        return `<div class="row-item">
          <div><div class="t">${d.headline}</div><div class="d">${d.date} · ${fmt(d.duration)} · ${d.sentences} sentences</div></div>
          <span class="badge ${done ? 'ok' : ''}">${done ? 'DONE' : 'OPEN'}</span>
        </div>`;
      }).join('')}</div>` : `<div class="empty">No days yet.</div>`}
    </div>

    <div class="row-item" style="margin-top:22px" id="toWords">
      <div>
        <div class="eyebrow">Saved words</div>
        <div class="t" style="margin-top:5px;font-weight:400;color:#4A4744">${Object.keys(S.words).length} saved · ${Object.values(S.words).filter(isDue).length} due today</div>
      </div>
      <svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 1.5L8.5 6 4 10.5" stroke="#C4C0B8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
    </div>

    <div class="stack gap-8" style="margin-top:22px">
      <div class="eyebrow">How this is measured</div>
      <div class="sub">You rate each sentence by ear — clear, close, or retry. There is no score to chase; the bar above only shows which sounds keep coming back.</div>
    </div>
  </div>`;

  document.getElementById('toWords').onclick = () => go('words');
}
/* -------- WORDS -------- */
function sWords() {
  const list = Object.values(S.words);
  const due = list.filter(isDue);
  root.innerHTML = `
  <div class="screen">
    <div class="stack gap-6">
      <div class="eyebrow">Words</div>
      <div class="row" style="align-items:flex-end">
        <h1 class="h1">Saved words</h1>
        <span style="font-family:var(--serif);font-size:22px;font-weight:500;color:#C4C0B8">${list.length}</span>
      </div>
    </div>

    <div class="chips" style="margin-top:18px">
      <span class="tchip" style="background:var(--ink);color:var(--paper);border-color:var(--ink)">All ${list.length}</span>
      <span class="tchip">Due ${due.length}</span>
    </div>

    <div class="rows" style="margin-top:14px">
      ${list.length ? list.map(w => {
        const d = isDue(w);
        return `<button class="row-item" data-w="${w.word}">
          <div style="flex:1">
            <div class="t">${w.word}</div>
            <div class="d">${w.phonetic || ''} · ${w.pos || ''}</div>
          </div>
          ${d ? '<span class="badge">DUE</span>' : '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 1.5L8.5 6 4 10.5" stroke="#C4C0B8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'}
        </button>`;
      }).join('') : `<div class="empty" style="padding:14px 0 6px">Not saved yet — these are today's key terms.</div>
        ${(S.day.terms || []).map(t => `<button class="row-item" data-preview="${t.word}" style="width:100%">
          <div style="flex:1"><div class="t">${t.word}</div><div class="d">${t.phonetic || ''} · ${t.pos || ''}</div></div>
          <span class="badge">TODAY</span>
        </button>`).join('')}
        <div class="empty" style="padding-top:12px">Finish today's practice to add them to your list.</div>`}
    </div>

    ${due.length ? `<button class="btn" id="drill" style="margin-top:18px">Review ${due.length} due word${due.length > 1 ? 's' : ''} · 2 min</button>` : ''}
  </div>`;

  document.querySelectorAll('.row-item[data-w]').forEach(b => {
    b.onclick = () => {
      const w = S.words[b.dataset.w];
      if (!w) return;
      speak(w.word);
      const gap = dayDiff(w.last || w.added, todayISO());
      if (gap >= 1) { w.last = todayISO(); w.box = Math.min((w.box || 0) + 1, INTERVALS.length - 1); save('words', S.words); }
      toast(`${w.word} — ${w.gloss}`);
    };
  });
  document.querySelectorAll('[data-preview]').forEach(b => {
    b.onclick = () => speak(b.dataset.preview);
  });
  document.getElementById('drill')?.addEventListener('click', () => {
    due.slice(0, 8).forEach((w, i) => setTimeout(() => speak(w.word), i * 1800));
    toast('Listen and repeat — ' + due.length + ' words');
  });
}

/* ---------------------------------------------------------------- boot */
async function boot() {
  try {
    const idx = await fetch('data/index.json', { cache: 'no-store' }).then(r => r.json());
    S.index = idx.days || [];
  } catch { S.index = []; }

  const q = new URLSearchParams(location.search).get('d');
  const target = q || S.index[0]?.date || todayISO();
  try {
    S.day = await fetch(`data/${target}.json`).then(r => { if (!r.ok) throw 0; return r.json(); });
  } catch {
    root.innerHTML = `<div class="empty">No brief for ${target} yet.<br><br>Run <code>python3 pipeline/generate.py --date ${target}</code> and reload.</div>`;
    return;
  }
  document.title = S.day.headline;
  dp(S.day.date);
  bindBack();
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
    fetch(files[i++]).then(() => setTimeout(step, 260)).catch(() => {});
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
