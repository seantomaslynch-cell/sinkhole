'use strict';

/* ============================================================================
   SINKHOLE
   One input. Hold to pay out the line and sink; release and the winch hauls
   you back. Treasure is picked up automatically, and every piece of it makes
   the climb slower. The lamp is the only clock.

   Architecture follows the shape proven in Endless Core: a fixed logical
   canvas rendered at devicePixelRatio and CSS-stretched to fill the viewport,
   procedural audio (no files), localStorage as the synchronous store with
   bridge.storage mirrored on top of it, and every platform hook routed through
   the Playgama Bridge SDK (which forwards to YouTube's own SDK on Playables).
   ========================================================================= */

// ---------- Canvas & logical resolution ----------
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Logical height is fixed; logical WIDTH tracks the live viewport aspect and
// is recomputed on every resize.
//
// The usual approach here is to freeze the logical width at load and CSS-
// stretch it, which is simpler but means a frame that changes size after load
// — a rotation, or the Playables frame resizing around the game — renders
// increasingly distorted, with no event able to correct it. Recomputing is
// only safe because nothing in this game stores an absolute x: treasure,
// rocks and snags are all stored as a depth plus a FRACTION of the shaft
// half-width, and the diver's x is derived fresh from the swing every frame.
// So there is genuinely nothing to rescale per-entity, and the aspect stays
// correct on any frame from a tall phone to a wide desktop player.
const LOGICAL_H = 640;
let LOGICAL_W = 360;
let DPR = 1;

function applyCanvasSize(cssW, cssH) {
  const aspect = cssW / cssH;
  const safeAspect = (isFinite(aspect) && aspect > 0) ? aspect : 0.46;
  // Clamps cover the 9:32 .. 32:9 range the platform requires support for.
  LOGICAL_W = Math.round(Math.min(1900, Math.max(200, LOGICAL_H * safeAspect)));

  // Backing buffer at devicePixelRatio so the canvas isn't an upscaled low-res
  // buffer on high-DPI screens. Capped at 3 — cost scales with DPR squared and
  // there is no visible gain past that at this size. Re-read on every resize
  // because it changes when a window moves between displays.
  DPR = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(LOGICAL_W * DPR);
  canvas.height = Math.round(LOGICAL_H * DPR);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  // setTransform, not scale — scale() would compound on every resize.
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

// `state` is a const declared further down, so it is in the temporal dead zone
// during the boot-time resizeCanvas() call below — and `typeof` does NOT make
// a TDZ reference safe. This flag is the guard; boot sets it once state exists.
let stateReady = false;
let resizeRetries = 0;

function resizeCanvas() {
  try {
    // A freshly-loaded page can momentarily report 0x0 before its first layout
    // pass. Committing that would leave the canvas permanently invisible and no
    // later resize event would correct it, so retry on a timer instead
    // (setTimeout, not rAF — rAF can be suspended entirely for a hidden doc).
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w > 0 && h > 0) {
      applyCanvasSize(w, h);
      // Keep the menu's idle lamp centred when the shaft width changes.
      if (stateReady && !state.running) state.x = shaftCenter();
      resizeRetries = 0;
    } else if (resizeRetries < 30) {
      resizeRetries++;
      setTimeout(resizeCanvas, 50);
    }
  } catch (e) {
    // A resize handler must never throw and take the page down with it.
  }
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', resizeCanvas);
resizeCanvas();

// ---------- Small helpers ----------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

// Deterministic value noise keyed on an integer, so the shaft walls look the
// same every time you pass a given depth within a run and cost nothing to
// store. Not cryptographic, just stable and cheap.
function hash01(n) {
  let x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const s = f * f * (3 - 2 * f);
  return lerp(hash01(i), hash01(i + 1), s);
}

// ---------- Audio (procedural; no files) ----------
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audioCtx = AudioContextClass ? new AudioContextClass() : null;
let masterGain = null;
if (audioCtx) {
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 0.5;
  masterGain.connect(audioCtx.destination);
}

// Reflects the host platform's own mute state (bridge.platform.isAudioEnabled
// / AUDIO_STATE_CHANGED). The requirement is zero sound NODES while muted, not
// merely silent output, so playSound() returns before constructing anything.
let sdkAudioEnabled = true;

function applySdkAudioState(enabled) {
  sdkAudioEnabled = !!enabled;
  if (!sdkAudioEnabled) {
    stopDrone();
  } else if (state.running && !isPaused) {
    startDrone();
  }
}

// Browsers keep the context suspended until a genuine user gesture. One
// listener covers every entry point without wiring resume() into each button.
function unlockAudio() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
if (audioCtx) {
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });
}

// Chrome logs a console error for navigator.vibrate() before any real user
// gesture, and a console error fails the compliance run. Gate on a flag rather
// than reusing the audio unlock, which is once-only and may not have fired.
let hasUserGestured = false;
window.addEventListener('pointerdown', () => { hasUserGestured = true; }, { once: true });
window.addEventListener('keydown', () => { hasUserGestured = true; }, { once: true });

function haptic(ms) {
  if (!hasUserGestured) return;
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
}

function playSound(type) {
  if (!audioCtx || audioCtx.state !== 'running') return;
  if (!sdkAudioEnabled) return; // platform-muted: create zero sound nodes

  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(masterGain);

  let dur = 0.12;
  let peak = 0.18;

  if (type === 'coin') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.07);
    dur = 0.1; peak = 0.14;
  } else if (type === 'gem') {
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1180, now);
    osc.frequency.exponentialRampToValueAtTime(1760, now + 0.11);
    dur = 0.18; peak = 0.17;
  } else if (type === 'relic') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523, now);
    osc.frequency.exponentialRampToValueAtTime(1046, now + 0.22);
    dur = 0.45; peak = 0.2;
  } else if (type === 'hit') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.18);
    dur = 0.22; peak = 0.2;
  } else if (type === 'gas') {
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.linearRampToValueAtTime(150, now + 0.3);
    dur = 0.34; peak = 0.1;
  } else if (type === 'bank') {
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.16);
    dur = 0.4; peak = 0.22;
  } else if (type === 'warn') {
    osc.type = 'square';
    osc.frequency.setValueAtTime(320, now);
    osc.frequency.linearRampToValueAtTime(220, now + 0.14);
    dur = 0.16; peak = 0.09;
  } else { // 'click'
    osc.type = 'square';
    osc.frequency.setValueAtTime(660, now);
    dur = 0.05; peak = 0.06;
  }

  // Always ramp from and back to near-silence so start/stop never pops.
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  osc.start(now);
  osc.stop(now + dur + 0.02);
}

// Continuous depth drone. Unlike the one-shots above it can already be running
// when the platform mutes us, so applySdkAudioState() stops it explicitly.
let droneNodes = null;
function startDrone() {
  if (!audioCtx || audioCtx.state !== 'running' || !sdkAudioEnabled || droneNodes) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 55;
  gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.05, audioCtx.currentTime + 1.2);
  osc.connect(gain);
  gain.connect(masterGain);
  osc.start();
  droneNodes = { osc, gain };
}
function stopDrone() {
  if (!droneNodes || !audioCtx) return;
  const { osc, gain } = droneNodes;
  droneNodes = null;
  try {
    gain.gain.cancelScheduledValues(audioCtx.currentTime);
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.4);
    osc.stop(audioCtx.currentTime + 0.45);
  } catch (e) {}
}

// Ducks everything while a rewarded ad plays, independent of platform mute.
function muteAudio() { if (masterGain && audioCtx) masterGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.02); }
function unmuteAudio() { if (masterGain && audioCtx) masterGain.gain.setTargetAtTime(0.5, audioCtx.currentTime, 0.05); }

