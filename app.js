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

// ─── Ripple constants ─────────────────────────────────────────────────────────

const RIPPLE_SPEED         = 2.0;  // base radius growth per frame (CSS px)
const RIPPLE_MAX_COUNT     = 12;   // maximum concurrent ripples
const BEAT_THRESHOLD_RATIO = 1.35; // energy vs rolling average to detect a beat
const BEAT_HISTORY_LEN     = 43;   // frames of energy history (~1.5 s @ 30 fps)
const MESH_CELL_SIZE       = 45;   // hex cell "radius" – center to corner (CSS px)
const MIN_BEAT_GAP_MS         = 250;  // ~240 BPM max; prevents double-firing on one beat
const BEAT_INTERVAL_BUF_SIZE  = 8;    // number of inter-beat intervals tracked for BPM

// ─── State ───────────────────────────────────────────────────────────────────

let audioCtx    = null;
let analyser    = null;
let micStream   = null;
let rafId       = null;
let freqData    = null;
let peakValues  = null;
let peakTimers  = null;
let isRunning   = false;

// Ripple state
let ripples         = [];
let beatEnergy      = null;   // Float32Array, allocated in startVisualizer
let beatHistIdx     = 0;
let lastBeatMs      = 0;      // timestamp of the last confirmed beat (ms)
let beatCount       = 0;      // total beats since start; mod 4 = position in bar
let beatIntervalBuf = null;   // circular buffer of inter-beat intervals (ms)
let beatIntervalIdx = 0;
let meshAlpha       = 0;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const canvas      = document.getElementById('eq-canvas');
const ctx         = canvas.getContext('2d');
const overlay     = document.getElementById('overlay');
const btnStart    = document.getElementById('btn-start');
const btnStop     = document.getElementById('btn-stop');
const selViz      = document.getElementById('sel-viz');
const selBands    = document.getElementById('sel-bands');
const selMode     = document.getElementById('sel-mode');
const rangeGain   = document.getElementById('range-gain');
const lblGain     = document.getElementById('lbl-gain');
const statusText  = document.getElementById('status-text');
const chkMesh     = document.getElementById('chk-mesh');
const spectrumSettings = document.getElementById('spectrum-settings');
const rippleSettings   = document.getElementById('ripple-settings');

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

/**
 * Map a frequency (Hz) to a hue (degrees) on a log scale.
 * 20 Hz → 0° (red), 20 kHz → 280° (violet), covering the visible spectrum.
 */
function freqToHue(freq) {
  const logMin = Math.log10(20);
  const logMax = Math.log10(20000);
  const t = (Math.log10(Math.max(20, Math.min(20000, freq))) - logMin) / (logMax - logMin);
  return t * 280;
}

/** Average normalised energy (0–1) of FFT bins in [startBin, endBin]. */
function getRangeEnergy(data, startBin, endBin) {
  let sum = 0;
  const n = endBin - startBin + 1;
  for (let i = startBin; i <= endBin; i++) sum += data[i];
  return n > 0 ? sum / n / 255 : 0;
}

/**
 * Draw a pointy-top hexagonal mesh covering the entire canvas.
 * @param {number} w     CSS canvas width
 * @param {number} h     CSS canvas height
 * @param {number} hue   Hue in degrees (0–360)
 * @param {number} alpha Opacity (0–1)
 */
