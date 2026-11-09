/* coach.js — feedback for the free-speaking recall step.
 *
 * The recording is only audio. To say anything useful about *how* the summary
 * was put together we need words, so the learner types (or dictates) what they
 * just said. Everything below runs on the device and works offline: it extracts
 * the key points from the issue itself, checks which ones the learner covered,
 * looks for structural signals and flags unidiomatic phrasing.
 *
 * An optional DeepSeek key unlocks a real line-by-line rewrite. The key lives
 * in this browser's localStorage only and is sent to no one but DeepSeek.
 */
(function (global) {
  'use strict';

  const STOP = new Set(('the a an and or but of to in on at for with from by as is are was were be been '
    + 'being it its this that these those they them their he she his her we our you your i me my '
    + 'has have had do does did not no so if then than there here about into over after before '
    + 'also just more most some any all can could will would should may might must one two ')
    .split(' ').filter(Boolean));

  const CONNECTORS = /\b(but|however|although|though|while|whereas|because|since|so|therefore|as a result|which means|which suggests|instead|rather than|even though|the point is|the upshot|ultimately|that said|in other words)\b/gi;

  /* Common Chinese-learner filler and the more natural alternative. Each hit
     becomes one concrete "say X instead" line in the feedback. */
  const UPGRADES = [
    [/\bvery important\b/i, 'key / central', 'very important → key, central'],
    [/\bvery big\b/i, 'major / sweeping', 'very big → major, sweeping'],
    [/\ba lot of\b/i, 'a wave of / a string of', 'a lot of → a wave of, a string of'],
    [/\bmore and more\b/i, 'increasingly / a growing number of', 'more and more → increasingly'],
    [/\bnowadays\b/i, 'these days / today', 'nowadays → these days'],
    [/\bin my opinion\b/i, '', '总结里别说 in my opinion，直接给判断'],
    [/\bi think\b/i, '', '删掉 I think，句子本身就是在表达你的判断'],
    [/\bthe article (says|tells|talks about|is about)\b/i, 'the report says / according to the piece', 'the article says → the report says / according to the piece'],
    [/\bthis (article|passage|news) (is about|talks about|tells)\b/i, '', '别复述「这篇文章讲了…」，直接讲事情'],
    [/\bit tells us that\b/i, 'what this shows is', 'it tells us that → what this shows is'],
    [/\bwith the development of\b/i, 'as … grows', 'with the development of → as X grows'],
    [/\bplay(s|ed)? an important role\b/i, 'matters / is central to', 'play an important role → matters, is central to'],
    [/\bpay attention to\b/i, 'focus on', 'pay attention to → focus on'],
    [/\bdiscuss about\b/i, 'discuss', 'discuss 后面不加 about'],
    [/\bin a word\b/i, 'ultimately / the upshot is', 'in a word → ultimately, the upshot is'],
    [/\bbecause\b[\s\S]{0,60}\bso\b/i, '', 'because 和 so 不能同时用，留一个'],
    [/\bcan not\b/i, "can't / cannot", "can not → can't"],
    [/\bmake(s|)? a (decision|change) to\b/i, 'decided to / moved to', 'make a decision to → decided to'],
  ];

  const words = t => (t.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [])
    .filter(w => !STOP.has(w) && w.length > 2);

  /* Which sentences actually carry the story: the opening, anything with a
     turn or a cause, and the closing line. Those become the "key points". */
  function keypoints(day) {
    const ss = day.sentences || [];
    if (!ss.length) return [];
    // A closing quote ("one former scout said she was sad") is colour, not the
    // takeaway. Step back one line when the last sentence ends on someone's
    // feelings or a quote, otherwise the model summary teaches the wrong thing.
    let last = ss.length - 1;
    if (/\b(said|told|says|hoped|sad|according to)\b/i.test(ss[last].text) && last > 1) last -= 1;
    const idx = new Set([0, last]);
    ss.forEach((s, i) => {
      if (/\b(but|however|because|since|so|shows|means|suggests|instead|while|although|as a result|has reached|plans to)\b/i.test(s.text)) idx.add(i);
      if (/\b\d[\d,.]*\s*(billion|million|percent|%|years?|gigawatts?|dollars?)\b/i.test(s.text)) idx.add(i);
    });
    return [...idx].sort((a, b) => a - b).slice(0, 5).map(i => {
      const s = ss[i];
      const w = [...new Set(words(s.text))];
      return { i, text: s.text, words: w, label: shortLabel(s.text) };
    });
  }

  function shortLabel(text) {
    const w = text.replace(/[.,;:].*$/, '').split(/\s+/).slice(0, 9).join(' ');
    return w + (text.length > w.length + 2 ? '…' : '');
  }

  function model(day, points) {
    if (!points.length) return [];
    const pick = i => points[i]?.text || '';
    const tags = ['Topic', 'Why / turn', 'So what'];
    const chosen = points.length >= 3
      ? [pick(0), pick(Math.floor((points.length - 1) / 2)), pick(points.length - 1)]
      : points.map(p => p.text);
    return chosen.map((text, i) => ({ tag: tags[i] || 'Detail', text }));
  }

  function evaluate(text, day) {
    const raw = (text || '').trim();
    if (words(raw).length < 4) return { ok: false, reason: 'too-short' };

    const pts = keypoints(day);
    const said = new Set(words(raw));
    const hits = [], miss = [];
    pts.forEach(p => {
      const overlap = p.words.filter(w => said.has(w)).length;
      (overlap >= 2 || (p.words.length && overlap / p.words.length >= 0.34) ? hits : miss).push(p);
    });

    const sentences = raw.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
    const wordCount = words(raw).length;
    const connectors = [...new Set((raw.match(CONNECTORS) || []).map(s => s.toLowerCase()))];
    const tips = [];

    /* coverage */
    const coverage = pts.length ? Math.round(hits.length / pts.length * 100) : 60;
    if (miss.length) {
      tips.push({ kind: 'miss', title: '漏掉的点', body: miss.slice(0, 2).map(p => `「${p.label}」`).join('、') + ' 没提到，补一句就完整了。' });
    }

    /* structure */
    let structure = 45;
    if (sentences.length >= 2 && sentences.length <= 5) structure += 22;
    if (connectors.length >= 1) structure += 18;
    if (connectors.length >= 2) structure += 8;
    if (wordCount >= 25 && wordCount <= 85) structure += 12;
    structure = Math.min(100, structure);
    if (sentences.length < 2) tips.push({ kind: 'struct', title: '别只说一句', body: '三句最好：发生了什么 → 为什么 → 意味着什么。' });
    else if (sentences.length > 5) tips.push({ kind: 'struct', title: '收一收', body: '超过五句就不是总结了，留三句主干。' });
    if (!connectors.length) tips.push({ kind: 'struct', title: '加一个逻辑词', body: '用 but / which means / as a result 把因果或转折说出来，比三句并列地道得多。' });
    if (wordCount < 25) tips.push({ kind: 'struct', title: '太短', body: '25 词以下通常只是把标题换了个说法，补上原因和结果。' });
    if (wordCount > 85) tips.push({ kind: 'struct', title: '太长', body: '85 词以上多半在逐句复述，试着只留三个信息点。' });
    if (hits.length === 1 && pts.length >= 3) tips.push({ kind: 'struct', title: '只在复述开头', body: '你基本只覆盖了第一句，把结尾的结论也说出来。' });

    /* expression */
    let expression = 82;
    const upgrades = [];
    UPGRADES.forEach(([re, alt, note]) => {
      const m = raw.match(re);
      if (m) { expression -= 9; upgrades.push({ from: m[0], to: alt, note }); }
    });
    expression = Math.max(20, Math.min(100, expression));
    if (upgrades.length) tips.push({ kind: 'phrase', title: '更地道的说法', body: upgrades.slice(0, 3).map(u => u.note).join('；') });
    if (!upgrades.length) tips.push({ kind: 'phrase', title: '表达没踩坑', body: '没发现明显的中式直译。下一步练「一句给结论」，例如 What this shows is…' });

    const score = Math.round(Math.min(100, coverage * 0.45 + structure * 0.30 + expression * 0.25));
    const band = score >= 78 ? 'Solid' : (score >= 55 ? 'Getting there' : 'Rework');
    return {
      ok: true, score, band,
      parts: { coverage, structure, expression },
      hits, miss, connectors, wordCount, sentenceCount: sentences.length,
      upgrades, tips, model: model(day, pts),
    };
  }

  /* ---------------- optional: a real rewrite, powered by the user's own key */
  const KEY_STORE = 'dtb.llmkey';
  const getKey = () => { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } };
  const setKey = k => localStorage.setItem(KEY_STORE, (k || '').trim());

  async function polish(text, day, key) {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (key || getKey()) },
      body: JSON.stringify({
        model: 'deepseek-chat', temperature: 0.35, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a concise English writing coach for a Chinese learner summarising a news story aloud. Be specific, never generic. Explanations may be in Chinese. Reply with JSON only: {"rewritten": string, "changes": string[3], "missed": string, "phrase": string}. "rewritten" is a 2-3 sentence native-sounding version of THEIR summary, keeping their facts. Never open with "This article is about" / "The passage tells" / "I think" — start directly with the news, and use at least one natural connector (but / which means / as a result). "changes" are short before → after items quoting their exact wording. "missed" is one important fact from the article they left out. "phrase" is one natural expression worth reusing.' },
          { role: 'user', content: 'ARTICLE SCRIPT:\n' + (day.script || '') + '\n\nLEARNER SUMMARY:\n' + text },
        ],
      }),
    });
    if (!r.ok) throw new Error('API ' + r.status);
    const j = await r.json();
    const body = j.choices?.[0]?.message?.content || '{}';
    return JSON.parse(body.replace(/^```json\s*|\s*```$/g, ''));
  }

  /* Browser dictation. Chrome routes this through a Google service that is
     usually unreachable in mainland China; treat it strictly as a convenience. */
  function dictationSupported() {
    return !!(global.SpeechRecognition || global.webkitSpeechRecognition);
  }
  function dictate(onText, onEnd) {
    const C = global.SpeechRecognition || global.webkitSpeechRecognition;
    if (!C) return null;
    const rec = new C();
    rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
    let final = '';
    rec.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += (final ? ' ' : '') + t.trim();
        else interim += t;
      }
      onText((final + ' ' + interim).trim());
    };
    rec.onerror = () => onEnd && onEnd(false);
    rec.onend = () => onEnd && onEnd(true);
    try { rec.start(); } catch { return null; }
    return rec;
  }

  const api = { evaluate, polish, getKey, setKey, dictationSupported, dictate, keypoints };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.DTBCoach = api;
})(typeof window !== 'undefined' ? window : globalThis);