// ---------- Storage ----------
// localStorage is the synchronous store; bridge.storage is mirrored on top of
// it (see sdkSaveIfAvailable). Reads never go straight to the SDK.
const SK = 'sh_';
function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function storageSetRaw(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function storageSet(k, v) { storageSetRaw(k, v); sdkSaveIfAvailable(); }

function loadNum(k, d) {
  const v = storageGet(SK + k);
  const n = v === null ? NaN : parseFloat(v);
  return isFinite(n) ? n : d;
}

// ---------- Balance config ----------
const UPGRADES = {
  lamp:    { max: 5, cost: (l) => [40, 90, 180, 340, 600][l] },
  winch:   { max: 5, cost: (l) => [50, 110, 220, 400, 700][l] },
  satchel: { max: 5, cost: (l) => [60, 130, 260, 460, 800][l] },
};

const LAMP_BASE = 22;        // seconds at level 0
const LAMP_PER_LEVEL = 4;
const DESCEND_SPEED = 195;   // px/s
const ASCEND_SPEED = 168;    // px/s at zero weight
const WEIGHT_FACTOR_BASE = 0.020;
const WEIGHT_FACTOR_PER_LEVEL = 0.003;
const SATCHEL_PER_LEVEL = 0.15;

// 520 units (52 m) per stratum, not 900.
//
// At 900 a level-0 run bottomed out around 160 m — barely into the second
// stratum — and even a fully outfitted 42-second lamp could not reach The Deep
// at 4500. Three of the five authored strata and two of the three hazards were
// content no player would ever see. 600 fixed most of it but still left The
// Deep out of reach at max gear. At 480 each upgrade tier reveals a new
// stratum: level 0 reaches Crystal Vein, level 2 meets gas, level 3 reaches
// Bone Cathedral, and a fully outfitted diver breaks into The Deep with real
// margin rather than by a hair — 520 put max gear within 31 units of the
// boundary, which is a knife edge one balance tweak away from breaking.
const STRATUM_DEPTH = 480;   // world units per stratum
const AUTHORED_STRATA = 5;   // after this, The Deep runs on forever
const DEEP_START = STRATUM_DEPTH * AUTHORED_STRATA;

const STRATA = [
  { name: 'Topsoil',        top: '#1d1a14', bot: '#0b0a08', accent: '#c9a86a' },
  { name: 'Limestone',      top: '#1a1e22', bot: '#080a0c', accent: '#9fb3c4' },
  { name: 'Crystal Vein',   top: '#151d28', bot: '#070a10', accent: '#6fd8e8' },
  { name: 'Sulphur Deep',   top: '#1f2016', bot: '#0b0c07', accent: '#c9d86a' },
  { name: 'Bone Cathedral', top: '#221b22', bot: '#0c080c', accent: '#e0c8d8' },
  { name: 'The Deep',       top: '#0a0d16', bot: '#03040a', accent: '#7f8fd8' },
];

const TREASURE = {
  coin:  { value: 5,  weight: 1, radius: 6,  sound: 'coin',  color: '#ffd05e' },
  gem:   { value: 18, weight: 3, radius: 8,  sound: 'gem',   color: '#6fd8e8' },
  relic: { value: 70, weight: 9, radius: 11, sound: 'relic', color: '#ffe9c4' },
};

const CHUNK = 300;           // world units per generated chunk
const COLLECT_RADIUS = 30;
const MAGNET_RADIUS = 64;    // items inside this drift toward the diver

// ---------- State ----------
const state = {
  running: false,
  hasDescended: false,

  // run
  depth: 0,
  vy: 0,
  x: 0,
  swingPhase: 0,
  swingAmp: 0,
  lamp: LAMP_BASE,
  lampMax: LAMP_BASE,
  haul: 0,
  weight: 0,
  maxDepthThisRun: 0,
  inGas: false,
  relightUsed: false,
  doubleUsed: false,
  hurtFlash: 0,
  gasWarned: false,

  // meta (persisted)
  coins: loadNum('coins', 0),
  bestDepth: loadNum('bestDepth', 0),
  lampLevel: loadNum('lampLevel', 0),
  winchLevel: loadNum('winchLevel', 0),
  satchelLevel: loadNum('satchelLevel', 0),
  totalRuns: loadNum('totalRuns', 0),
  seenTutorial: loadNum('seenTutorial', 0),
  seenEndOfContent: loadNum('seenEndOfContent', 0),
};

const held = { pointer: false, key: false };
const isHolding = () => held.pointer || held.key;

let items = [];      // treasure in the shaft
let hazards = [];    // snags + gas bands
let rocks = [];      // live falling rocks
let particles = [];
let generatedTo = 0;

// ---------- DOM ----------
const el = (id) => document.getElementById(id);
const hud = el('hud');
const depthDisplay = el('depth-display');
const haulAmount = el('haul-amount');
const lampBar = el('lamp-bar-inner');
const lampReserve = el('lamp-reserve');
const weightBar = el('weight-bar-inner');
const stratumDisplay = el('stratum-display');
const ascendHint = el('ascend-hint');
const toastEl = el('toast');
const pauseOverlay = el('pause-overlay');
const startScreen = el('start-screen');
const tutorialScreen = el('tutorial-screen');
const lostScreen = el('lost-screen');
const surfacedScreen = el('surfaced-screen');
const upgradesScreen = el('upgrades-screen');
const leaderboardScreen = el('leaderboard-screen');
const leaderboardListEl = el('leaderboard-list');

// ---------- Derived stats ----------
const lampMaxFor = () => LAMP_BASE + LAMP_PER_LEVEL * state.lampLevel;
const weightFactor = () => WEIGHT_FACTOR_BASE - WEIGHT_FACTOR_PER_LEVEL * state.winchLevel;
const satchelMult = () => 1 + SATCHEL_PER_LEVEL * state.satchelLevel;
const ascendSpeed = () => ASCEND_SPEED / (1 + state.weight * weightFactor());
const stratumIndex = (d) => Math.min(STRATA.length - 1, Math.floor(d / STRATUM_DEPTH));

const shaftHalf = () => Math.min(LOGICAL_W * 0.38, 210);
const shaftCenter = () => LOGICAL_W / 2;

// Seconds of lamp the climb home costs from here, INCLUDING the extra burn for
// any gas still between the diver and the surface.
//
// Counting gas is not a refinement, it is the difference between an honest
// readout and a lying one. A plain depth/speed estimate says a climb through a
// gas band is affordable when it costs three times as much inside it, and the
// player turns around "in time" and dies anyway. That was reproducible: at
// upgrade tier 4, where runs bottom out inside the gas strata, a simulated
// player reading the naive estimate lost 3 runs out of 3, while the tiers
// either side of it survived 3 out of 3.
function climbCost() {
  const v = Math.max(ascendSpeed(), 1);
  let cost = state.depth / v;
  for (let i = 0; i < hazards.length; i++) {
    const h = hazards[i];
    if (h.kind !== 'gas') continue;
    // How much of this band lies between the surface and the diver.
    const overlap = Math.min(state.depth, h.depth + h.length) - Math.max(0, h.depth);
    if (overlap > 0) cost += (overlap / v) * 2; // gas burns 3x, so 2x extra
  }
  return cost;
}

// Shaft wall wobble, deterministic per depth.
function wallOffsetAt(d) {
  return (noise1(d / 260) - 0.5) * shaftHalf() * 0.34;
}

// ---------- Toast ----------
let toastTimer = null;
function showToast(msg, kind) {
  toastEl.textContent = msg;
  toastEl.className = kind || '';
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 1500);
}

