// Overlay injected into the captured tab. Renders the detected chord, the
// estimated key, recent chord history and the user's play-along settings.

(() => {
  if (window.__chordItLoaded) return;
  window.__chordItLoaded = true;

  const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const COMMON = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const FLAT_MAJOR_TONICS = [5, 10, 3, 8, 1, 6];
  const FLAT_MINOR_TONICS = [2, 7, 0, 5, 10, 3];
  const HISTORY_LEN = 8;

  const settings = { capo: 0, delayMs: 0, showChroma: true, pos: null };
  let last = null;
  let history = [];

  function spelling(key) {
    if (!key) return COMMON;
    const flats = key.mode === 'major' ? FLAT_MAJOR_TONICS : FLAT_MINOR_TONICS;
    return flats.includes(key.tonic) ? FLATS : SHARPS;
  }

  function chordName(chord, names, shift = 0) {
    const t = (pc) => names[(pc - shift + 12) % 12];
    return t(chord.root) + chord.quality + (chord.bass != null ? '/' + t(chord.bass) : '');
  }

  // ---- DOM ----------------------------------------------------------------

  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 16px; right: 16px;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .panel {
        font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #f5f5f5; background: rgba(17, 17, 20, 0.88);
        border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); width: 240px;
        backdrop-filter: blur(6px); user-select: none; overflow: hidden;
      }
      .bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 12px;
        cursor: move; background: rgba(255, 255, 255, 0.05); }
      .title { font-weight: 600; letter-spacing: .02em; }
      .key { margin-left: auto; color: #a3a3a3; font-size: 12px; }
      button { all: unset; cursor: pointer; color: #d4d4d4; padding: 2px 7px; border-radius: 6px;
        font-size: 13px; line-height: 18px; }
      button:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
      .chord { font-size: 56px; font-weight: 700; text-align: center; padding: 8px 8px 0;
        letter-spacing: -.02em; transition: opacity .15s; min-height: 68px; }
      .sub { text-align: center; color: #a3a3a3; font-size: 12px; min-height: 16px; }
      .history { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap;
        padding: 8px 10px; color: #8a8a8a; font-size: 13px; min-height: 18px; }
      .history span:first-child { color: #d4d4d4; }
      .chroma { display: grid; grid-template-columns: repeat(12, 1fr); gap: 2px; padding: 0 10px 4px;
        height: 34px; align-items: end; }
      .chroma div { background: #4f8cff; border-radius: 2px 2px 0 0; min-height: 1px; }
      .chroma div.on { background: #fbbf24; }
      .labels { display: grid; grid-template-columns: repeat(12, 1fr); gap: 2px; padding: 0 10px 6px;
        font-size: 9px; color: #737373; text-align: center; }
      .controls { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.08); color: #d4d4d4; font-size: 12px; }
      .row { display: flex; align-items: center; gap: 6px; }
      .row label { width: 44px; color: #a3a3a3; }
      .row output { min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
      input[type=range] { flex: 1; accent-color: #4f8cff; }
      .hidden { display: none; }
    </style>
    <div class="panel">
      <div class="bar">
        <span class="title">ChordIt</span>
        <span class="key"></span>
        <button class="toggle-chroma" title="Show/hide pitch meter">≡</button>
        <button class="close" title="Stop ChordIt">✕</button>
      </div>
      <div class="chord">…</div>
      <div class="sub">Listening…</div>
      <div class="history"></div>
      <div class="chroma-wrap">
        <div class="chroma">${'<div></div>'.repeat(12)}</div>
        <div class="labels">${COMMON.map((n) => `<span>${n}</span>`).join('')}</div>
      </div>
      <div class="controls">
        <div class="row">
          <label>Capo</label>
          <button class="capo-down" title="Lower capo">−</button>
          <output class="capo-val">0</output>
          <button class="capo-up" title="Raise capo">+</button>
        </div>
        <div class="row">
          <label>Delay</label>
          <input class="delay" type="range" min="0" max="1500" step="50" value="0"
            title="Delay the audio so it lines up with the chord display (video will drift out of sync)">
          <output class="delay-val">0 ms</output>
        </div>
      </div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const el = {
    panel: $('.panel'), bar: $('.bar'), key: $('.key'), chord: $('.chord'), sub: $('.sub'),
    history: $('.history'), chromaWrap: $('.chroma-wrap'), bars: [...root.querySelectorAll('.chroma div')],
    capoVal: $('.capo-val'), delay: $('.delay'), delayVal: $('.delay-val'),
  };

  function mount() {
    const fs = document.fullscreenElement;
    // A fullscreen element hides everything outside it, so move the overlay inside.
    const parent = fs && !(fs instanceof HTMLMediaElement) ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function applyPosition() {
    if (!settings.pos) return;
    const x = Math.min(Math.max(0, settings.pos.x), window.innerWidth - 60);
    const y = Math.min(Math.max(0, settings.pos.y), window.innerHeight - 40);
    Object.assign(host.style, { left: x + 'px', top: y + 'px', right: 'auto' });
  }

  // ---- rendering ----------------------------------------------------------

  function render() {
    el.capoVal.textContent = settings.capo;
    el.delay.value = settings.delayMs;
    el.delayVal.textContent = settings.delayMs + ' ms';
    el.chromaWrap.classList.toggle('hidden', !settings.showChroma);
    if (!last) return;

    const names = spelling(last.key);
    el.key.textContent = last.key ? `Key: ${names[last.key.tonic]}${last.key.mode === 'minor' ? 'm' : ''}` : '';

    const c = last.chord;
    if (!c) {
      el.chord.textContent = 'N.C.';
      el.chord.style.opacity = 0.5;
      el.sub.textContent = last.silent ? 'No audio' : 'Listening…';
    } else {
      const actual = chordName(c, names);
      if (settings.capo) {
        el.chord.textContent = chordName(c, COMMON, settings.capo);
        el.sub.textContent = `sounds as ${actual} · capo ${settings.capo}`;
      } else {
        el.chord.textContent = actual;
        el.sub.textContent = `confidence ${Math.round(c.confidence * 100)}%`
          + (Math.abs(last.tuningCents) >= 10 ? ` · tuning ${last.tuningCents > 0 ? '+' : ''}${last.tuningCents}¢` : '');
      }
      el.chord.style.opacity = 0.45 + 0.55 * Math.min(1, c.confidence / 0.8);
    }

    el.history.replaceChildren(...history.map((h) => {
      const s = document.createElement('span');
      s.textContent = settings.capo ? chordName(h, COMMON, settings.capo) : chordName(h, names);
      return s;
    }));

    if (settings.showChroma) {
      const tones = c ? chordTones(c) : [];
      last.chroma.forEach((v, i) => {
        el.bars[i].style.height = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%';
        el.bars[i].classList.toggle('on', tones.includes(i));
      });
    }
  }

  const INTERVALS = { '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11],
    m7: [0, 3, 7, 10], sus4: [0, 5, 7], dim: [0, 3, 6] };
  const chordTones = (c) => (INTERVALS[c.quality] || []).map((iv) => (c.root + iv) % 12);

  function onUpdate(data) {
    const c = data.chord;
    const prev = last?.chord;
    const changed = c && (!prev || c.root !== prev.root || c.quality !== prev.quality || c.bass !== prev.bass);
    if (changed) {
      const top = history[0];
      if (!top || top.root !== c.root || top.quality !== c.quality || top.bass !== c.bass) {
        history = [c, ...history].slice(0, HISTORY_LEN);
      }
    }
    last = data;
    render();
  }

  // ---- settings & interaction ---------------------------------------------

  function save() {
    chrome.storage.local.set({ capo: settings.capo, delayMs: settings.delayMs,
      showChroma: settings.showChroma, pos: settings.pos });
  }

  $('.capo-down').addEventListener('click', () => { settings.capo = Math.max(0, settings.capo - 1); save(); render(); });
  $('.capo-up').addEventListener('click', () => { settings.capo = Math.min(11, settings.capo + 1); save(); render(); });
  $('.toggle-chroma').addEventListener('click', () => { settings.showChroma = !settings.showChroma; save(); render(); });
  $('.close').addEventListener('click', () => {
    chrome.runtime.sendMessage({ target: 'background', type: 'stop' }).catch(() => {});
  });
  el.delay.addEventListener('input', () => {
    settings.delayMs = Number(el.delay.value);
    el.delayVal.textContent = settings.delayMs + ' ms';
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'setDelay', delayMs: settings.delayMs }).catch(() => {});
  });
  el.delay.addEventListener('change', save);

  let drag = null;
  el.bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = host.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    el.bar.setPointerCapture(e.pointerId);
  });
  el.bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    settings.pos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy };
    applyPosition();
  });
  el.bar.addEventListener('pointerup', () => { if (drag) { drag = null; save(); } });

  function onMessage(msg, _sender, sendResponse) {
    switch (msg.type) {
      case 'chordit:ping':
        sendResponse('pong');
        break;
      case 'chordit:update':
        onUpdate(msg.data);
        break;
      case 'chordit:close':
        teardown();
        break;
    }
  }

  function teardown() {
    chrome.runtime.onMessage.removeListener(onMessage);
    document.removeEventListener('fullscreenchange', mount);
    window.removeEventListener('resize', applyPosition);
    host.remove();
    window.__chordItLoaded = false;
  }

  document.addEventListener('fullscreenchange', mount);
  window.addEventListener('resize', applyPosition);
  chrome.runtime.onMessage.addListener(onMessage);

  chrome.storage.local.get(['capo', 'delayMs', 'showChroma', 'pos']).then((s) => {
    Object.assign(settings, Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)));
    applyPosition();
    render();
  });

  mount();
  render();
})();
