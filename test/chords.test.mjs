// Feeds synthetic spectra (notes with decaying harmonics, plus noise) through
// the detector and checks it names the right chord. Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChordDetector } from '../src/chords.js';

const SR = 48000;
const FFT = 16384;
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Builds a dB spectrum resembling AnalyserNode output for the given MIDI notes.
function spectrum(midiNotes, { cents = 0, noiseDb = -90, seed = 1 } = {}) {
  const bins = FFT / 2;
  const binHz = SR / FFT;
  const power = new Float64Array(bins);
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < bins; k++) power[k] = 10 ** (noiseDb / 10) * (0.5 + rand());
  for (const m of midiNotes) {
    const f0 = 440 * 2 ** ((m - 69 + cents / 100) / 12);
    for (let h = 1; h <= 8; h++) {
      const f = f0 * h;
      const amp = 0.3 / h;
      const center = f / binHz;
      // Spread each partial over neighbouring bins like a Blackman window main lobe.
      for (let d = -3; d <= 3; d++) {
        const k = Math.round(center) + d;
        if (k <= 0 || k >= bins) continue;
        const x = k - center;
        power[k] += (amp * Math.exp(-(x * x) / 1.5)) ** 2;
      }
    }
  }
  return Float32Array.from(power, (p) => 10 * Math.log10(p));
}

function label(r) {
  const c = r.chord;
  return c ? NAMES[c.root] + c.quality + (c.bass != null ? '/' + NAMES[c.bass] : '') : 'N.C.';
}

function detect(notes, opts, frames = 6, det = new ChordDetector()) {
  let r;
  for (let i = 0; i < frames; i++) r = det.process(spectrum(notes, { ...opts, seed: i + 1 }), SR, FFT, -20);
  return r;
}

const CASES = [
  ['C', [48, 52, 55, 60, 64]],
  ['G', [43, 55, 59, 62, 67]],
  ['Am', [45, 57, 60, 64, 69]],
  ['Em', [40, 52, 55, 59, 64]],
  ['F', [41, 53, 57, 60, 65]],
  ['D', [50, 57, 62, 66]],
  ['Bm', [47, 54, 59, 62, 66]],
  ['G7', [43, 55, 59, 62, 65]],
  ['Cmaj7', [48, 55, 59, 64]],
  ['Am7', [45, 55, 60, 64]],
  ['Dsus4', [50, 57, 62, 67]],
];

for (const [name, notes] of CASES) {
  test(`detects ${name}`, () => assert.equal(label(detect(notes)), name));
}

test('tolerates a recording tuned 30 cents sharp', () => {
  const det = new ChordDetector();
  for (let i = 0; i < 60; i++) det.process(spectrum([48, 52, 55, 60, 64], { cents: 30, seed: i + 1 }), SR, FFT, -20);
  const r = detect([45, 57, 60, 64, 69], { cents: 30 }, 6, det);
  assert.equal(label(r), 'Am');
  assert.ok(r.tuningCents > 15, `tuning estimate ${r.tuningCents}`);
});

test('reports a slash chord when a non-root tone dominates the bass', () => {
  assert.equal(label(detect([40, 52, 55, 60, 64])), 'C/E');
});

test('follows a progression', () => {
  const det = new ChordDetector();
  const seen = [];
  for (const [name, notes] of [CASES[0], CASES[1], CASES[2], CASES[4]]) {
    const r = detect(notes, {}, 8, det);
    seen.push(label(r));
    assert.equal(label(r), name);
  }
});

test('reports N.C. on silence', () => {
  const det = new ChordDetector();
  detect([48, 52, 55, 60, 64], {}, 6, det);
  let r;
  for (let i = 0; i < 5; i++) r = det.process(spectrum([]), SR, FFT, -80);
  assert.equal(label(r), 'N.C.');
});

test('estimates the key after sustained playing', () => {
  const det = new ChordDetector();
  const prog = [CASES[1], ['C', [48, 55, 60, 64]], ['D', [50, 57, 62, 66]], CASES[3]]; // G C D Em
  let r;
  for (let i = 0; i < 20; i++) for (const [, notes] of prog) r = detect(notes, {}, 5, det);
  assert.deepEqual(r.key, { tonic: 7, mode: 'major' });
});