// ---------- World generation ----------
function generateChunk(chunkIndex) {
  const base = chunkIndex * CHUNK;
  const s = stratumIndex(base);
  const deepScale = base > DEEP_START ? 1 + (base - DEEP_START) / 3000 : 1;

  // Treasure. Deeper strata trade coin count for gem/relic density.
  const count = 3 + Math.floor(hash01(chunkIndex * 7.3) * 3) + Math.min(3, s);
  for (let i = 0; i < count; i++) {
    const r = hash01(chunkIndex * 31.7 + i * 4.1);
    let type = 'coin';
    if (s >= 4 && r > 0.90) type = 'relic';
    else if (s >= 1 && r > 0.62) type = 'gem';
    else if (s >= 3 && r > 0.45) type = 'gem';

    const d = base + hash01(chunkIndex * 13.9 + i * 2.7) * CHUNK;
    // A short clean run-up so the very first moment isn't a pickup, but only a
    // short one: this is an impulse-click game and an empty opening screen is
    // the most expensive thing it could possibly show.
    if (d < 70) continue;
    const lateral = (hash01(chunkIndex * 5.5 + i * 9.2) - 0.5) * 1.55; // -0.77..0.77 of half-width
    items.push({ type: type, depth: d, lateral: lateral, taken: false });
  }

  // Wall snags — dodged by hovering (a slow diver swings narrow).
  if (s >= 1 && hash01(chunkIndex * 3.1) > 0.52) {
    const side = hash01(chunkIndex * 8.8) > 0.5 ? 1 : -1;
    hazards.push({
      kind: 'snag',
      depth: base + hash01(chunkIndex * 2.2) * (CHUNK - 90),
      length: 70,
      side: side,
    });
  }

  // Gas pockets — the whole shaft, lamp burns three times as fast inside.
  if (s >= 3 && hash01(chunkIndex * 6.4) > 0.55) {
    hazards.push({
      kind: 'gas',
      depth: base + hash01(chunkIndex * 4.4) * (CHUNK - 160),
      length: 110 + hash01(chunkIndex * 1.9) * 90,
    });
  }

  // Falling-rock triggers.
  if (s >= 2 && hash01(chunkIndex * 9.6) > 0.60 / deepScale) {
    hazards.push({
      kind: 'rockTrigger',
      depth: base + hash01(chunkIndex * 7.7) * (CHUNK - 60),
      lateral: (hash01(chunkIndex * 11.3) - 0.5) * 1.3,
      fired: false,
    });
  }
}

function ensureGenerated(toDepth) {
  const need = Math.ceil((toDepth + LOGICAL_H) / CHUNK);
  while (generatedTo <= need) {
    generateChunk(generatedTo);
    generatedTo++;
  }
}

// ---------- Run lifecycle ----------
function startGame() {
  state.running = true;
  state.hasDescended = false;
  state.depth = 0;
  state.vy = 0;
  state.swingPhase = Math.PI * 0.5;
  state.swingAmp = 0;
  state.x = shaftCenter();
  state.lampMax = lampMaxFor();
  state.lamp = state.lampMax;
  state.haul = 0;
  state.weight = 0;
  state.maxDepthThisRun = 0;
  state.inGas = false;
  state.relightUsed = false;
  state.doubleUsed = false;
  state.hurtFlash = 0;
  state.gasWarned = false;

  items = [];
  hazards = [];
  rocks = [];
  particles = [];
  generatedTo = 0;
  ensureGenerated(0);

  startScreen.classList.add('hidden');
  tutorialScreen.classList.add('hidden');
  lostScreen.classList.add('hidden');
  surfacedScreen.classList.add('hidden');
  upgradesScreen.classList.add('hidden');
  leaderboardScreen.classList.add('hidden');
  hud.classList.remove('hidden');
  hideMenuBanner(); // leaving a menu for active gameplay

  startDrone();

  // The very first run of a session gets a pre-roll-style interstitial; after
  // that the ~90s timer governs (see tickInterstitialTimer).
  if (!firstInterstitialShown) {
    firstInterstitialShown = true;
    lastInterstitialTime = Date.now();
    showInterstitialAd(); // fire-and-forget — never blocks the run from starting
  }

  if (rafId === null && !isPaused) {
    lastFrameTime = performance.now();
    accumulator = 0;
    rafId = requestAnimationFrame(loop);
  }
}

// Failure: the lamp died before the surface. The haul is lost; nothing that
// was already banked is ever touched.
function endGame() {
  // Deliberately re-entrant: the run may already be over (the cert harness
  // ends a run it has already ended, and a relit run can end twice). Scoring
  // is guarded so it only counts once, but the screen and any armed
  // interstitial must still resolve on every call.
  const wasRunning = state.running;
  state.running = false;
  stopDrone();
  hud.classList.add('hidden');

  const depthM = Math.round(state.maxDepthThisRun / 10);
  const isRecord = wasRunning && state.maxDepthThisRun > state.bestDepth;
  if (isRecord) {
    state.bestDepth = state.maxDepthThisRun;
    storageSet(SK + 'bestDepth', String(state.bestDepth));
  }
  if (wasRunning) {
    state.totalRuns++;
    storageSet(SK + 'totalRuns', String(state.totalRuns));
  }

  el('lost-depth').textContent = depthM;
  el('lost-haul').textContent = Math.round(state.haul);
  el('lost-record').classList.toggle('hidden', !isRecord);
  el('relight-btn').classList.toggle('hidden', state.relightUsed || !rewardedAvailable());
  lostScreen.classList.remove('hidden');

  playSound('hit');
  sdkSendLevelFailed();
  if (wasRunning) submitLeaderboardScore(depthM);
  showMenuBanner(); // result screen: fits one viewport, empty space below the buttons

  if (interstitialArmed) {
    interstitialArmed = false;
    lastInterstitialTime = Date.now();
    showInterstitialAd(); // the natural break the timer was waiting for
  }
}

// Success: back at the surface with the haul intact.
function surfaceRun() {
  state.running = false;
  stopDrone();
  hud.classList.add('hidden');

  const banked = Math.round(state.haul);
  state.coins += banked;
  storageSet(SK + 'coins', String(state.coins));

  const depthM = Math.round(state.maxDepthThisRun / 10);
  const isRecord = state.maxDepthThisRun > state.bestDepth;
  if (isRecord) {
    state.bestDepth = state.maxDepthThisRun;
    storageSet(SK + 'bestDepth', String(state.bestDepth));
  }
  state.totalRuns++;
  storageSet(SK + 'totalRuns', String(state.totalRuns));

  el('surfaced-haul').textContent = banked;
  el('surfaced-depth').textContent = depthM;
  el('surfaced-record').classList.toggle('hidden', !isRecord);
  el('double-btn').classList.toggle('hidden', state.doubleUsed || banked <= 0 || !rewardedAvailable());
  surfacedScreen.classList.remove('hidden');

  playSound('bank');
  haptic(18);
  submitLeaderboardScore(depthM);
  showMenuBanner(); // result screen: fits one viewport, empty space below the buttons

  if (interstitialArmed) {
    interstitialArmed = false;
    lastInterstitialTime = Date.now();
    showInterstitialAd();
  }
}

function backToCamp() {
  state.running = false;
  stopDrone();
  hud.classList.add('hidden');
  lostScreen.classList.add('hidden');
  surfacedScreen.classList.add('hidden');
  upgradesScreen.classList.add('hidden');
  leaderboardScreen.classList.add('hidden');
  refreshStartScreen();
  startScreen.classList.remove('hidden');
  showMenuBanner();
}

