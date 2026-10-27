// Real-time chord detection from an FFT magnitude spectrum.
//
// Pipeline per frame:
//   spectrum (dB) -> spectral peaks -> pitch-class profile (chroma) + bass chroma
//   -> exponential smoothing -> correlation against chord templates
//   -> key/bass/complexity adjustments -> hysteresis -> chord.
//
// Pure module with no browser dependencies so it can be unit tested in Node.

export const QUALITIES = [
  { id: '', intervals: [0, 4, 7], penalty: 0 },
  { id: 'm', intervals: [0, 3, 7], penalty: 0 },
  { id: '7', intervals: [0, 4, 7, 10], penalty: 0.04 },
  { id: 'maj7', intervals: [0, 4, 7, 11], penalty: 0.04 },
  { id: 'm7', intervals: [0, 3, 7, 10], penalty: 0.04 },
  { id: 'sus4', intervals: [0, 5, 7], penalty: 0.06 },
  { id: 'dim', intervals: [0, 3, 6], penalty: 0.08 },
];

// Krumhansl-Kessler key profiles.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
// Natural minor plus the raised 7th so V and V7 count as diatonic.
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10, 11];

const MIN_FREQ = 50;
const MAX_FREQ = 2100;
const BASS_MAX_FREQ = 260;

const DEFAULTS = {
  smoothing: 0.4, // EMA weight of the newest chroma frame
  keySmoothing: 0.006, // EMA weight for the long-term key chroma
  minScore: 0.45, // below this correlation the current chord is kept
  holdFrames: 2, // frames a new chord must win before it replaces the current one
  instantMargin: 0.15, // ...unless it beats the current chord by this much
  silenceDb: -55, // RMS (dBFS) under which the input is treated as silence
  silenceFrames: 4, // silent frames before reporting N.C.
};

function correlate(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function buildTemplates() {
  const out = [];
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      const t = new Float32Array(12);
      const pcs = q.intervals.map((iv) => (root + iv) % 12);
      for (const pc of pcs) t[pc] = 1;
      out.push({ key: `${root}:${q.id}`, root, quality: q.id, pcs, penalty: q.penalty, template: t });
    }
  }
  return out;
}

const TEMPLATES = buildTemplates();

function rotate(profile, n) {
  const out = new Array(12);
  for (let i = 0; i < 12; i++) out[(i + n) % 12] = profile[i];
  return out;
}

export function estimateKey(chroma) {
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
      const score = correlate(chroma, rotate(profile, tonic));
      if (!best || score > best.score) best = { tonic, mode, score };
    }
  }
  return best;
}

function isDiatonic(pcs, key) {
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  return pcs.every((pc) => scale.includes((pc - key.tonic + 12) % 12));
}

