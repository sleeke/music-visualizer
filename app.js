/**
 * Music Visualizer – Graphic Equalizer
 *
 * Uses the Web Audio API to read microphone input, analyse frequency
 * data via an AnalyserNode and render a styled bar-graph equalizer on
 * an HTML5 Canvas element.
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const BAR_GAP_RATIO = 0.25;   // gap as a fraction of bar width
const MIN_DB        = -90;    // AnalyserNode min decibels
const MAX_DB        = -10;    // AnalyserNode max decibels
const SMOOTHING     = 0.8;    // time-domain smoothing constant (0–1)
const PEAK_HOLD_FRAMES = 45;  // frames to hold a peak marker
const PEAK_DECAY    = 0.5;    // pixels per frame the peak falls

// Gradient colour stops (bottom → top)
const GRADIENT_STOPS = [
  { pos: 0.0,  color: '#06b6d4' },  // cyan   (low)
  { pos: 0.5,  color: '#7c3aed' },  // violet (mid)
  { pos: 1.0,  color: '#ec4899' },  // pink   (high)
];

// ─── State ───────────────────────────────────────────────────────────────────

let audioCtx    = null;
let analyser    = null;
let micStream   = null;
let rafId       = null;
let freqData    = null;
let peakValues  = null;
let peakTimers  = null;
let isRunning   = false;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const canvas      = document.getElementById('eq-canvas');
const ctx         = canvas.getContext('2d');
const overlay     = document.getElementById('overlay');
const btnStart    = document.getElementById('btn-start');
const btnStop     = document.getElementById('btn-stop');
const selBands    = document.getElementById('sel-bands');
const selMode     = document.getElementById('sel-mode');
const rangeGain   = document.getElementById('range-gain');
const lblGain     = document.getElementById('lbl-gain');
const statusText  = document.getElementById('status-text');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(msg) {
  statusText.textContent = msg;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width  = Math.round(rect.width  * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.scale(dpr, dpr);
}

function buildGradient(canvasHeight) {
  const grad = ctx.createLinearGradient(0, canvasHeight, 0, 0);
  GRADIENT_STOPS.forEach(({ pos, color }) => grad.addColorStop(pos, color));
  return grad;
}

/** Map a raw FFT bin index to a "band" bucket using a logarithmic scale. */
function computeBandMap(numBands, fftSize, sampleRate) {
  const nyquist   = sampleRate / 2;
  const binCount  = fftSize / 2;
  const freqPerBin = nyquist / binCount;
  const minFreq   = 20;
  const maxFreq   = Math.min(20000, nyquist);
  const logMin    = Math.log10(minFreq);
  const logMax    = Math.log10(maxFreq);
  const map       = new Array(numBands).fill(0).map(() => ({ start: 0, end: 0 }));

  for (let b = 0; b < numBands; b++) {
    const freqLow  = Math.pow(10, logMin + (b / numBands) * (logMax - logMin));
    const freqHigh = Math.pow(10, logMin + ((b + 1) / numBands) * (logMax - logMin));
    map[b].start = Math.max(0, Math.floor(freqLow  / freqPerBin));
    map[b].end   = Math.min(binCount - 1, Math.ceil(freqHigh / freqPerBin));
    if (map[b].end < map[b].start) map[b].end = map[b].start;
  }
  return map;
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function draw() {
  if (!isRunning) return;

  rafId = requestAnimationFrame(draw);

  analyser.getByteFrequencyData(freqData);

  const cssWidth  = canvas.getBoundingClientRect().width;
  const cssHeight = canvas.getBoundingClientRect().height;
  const numBands  = parseInt(selBands.value, 10);
  const mode      = selMode.value;

  ctx.clearRect(0, 0, cssWidth, cssHeight);

  // Dark background
  ctx.fillStyle = '#13131a';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // Subtle grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  const gridRows = 4;
  for (let i = 1; i < gridRows; i++) {
    const y = (cssHeight / gridRows) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cssWidth, y);
    ctx.stroke();
  }

  const bandMap  = computeBandMap(numBands, analyser.fftSize, audioCtx.sampleRate);
  const totalGap = cssWidth * BAR_GAP_RATIO;
  const barWidth = (cssWidth - totalGap) / numBands;
  const gap      = totalGap / (numBands + 1);
  const gradient = buildGradient(cssHeight);

  for (let b = 0; b < numBands; b++) {
    // Average the FFT bins that fall within this band
    const { start, end } = bandMap[b];
    let sum = 0;
    let count = 0;
    for (let i = start; i <= end; i++) {
      sum += freqData[i];
      count++;
    }
    const avg = count > 0 ? sum / count : 0;
    const normalised = avg / 255;   // 0–1

    const x      = gap + b * (barWidth + gap);
    const barH   = normalised * cssHeight;

    // Peak tracking
    if (normalised * cssHeight > peakValues[b]) {
      peakValues[b] = normalised * cssHeight;
      peakTimers[b] = PEAK_HOLD_FRAMES;
    } else {
      if (peakTimers[b] > 0) {
        peakTimers[b]--;
      } else {
        peakValues[b] = Math.max(0, peakValues[b] - PEAK_DECAY);
      }
    }

    if (mode === 'bars' || mode === 'both') {
      // Main bar
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.roundRect(x, cssHeight - barH, barWidth, barH, [4, 4, 0, 0]);
      ctx.fill();

      // Reflection (mirrored, faded)
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.roundRect(x, cssHeight, barWidth, barH * 0.4, [0, 0, 4, 4]);
      ctx.fill();
      ctx.restore();
    }

    if (mode === 'line' || mode === 'both') {
      // We'll draw the line path after all bars
    }

    // Peak marker
    if (peakValues[b] > 2) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x, cssHeight - peakValues[b] - 2, barWidth, 2);
    }
  }

  // Line mode overlay
  if (mode === 'line' || mode === 'both') {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.85)';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (let b = 0; b < numBands; b++) {
      const { start, end } = bandMap[b];
      let sum = 0, count = 0;
      for (let i = start; i <= end; i++) { sum += freqData[i]; count++; }
      const avg = count > 0 ? sum / count : 0;
      const normalised = avg / 255;
      const x = gap + b * (barWidth + gap) + barWidth / 2;
      const y = cssHeight - normalised * cssHeight;
      b === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