// ---------- Input ----------
canvas.addEventListener('pointerdown', (e) => {
  if (isPaused) return;
  held.pointer = true;
});
window.addEventListener('pointerup', () => { held.pointer = false; });
window.addEventListener('pointercancel', () => { held.pointer = false; });

window.addEventListener('keydown', (e) => {
  if (isPaused) return;
  // Space and ArrowDown hold the line. Escape is deliberately untouched — the
  // platform reserves it and preventDefault() on it fails certification.
  if (e.code === 'Space' || e.code === 'ArrowDown') {
    held.key = true;
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowDown') held.key = false;
});

// A pointerdown anywhere on a button gives light haptic feedback without
// wiring it into every individual handler.
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest && e.target.closest('button')) haptic(10);
});

// ---------- Update ----------
function update(dt) {
  if (!state.running) return;

  ensureGenerated(state.depth);

  const descending = isHolding();

  // Vertical motion. Heavier means you sink faster and climb slower — the
  // whole tension of the game lives in this asymmetry.
  const target = descending ? (DESCEND_SPEED + state.weight * 1.2) : -ascendSpeed();
  state.vy = lerp(state.vy, target, 1 - Math.pow(0.001, dt));
  state.depth += state.vy * dt;

  if (state.depth > 60) state.hasDescended = true;
  if (state.depth < 0) state.depth = 0;
  if (state.depth > state.maxDepthThisRun) state.maxDepthThisRun = state.depth;

  // The line swings wider the faster you move, so speed buys reach into the
  // walls and hovering threads the narrow gaps. One input, two coupled axes.
  const speedFrac = clamp(Math.abs(state.vy) / DESCEND_SPEED, 0, 1.3);
  const targetAmp = speedFrac * shaftHalf() * 0.62;
  state.swingAmp = lerp(state.swingAmp, targetAmp, 1 - Math.pow(0.02, dt));
  state.swingPhase += dt * (1.5 + speedFrac * 2.6);
  state.x = shaftCenter() + wallOffsetAt(state.depth) + Math.sin(state.swingPhase) * state.swingAmp;

  // Gas: triples the lamp burn while you are inside the band.
  let inGas = false;
  for (let i = 0; i < hazards.length; i++) {
    const h = hazards[i];
    if (h.kind === 'gas' && state.depth > h.depth && state.depth < h.depth + h.length) { inGas = true; break; }
  }
  if (inGas && !state.inGas) {
    showToast('Sour air', 'gas');
    playSound('gas');
  }
  state.inGas = inGas;

  // Lamp
  state.lamp -= dt * (inGas ? 3 : 1);
  if (state.lamp <= 0) {
    state.lamp = 0;
    endGame();
    return;
  }

  // Snags: catch you if the swing carries you into the wall they sit on.
  for (let i = 0; i < hazards.length; i++) {
    const h = hazards[i];
    if (h.kind !== 'snag' || h.hit) continue;
    if (state.depth > h.depth && state.depth < h.depth + h.length) {
      const wallX = shaftCenter() + wallOffsetAt(state.depth) + h.side * shaftHalf();
      if (Math.abs(state.x - wallX) < 34) {
        h.hit = true;
        state.lamp = Math.max(0, state.lamp - 2.5);
        state.swingAmp = 0;
        state.vy *= 0.3;
        state.hurtFlash = 0.35;
        showToast('Snagged', 'danger');
        playSound('hit');
        haptic(30);
      }
    }
  }

  // Rock triggers: arm as you pass, then a rock falls from above.
  for (let i = 0; i < hazards.length; i++) {
    const h = hazards[i];
    if (h.kind !== 'rockTrigger' || h.fired) continue;
    if (state.depth > h.depth - 240 && state.depth < h.depth + 40) {
      h.fired = true;
      rocks.push({
        depth: state.depth - LOGICAL_H * 0.55,
        lateral: h.lateral,
        vy: 300,
        warn: 0.7,
      });
      playSound('warn');
    }
  }

  // Live rocks
  for (let i = rocks.length - 1; i >= 0; i--) {
    const r = rocks[i];
    if (r.warn > 0) {
      r.warn -= dt;
    } else {
      r.vy += 420 * dt;
      r.depth += r.vy * dt;
    }
    const rx = shaftCenter() + wallOffsetAt(r.depth) + r.lateral * shaftHalf();
    if (Math.abs(r.depth - state.depth) < 22 && Math.abs(rx - state.x) < 26) {
      rocks.splice(i, 1);
      state.lamp = Math.max(0, state.lamp - 3);
      state.hurtFlash = 0.45;
      state.vy = Math.max(state.vy, 120);
      showToast('Rockfall', 'danger');
      playSound('hit');
      haptic(45);
      continue;
    }
    if (r.depth > state.depth + LOGICAL_H) rocks.splice(i, 1);
  }

  // Treasure pickup, with a short magnet range in front of it.
  //
  // The player has no lateral control — x comes entirely from the swing — so
  // without a magnet a near-miss reads as arbitrary rather than earned, and
  // early playtest runs collected under a fifth of what they passed. The
  // magnet converts near-misses into a pull while still leaving the wide-swing
  // reach genuinely worth having: it only closes the last stretch.
  const halfW = shaftHalf();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.taken) continue;
    if (Math.abs(it.depth - state.depth) > MAGNET_RADIUS * 1.5) continue;

    let ix = shaftCenter() + wallOffsetAt(it.depth) + it.lateral * halfW;
    let dx = ix - state.x;
    let dy = it.depth - state.depth;
    const dist = Math.hypot(dx, dy);

    // The magnet only works on the way DOWN. On the way up you are hauling,
    // not hunting — and mechanically this is what makes the climb-home
    // estimate honest: if the lamp kept vacuuming weight onto you during the
    // ascent, the reserve marker would understate every climb and turning
    // around "in time" would still lose, which is exactly what playtesting
    // showed. Anything you swing directly into on the way up is still yours.
    if (descending && dist < MAGNET_RADIUS && dist > 0.001) {
      // Exponential form so the pull is identical at any step size.
      const pull = 1 - Math.exp(-(1 - dist / MAGNET_RADIUS) * 7 * dt);
      const targetLat = (state.x - shaftCenter() - wallOffsetAt(it.depth)) / halfW;
      it.lateral = lerp(it.lateral, targetLat, pull);
      it.depth = lerp(it.depth, state.depth, pull);
      ix = shaftCenter() + wallOffsetAt(it.depth) + it.lateral * halfW;
      dx = ix - state.x;
      dy = it.depth - state.depth;
    }

    if (dx * dx + dy * dy < COLLECT_RADIUS * COLLECT_RADIUS) {
      const def = TREASURE[it.type];
      it.taken = true;
      state.haul += def.value * satchelMult();
      state.weight += def.weight;
      playSound(def.sound);
      haptic(8);
      for (let p = 0; p < 7; p++) {
        particles.push({
          x: ix, depth: it.depth,
          vx: (Math.random() - 0.5) * 90,
          vy: (Math.random() - 0.5) * 90,
          life: 0.5, color: def.color,
        });
      }
    }
  }

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.depth += p.vy * dt;
  }

  if (state.hurtFlash > 0) state.hurtFlash -= dt;

  // End-of-content notice, once ever. The Deep really is endless, and saying
  // so plainly is a platform requirement, not a nicety.
  if (!state.seenEndOfContent && state.depth >= DEEP_START) {
    state.seenEndOfContent = 1;
    storageSet(SK + 'seenEndOfContent', '1');
    showToast('The Deep — endless from here', 'good');
  }

  // Surfaced?
  if (state.hasDescended && state.depth <= 0.5 && state.vy <= 0) {
    surfaceRun();
    return;
  }

  updateHud();
}