export class ChordDetector {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.chroma = new Float32Array(12);
    this.bass = new Float32Array(12);
    this.keyChroma = new Float32Array(12);
    this.keyFrames = 0;
    this.tuning = 0; // estimated detuning from A440, in semitones
    this.current = null;
    this.pendingKey = null;
    this.pendingCount = 0;
    this.silentCount = 0;
  }

  // Extracts chroma and bass chroma from one spectrum frame.
  // spectrumDb: Float32Array of dB magnitudes (AnalyserNode.getFloatFrequencyData).
  analyzeSpectrum(spectrumDb, sampleRate, fftSize) {
    const binHz = sampleRate / fftSize;
    const kMin = Math.max(1, Math.ceil(MIN_FREQ / binHz));
    const kMax = Math.min(spectrumDb.length - 2, Math.floor(MAX_FREQ / binHz));
    const chroma = new Float32Array(12);
    const bass = new Float32Array(12);

    let maxDb = -Infinity;
    for (let k = kMin; k <= kMax; k++) if (spectrumDb[k] > maxDb) maxDb = spectrumDb[k];
    if (!Number.isFinite(maxDb)) return { chroma, bass };
    const floorDb = Math.max(maxDb - 45, -100);

    const peaks = [];
    for (let k = kMin; k <= kMax; k++) {
      const b = spectrumDb[k];
      if (b < floorDb) continue;
      const a = spectrumDb[k - 1], c = spectrumDb[k + 1];
      if (!(b > a && b >= c)) continue;

      // Parabolic interpolation for sub-bin frequency accuracy.
      const denom = a - 2 * b + c;
      const p = denom ? (0.5 * (a - c)) / denom : 0;
      const peakDb = b - 0.25 * (a - c) * p;
      peaks.push({ freq: (k + p) * binHz, mag: Math.pow(10, (peakDb - maxDb) / 20) });
    }

    let tunSin = 0, tunCos = 0;
    for (const { freq, mag } of peaks) {
      // Overtones at 3x, 5x and 6x a note add a fifth / major third that is not
      // really being played (octave overtones keep the pitch class, so they're fine).
      let harmonic = 1;
      for (const lower of peaks) {
        if (lower.freq >= freq / 2.5) break;
        if (lower.mag < mag * 0.5) continue;
        const ratio = freq / lower.freq;
        if ([3, 5, 6].some((n) => Math.abs(ratio - n) < n * 0.015)) { harmonic = 0.35; break; }
      }

      const midi = 69 + 12 * Math.log2(freq / 440) - this.tuning;
      const nearest = Math.round(midi);
      const dev = midi - nearest;
      tunSin += mag * Math.sin(2 * Math.PI * dev);
      tunCos += mag * Math.cos(2 * Math.PI * dev);

      // Favour peaks close to a semitone and in the 80 Hz - 1 kHz range,
      // where fundamentals dominate over harmonics.
      const closeness = Math.cos(Math.PI * dev) ** 2;
      const freqWeight = freq < 80 ? 0.6 : freq > 1000 ? 1000 / freq : 1;
      const w = Math.sqrt(mag) * closeness * freqWeight * harmonic;
      const pc = ((nearest % 12) + 12) % 12;
      chroma[pc] += w;
      if (freq < BASS_MAX_FREQ) bass[pc] += w;
    }

    if (peaks.length > 8) {
      const drift = Math.atan2(tunSin, tunCos) / (2 * Math.PI);
      this.tuning = Math.max(-0.5, Math.min(0.5, this.tuning + 0.02 * drift));
    }
    return { chroma, bass };
  }

  scoreChords() {
    const key = this.currentKey();
    let bassPc = -1, bassStrength = 0, bassSum = 0;
    for (let i = 0; i < 12; i++) {
      bassSum += this.bass[i];
      if (bassPc < 0 || this.bass[i] > this.bass[bassPc]) bassPc = i;
    }
    if (bassSum > 0) bassStrength = this.bass[bassPc] / bassSum;

    return TEMPLATES.map((t) => {
      let score = correlate(this.chroma, t.template) - t.penalty;
      if (key && isDiatonic(t.pcs, key)) score += 0.03;
      if (bassPc === t.root) score += 0.06 * bassStrength;
      return { ...t, score };
    }).sort((x, y) => y.score - x.score);
  }

  currentKey() {
    if (this.keyFrames < 50) return null;
    const key = estimateKey(this.keyChroma);
    return key.score > 0.5 ? key : null;
  }

  // Processes one analysis frame and returns the detection result.
  process(spectrumDb, sampleRate, fftSize, rmsDb) {
    const o = this.opts;
    const silent = rmsDb < o.silenceDb;

    if (silent) {
      this.silentCount++;
      for (let i = 0; i < 12; i++) { this.chroma[i] *= 0.5; this.bass[i] *= 0.5; }
      if (this.silentCount >= o.silenceFrames) {
        this.current = null;
        this.pendingKey = null;
        this.pendingCount = 0;
      }
      return this.result(null, true);
    }
    this.silentCount = 0;

    const frame = this.analyzeSpectrum(spectrumDb, sampleRate, fftSize);
    const norm = (v) => {
      let max = 0;
      for (let i = 0; i < 12; i++) if (v[i] > max) max = v[i];
      if (max > 0) for (let i = 0; i < 12; i++) v[i] /= max;
    };
    norm(frame.chroma);
    norm(frame.bass);
    for (let i = 0; i < 12; i++) {
      this.chroma[i] = o.smoothing * frame.chroma[i] + (1 - o.smoothing) * this.chroma[i];
      this.bass[i] = o.smoothing * frame.bass[i] + (1 - o.smoothing) * this.bass[i];
      this.keyChroma[i] = o.keySmoothing * frame.chroma[i] + (1 - o.keySmoothing) * this.keyChroma[i];
    }
    this.keyFrames++;

    const ranked = this.scoreChords();
    const best = ranked[0];
    this.applyHysteresis(best, ranked);
    return this.result(ranked, false);
  }

  applyHysteresis(best, ranked) {
    const o = this.opts;
    if (best.score < o.minScore) {
      this.pendingKey = null;
      this.pendingCount = 0;
      return;
    }
    if (this.current && best.key === this.current.key) {
      this.current = best;
      this.pendingKey = null;
      this.pendingCount = 0;
      return;
    }
    if (best.key === this.pendingKey) this.pendingCount++;
    else { this.pendingKey = best.key; this.pendingCount = 1; }

    const currentScore = this.current
      ? ranked.find((r) => r.key === this.current.key).score
      : -Infinity;
    if (this.pendingCount >= o.holdFrames || best.score - currentScore > o.instantMargin) {
      this.current = best;
      this.pendingKey = null;
      this.pendingCount = 0;
    }
  }

  result(ranked, silent) {
    let chord = null;
    if (this.current) {
      const c = this.current;
      // Report a slash chord when a non-root chord tone clearly dominates the bass.
      let bassPc = 0, bassSum = 0;
      for (let i = 0; i < 12; i++) {
        bassSum += this.bass[i];
        if (this.bass[i] > this.bass[bassPc]) bassPc = i;
      }
      const slash = bassSum > 0 && bassPc !== c.root && c.pcs.includes(bassPc)
        && this.bass[bassPc] / bassSum > 0.45;
      const live = ranked ? ranked.find((r) => r.key === c.key) : null;
      chord = {
        root: c.root,
        quality: c.quality,
        bass: slash ? bassPc : null,
        confidence: Math.max(0, Math.min(1, live ? live.score : c.score)),
      };
    }
    const key = this.currentKey();
    return {
      chord,
      silent,
      key: key ? { tonic: key.tonic, mode: key.mode } : null,
      chroma: Array.from(this.chroma),
      tuningCents: Math.round(this.tuning * 100),
    };
  }
}