// ─── Audio setup ─────────────────────────────────────────────────────────────

async function startVisualizer() {
  try {
    setStatus('Requesting microphone…');
    btnStart.disabled = true;

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(micStream);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize        = 2048;
    analyser.minDecibels    = MIN_DB;
    analyser.maxDecibels    = MAX_DB;
    analyser.smoothingTimeConstant = SMOOTHING;

    // Optional gain node
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = parseFloat(rangeGain.value);
    rangeGain.addEventListener('input', () => {
      gainNode.gain.value = parseFloat(rangeGain.value);
      lblGain.textContent = `${parseFloat(rangeGain.value).toFixed(1)}×`;
    });

    source.connect(gainNode);
    gainNode.connect(analyser);
    // NOTE: analyser is NOT connected to destination – no audio playback (avoids feedback)

    const bufferLen = analyser.frequencyBinCount;
    freqData   = new Uint8Array(bufferLen);
    peakValues = new Float32Array(parseInt(selBands.value, 10));
    peakTimers = new Int32Array(parseInt(selBands.value, 10));

    selBands.addEventListener('change', () => {
      const n = parseInt(selBands.value, 10);
      peakValues = new Float32Array(n);
      peakTimers = new Int32Array(n);
    });

    isRunning = true;
    resizeCanvas();
    overlay.classList.add('hidden');
    btnStop.disabled  = false;
    btnStart.disabled = true;
    setStatus('Listening…');
    draw();
  } catch (err) {
    btnStart.disabled = false;
    setStatus(`Error: ${err.message}`);
    console.error(err);
  }
}

function stopVisualizer() {
  isRunning = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (audioCtx)  { audioCtx.close(); audioCtx = null; }
  analyser = null;
  overlay.classList.remove('hidden');
  btnStart.disabled = false;
  btnStop.disabled  = true;
  setStatus('Stopped');
}

// ─── Event listeners ─────────────────────────────────────────────────────────

btnStart.addEventListener('click', startVisualizer);
btnStop.addEventListener('click', stopVisualizer);

window.addEventListener('resize', () => {
  if (isRunning) resizeCanvas();
});

// ─── PWA service worker registration ─────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
