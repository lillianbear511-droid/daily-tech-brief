/* assess.js — on-device shadowing assessment.
 *
 * Compares the learner's recording against the reference reading of the same
 * sentence. Everything happens locally: no upload, no API key, no network.
 *
 * What it actually measures (and what it does not):
 *   - how closely the spectral shape of your speech tracks the reference,
 *     after time alignment  ->  "did it sound like the same sentence"
 *   - how much of the sentence you actually voiced, and whether the timing
 *     followed 1:1 or had to be stretched  ->  dropped or rushed words
 *   - high-frequency energy vs the reference  ->  swallowed word endings
 *   - level and clipping  ->  microphone problems, not pronunciation
 *
 * It does NOT do phoneme scoring. A native-sounding attempt with a different
 * timbre still scores below the reference itself; the score is a comparison,
 * not an absolute grade. Voice is stripped of its average colour (cepstral
 * mean normalisation) so a woman reading a man's line is not punished for it.
 */
(function (global) {
  'use strict';

  const SR = 16000;          // everything is resampled to this before analysis
  const FRAME = 400;         // 25 ms
  const HOP = 160;           // 10 ms
  const NFFT = 512;
  const NMEL = 26;
  const NCEP = 12;           // c1..c12, c0 is loudness and is kept separately
  const LOW_HZ = 80;
  const HIGH_HZ = 7000;      // speech band; above this it is mostly room noise
  const HF_HZ = 2000;        // "consonant clarity" band starts here

  /* ----------------------------------------------------------- fft */
  const cosT = new Float32Array(NFFT / 2);
  const sinT = new Float32Array(NFFT / 2);
  for (let i = 0; i < NFFT / 2; i++) {
    cosT[i] = Math.cos(-2 * Math.PI * i / NFFT);
    sinT[i] = Math.sin(-2 * Math.PI * i / NFFT);
  }
  const rev = new Uint16Array(NFFT);
  for (let i = 0; i < NFFT; i++) {
    let r = 0;
    for (let b = 0; b < 9; b++) r |= ((i >> b) & 1) << (8 - b);
    rev[i] = r;
  }

  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);

  function fftPower(x) {                       // x: Float32Array(NFFT) in place ok
    for (let i = 0; i < NFFT; i++) {
      const j = rev[i];
      re[i] = x[j];
      im[i] = 0;
    }
    for (let size = 2; size <= NFFT; size <<= 1) {
      const half = size >> 1, step = NFFT / size;
      for (let i = 0; i < NFFT; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = cosT[k], s = sinT[k];
          const ar = re[i + j + half], ai = im[i + j + half];
          const tr = ar * c - ai * s;
          const ti = ar * s + ai * c;
          re[i + j + half] = re[i + j] - tr;
          im[i + j + half] = im[i + j] - ti;
          re[i + j] += tr;
          im[i + j] += ti;
        }
      }
    }
    const out = new Float64Array(NFFT / 2 + 1);
    for (let i = 0; i <= NFFT / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
    return out;
  }

  /* --------------------------------------------------------- mel bank */
  const hz2mel = f => 2595 * Math.log10(1 + f / 700);
  const mel2hz = m => 700 * (Math.pow(10, m / 2595) - 1);

  const MELF = (() => {
    const bins = NFFT / 2 + 1;
    const hi = Math.min(HIGH_HZ, SR / 2 * 0.96);
    const lo = hz2mel(LOW_HZ), up = hz2mel(hi);
    const pts = [];
    for (let i = 0; i < NMEL + 2; i++) pts.push(mel2hz(lo + (up - lo) * i / (NMEL + 1)));
    const bank = [];
    for (let m = 1; m <= NMEL; m++) {
      const f = new Float64Array(bins);
      const l = pts[m - 1], c = pts[m], r = pts[m + 1];
      let any = false;
      for (let k = 0; k < bins; k++) {
        const hz = k * SR / NFFT;
        let w = 0;
        if (hz >= l && hz <= c) w = (hz - l) / (c - l);
        else if (hz > c && hz <= r) w = (r - hz) / (r - c);
        if (w > 0) { f[k] = w; any = true; }
      }
      if (!any) {                              // very low bands can fall between bins
        const k = Math.min(bins - 1, Math.round(c * NFFT / SR));
        f[k] = 1;
      }
      bank.push(f);
    }
    return bank;
  })();

  // Consonants, -s and -ed live above HF_HZ; measuring them as a share of the
  // whole spectrum is what catches swallowed word endings.
  const HF_BIN = Math.ceil(HF_HZ * NFFT / SR);

  const DCT = (() => {
    const t = [];
    for (let k = 1; k <= NCEP; k++) {
      const row = new Float64Array(NMEL);
      for (let m = 0; m < NMEL; m++) row[m] = Math.cos(Math.PI * k * (m + 0.5) / NMEL);
      t.push(row);
    }
    return t;
  })();

  /* ------------------------------------------------------- utterances */
  /** Float32Array @16 kHz -> { frames, cep[], loge[], hf[], rms[] } */
  function featurise(sig) {
    const n = sig.length;
    if (n < FRAME * 3) return null;
    const count = 1 + Math.floor((n - FRAME) / HOP);
    const win = new Float64Array(FRAME);
    for (let i = 0; i < FRAME; i++) win[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (FRAME - 1));

    const cep = [];
    const loge = new Float32Array(count);
    const hf = new Float32Array(count);
    const rms = new Float32Array(count);
    const buf = new Float32Array(NFFT);

    for (let f = 0; f < count; f++) {
      const off = f * HOP;
      let e = 0;
      for (let i = 0; i < FRAME; i++) {
        const v = sig[off + i];
        e += v * v;
      }
      rms[f] = Math.sqrt(e / FRAME);

      for (let i = 0; i < FRAME; i++) {
        const cur = sig[off + i];
        const prev = off + i > 0 ? sig[off + i - 1] : 0;
        buf[i] = (cur - 0.97 * prev) * win[i];
      }
      for (let i = FRAME; i < NFFT; i++) buf[i] = 0;

      const pw = fftPower(buf);
      const mel = new Float64Array(NMEL);
      let band = 0, high = 0, all = 0;
      for (let k = 1; k <= NFFT / 2; k++) {
        all += pw[k];
        if (k >= HF_BIN) high += pw[k];
      }
      for (let m = 0; m < NMEL; m++) {
        const filt = MELF[m];
        let s = 0;
        for (let k = 0; k < filt.length; k++) if (filt[k]) s += filt[k] * pw[k];
        mel[m] = Math.log(s + 1e-9);
        band += s;
      }
      loge[f] = 10 * Math.log10(band + 1e-12);
      hf[f] = all > 0 ? high / all : 0;

      const c = new Float32Array(NCEP);
      for (let k = 0; k < NCEP; k++) {
        const row = DCT[k];
        let s = 0;
        for (let m = 0; m < NMEL; m++) s += row[m] * mel[m];
        c[k] = s;
      }
      cep.push(c);
    }
    return { frames: count, cep, loge, hf, rms };
  }

  /** Energy gate. Returns frame indices [start, end) that carry speech. */
  function voicedRange(u) {
    const n = u.frames;
    const sorted = Float32Array.from(u.loge).sort();
    const floor = sorted[Math.floor(n * 0.10)];
    const peak = sorted[Math.floor(n * 0.95)];
    const thr = Math.max(floor + 9, peak - 42);
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) {
      if (u.loge[i] > thr && u.rms[i] > 0.0016) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) return null;
    return [Math.max(0, first - 4), Math.min(n, last + 5)];
  }

  function slice(u, a, b) {
    const cep = u.cep.slice(a, b);
    const loge = u.loge.slice(a, b);
    const hf = u.hf.slice(a, b);
    const rms = u.rms.slice(a, b);
    return { frames: b - a, cep, loge, hf, rms };
  }

  function cmn(u) {                            // remove average timbre
    const mean = new Float64Array(NCEP);
    for (const c of u.cep) for (let k = 0; k < NCEP; k++) mean[k] += c[k];
    for (let k = 0; k < NCEP; k++) mean[k] /= u.frames;
    for (const c of u.cep) for (let k = 0; k < NCEP; k++) c[k] -= mean[k];
    return u;
  }

  /* --------------------------------------------------------------- dtw */
  const INF = 1e18;
  const DIM = NCEP * 2;
  // How much weight the frame-to-frame change carries. Swept over 0..8 on a
  // corpus of the same sentence read by six voices vs. other sentences; 4
  // separated them best (d' = 5.2), and anything above 8 let the deltas
  // drown out the formants.
  const DELTA_SCALE = 4;

  /** CMN'd frames -> [static | delta] vectors. */
  function vectors(u) {
    const n = u.frames;
    const out = new Array(n);
    for (let t = 0; t < n; t++) {
      const a = u.cep[Math.max(0, t - 1)];
      const b = u.cep[Math.min(n - 1, t + 1)];
      const c = u.cep[t];
      const v = new Float32Array(DIM);
      for (let k = 0; k < NCEP; k++) {
        v[k] = c[k];
        v[NCEP + k] = (b[k] - a[k]) / 2 * DELTA_SCALE;
      }
      out[t] = v;
    }
    return out;
  }

  function cost(a, b) {
    let s = 0;
    for (let k = 0; k < DIM; k++) { const d = a[k] - b[k]; s += d * d; }
    return Math.sqrt(s / DIM);
  }

  /** Unconstrained DTW. Returns the mean frame cost and how much of the path
   *  was 1:1; a reading that skips words has to jump instead. */
  function dtw(A, B) {
    const n = A.length, m = B.length;
    const dir = new Uint8Array(n * m);
    let prev = new Float64Array(m), cur = new Float64Array(m);
    prev[0] = cost(A[0], B[0]);
    for (let j = 1; j < m; j++) prev[j] = prev[j - 1] + cost(A[0], B[j]);
    for (let i = 1; i < n; i++) {
      cur[0] = prev[0] + cost(A[i], B[0]);
      for (let j = 1; j < m; j++) {
        const c = cost(A[i], B[j]);
        let best = prev[j - 1], how = 0;
        if (prev[j] < best) { best = prev[j]; how = 1; }
        if (cur[j - 1] < best) { best = cur[j - 1]; how = 2; }
        cur[j] = best + c;
        dir[i * m + j] = how;
      }
      const t = prev; prev = cur; cur = t;
    }
    let i = n - 1, j = m - 1, total = 0, diag = 0, steps = 0;
    const walk = (x, y) => {
      total += cost(A[x], B[y]); steps++;
      const how = x > 0 && y > 0 ? dir[x * m + y] : (x > 0 ? 1 : 2);
      if (how === 0) { diag++; return [x - 1, y - 1]; }
      if (how === 1) return [x - 1, y];
      return [x, y - 1];
    };
    while (i > 0 && j > 0) {
      const [x, y] = walk(i, j); i = x; j = y;
    }
    while (i > 0) { const [x, y] = walk(i, j); i = x; j = y; }
    while (j > 0) { const [x, y] = walk(i, j); i = x; j = y; }
    walk(0, 0);
    return { mean: total / (n + m), diag: diag / Math.max(1, steps), steps };
  }

  /* ------------------------------------------------------------ scoring */
  // Calibrated on 3 sentences from the daily brief:
  //   same sentence, six different voices (incl. two Chinese-accented) 5.2-6.8
  //   a different sentence of similar length                           7.5-7.8
  // The midpoint sits above the worst honest attempt, so a real learner with
  // an accent still clears "close" while a different sentence fails.
  const D_MID = 7.15;
  const D_SLOPE = 1.05;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function pct(arr, p) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  }

  function median(arr) {
    if (!arr.length) return 0;
    const s = Array.from(arr).sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }

  /**
   * @param {Float32Array} refPcm  reference reading, 16 kHz mono
   * @param {Float32Array} userPcm learner recording, 16 kHz mono
   */
  function compare(refPcm, userPcm) {
    const rAll = featurise(refPcm);
    const uAll = featurise(userPcm);
    if (!rAll || !uAll) return { ok: false, reason: 'too-short' };

    const rSpan = voicedRange(rAll);
    if (!rSpan) return { ok: false, reason: 'no-reference' };

    // level of the raw take, before trimming
    let peak = 0, sum = 0;
    for (let i = 0; i < userPcm.length; i++) {
      const v = Math.abs(userPcm[i]);
      if (v > peak) peak = v;
      sum += v * v;
    }
    const db = 20 * Math.log10(Math.sqrt(sum / userPcm.length) + 1e-9);
    const clip = peak > 0.985;

    const uSpan = voicedRange(uAll);
    if (!uSpan) return { ok: false, reason: 'silent', db, clip };

    const voicedSec = f => f * HOP / SR;
    if (voicedSec(uSpan[1] - uSpan[0]) < 0.45) return { ok: false, reason: 'silent', db, clip };

    // how far the speech sits above the recording's own noise floor
    const snr = pct(uAll.loge, 0.95) - pct(uAll.loge, 0.12);

    const ref = cmn(slice(rAll, rSpan[0], rSpan[1]));
    const user = cmn(slice(uAll, uSpan[0], uSpan[1]));

    const durRatio = voicedSec(user.frames) / Math.max(0.2, voicedSec(ref.frames));
    const al = dtw(vectors(user), vectors(ref));

    const match = 100 / (1 + Math.exp((al.mean - D_MID) / D_SLOPE));

    // Did they say the whole thing? Two independent readings of the same fact:
    // how long they spoke relative to the original, and how much of the
    // alignment had to be stretched to make the ends meet.
    const covered = clamp((durRatio - 0.60) / 0.32, 0, 1) * 100;
    const steadiness = clamp((al.diag - 0.40) / 0.40, 0, 1) * 100;
    const completeness = covered * 0.62 + steadiness * 0.38;

    // pace: ±12 % is free, then it starts to count
    const pace = clamp(100 - (Math.abs(durRatio - 1) - 0.12) * 260, 0, 100);

    // clarity: endings and fricatives live above 2 kHz
    const hfRef = median(Array.from(ref.hf).filter(v => v > 0));
    const hfUser = median(Array.from(user.hf).filter(v => v > 0));
    const hfRatio = hfRef > 1e-4 ? hfUser / hfRef : 1;
    const clarity = clamp(100 - Math.abs(Math.log(hfRatio)) * 62, 0, 100);

    const level = clip ? 55
      : db < -42 ? clamp(100 * (db + 60) / 18, 0, 70)
      : db > -8 ? 72
      : 100;

    // Similarity is the base, not one voice among equals: saying a different
    // sentence of the right length should not collect full marks for "length
    // matched" and "pace matched". The other parts nudge, they do not carry.
    let score = match * (0.72 + 0.28 * (completeness / 100));
    score += (clarity - 70) * 0.10 + (pace - 70) * 0.06 + (level - 70) * 0.06;
    // dropping most of the sentence is a different failure from getting the
    // sounds slightly wrong, and must not average away
    score *= clamp(durRatio / 0.90, 0.30, 1);
    const noisy = snr < 17;
    if (noisy) score = Math.min(score, 82);
    score = Math.round(clamp(score, 0, 100));

    const band = score >= 78 ? 'g' : score >= 58 ? 'a' : 'r';

    const notes = [];
    if (clip) notes.push({ k: 'mic', t: 'The take is clipping. Hold the phone a little further away.' });
    else if (db < -42) notes.push({ k: 'mic', t: 'Very quiet — move closer to the mic, or the comparison is guesswork.' });
    else if (noisy) notes.push({ k: 'noise', t: 'A lot of background noise. Try again somewhere quieter for a reliable score.' });

    // Below this the take is not a rough version of this line at all, and
    // every other measurement becomes noise. Say so instead of diagnosing
    // "swallowed endings" on a sentence the learner never read.
    const otherLine = match < 45;
    if (otherLine) {
      notes.push({ k: 'wrong', t: 'That does not sound like the line on screen. Read this sentence from its first word.' });
    } else {
      if (durRatio < 0.78) notes.push({ k: 'short', t: `About ${Math.round((1 - durRatio) * 100)}% shorter than the original — part of the sentence is missing.` });
      else if (durRatio > 1.42) notes.push({ k: 'long', t: 'Much slower than the original. Keep the phrase in one breath, then slow down only the hard word.' });

      if (hfRatio < 0.62) notes.push({ k: 'tail', t: 'Word endings are getting swallowed (-s, -t, -ed). Finish each word before moving on.' });
      else if (hfRatio > 1.75) notes.push({ k: 'hiss', t: 'Lots of high-frequency energy — hissing s sounds, or the mic is too close.' });

      if (al.diag < 0.52 && durRatio >= 0.78 && durRatio <= 1.42) {
        notes.push({ k: 'jump', t: 'Your pauses do not land where the original ones do — the rhythm drifts mid-sentence.' });
      }
    }

    if (!notes.length) {
      notes.push(match >= 70
        ? { k: 'ok', t: 'Tracks the original closely in timing and shape.' }
        : { k: 'shape', t: 'Timing and length match. What differs is the individual sounds themselves.' });
    }

    return {
      ok: true, score, band,
      parts: {
        match: Math.round(match), completeness: Math.round(completeness),
        pace: Math.round(pace), clarity: Math.round(clarity), level: Math.round(level),
      },
      facts: {
        seconds: +voicedSec(user.frames).toFixed(1),
        refSeconds: +voicedSec(ref.frames).toFixed(1),
        durRatio: +durRatio.toFixed(2),
        distance: +al.mean.toFixed(2),
        diag: +al.diag.toFixed(2),
        snr: Math.round(snr),
        db: Math.round(db),
      },
      notes: notes.slice(0, 2),
    };
  }

  const api = { compare, featurise, voicedRange, slice, _cfg: { SR, NCEP, D_MID, D_SLOPE } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DTBAssess = api;
})(typeof window !== 'undefined' ? window : globalThis);