function drawHexMesh(w, h, hue, alpha) {
  const s    = MESH_CELL_SIZE;
  const hexW = s * Math.sqrt(3);  // pointy-top hex: width = s*√3
  const rowH = s * 1.5;           // vertical distance between row centers
  const rows = Math.ceil(h / rowH) + 2;
  const cols = Math.ceil(w / hexW) + 2;

  ctx.save();
  ctx.strokeStyle = `hsla(${hue},80%,65%,${alpha})`;
  ctx.lineWidth   = 0.8;
  ctx.beginPath();

  for (let row = -1; row <= rows; row++) {
    const cy = row * rowH;
    for (let col = -1; col <= cols; col++) {
      const cx = col * hexW + (row % 2 !== 0 ? hexW / 2 : 0);
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i + Math.PI / 6;  // pointy-top corners
        const px = cx + s * Math.cos(angle);
        const py = cy + s * Math.sin(angle);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
  }

  ctx.stroke();
  ctx.restore();
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

function draw() {
  if (!isRunning) return;
  rafId = requestAnimationFrame(draw);
  if (selViz.value === 'ripple') {
    drawRippleFrame();
  } else {
    drawSpectrumFrame();
  }
}

function drawSpectrumFrame() {
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

function drawRippleFrame() {
  analyser.getByteFrequencyData(freqData);

  const cssWidth  = canvas.getBoundingClientRect().width;
  const cssHeight = canvas.getBoundingClientRect().height;
  const cx        = cssWidth  / 2;
  const cy        = cssHeight / 2;
  const maxR      = Math.hypot(cx, cy);

  // ── Dominant frequency → hue ──────────────────────────────────────────────
  let maxVal = 0, maxIdx = 1;
  for (let i = 1; i < freqData.length; i++) {
    if (freqData[i] > maxVal) { maxVal = freqData[i]; maxIdx = i; }
  }
  const nyquist      = audioCtx.sampleRate / 2;
  const dominantFreq = (maxIdx / freqData.length) * nyquist;
  const hue          = freqToHue(dominantFreq);

  // ── Beat detection (bass band energy) ─────────────────────────────────────
  const bassEndBin = Math.min(Math.floor(250 / nyquist * freqData.length), freqData.length - 1);
  const energy     = getRangeEnergy(freqData, 0, bassEndBin);

  beatEnergy[beatHistIdx] = energy;
  beatHistIdx = (beatHistIdx + 1) % beatEnergy.length;
  const avgEnergy = beatEnergy.reduce((s, v) => s + v, 0) / beatEnergy.length;
  const isBeat    = energy > avgEnergy * BEAT_THRESHOLD_RATIO && energy > 0.05;

  // ── Rhythm-aware beat handling ─────────────────────────────────────────────
  // Use a time-based lockout instead of an energy-drop latch so that each
  // musical beat spawns exactly one ripple, even if the energy stays elevated.
  const nowMs = performance.now();
  const gapOk = (nowMs - lastBeatMs) >= MIN_BEAT_GAP_MS;

  if (isBeat && gapOk) {
    // Track inter-beat interval for BPM estimation
    if (lastBeatMs > 0) {
      beatIntervalBuf[beatIntervalIdx] = nowMs - lastBeatMs;
      beatIntervalIdx = (beatIntervalIdx + 1) % beatIntervalBuf.length;
    }
    lastBeatMs = nowMs;

    // Bar position in 4/4 time: 0 = downbeat, 2 = mid-bar, 1/3 = backbeats.
    const barPos     = beatCount % 4;
    const isDownbeat = barPos === 0;
    const strength   = isDownbeat ? 1.0 : (barPos === 2 ? 0.75 : 0.5);

    // Primary ripple – downbeat starts with a larger initial radius
    if (ripples.length < RIPPLE_MAX_COUNT) {
      ripples.push({ radius: isDownbeat ? 12 : 4, hue, energy, strength });
    }
    // Second outer ring on the downbeat to visually mark the bar start
    if (isDownbeat && ripples.length < RIPPLE_MAX_COUNT) {
      ripples.push({ radius: 26, hue, energy: energy * 0.6, strength: 0.85 });
    }
    beatCount++;
  }

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // ── Ambient radial glow ───────────────────────────────────────────────────
  const glowR  = 15 + energy * 70;
  const radGrd = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(glowR * 4, 10));
  radGrd.addColorStop(0,   `hsla(${hue},100%,60%,${0.1 + energy * 0.25})`);
  radGrd.addColorStop(0.4, `hsla(${hue},80%,45%,${energy * 0.08})`);
  radGrd.addColorStop(1,   'transparent');
  ctx.fillStyle = radGrd;
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // ── Geometric hex mesh (behind rings) ─────────────────────────────────────
  if (chkMesh.checked) {
    const targetMesh = 0.04 + energy * 0.3;
    meshAlpha += (targetMesh - meshAlpha) * 0.1;
    drawHexMesh(cssWidth, cssHeight, hue, meshAlpha);
  }

  // ── Ripple rings ──────────────────────────────────────────────────────────
  ripples = ripples.filter(r => r.radius < maxR + 20);

  for (const r of ripples) {
    r.radius += RIPPLE_SPEED + r.energy * 2.5;
    const alpha = Math.pow(Math.max(0, 1 - r.radius / maxR), 1.2) * r.strength;
    if (alpha < 0.01) continue;

    const lw = (1.5 + r.energy * 3.5) * r.strength;

    // Soft outer glow ring
    ctx.beginPath();
    ctx.arc(cx, cy, r.radius, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(${r.hue},90%,70%,${alpha * 0.2})`;
    ctx.lineWidth   = lw * 5;
    ctx.stroke();

    // Main ring
    ctx.beginPath();
    ctx.arc(cx, cy, r.radius, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(${r.hue},95%,65%,${alpha})`;
    ctx.lineWidth   = lw;
    ctx.stroke();

    // Bright inner highlight edge
    ctx.beginPath();
    ctx.arc(cx, cy, r.radius - lw * 0.4, 0, Math.PI * 2);
    ctx.strokeStyle = `hsla(${r.hue},100%,90%,${alpha * 0.5})`;
    ctx.lineWidth   = lw * 0.35;
    ctx.stroke();
  }

  // ── Centre pulse dot ──────────────────────────────────────────────────────
  const pgrd = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  pgrd.addColorStop(0,   `hsla(${hue},100%,92%,${0.7 + energy * 0.3})`);
  pgrd.addColorStop(0.5, `hsla(${hue},100%,70%,${0.3 + energy * 0.4})`);
  pgrd.addColorStop(1,   'transparent');
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fillStyle = pgrd;
  ctx.fill();
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

    // Ripple state initialisation
    ripples         = [];
    beatEnergy      = new Float32Array(BEAT_HISTORY_LEN);
    beatHistIdx     = 0;
    lastBeatMs      = 0;
    beatCount       = 0;
    beatIntervalBuf = new Float32Array(BEAT_INTERVAL_BUF_SIZE);
    beatIntervalIdx = 0;
    meshAlpha       = 0;

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
  ripples     = [];
  if (beatEnergy)      beatEnergy.fill(0);
  if (beatIntervalBuf) beatIntervalBuf.fill(0);
  beatHistIdx     = 0;
  lastBeatMs      = 0;
  beatCount       = 0;
  beatIntervalIdx = 0;
  meshAlpha       = 0;
  overlay.classList.remove('hidden');
  btnStart.disabled = false;
  btnStop.disabled  = true;
  setStatus('Stopped');
}

// ─── Event listeners ─────────────────────────────────────────────────────────

function updateVizSettings() {
  const isRipple = selViz.value === 'ripple';
  spectrumSettings.classList.toggle('hidden-group', isRipple);
  rippleSettings.classList.toggle('hidden-group', !isRipple);
}

selViz.addEventListener('change', updateVizSettings);
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