function updateHud() {
  depthDisplay.innerHTML = Math.round(state.depth / 10) + '<span class="unit">m</span>';
  haulAmount.textContent = Math.round(state.haul);

  const lampFrac = clamp(state.lamp / state.lampMax, 0, 1);
  lampBar.style.width = (lampFrac * 100) + '%';
  lampBar.className = lampFrac < 0.15 ? 'critical' : lampFrac < 0.34 ? 'low' : '';

  weightBar.style.width = clamp(state.weight / 70, 0, 1) * 100 + '%';
  stratumDisplay.textContent = STRATA[stratumIndex(state.depth)].name;

  // The climb-home reserve. Without this the turnaround decision is not
  // actually computable by the player: weight keeps growing on the way up, so
  // a dive that looked survivable at the turn can still fail. Showing the cost
  // against the lamp turns that from an unfair surprise into visible dread.
  const climbTime = climbCost();
  const reserveFrac = clamp(climbTime / state.lampMax, 0, 1);
  lampReserve.style.width = (reserveFrac * 100) + '%';
  lampReserve.classList.toggle('over', climbTime > state.lamp);

  const shouldWarn = state.running && isHolding() && climbTime > state.lamp * 0.82;
  ascendHint.classList.toggle('hidden', !shouldWarn);
}

