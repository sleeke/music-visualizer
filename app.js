/**
 * Music Visualizer – Graphic Equalizer
 *
 * Uses the Web Audio API to read microphone input, analyse frequency
 * data via an AnalyserNode and render a styled bar-graph equalizer on
 * an HTML5 Canvas element.
 *
 * Effects:
 *  - Deep-blue → yellow colour gradient matching amplitude level
 *  - Star-shaped peak markers that slowly fall
 *  - Fireworks particle bursts when peaks exceed the high-level threshold
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const BAR_GAP_RATIO    = 0.25;   // gap as a fraction of bar width
const MIN_DB           = -90;    // AnalyserNode min decibels
const MAX_DB           = -10;    // AnalyserNode max decibels
const SMOOTHING        = 0.8;    // time-domain smoothing constant (0–1)
const PEAK_HOLD_FRAMES = 45;     // frames to hold a peak marker
const PEAK_DECAY       = 0.5;    // pixels per frame the peak falls

// Threshold (normalised 0–1) above which a peak triggers fireworks
const FIREWORKS_THRESHOLD   = 0.75;
// Maximum number of active firework particles
const MAX_PARTICLES         = 400;
// Gravity applied to each particle per frame (pixels/frame²)
const PARTICLE_GRAVITY      = 0.06;
// Angular jitter (radians) added to each particle's launch angle
const PARTICLE_ANGLE_JITTER = 0.4;
// Inner-to-outer radius ratio for the 5-pointed star peak markers
const STAR_INNER_RATIO      = 0.45;

// Gradient colour stops (bottom → top), deep blue at low levels, yellow at high levels
const GRADIENT_STOPS = [
  { pos: 0.0,  color: '#0d1b6e' },  // deep navy-blue  (very low)
  { pos: 0.35, color: '#1565c0' },  // medium blue      (low-mid)
  { pos: 0.6,  color: '#f57f17' },  // amber/orange     (mid-high)
  { pos: 1.0,  color: '#ffd600' },  // bright yellow    (peak)
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

/** @type {{ x: number, y: number, vx: number, vy: number, life: number, maxLife: number, color: string, size: number }[]} */
let particles   = [];

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
  const nyquist    = sampleRate / 2;
  const binCount   = fftSize / 2;
  const freqPerBin = nyquist / binCount;
  const minFreq    = 20;
  const maxFreq    = Math.min(20000, nyquist);
  const logMin     = Math.log10(minFreq);
  const logMax     = Math.log10(maxFreq);
  const map        = new Array(numBands).fill(0).map(() => ({ start: 0, end: 0 }));

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
 * Return the colour that corresponds to the given normalised level (0–1)
 * by interpolating through GRADIENT_STOPS.  Used to tint particles and
 * star markers so they always match the bar colour at that height.
 */
function levelToColor(t) {
  // Clamp
  t = Math.max(0, Math.min(1, t));

  // Find the two surrounding stops
  let lo = GRADIENT_STOPS[0];
  let hi = GRADIENT_STOPS[GRADIENT_STOPS.length - 1];
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i++) {
    if (t >= GRADIENT_STOPS[i].pos && t <= GRADIENT_STOPS[i + 1].pos) {
      lo = GRADIENT_STOPS[i];
      hi = GRADIENT_STOPS[i + 1];
      break;
    }
  }

  const span = hi.pos - lo.pos || 1;
  const f    = (t - lo.pos) / span;

  // Parse hex colours and lerp
  const loRGB = hexToRgb(lo.color);
  const hiRGB = hexToRgb(hi.color);
  const r = Math.round(loRGB.r + f * (hiRGB.r - loRGB.r));
  const g = Math.round(loRGB.g + f * (hiRGB.g - loRGB.g));
  const b = Math.round(loRGB.b + f * (hiRGB.b - loRGB.b));
  return `rgb(${r},${g},${b})`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// ─── Star drawing ─────────────────────────────────────────────────────────────

/**
 * Draw a 5-pointed star centred on (cx, cy) with the given outer radius.
 * @param {number} cx - centre x
 * @param {number} cy - centre y
 * @param {number} outerR - outer radius
 * @param {string} color - fill colour
 * @param {number} [alpha=1] - opacity
 */
