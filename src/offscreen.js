// Offscreen document: owns the captured tab audio, plays it back to the user,
// and runs chord detection on it.

import { ChordDetector } from './chords.js';

const FFT_SIZE = 16384; // ~2.9 Hz bins at 48 kHz, enough to separate low semitones
const TICK_MS = 100;

let session = null;

async function start({ streamId, tabId, delayMs }) {
  stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);

  // Capturing a tab mutes it, so route the audio back out. The optional delay
  // lets the user hear the music in step with the (inevitably lagging) chord display.
  const delay = ctx.createDelay(2);
  delay.delayTime.value = (delayMs || 0) / 1000;
  source.connect(delay).connect(ctx.destination);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);

  const spectrum = new Float32Array(analyser.frequencyBinCount);
  const wave = new Float32Array(analyser.fftSize);
  const detector = new ChordDetector();

  const timer = setInterval(() => {
    analyser.getFloatFrequencyData(spectrum);
    analyser.getFloatTimeDomainData(wave);
    let sum = 0;
    for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
    const rmsDb = 10 * Math.log10(sum / wave.length + 1e-12);
    const data = detector.process(spectrum, ctx.sampleRate, FFT_SIZE, rmsDb);
    chrome.runtime.sendMessage({ target: 'background', type: 'update', tabId, data }).catch(() => {});
  }, TICK_MS);

  stream.getAudioTracks()[0].addEventListener('ended', () => {
    chrome.runtime.sendMessage({ target: 'background', type: 'ended', tabId }).catch(() => {});
    stop();
  });

  session = { stream, ctx, delay, timer };
}

function stop() {
  if (!session) return;
  clearInterval(session.timer);
  session.stream.getTracks().forEach((t) => t.stop());
  session.ctx.close();
  session = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'start':
      start(msg).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
      );
      return true;
    case 'stop':
      stop();
      sendResponse({ ok: true });
      break;
    case 'setDelay':
      if (session) session.delay.delayTime.setTargetAtTime(msg.delayMs / 1000, session.ctx.currentTime, 0.05);
      break;
  }
});