// ---------- Render ----------
function render() {
  const cameraDepth = state.depth - LOGICAL_H * 0.42;
  const s = stratumIndex(state.depth);
  const strat = STRATA[s];

  // Background
  const g = ctx.createLinearGradient(0, 0, 0, LOGICAL_H);
  g.addColorStop(0, strat.top);
  g.addColorStop(1, strat.bot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  const toScreenY = (d) => d - cameraDepth;
  const half = shaftHalf();

  // Shaft walls
  ctx.fillStyle = '#04060a';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  for (let y = -20; y <= LOGICAL_H + 20; y += 20) {
    const d = y + cameraDepth;
    ctx.lineTo(shaftCenter() + wallOffsetAt(d) - half, y);
  }
  ctx.lineTo(0, LOGICAL_H);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(LOGICAL_W, 0);
  for (let y = -20; y <= LOGICAL_H + 20; y += 20) {
    const d = y + cameraDepth;
    ctx.lineTo(shaftCenter() + wallOffsetAt(d) + half, y);
  }
  ctx.lineTo(LOGICAL_W, LOGICAL_H);
  ctx.closePath();
  ctx.fill();

  // Wall edge highlight
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 2;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    for (let y = -20; y <= LOGICAL_H + 20; y += 20) {
      const d = y + cameraDepth;
      const x = shaftCenter() + wallOffsetAt(d) + sign * half;
      if (y === -20) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Depth ticks every 50 units
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  const firstTick = Math.floor(cameraDepth / 50) * 50;
  for (let d = firstTick; d < cameraDepth + LOGICAL_H; d += 50) {
    if (d < 0) continue;
    const y = toScreenY(d);
    ctx.fillRect(shaftCenter() + wallOffsetAt(d) - half + 4, y, 10, 1);
  }

  const diverY = toScreenY(state.depth);

  // Gas bands
  for (const h of hazards) {
    if (h.kind !== 'gas') continue;
    const y0 = toScreenY(h.depth);
    if (y0 > LOGICAL_H + 40 || y0 + h.length < -40) continue;
    ctx.fillStyle = 'rgba(147, 224, 122, 0.13)';
    ctx.fillRect(0, y0, LOGICAL_W, h.length);
    ctx.fillStyle = 'rgba(147, 224, 122, 0.30)';
    ctx.fillRect(0, y0, LOGICAL_W, 2);
    ctx.fillRect(0, y0 + h.length - 2, LOGICAL_W, 2);
  }

  // Snags
  for (const h of hazards) {
    if (h.kind !== 'snag') continue;
    const y0 = toScreenY(h.depth);
    if (y0 > LOGICAL_H + 40 || y0 + h.length < -40) continue;
    ctx.fillStyle = h.hit ? 'rgba(120,120,130,0.5)' : '#3a2b2b';
    for (let y = y0; y < y0 + h.length; y += 14) {
      const d = y + cameraDepth;
      const wallX = shaftCenter() + wallOffsetAt(d) + h.side * half;
      ctx.beginPath();
      ctx.moveTo(wallX, y);
      ctx.lineTo(wallX - h.side * 24, y + 7);
      ctx.lineTo(wallX, y + 14);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Treasure — dimmed by distance from the lamp so darkness is real
  for (const it of items) {
    if (it.taken) continue;
    const y = toScreenY(it.depth);
    if (y < -30 || y > LOGICAL_H + 30) continue;
    const def = TREASURE[it.type];
    const x = shaftCenter() + wallOffsetAt(it.depth) + it.lateral * half;
    const dist = Math.hypot(x - state.x, it.depth - state.depth);
    const vis = clamp(1 - (dist - 60) / 170, 0.06, 1);

    ctx.globalAlpha = vis;
    ctx.fillStyle = def.color;
    ctx.beginPath();
    ctx.arc(x, y, def.radius, 0, Math.PI * 2);
    ctx.fill();
    // glint
    ctx.globalAlpha = vis * 0.85;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(x - def.radius * 0.3, y - def.radius * 0.35, def.radius * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Rocks
  for (const r of rocks) {
    const y = toScreenY(r.depth);
    const x = shaftCenter() + wallOffsetAt(r.depth) + r.lateral * half;
    if (r.warn > 0) {
      ctx.strokeStyle = 'rgba(255,90,73,' + (0.35 + 0.4 * Math.sin(r.warn * 30)) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#5a5048';
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3b342e';
      ctx.beginPath();
      ctx.arc(x + 3, y + 3, 8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Particles
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life * 2, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 2, toScreenY(p.depth) - 2, 3, 3);
  }
  ctx.globalAlpha = 1;

  // Rope
  ctx.strokeStyle = '#6b6152';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(shaftCenter() + wallOffsetAt(cameraDepth), -10);
  ctx.quadraticCurveTo(
    (shaftCenter() + state.x) / 2, diverY * 0.55,
    state.x, diverY - 8
  );
  ctx.stroke();

  // Diver
  ctx.fillStyle = '#d8dde6';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(state.x - 7, diverY - 9, 14, 20, 6) : ctx.rect(state.x - 7, diverY - 9, 14, 20);
  ctx.fill();
  ctx.fillStyle = '#ffcf7a';
  ctx.beginPath();
  ctx.arc(state.x, diverY - 2, 4, 0, Math.PI * 2);
  ctx.fill();

  // Lamp cone / darkness. Drawn as a big radial gradient that is transparent
  // at the diver and opaque black past the lamp radius, so the shaft genuinely
  // disappears rather than merely being tinted.
  // Radius is keyed to LOGICAL_H, not to pixels, so the lit pocket is the same
  // fraction of the shaft on every frame size. A dying lamp closes it in.
  const lampFrac = clamp(state.lamp / state.lampMax, 0, 1);
  const radius = LOGICAL_H * (0.15 + 0.19 * lampFrac);
  const flicker = 1 + Math.sin(performance.now() / 90) * 0.02 * (1.4 - lampFrac);
  const lg = ctx.createRadialGradient(state.x, diverY, 8, state.x, diverY, radius * flicker);
  lg.addColorStop(0, 'rgba(0,0,0,0)');
  lg.addColorStop(0.38, 'rgba(0,0,0,0.08)');
  lg.addColorStop(0.66, 'rgba(0,0,0,0.62)');
  lg.addColorStop(0.86, 'rgba(0,0,0,0.90)');
  lg.addColorStop(1, 'rgba(0,0,0,0.975)');
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  // Warm bloom on top of the darkness. Kept low — the lamp should pick objects
  // out of the black, not tint the whole frame amber.
  const bloom = ctx.createRadialGradient(state.x, diverY, 4, state.x, diverY, radius * 0.6);
  bloom.addColorStop(0, 'rgba(255, 207, 122, ' + (0.13 * lampFrac + 0.03) + ')');
  bloom.addColorStop(1, 'rgba(255, 207, 122, 0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

  // A faint rim along the wall edges, drawn ON TOP of the darkness. Without it
  // everything outside the lamp is a featureless black rectangle and the sense
  // of moving through a shaft — the entire reason the screen is dark — is lost.
  ctx.strokeStyle = 'rgba(150, 170, 200, 0.10)';
  ctx.lineWidth = 1.5;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    for (let y = -20; y <= LOGICAL_H + 20; y += 20) {
      const d = y + cameraDepth;
      const x = shaftCenter() + wallOffsetAt(d) + sign * half;
      if (y === -20) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Damage flash
  if (state.hurtFlash > 0) {
    ctx.fillStyle = 'rgba(255, 90, 73, ' + clamp(state.hurtFlash * 0.5, 0, 0.5) + ')';
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);
  }

  // Surface marker
  if (cameraDepth < 40) {
    const y = toScreenY(0);
    ctx.strokeStyle = 'rgba(255, 207, 122, 0.5)';
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(LOGICAL_W, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---------- Loop ----------
//
// FIXED TIMESTEP. The simulation always advances in exact 1/60 increments no
// matter what the display is doing; only rendering is tied to the frame rate.
//
// This is not a micro-optimisation, it is the thing that makes the game's feel
// and balance verifiable. With a variable dt, a 30fps phone and a 120fps
// desktop get subtly different physics — different swing arcs, different
// collision resolution, and at low frame rates a falling rock can move further
// per step than the collision threshold and tunnel straight through the diver.
// Pinning the step also means the deterministic balance harness (which steps
// update(1/60) directly) is measuring exactly what a real player experiences,
// rather than an approximation of it.
const FIXED_DT = 1 / 60;
const MAX_CATCHUP = 0.25; // seconds of simulation allowed per rendered frame

let rafId = null;
let lastFrameTime = 0;
let accumulator = 0;

function loop(now) {
  rafId = requestAnimationFrame(loop);

  let elapsed = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  if (!isFinite(elapsed) || elapsed < 0) elapsed = 0;

  // Clamping here means a long stall — an ad, a backgrounded tab, a resumed
  // laptop — is absorbed rather than replayed as a burst of catch-up steps
  // that would teleport the diver through half the shaft.
  accumulator += Math.min(elapsed, MAX_CATCHUP);

  tickInterstitialTimer(); // wall-clock based; runs regardless of run state

  let steps = 0;
  while (accumulator >= FIXED_DT && steps < 15) {
    update(FIXED_DT);
    accumulator -= FIXED_DT;
    steps++;
  }
  // If we hit the step cap the device cannot keep up; drop the debt instead of
  // letting it grow every frame into a death spiral.
  if (steps >= 15) accumulator = 0;

  render();
}

// ---------- SDK-driven platform pause ----------
// Fires from Bridge's PAUSE_STATE_CHANGED at any point — menu, mid-run,
// mid-overlay — so it must work regardless of what else is on screen. The CSS
// lockout in style.css backs this up.
let isPaused = false;
let wasRunningBeforePause = false;

function handleSdkPause() {
  if (isPaused) return;
  isPaused = true;
  document.body.classList.add('paused');
  pauseOverlay.classList.remove('hidden');
  wasRunningBeforePause = state.running;
  held.pointer = false;
  held.key = false;
  if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  muteAudio();
}

function handleSdkResume() {
  if (!isPaused) return;
  isPaused = false;
  document.body.classList.remove('paused');
  pauseOverlay.classList.add('hidden');
  unmuteAudio();
  lastFrameTime = performance.now();
  accumulator = 0; // never replay the paused interval as catch-up steps
  if (rafId === null) rafId = requestAnimationFrame(loop);
}

// ---------- Ads ----------
const REWARD_ID_RELIGHT = 'sinkhole-relight';
const REWARD_ID_DOUBLE = 'sinkhole-2xhaul';

let bridgeReadyPromise = null;
let firstInterstitialShown = false;
let interstitialArmed = false;
let lastInterstitialTime = 0;
const INTERSTITIAL_GAP_MS = 90000;

// Bridge signals rewarded completion through an event rather than the call's
// return value, so the promise resolves from the listener and the listener is
// always removed on both paths.
function bridgeShowRewarded(placement) {
  return new Promise((resolve) => {
    const ads = window.bridge && window.bridge.advertisement;
    if (!(ads && ads.showRewarded)) { resolve(false); return; }
    const eventName = window.bridge.EVENT_NAME && window.bridge.EVENT_NAME.REWARDED_STATE_CHANGED;
    if (!eventName || typeof ads.on !== 'function') { resolve(false); return; }

    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { if (typeof ads.off === 'function') ads.off(eventName, onState); } catch (e) {}
      resolve(ok);
    };
    const onState = (st) => {
      if (st === 'rewarded') done(true);
      else if (st === 'closed' || st === 'failed') done(false);
    };
    try {
      ads.on(eventName, onState);
      ads.showRewarded(placement);
    } catch (e) { done(false); }
    // Never leave the game waiting on a host that goes silent.
    setTimeout(() => done(false), 45000);
  });
}

// Whether the host can actually serve a rewarded ad right now. Offering a
// button that resolves to "Ad unavailable" is worse than offering nothing —
// and it matters in practice, because this same build ships to platforms with
// different ad support, and to plain web with no host at all.
function rewardedAvailable() {
  try {
    return !!(window.bridge && bridgeReadyPromise &&
              window.bridge.advertisement &&
              window.bridge.advertisement.isRewardedSupported);
  } catch (e) {
    return false;
  }
}

async function showRewardedVideo(rewardId) {
  if (!(window.bridge && bridgeReadyPromise)) return false;
  muteAudio();
  try {
    // Never touch bridge.advertisement before initialize() has settled.
    try { await bridgeReadyPromise; } catch (e) { unmuteAudio(); return false; }
    if (window.bridge.advertisement && window.bridge.advertisement.isRewardedSupported) {
      const ok = await bridgeShowRewarded(rewardId);
      unmuteAudio();
      return ok;
    }
  } catch (e) {}
  unmuteAudio();
  return false;
}

async function showInterstitialAd() {
  if (!(window.bridge && bridgeReadyPromise)) return;
  try {
    await bridgeReadyPromise;
    const ads = window.bridge.advertisement;
    if (!(ads && ads.showInterstitial && ads.isInterstitialSupported)) return;
    ads.showInterstitial();
  } catch (e) {}
}

// Wall-clock gate. Polled once per frame; arms itself once enough time has
// passed, and the next natural breakpoint (a run ending) spends it.
function tickInterstitialTimer() {
  if (interstitialArmed) return;
  if (!firstInterstitialShown) return;
  if (Date.now() - lastInterstitialTime >= INTERSTITIAL_GAP_MS) interstitialArmed = true;
}

// Named entry point for the rewarded revive. Grants the reward only when the
// ad actually completed — a closed or failed ad must change nothing.
async function watchAdRelight() {
  if (state.relightUsed) return;
  const btn = el('relight-btn');
  btn.disabled = true;
  const watched = await showRewardedVideo(REWARD_ID_RELIGHT);
  btn.disabled = false;
  if (!watched) { showToast('Ad unavailable', 'danger'); return; }

  state.relightUsed = true;
  // Re-read the lamp cap: the player may have bought a Lamp upgrade from the
  // loss screen's Outfit button before relighting, and resuming the run on the
  // pre-purchase cap would silently sell them nothing.
  state.lampMax = lampMaxFor();
  state.lamp = state.lampMax * 0.45;
  state.running = true;
  state.hurtFlash = 0;
  lostScreen.classList.add('hidden');
  hud.classList.remove('hidden');
  btn.classList.add('hidden');
  hideMenuBanner(); // back into gameplay
  startDrone();
  showToast('Lamp relit', 'good');
  if (rafId === null && !isPaused) {
    lastFrameTime = performance.now();
    accumulator = 0;
    rafId = requestAnimationFrame(loop);
  }
}

async function watchAdDoubleHaul() {
  if (state.doubleUsed) return;
  const btn = el('double-btn');
  btn.disabled = true;
  const watched = await showRewardedVideo(REWARD_ID_DOUBLE);
  btn.disabled = false;
  if (!watched) { showToast('Ad unavailable', 'danger'); return; }

  state.doubleUsed = true;
  const bonus = Math.round(state.haul);
  state.coins += bonus;
  storageSet(SK + 'coins', String(state.coins));
  el('surfaced-haul').textContent = bonus * 2;
  btn.classList.add('hidden');
  playSound('bank');
  showToast('Haul doubled', 'good');
}

// ---------- Advanced banners ----------
// Bridge-only and web-only; a no-op anywhere the host doesn't support it.
//
// The banner is only ever shown on screens that are "banner safe": screens
// that fit in one viewport and have genuinely empty space at the bottom. The
// Outfit and leaderboard screens scroll internally, so a fixed bottom banner
// could cover a control the player is trying to reach — those hide it. During
// a run it is always hidden. body.banner adds matching bottom padding to every
// overlay so nothing can be occluded even at the safe placements.
const BANNER_PLACEMENT = 'menu_idle';

function showMenuBanner() {
  if (!(window.bridge && bridgeReadyPromise)) return;
  bridgeReadyPromise.then(() => {
    const ads = window.bridge.advertisement;
    if (ads && ads.isAdvancedBannersSupported && ads.showAdvancedBanners) {
      ads.showAdvancedBanners(BANNER_PLACEMENT);
      document.body.classList.add('banner');
    }
  }).catch(() => {});
}

function hideMenuBanner() {
  document.body.classList.remove('banner');
  if (!(window.bridge && bridgeReadyPromise)) return;
  bridgeReadyPromise.then(() => {
    const ads = window.bridge.advertisement;
    if (ads && ads.hideAdvancedBanners) ads.hideAdvancedBanners();
  }).catch(() => {});
}

// ---------- Leaderboard (Playgama SaaS) ----------
// The public token and service enablement live in playgama-bridge-config.json,
// not here. Score is deepest metres reached in a single run — the purest
// measure of the only decision the game asks about.
const BRIDGE_LEADERBOARD_ID = 'sinkhole_deepest_dive';

function submitLeaderboardScore(metres) {
  if (!(window.bridge && bridgeReadyPromise)) return;
  if (!(metres > 0)) return;
  bridgeReadyPromise.then(() => {
    const lb = window.bridge.leaderboards;
    if (lb && lb.setScore) return lb.setScore(BRIDGE_LEADERBOARD_ID, Math.round(metres));
  }).catch(() => {});
}

// Reached only when bridge.leaderboards.type === 'in_game' — that mode means
// the host has no leaderboard UI of its own and hands back raw entries for the
// game to render.
//
// Built with DOM nodes and textContent rather than an innerHTML template:
// entry names are other players' input, and interpolating them into markup is
// an injection hole. Player photos are deliberately NOT rendered either —
// they are remote URLs, and the platform requirement is a self-contained
// bundle with no external network calls.
function renderLeaderboardScreen(entries) {
  leaderboardListEl.textContent = '';

  if (!entries || !entries.length) {
    const empty = document.createElement('div');
    empty.className = 'leaderboard-empty';
    empty.textContent = 'No dives recorded yet — be the first down.';
    leaderboardListEl.appendChild(empty);
    return;
  }

  entries.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'leaderboard-row' + (e.isPlayer ? ' is-you' : '');

    const rank = document.createElement('div');
    rank.className = 'leaderboard-rank';
    rank.textContent = '#' + (e.rank != null ? e.rank : i + 1);

    const name = document.createElement('div');
    name.className = 'leaderboard-name';
    name.textContent = e.name || 'Diver';

    const score = document.createElement('div');
    score.className = 'leaderboard-score';
    score.textContent = (e.score != null ? e.score : 0) + 'm';

    row.appendChild(rank);
    row.appendChild(name);
    row.appendChild(score);
    leaderboardListEl.appendChild(row);
  });
}

async function openLeaderboard() {
  if (!(window.bridge && bridgeReadyPromise)) { showToast('Leaderboard unavailable'); return; }
  try {
    await bridgeReadyPromise;
    const lb = window.bridge.leaderboards;
    if (!lb) { showToast('Leaderboard unavailable'); return; }

    if (lb.type === 'native_popup' && lb.showNativePopup) {
      await lb.showNativePopup(BRIDGE_LEADERBOARD_ID);
    } else if (lb.type === 'in_game' && lb.getEntries) {
      const entries = await lb.getEntries(BRIDGE_LEADERBOARD_ID);
      renderLeaderboardScreen(entries || []);
      hideMenuBanner(); // this screen scrolls — not a banner-safe placement
      startScreen.classList.add('hidden');
      leaderboardScreen.classList.remove('hidden');
    } else {
      // 'not_available', or a host that supports neither UI mode.
      showToast('Leaderboard unavailable');
    }
  } catch (e) {
    showToast('Leaderboard unavailable');
  }
}

// ---------- Bridge bootstrap ----------
function initPlayablesSDK() {
  if (!(window.bridge && window.bridge.initialize)) return; // no SDK: game still runs fully offline
  bridgeReadyPromise = window.bridge.initialize();
  bridgeReadyPromise.then(() => {
    try {
      // Required step: read platform.language once after init. This game has
      // no localization system, so reading and not acting on it is the honest
      // compliant thing to do rather than faking a switch we cannot make.
      void window.bridge.platform.language;

      const platform = window.bridge.platform;
      const EVENT = window.bridge.EVENT_NAME;
      if (platform) {
        // Apply the CURRENT audio state now — the event below only fires on
        // subsequent changes, never the initial value.
        if (typeof platform.isAudioEnabled !== 'undefined') applySdkAudioState(platform.isAudioEnabled);
        if (EVENT && typeof platform.on === 'function') {
          if (EVENT.AUDIO_STATE_CHANGED) platform.on(EVENT.AUDIO_STATE_CHANGED, (enabled) => applySdkAudioState(enabled));
          if (EVENT.PAUSE_STATE_CHANGED) platform.on(EVENT.PAUSE_STATE_CHANGED, (paused) => { if (paused) handleSdkPause(); else handleSdkResume(); });
        }
      }
    } catch (e) {
      // SDK wiring must never block the game from running.
    }
    notifyGameReady();
    sdkLoadAndMergeIfAvailable();
    if (!state.running) showMenuBanner(); // Start Screen is the default visible screen
  }).catch(() => {});
}

function notifyGameReady() {
  try {
    if (window.bridge && window.bridge.platform && window.bridge.platform.sendMessage) {
      window.bridge.platform.sendMessage('game_ready');
    }
  } catch (e) {}
}

function sdkSendLevelFailed() {
  if (!(window.bridge && bridgeReadyPromise)) return;
  bridgeReadyPromise.then(() => {
    if (window.bridge.platform && window.bridge.platform.sendMessage) {
      window.bridge.platform.sendMessage('level_failed');
    }
  }).catch(() => {});
}

// Mirrors the persisted fields into the platform's own save slot. savedAt is
// stamped synchronously via storageSetRaw the instant this fires — not when
// the async set() completes — so it stays accurate even if the write never
// finishes because the tab closed. That timestamp is what the loader below
// compares against, instead of blindly trusting either copy.
function sdkSaveIfAvailable() {
  if (!(window.bridge && bridgeReadyPromise)) return;
  const savedAt = Date.now();
  storageSetRaw(SK + 'savedAt', String(savedAt));
  bridgeReadyPromise.then(() => {
    if (!window.bridge.storage) return;
    return window.bridge.storage.set([SK + 'save'], [JSON.stringify({
      savedAt: savedAt,
      coins: state.coins,
      bestDepth: state.bestDepth,
      lampLevel: state.lampLevel,
      winchLevel: state.winchLevel,
      satchelLevel: state.satchelLevel,
      totalRuns: state.totalRuns,
      seenTutorial: state.seenTutorial,
      seenEndOfContent: state.seenEndOfContent,
    })]);
  }).catch(() => {});
}

// Pulls the platform copy in on boot, but only when it is genuinely newer.
// localStorage is written synchronously while the mirror write above is async
// and can still be in flight when a tab closes, so a blunt "platform always
// wins" rule would happily overwrite fresher local progress with a stale
// snapshot.
async function sdkLoadAndMergeIfAvailable() {
  if (!(window.bridge && window.bridge.storage && bridgeReadyPromise)) return;
  try {
    await bridgeReadyPromise;
    const result = await window.bridge.storage.get([SK + 'save']);
    const raw = result && result[0];
    if (!raw) return;
    // storage.get() can hand back an already-parsed object for a value that
    // was set as a JSON string, so only parse when it is still a string.
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const localSavedAt = parseInt(storageGet(SK + 'savedAt') || '0', 10);
    if (typeof data.savedAt === 'number' && data.savedAt <= localSavedAt) return;

    // The platform copy won. Apply to state AND to the individual localStorage
    // keys — boot-time hydration reads those directly and never this blob, so
    // skipping that half would revert on the next plain reload.
    const setNum = (field) => {
      if (typeof data[field] === 'number' && isFinite(data[field])) {
        state[field] = data[field];
        storageSetRaw(SK + field, String(data[field]));
      }
    };
    ['coins', 'bestDepth', 'lampLevel', 'winchLevel', 'satchelLevel',
     'totalRuns', 'seenTutorial', 'seenEndOfContent'].forEach(setNum);
    refreshStartScreen();
    refreshUpgrades();
  } catch (e) {}
}

// ---------- Menus ----------
function refreshStartScreen() {
  el('start-coins').textContent = Math.round(state.coins);
  el('start-best').textContent = Math.round(state.bestDepth / 10);
}

function upgradeRow(key, descFn) {
  const level = state[key + 'Level'];
  const cfg = UPGRADES[key];
  const maxed = level >= cfg.max;
  const cost = maxed ? 0 : cfg.cost(level);
  const btn = el(key + '-btn');

  el(key + '-desc').textContent = 'Level ' + level + '/' + cfg.max + ' — ' + descFn(level);
  if (maxed) {
    btn.textContent = 'Fully outfitted';
    btn.disabled = true;
    btn.classList.remove('affordable');
  } else {
    btn.textContent = 'Improve — ' + cost;
    btn.disabled = state.coins < cost;
    btn.classList.toggle('affordable', state.coins >= cost);
  }
}

function refreshUpgrades() {
  el('upgrade-coins').textContent = Math.round(state.coins);
  upgradeRow('lamp', (l) => (LAMP_BASE + LAMP_PER_LEVEL * l) + 's of light');
  upgradeRow('winch', (l) => {
    const f = WEIGHT_FACTOR_BASE - WEIGHT_FACTOR_PER_LEVEL * l;
    const at30 = Math.round(ASCEND_SPEED / (1 + 30 * f));
    return 'climbs at ' + at30 + ' carrying 30';
  });
  upgradeRow('satchel', (l) => '+' + Math.round(SATCHEL_PER_LEVEL * l * 100) + '% value');
}

function buyUpgrade(key) {
  const cfg = UPGRADES[key];
  const level = state[key + 'Level'];
  if (level >= cfg.max) return;
  const cost = cfg.cost(level);
  if (state.coins < cost) return;
  state.coins -= cost;
  state[key + 'Level'] = level + 1;
  storageSet(SK + 'coins', String(state.coins));
  storageSet(SK + key + 'Level', String(state[key + 'Level']));
  playSound('bank');
  refreshUpgrades();
  refreshStartScreen();
}

function openUpgrades(fromScreen) {
  fromScreen.classList.add('hidden');
  refreshUpgrades();
  upgradesScreen.classList.remove('hidden');
  hideMenuBanner(); // this screen scrolls — not a banner-safe placement
  upgradesReturnTo = fromScreen;
}
let upgradesReturnTo = null;

function beginDive() {
  if (!state.seenTutorial) {
    state.seenTutorial = 1;
    storageSet(SK + 'seenTutorial', '1');
    startScreen.classList.add('hidden');
    tutorialScreen.classList.remove('hidden');
    return;
  }
  startGame();
}

// ---------- UI wiring ----------
el('dive-btn').addEventListener('click', beginDive);
el('tutorial-close-btn').addEventListener('click', () => startGame());
el('start-upgrades-btn').addEventListener('click', () => openUpgrades(startScreen));

el('relight-btn').addEventListener('click', watchAdRelight);
el('lost-again-btn').addEventListener('click', () => startGame());
el('lost-upgrades-btn').addEventListener('click', () => openUpgrades(lostScreen));
el('lost-menu-btn').addEventListener('click', backToCamp);

el('double-btn').addEventListener('click', watchAdDoubleHaul);
el('surfaced-again-btn').addEventListener('click', () => startGame());
el('surfaced-upgrades-btn').addEventListener('click', () => openUpgrades(surfacedScreen));
el('surfaced-menu-btn').addEventListener('click', backToCamp);

el('lamp-btn').addEventListener('click', () => buyUpgrade('lamp'));
el('winch-btn').addEventListener('click', () => buyUpgrade('winch'));
el('satchel-btn').addEventListener('click', () => buyUpgrade('satchel'));
el('close-upgrades-btn').addEventListener('click', () => {
  upgradesScreen.classList.add('hidden');
  (upgradesReturnTo || startScreen).classList.remove('hidden');
  if (upgradesReturnTo === startScreen || !upgradesReturnTo) refreshStartScreen();
  showMenuBanner(); // back to a banner-safe screen
});

el('start-leaderboard-btn').addEventListener('click', openLeaderboard);
el('close-leaderboard-btn').addEventListener('click', () => {
  leaderboardScreen.classList.add('hidden');
  refreshStartScreen();
  startScreen.classList.remove('hidden');
  showMenuBanner();
});

// ---------- Boot ----------
stateReady = true;
state.x = shaftCenter();
refreshStartScreen();
refreshUpgrades();
initPlayablesSDK();

// Idle render so the menu sits over a live shaft rather than a blank canvas.
lastFrameTime = performance.now();
rafId = requestAnimationFrame(loop);