function drawStar(cx, cy, outerR, color, alpha = 1) {
  const innerR = outerR * STAR_INNER_RATIO;
  const points = 5;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle   = color;
  ctx.shadowColor = color;
  ctx.shadowBlur  = outerR * 1.5;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const angle  = (i * Math.PI) / points - Math.PI / 2;
    const radius = i % 2 === 0 ? outerR : innerR;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ─── Fireworks particle system ────────────────────────────────────────────────

/**
 * Spawn a burst of particles at (x, y) for a firework explosion.
 * @param {number} x - origin x
 * @param {number} y - origin y
 * @param {number} level - normalised amplitude (0–1), used to colour particles
 */
function spawnFirework(x, y, level) {
  const count = 18 + Math.floor(level * 22); // 18–40 particles per burst
  const color = levelToColor(level);

  for (let i = 0; i < count; i++) {
    if (particles.length >= MAX_PARTICLES) break;
    const angle = (2 * Math.PI * i) / count + (Math.random() - 0.5) * PARTICLE_ANGLE_JITTER;
    const speed = 1.5 + Math.random() * 3.5 * level;
    const life  = 40 + Math.floor(Math.random() * 30);
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      maxLife: life,
      color,
      size: 1.5 + Math.random() * 2.5,
    });
  }
}

/** Update and draw all live particles. */
function updateParticles() {
  const gravity = PARTICLE_GRAVITY;
  let i = 0;
  while (i < particles.length) {
    const p = particles[i];
    p.x  += p.vx;
    p.y  += p.vy;
    p.vy += gravity;        // gentle gravity pull
    p.vx *= 0.97;           // air drag
    p.life--;

    if (p.life <= 0) {
      // Remove dead particle efficiently
      particles[i] = particles[particles.length - 1];
      particles.pop();
      continue;
    }

    const alpha = p.life / p.maxLife;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur  = 4;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    i++;
  }
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
  ctx.fillStyle = '#0a0a12';
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
    const avg        = count > 0 ? sum / count : 0;
    const normalised = avg / 255;   // 0–1

    const x    = gap + b * (barWidth + gap);
    const barH = normalised * cssHeight;

    // ── Peak tracking ──────────────────────────────────────────────────────
    const prevPeak = peakValues[b];
    if (barH > prevPeak) {
      peakValues[b] = barH;
      peakTimers[b] = PEAK_HOLD_FRAMES;

      // Trigger fireworks when a new peak crosses the high-level threshold
      if (normalised >= FIREWORKS_THRESHOLD) {
        const peakX = x + barWidth / 2;
        const peakY = cssHeight - barH;
        spawnFirework(peakX, peakY, normalised);
      }
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
      ctx.fillStyle   = gradient;
      ctx.beginPath();
      ctx.roundRect(x, cssHeight, barWidth, barH * 0.4, [0, 0, 4, 4]);
      ctx.fill();
      ctx.restore();
    }

    // ── Star peak marker ──────────────────────────────────────────────────
    if (peakValues[b] > 4) {
      const peakX    = x + barWidth / 2;
      const peakY    = cssHeight - peakValues[b] - 4;
      const level    = peakValues[b] / cssHeight;   // 0–1 based on peak height
      const starR    = Math.max(3, Math.min(barWidth * 0.55, 7));
      const starColor = levelToColor(level);
      drawStar(peakX, peakY, starR, starColor);
    }
  }

  // Line mode overlay
  if (mode === 'line' || mode === 'both') {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(29, 101, 192, 0.85)';
    ctx.lineWidth = 2;
    ctx.lineJoin  = 'round';
    for (let b = 0; b < numBands; b++) {
      const { start, end } = bandMap[b];
      let sum = 0, count = 0;
      for (let i = start; i <= end; i++) { sum += freqData[i]; count++; }
      const avg        = count > 0 ? sum / count : 0;
      const normalised = avg / 255;
      const x = gap + b * (barWidth + gap) + barWidth / 2;
      const y = cssHeight - normalised * cssHeight;
      b === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Draw live firework particles on top of bars
  updateParticles();
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
    analyser.fftSize               = 2048;
    analyser.minDecibels           = MIN_DB;
    analyser.maxDecibels           = MAX_DB;
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
    particles  = [];

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
  particles = [];
  if (rafId)     { cancelAnimationFrame(rafId); rafId = null; }
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
