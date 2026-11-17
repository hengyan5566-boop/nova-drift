'use strict';
/* ============================================================================
   NOVA DRIFT — a neon twin-stick arena shooter.
   Original game: all art is drawn in code on a canvas, all sound is
   synthesised with WebAudio. No assets, no network, no libraries.
   Controls: WASD / arrows move, mouse aims, hold click or Space to shoot,
   Shift dashes (brief invulnerability), P pauses, M mutes, R restarts.
   Campaign: survive 10 drifts; a flagship named THE HOLLOW STAR guards
   drifts 5 and 10. Break it, clear drift 10, and the drift is yours.
   ============================================================================ */

const W = 1280;
const H = 720;
const TAU = Math.PI * 2;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

/* ------------------------------ utilities -------------------------------- */
function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function angleTo(ax, ay, bx, by) { return Math.atan2(by - ay, bx - ax); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/* ------------------------------ game state ------------------------------- */
const Game = {
  state: 'title',          // 'title' | 'playing' | 'gameover' | 'victory'
  paused: false,
  time: 0,
  score: 0,
  best: 0,
  wave: 0,
  lives: 3,
  combo: 0,                // kills chained inside the combo window
  comboTimer: 0,           // seconds left on the current chain
  kills: 0,
  cores: 0,                // NOVA CORES collected (score-orb currency)
  shake: 0,                // screen-shake magnitude, decays
  flash: 0,                // red hit-flash overlay alpha
  bannerTimer: 0,          // wave-banner countdown
  bannerText: '',
  spawnTimer: 0,           // gap between spawns from the queue
  spawnQueue: [],          // enemy types waiting to enter
  shieldTimer: 0,          // time until the next guaranteed shield drop
  autopilot: false,        // demo mode: the ship plays itself (screenshots)
};

/* Campaign constants: ten drifts, flagship boss on drifts 5 and 10. */
const DRIFT_TOTAL = 10;
const BOSS_NAME = 'THE HOLLOW STAR';

try { Game.best = parseInt(localStorage.getItem('novaDriftBest') || '0', 10) || 0; }
catch (e) { Game.best = 0; }

function saveBest() {
  if (Game.score > Game.best) {
    Game.best = Game.score;
    try { localStorage.setItem('novaDriftBest', String(Game.best)); } catch (e) { /* storage unavailable */ }
  }
}

/* ------------------------------ entities --------------------------------- */
const player = {
  x: W / 2, y: H / 2, vx: 0, vy: 0, angle: -Math.PI / 2, r: 15,
  fireCd: 0, dashCd: 0, dashTime: 0, invuln: 0, shield: false,
  muzzle: 0, thrust: 0,
};

let bullets = [];        // player shots
let enemyBullets = [];   // hostile shots
let enemies = [];        // chaser | shooter | splitter | mini | boss
let orbs = [];           // score pickups
let pickups = [];        // shield pickups
let particles = [];      // explosion / thrust sparks
let floaters = [];       // floating score text
let stars = [];          // parallax starfield layers

/* ------------------------------ input ------------------------------------ */
const keys = {};
const mouse = { x: W / 2, y: H / 2, down: false };

function canvasPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (W / rect.width),
    y: (clientY - rect.top) * (H / rect.height),
  };
}

window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  if (e.repeat) return;
  keys[e.key.toLowerCase()] = true;
  if (e.key === 'Enter' || e.key === ' ') startFromTitle();
  if (e.key.toLowerCase() === 'r') restartGame();
  if (e.key.toLowerCase() === 'p') togglePause();
  if (e.key.toLowerCase() === 'm') toggleMute();
});
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
canvas.addEventListener('mousemove', (e) => {
  const p = canvasPos(e.clientX, e.clientY);
  mouse.x = p.x; mouse.y = p.y;
});
canvas.addEventListener('mousedown', (e) => {
  mouse.down = true;
  const p = canvasPos(e.clientX, e.clientY);
  mouse.x = p.x; mouse.y = p.y;
  startFromTitle();
});
window.addEventListener('mouseup', () => { mouse.down = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

/* ------------------------------ audio ------------------------------------ */
/* Every sound is synthesised live: oscillators for tones, a noise buffer
   for explosions. The AudioContext is created only after a user gesture. */
const AudioSys = {
  ctx: null,
  master: null,
  muted: false,
  noiseBuf: null,

  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch (e) { this.ctx = null; }
  },

  tone(freq, dur, type, vol, slideTo) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(vol || 0.2, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  },

  noise(dur, vol, filterFreq) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(filterFreq || 1200, t0);
    filt.frequency.exponentialRampToValueAtTime(120, t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol || 0.4, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start(t0); src.stop(t0 + dur + 0.02);
  },

  shoot() { this.tone(880, 0.08, 'square', 0.10, 220); },
  explosion(big) {
    this.noise(big ? 0.55 : 0.28, big ? 0.5 : 0.32, big ? 900 : 1600);
    this.tone(big ? 120 : 160, big ? 0.5 : 0.25, 'sine', 0.35, 40);
  },
  pickup() { this.tone(660, 0.09, 'sine', 0.22); this.tone(990, 0.14, 'sine', 0.22); },
  hurt() { this.tone(220, 0.3, 'sawtooth', 0.3, 55); this.noise(0.2, 0.25, 800); },
  dash() { this.noise(0.16, 0.18, 2400); },
  waveStart() {
    if (!this.ctx || this.muted) return;
    [523, 659, 784, 1047].forEach((f, i) => {
      setTimeout(() => this.tone(f, 0.16, 'triangle', 0.2), i * 90);
    });
  },
  gameOver() {
    if (!this.ctx || this.muted) return;
    [392, 330, 262, 196].forEach((f, i) => {
      setTimeout(() => this.tone(f, 0.35, 'triangle', 0.25), i * 170);
    });
  },
};

function toggleMute() {
  AudioSys.muted = !AudioSys.muted;
  addFloater(player.x, player.y - 30, AudioSys.muted ? 'MUTED' : 'SOUND ON', '#8fb3ff');
}

/* ------------------------------ spawning & waves ------------------------- */
const ENEMY_STATS = {
  chaser:   { hp: 2, r: 16, speed: 150, score: 100, color: '#ff2d78' },
  shooter:  { hp: 2, r: 17, speed: 110, score: 150, color: '#ff9f1c' },
  splitter: { hp: 4, r: 24, speed: 80,  score: 200, color: '#39ff6a' },
  mini:     { hp: 1, r: 10, speed: 210, score: 50,  color: '#ff2d78' },
  boss:     { hp: 240, r: 52, speed: 55, score: 2000, color: '#b14bff' },
};

function edgeSpawnPos() {
  const side = randInt(0, 3);
  if (side === 0) return { x: -30, y: rand(0, H) };
  if (side === 1) return { x: W + 30, y: rand(0, H) };
  if (side === 2) return { x: rand(0, W), y: -30 };
  return { x: rand(0, W), y: H + 30 };
}

function spawnEnemy(type, x, y) {
  const s = ENEMY_STATS[type];
  const p = (x === undefined) ? edgeSpawnPos() : { x, y };
  const e = {
    type, x: p.x, y: p.y, vx: 0, vy: 0, angle: 0,
    hp: s.hp, maxHp: s.hp, r: s.r, speed: s.speed * rand(0.9, 1.1),
    score: s.score, color: s.color,
    fireTimer: rand(1.2, 2.4), spin: rand(-1.5, 1.5), t: rand(0, TAU),
    burstTimer: 2.2, miniTimer: 6, decor: false,
  };
  enemies.push(e);
  return e;
}

function spawnBoss() {
  const b = spawnEnemy('boss', W / 2, 110);
  b.hp = 240 + Game.wave * 20;
  b.maxHp = b.hp;
  return b;
}

/* Build the spawn queue for a drift. Chasers from drift 1, shooters from
   drift 2, splitters from drift 3; every 5th drift is a flagship drift.
   Counts are generous on purpose: the field should look busy, not empty. */
function buildWave(n) {
  const q = [];
  if (n % 5 === 0) {
    for (let i = 0; i < 6 + Math.floor(n / 5); i++) q.push('chaser');
    q.push('shooter');
    q.push('shooter');
    q.push('splitter');
  } else {
    const total = 6 + n * 3;
    for (let i = 0; i < total; i++) {
      const roll = Math.random();
      if (n >= 3 && roll < 0.24) q.push('splitter');
      else if (n >= 2 && roll < 0.54) q.push('shooter');
      else q.push('chaser');
    }
  }
  return q;
}

function startWave(n) {
  Game.wave = n;
  Game.spawnQueue = buildWave(n);
  Game.spawnTimer = 0.4;
  Game.bannerTimer = 2.2;
  Game.bannerText = n % 5 === 0 ? 'FLAGSHIP: ' + BOSS_NAME : 'DRIFT ' + n;
  AudioSys.waveStart();
  if (n % 5 === 0) setTimeout(() => { if (Game.state === 'playing') spawnBoss(); }, 1600);
}

function startGame() {
  bullets = []; enemyBullets = []; enemies = []; orbs = [];
  pickups = []; particles = []; floaters = [];
  Game.score = 0; Game.wave = 0; Game.lives = 3;
  Game.combo = 0; Game.comboTimer = 0; Game.kills = 0; Game.cores = 0;
  Game.shieldTimer = 25; Game.flash = 0; Game.shake = 0;
  player.x = W / 2; player.y = H / 2; player.vx = 0; player.vy = 0;
  player.angle = -Math.PI / 2; player.fireCd = 0; player.dashCd = 0;
  player.dashTime = 0; player.invuln = 1; player.shield = false;
  Game.state = 'playing';
  Game.paused = false;
  startWave(1);
}

function startFromTitle() {
  if (Game.state !== 'title') return;
  AudioSys.ensure();
  startGame();
}

function restartGame() {
  if (Game.state === 'playing' || Game.state === 'gameover' || Game.state === 'victory') {
    AudioSys.ensure();
    startGame();
  }
}

function togglePause() {
  if (Game.state === 'playing') Game.paused = !Game.paused;
}

function gameOver() {
  Game.state = 'gameover';
  saveBest();
  AudioSys.gameOver();
  explode(player.x, player.y, '#00e5ff', 90);
}

/* Clearing drift 10 wins the campaign. */
function victory() {
  Game.state = 'victory';
  saveBest();
  AudioSys.waveStart();
  explode(player.x, player.y, '#ffe14d', 120);
  addFloater(player.x, player.y - 40, 'CAMPAIGN COMPLETE', '#ffe14d');
}

/* ------------------------------ combat helpers --------------------------- */
function comboMultiplier() { return Math.min(Math.max(Game.combo, 1), 8); }

function addScore(base, x, y, label) {
  const pts = base * comboMultiplier();
  Game.score += pts;
  addFloater(x, y, '+' + pts + (label ? ' ' + label : ''), '#ffe14d');
}

function addFloater(x, y, text, color) {
  floaters.push({ x, y, text, color: color || '#ffffff', life: 1.1 });
}

function explode(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, TAU), sp = rand(40, 360);
    particles.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: rand(0.3, 1.0), maxLife: 1.0, size: rand(1.5, 5), color,
    });
  }
  Game.shake = Math.min(Game.shake + (count > 40 ? 11 : 5), 18);
}

function spawnOrbs(x, y, n) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU);
    orbs.push({ x, y, vx: Math.cos(a) * rand(30, 120), vy: Math.sin(a) * rand(30, 120), value: 25, life: 9 });
  }
}

function spawnShield(x, y) {
  pickups.push({ x, y, kind: 'shield', t: 0, life: 12 });
}

function killEnemy(e, awardScore) {
  const idx = enemies.indexOf(e);
  if (idx >= 0) enemies.splice(idx, 1);
  explode(e.x, e.y, e.color, e.type === 'boss' ? 160 : 40);
  AudioSys.explosion(e.type === 'boss');
  if (e.type === 'splitter') {
    spawnEnemy('mini', e.x - 14, e.y);
    spawnEnemy('mini', e.x + 14, e.y);
    if (Math.random() < 0.3) spawnShield(e.x, e.y);
  }
  if (e.type === 'boss') {
    spawnOrbs(e.x, e.y, 10);
    addScore(e.score, e.x, e.y, 'FLAGSHIP DOWN');
    Game.bannerText = BOSS_NAME + ' DESTROYED';
    Game.bannerTimer = 2.4;
    Game.combo = 0;
    return;
  }
  if (awardScore !== false) {
    Game.kills++;
    Game.combo++;
    Game.comboTimer = 3;
    addScore(e.score, e.x, e.y, '');
    spawnOrbs(e.x, e.y, e.type === 'splitter' ? 3 : e.type === 'shooter' ? 2 : 1);
  }
}

function damagePlayer() {
  if (player.invuln > 0 || player.dashTime > 0 || Game.state !== 'playing') return;
  if (player.shield) {
    player.shield = false;
    player.invuln = 1.2;
    addFloater(player.x, player.y - 28, 'SHIELD ABSORBED', '#39ff6a');
    AudioSys.hurt();
    explode(player.x, player.y, '#39ff6a', 18);
    return;
  }
  Game.lives--;
  Game.combo = 0;
  Game.comboTimer = 0;
  Game.flash = 0.55;
  Game.shake = 14;
  AudioSys.hurt();
  explode(player.x, player.y, '#00e5ff', 40);
  if (Game.lives <= 0) {
    gameOver();
  } else {
    player.invuln = 2;
  }
}

function fireBullet() {
  const a = player.angle;
  const nx = player.x + Math.cos(a) * 22, ny = player.y + Math.sin(a) * 22;
  bullets.push({
    x: nx, y: ny,
    vx: Math.cos(a) * 660 + player.vx * 0.4,
    vy: Math.sin(a) * 660 + player.vy * 0.4,
    life: 0.85, dmg: 1,
  });
  player.muzzle = 0.06;
  AudioSys.shoot();
  particles.push({
    x: nx, y: ny, vx: Math.cos(a) * 120, vy: Math.sin(a) * 120,
    life: 0.12, maxLife: 0.12, size: 5, color: '#bdf6ff',
  });
}

function enemyShoot(e, angle, speed) {
  enemyBullets.push({
    x: e.x + Math.cos(angle) * (e.r + 6),
    y: e.y + Math.sin(angle) * (e.r + 6),
    vx: Math.cos(angle) * (speed || 250),
    vy: Math.sin(angle) * (speed || 250),
    life: 4.5,
  });
}

/* ------------------------------ autopilot (demo mode) -------------------- */
/* Only active with ?demo=1 or ?state=boss. Drives the ship so screenshots
   show real combat. Never used in normal play. */
function autopilot(dt) {
  // Prefer the flagship when it is alive, so the boss fight stays in
  // frame; otherwise take the nearest enemy. Fire is deliberately slower
  // than a human's so the staged field stays busy for the action shot.
  let target = null, best = Infinity;
  for (const e of enemies) {
    if (e.decor) continue;
    if (e.type === 'boss') { target = e; break; }
    const d = dist2(player.x, player.y, e.x, e.y);
    if (d < best) { best = d; target = e; }
  }
  // Flee the nearest hostile bullet.
  let threat = null, threatD = 130 * 130;
  for (const b of enemyBullets) {
    const d = dist2(player.x, player.y, b.x, b.y);
    if (d < threatD) { threatD = d; threat = b; }
  }
  let mx = 0, my = 0;
  if (threat) {
    const a = angleTo(threat.x, threat.y, player.x, player.y);
    mx = Math.cos(a); my = Math.sin(a);
    if (Math.sqrt(threatD) < 70 && player.dashCd <= 0) doDash();
  } else if (target && best < 90 * 90) {
    const a = angleTo(target.x, target.y, player.x, player.y);
    mx = Math.cos(a); my = Math.sin(a);
  } else if (orbs.length) {
    let o = orbs[0], od = Infinity;
    for (const orb of orbs) {
      const d = dist2(player.x, player.y, orb.x, orb.y);
      if (d < od) { od = d; o = orb; }
    }
    const a = angleTo(player.x, player.y, o.x, o.y);
    mx = Math.cos(a) * 0.7; my = Math.sin(a) * 0.7;
  } else if (target) {
    const a = angleTo(player.x, player.y, target.x, target.y);
    mx = Math.cos(a) * 0.7; my = Math.sin(a) * 0.7;
  }
  if (target) player.angle = angleTo(player.x, player.y, target.x, target.y);
  // Keep the ship in frame for the screenshots: a soft pull away from the
  // edges (autopilot only runs in demo mode, never in normal play).
  if (player.x < 150) mx += 0.9; else if (player.x > W - 150) mx -= 0.9;
  if (player.y < 190) my += 0.9; else if (player.y > H - 110) my -= 0.9;
  player.vx += mx * 1400 * dt;
  player.vy += my * 1400 * dt;
  player.fireCd -= dt;
  if (player.fireCd <= 0 && target) { fireBullet(); player.fireCd = 0.3; }
}

function doDash() {
  if (player.dashCd > 0 || player.dashTime > 0) return;
  let dx = 0, dy = 0;
  if (keys['w'] || keys['arrowup']) dy -= 1;
  if (keys['s'] || keys['arrowdown']) dy += 1;
  if (keys['a'] || keys['arrowleft']) dx -= 1;
  if (keys['d'] || keys['arrowright']) dx += 1;
  if (dx === 0 && dy === 0) { dx = Math.cos(player.angle); dy = Math.sin(player.angle); }
  const len = Math.hypot(dx, dy);
  player.vx = (dx / len) * 950;
  player.vy = (dy / len) * 950;
  player.dashTime = 0.16;
  player.dashCd = 2.2;
  player.invuln = Math.max(player.invuln, 0.28);
  AudioSys.dash();
  explode(player.x, player.y, '#00e5ff', 8);
}

/* ------------------------------ per-frame update ------------------------- */
function updatePlayer(dt) {
  if (Game.autopilot) { autopilot(dt); }
  else {
    let mx = 0, my = 0;
    if (keys['w'] || keys['arrowup']) my -= 1;
    if (keys['s'] || keys['arrowdown']) my += 1;
    if (keys['a'] || keys['arrowleft']) mx -= 1;
    if (keys['d'] || keys['arrowright']) mx += 1;
    if (mx !== 0 || my !== 0) {
      const len = Math.hypot(mx, my);
      player.vx += (mx / len) * 1500 * dt;
      player.vy += (my / len) * 1500 * dt;
      player.thrust = 1;
    } else player.thrust = 0;
    player.angle = angleTo(player.x, player.y, mouse.x, mouse.y);
    if ((keys['shift'] || keys['shiftleft'] || keys['shiftright'])) doDash();
    player.fireCd -= dt;
    if ((mouse.down || keys[' ']) && player.fireCd <= 0) {
      fireBullet();
      player.fireCd = 0.13;
    }
  }

  // Damping, dash decay, speed cap, arena bounds.
  const damp = player.dashTime > 0 ? 0.4 : 3.2;
  player.vx -= player.vx * damp * dt;
  player.vy -= player.vy * damp * dt;
  const sp = Math.hypot(player.vx, player.vy);
  const maxSp = player.dashTime > 0 ? 1000 : 420;
  if (sp > maxSp) { player.vx *= maxSp / sp; player.vy *= maxSp / sp; }
  player.x = clamp(player.x + player.vx * dt, 20, W - 20);
  player.y = clamp(player.y + player.vy * dt, 20, H - 20);
  player.dashTime = Math.max(0, player.dashTime - dt);
  player.dashCd = Math.max(0, player.dashCd - dt);
  player.invuln = Math.max(0, player.invuln - dt);
  player.muzzle = Math.max(0, player.muzzle - dt);

  // Engine exhaust while thrusting.
  if (player.thrust > 0 && Math.random() < 0.6) {
    const back = player.angle + Math.PI;
    particles.push({
      x: player.x + Math.cos(back) * 16 + rand(-3, 3),
      y: player.y + Math.sin(back) * 16 + rand(-3, 3),
      vx: Math.cos(back) * 90 + rand(-20, 20),
      vy: Math.sin(back) * 90 + rand(-20, 20),
      life: 0.3, maxLife: 0.3, size: rand(1.5, 3), color: '#ff9f1c',
    });
  }
}

function updateEnemies(dt) {
  for (const e of enemies) {
    e.t += dt;
    if (e.decor) { e.x += e.vx * dt; e.y += e.vy * dt; continue; }
    const dPlayer = Math.hypot(player.x - e.x, player.y - e.y);
    if (e.type === 'chaser' || e.type === 'mini') {
      const a = angleTo(e.x, e.y, player.x, player.y);
      e.vx += Math.cos(a) * e.speed * 2.4 * dt;
      e.vy += Math.sin(a) * e.speed * 2.4 * dt;
      const s = Math.hypot(e.vx, e.vy);
      if (s > e.speed) { e.vx *= e.speed / s; e.vy *= e.speed / s; }
      e.angle = a;
    } else if (e.type === 'shooter') {
      const a = angleTo(e.x, e.y, player.x, player.y);
      const want = 280;
      const radial = dPlayer > want + 40 ? 1 : dPlayer < want - 40 ? -1 : 0;
      e.vx += Math.cos(a) * radial * e.speed * 2 * dt;
      e.vy += Math.sin(a) * radial * e.speed * 2 * dt;
      e.vx += Math.cos(a + Math.PI / 2) * 40 * dt;
      e.vy += Math.sin(a + Math.PI / 2) * 40 * dt;
      const s = Math.hypot(e.vx, e.vy);
      if (s > e.speed) { e.vx *= e.speed / s; e.vy *= e.speed / s; }
      e.angle = a;
      e.fireTimer -= dt;
      if (e.fireTimer <= 0 && dPlayer < 560) {
        enemyShoot(e, a, 260);
        e.fireTimer = rand(1.6, 2.4);
      }
    } else if (e.type === 'splitter') {
      const a = angleTo(e.x, e.y, player.x, player.y);
      e.vx += Math.cos(a) * e.speed * 1.6 * dt;
      e.vy += Math.sin(a) * e.speed * 1.6 * dt;
      const s = Math.hypot(e.vx, e.vy);
      if (s > e.speed) { e.vx *= e.speed / s; e.vy *= e.speed / s; }
      e.angle += e.spin * dt;
    } else if (e.type === 'boss') {
      // Slow sine sweep across the top half, radial bursts, aimed spreads.
      const targetX = W / 2 + Math.sin(e.t * 0.5) * 420;
      e.vx += (targetX - e.x) * 0.9 * dt;
      e.vy += (150 - e.y) * 0.9 * dt;
      e.vx *= (1 - 1.4 * dt); e.vy *= (1 - 1.4 * dt);
      e.angle = angleTo(e.x, e.y, player.x, player.y);
      e.burstTimer -= dt;
      if (e.burstTimer <= 0) {
        for (let i = 0; i < 14; i++) enemyShoot(e, (i / 14) * TAU + e.t, 210);
        e.burstTimer = 2.4;
        AudioSys.tone(180, 0.3, 'sawtooth', 0.16, 60);
      }
      e.fireTimer -= dt;
      if (e.fireTimer <= 0) {
        const base = angleTo(e.x, e.y, player.x, player.y);
        for (let k = -1; k <= 1; k++) enemyShoot(e, base + k * 0.22, 300);
        e.fireTimer = 1.5;
      }
      e.miniTimer -= dt;
      if (e.miniTimer <= 0 && enemies.length < 14) {
        spawnEnemy('mini', e.x - 40, e.y + 30);
        spawnEnemy('mini', e.x + 40, e.y + 30);
        e.miniTimer = 6;
      }
    }
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    // Boss stays on screen; the rest wrap back in from the edge.
    if (e.type === 'boss') {
      e.x = clamp(e.x, 70, W - 70);
      e.y = clamp(e.y, 70, 320);
    } else {
      if (e.x < -60) e.x = W + 50; if (e.x > W + 60) e.x = -50;
      if (e.y < -60) e.y = H + 50; if (e.y > H + 60) e.y = -50;
    }
  }
}

function updateBullets(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) {
      bullets.splice(i, 1);
    }
  }
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    const b = enemyBullets[i];
    b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
    if (b.life <= 0 || b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) {
      enemyBullets.splice(i, 1);
    }
  }
}

function updateOrbs(dt) {
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i];
    o.life -= dt;
    const d = Math.hypot(player.x - o.x, player.y - o.y);
    if (d < 150) {
      const a = angleTo(o.x, o.y, player.x, player.y);
      o.vx += Math.cos(a) * 900 * dt;
      o.vy += Math.sin(a) * 900 * dt;
    }
    o.vx *= (1 - 2 * dt); o.vy *= (1 - 2 * dt);
    o.x += o.vx * dt; o.y += o.vy * dt;
    if (d < 26) {
      Game.cores++;
      Game.score += o.value * comboMultiplier();
      addFloater(o.x, o.y, '+' + o.value * comboMultiplier(), '#7df9ff');
      AudioSys.pickup();
      orbs.splice(i, 1);
      continue;
    }
    if (o.life <= 0) orbs.splice(i, 1);
  }
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    p.t += dt; p.life -= dt;
    const d = Math.hypot(player.x - p.x, player.y - p.y);
    if (d < 150) {
      const a = angleTo(p.x, p.y, player.x, player.y);
      p.x += Math.cos(a) * 160 * dt;
      p.y += Math.sin(a) * 160 * dt;
    }
    if (d < 30) {
      player.shield = true;
      addFloater(player.x, player.y - 28, 'SHIELD UP', '#39ff6a');
      AudioSys.pickup();
      pickups.splice(i, 1);
      continue;
    }
    if (p.life <= 0) pickups.splice(i, 1);
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= (1 - 2.4 * dt); p.vy *= (1 - 2.4 * dt);
    if (p.life <= 0) particles.splice(i, 1);
  }
  if (particles.length > 450) particles.splice(0, particles.length - 450);
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt; f.y -= 42 * dt;
    if (f.life <= 0) floaters.splice(i, 1);
  }
}

/* ------------------------------ collisions -------------------------------- */
function checkCollisions() {
  // Player bullets vs enemies.
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    let hit = false;
    for (let j = enemies.length - 1; j >= 0; j--) {
      const e = enemies[j];
      if (e.decor) continue;
      const rr = e.r + 5;
      if (dist2(b.x, b.y, e.x, e.y) < rr * rr) {
        e.hp -= b.dmg;
        explode(b.x, b.y, e.color, 4);
        hit = true;
        if (e.hp <= 0) killEnemy(e);
        break;
      }
    }
    if (hit) bullets.splice(i, 1);
  }
  if (Game.state !== 'playing') return;
  // Enemies vs player.
  for (const e of enemies) {
    if (e.decor) continue;
    const rr = e.r + player.r - 4;
    if (dist2(e.x, e.y, player.x, player.y) < rr * rr) {
      damagePlayer();
      // Knock the enemy back so one touch is not a chain of hits.
      const a = angleTo(player.x, player.y, e.x, e.y);
      e.vx = Math.cos(a) * 320; e.vy = Math.sin(a) * 320;
      if (Game.state !== 'playing') return;
    }
  }
  // Enemy bullets vs player.
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    const b = enemyBullets[i];
    if (dist2(b.x, b.y, player.x, player.y) < (player.r - 2) * (player.r - 2)) {
      enemyBullets.splice(i, 1);
      damagePlayer();
      if (Game.state !== 'playing') return;
    }
  }
}

/* ------------------------------ wave flow -------------------------------- */
function updateWaves(dt) {
  if (Game.bannerTimer > 0) {
    Game.bannerTimer -= dt;
    return;
  }
  if (Game.spawnQueue.length > 0) {
    Game.spawnTimer -= dt;
    if (Game.spawnTimer <= 0) {
      spawnEnemy(Game.spawnQueue.shift());
      Game.spawnTimer = 0.45;
    }
  } else if (enemies.filter((e) => !e.decor).length === 0) {
    // Drift cleared: small breather, then the next one — or the campaign
    // is won once drift 10 is clear.
    if (Game.wave >= DRIFT_TOTAL) victory();
    else startWave(Game.wave + 1);
  }
  // A shield pickup is guaranteed every ~30 seconds of play.
  Game.shieldTimer -= dt;
  if (Game.shieldTimer <= 0) {
    spawnShield(rand(120, W - 120), rand(120, H - 120));
    Game.shieldTimer = 30;
  }
}

/* ------------------------------ background -------------------------------- */
function initStars() {
  stars = [];
  for (let layer = 0; layer < 3; layer++) {
    const n = 70 - layer * 14;
    for (let i = 0; i < n; i++) {
      stars.push({
        x: rand(0, W), y: rand(0, H), layer,
        size: rand(0.6, 1.6 + layer * 0.7),
        tw: rand(0, TAU),
        tint: pick(['#8fb3e8', '#8fb3e8', '#cfe8ff', '#ffd9a0', '#ffb3d9']),
      });
    }
  }
}

const nebula = document.createElement('canvas');
nebula.width = W; nebula.height = H;
(function paintNebula() {
  const c = nebula.getContext('2d');
  const blobs = [
    { x: 220, y: 150, r: 340, col: 'rgba(88, 28, 135, 0.30)' },
    { x: 1050, y: 560, r: 380, col: 'rgba(8, 90, 120, 0.28)' },
    { x: 900, y: 120, r: 260, col: 'rgba(190, 24, 93, 0.16)' },
    { x: 300, y: 620, r: 280, col: 'rgba(20, 60, 160, 0.20)' },
    { x: 640, y: 360, r: 300, col: 'rgba(120, 40, 180, 0.12)' },
    { x: 1150, y: 240, r: 220, col: 'rgba(255, 120, 40, 0.10)' },
    { x: 120, y: 480, r: 200, col: 'rgba(0, 180, 160, 0.12)' },
  ];
  for (const b of blobs) {
    const g = c.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
    g.addColorStop(0, b.col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
  }
})();

/* Two fixed nova glows, painted additively over the nebula so the field
   has bright anchor points instead of flat dark space. */
function drawNovaGlows() {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const glows = [
    { x: 1080, y: 130, r: 150, col: 'rgba(255, 140, 60, 0.10)' },
    { x: 170, y: 600, r: 170, col: 'rgba(0, 140, 255, 0.10)' },
  ];
  for (const gl of glows) {
    const g = ctx.createRadialGradient(gl.x, gl.y, 0, gl.x, gl.y, gl.r);
    g.addColorStop(0, gl.col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(gl.x, gl.y, gl.r, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#070722');
  g.addColorStop(0.55, '#04040c');
  g.addColorStop(1, '#0d0719');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(nebula, 0, 0);
  drawNovaGlows();
  for (const s of stars) {
    const par = (s.layer + 1) * 0.012;
    let sx = (s.x - player.x * par) % W;
    let sy = (s.y - player.y * par) % H;
    if (sx < 0) sx += W;
    if (sy < 0) sy += H;
    const twinkle = 0.55 + 0.45 * Math.sin(Game.time * 2 + s.tw);
    ctx.globalAlpha = twinkle * (0.35 + s.layer * 0.25);
    ctx.fillStyle = s.tint;
    ctx.fillRect(sx, sy, s.size, s.size);
  }
  ctx.globalAlpha = 1;
}

/* ------------------------------ entity drawing ---------------------------- */
function neonStroke(color, width, drawFn) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width + 3;
  ctx.globalAlpha = 0.28;
  drawFn();
  ctx.globalAlpha = 1;
  ctx.lineWidth = width;
  drawFn();
  ctx.restore();
}

function drawPlayer() {
  if (Game.state !== 'playing') return;
  const blink = player.invuln > 0 && (Game.time % 0.24) < 0.12;
  if (blink) return;
  ctx.save();
  ctx.translate(player.x, player.y);
  ctx.rotate(player.angle);
  // Soft halo so the ship stays readable in a busy field.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, 30);
  halo.addColorStop(0, 'rgba(0, 229, 255, 0.20)');
  halo.addColorStop(1, 'rgba(0, 229, 255, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(0, 0, 30, 0, TAU); ctx.fill();
  ctx.restore();
  // Shield ring.
  if (player.shield) {
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = '#39ff6a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 26 + Math.sin(Game.time * 5) * 2, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
  // Dash trail.
  if (player.dashTime > 0) {
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath();
    ctx.moveTo(-14, 8); ctx.lineTo(-34, 0); ctx.lineTo(-14, -8);
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }
  neonStroke('#00e5ff', 2, () => {
    ctx.beginPath();
    ctx.moveTo(20, 0); ctx.lineTo(-13, 11); ctx.lineTo(-7, 0); ctx.lineTo(-13, -11);
    ctx.closePath(); ctx.stroke();
  });
  ctx.fillStyle = 'rgba(0, 229, 255, 0.25)';
  ctx.beginPath();
  ctx.moveTo(20, 0); ctx.lineTo(-13, 11); ctx.lineTo(-7, 0); ctx.lineTo(-13, -11);
  ctx.closePath(); ctx.fill();
  // Cockpit dot + muzzle flash.
  ctx.fillStyle = '#eafcff';
  ctx.beginPath(); ctx.arc(5, 0, 3, 0, TAU); ctx.fill();
  if (player.muzzle > 0) {
    ctx.globalCompositeOperation = 'lighter';
    const mg = ctx.createRadialGradient(24, 0, 0, 24, 0, 16);
    mg.addColorStop(0, 'rgba(190, 250, 255, 0.95)');
    mg.addColorStop(1, 'rgba(0, 229, 255, 0)');
    ctx.fillStyle = mg;
    ctx.beginPath(); ctx.arc(24, 0, 16, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.restore();
}

function drawEnemy(e) {
  ctx.save();
  ctx.translate(e.x, e.y);
  if (e.type === 'chaser' || e.type === 'mini') {
    ctx.rotate(e.angle);
    neonStroke(e.color, 2, () => {
      ctx.beginPath();
      ctx.moveTo(e.r, 0); ctx.lineTo(-e.r * 0.8, e.r * 0.7); ctx.lineTo(-e.r * 0.4, 0);
      ctx.lineTo(-e.r * 0.8, -e.r * 0.7); ctx.closePath(); ctx.stroke();
    });
  } else if (e.type === 'shooter') {
    ctx.rotate(e.angle + Math.PI / 4);
    neonStroke(e.color, 2, () => {
      ctx.strokeRect(-e.r * 0.7, -e.r * 0.7, e.r * 1.4, e.r * 1.4);
    });
    ctx.fillStyle = e.color;
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, TAU); ctx.fill();
  } else if (e.type === 'splitter') {
    ctx.rotate(e.angle);
    neonStroke(e.color, 2, () => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        const px = Math.cos(a) * e.r, py = Math.sin(a) * e.r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.stroke();
    });
    ctx.fillStyle = e.color;
    ctx.beginPath(); ctx.arc(0, 0, 4, 0, TAU); ctx.fill();
  } else if (e.type === 'boss') {
    ctx.rotate(Math.sin(e.t * 0.8) * 0.12);
    neonStroke(e.color, 3, () => {
      ctx.beginPath();
      ctx.moveTo(0, e.r);
      ctx.lineTo(e.r * 0.9, e.r * 0.25);
      ctx.lineTo(e.r * 0.55, -e.r * 0.7);
      ctx.lineTo(-e.r * 0.55, -e.r * 0.7);
      ctx.lineTo(-e.r * 0.9, e.r * 0.25);
      ctx.closePath(); ctx.stroke();
    });
    ctx.fillStyle = 'rgba(177, 75, 255, 0.22)';
    ctx.beginPath();
    ctx.moveTo(0, e.r);
    ctx.lineTo(e.r * 0.9, e.r * 0.25);
    ctx.lineTo(e.r * 0.55, -e.r * 0.7);
    ctx.lineTo(-e.r * 0.55, -e.r * 0.7);
    ctx.lineTo(-e.r * 0.9, e.r * 0.25);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffd7ff';
    ctx.beginPath(); ctx.arc(0, 0, 7 + Math.sin(e.t * 6) * 2, 0, TAU); ctx.fill();
  }
  ctx.restore();
  // The flagship's named health bar is drawn by the HUD at the top centre.
}

function drawWorld() {
  drawBackground();
  // Score orbs.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const o of orbs) {
    const pulse = 0.7 + 0.3 * Math.sin(Game.time * 6 + o.x);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#7df9ff';
    ctx.beginPath(); ctx.arc(o.x, o.y, 5, 0, TAU); ctx.fill();
    ctx.globalAlpha = pulse * 0.35;
    ctx.beginPath(); ctx.arc(o.x, o.y, 10, 0, TAU); ctx.fill();
  }
  for (const p of pickups) {
    const pulse = 0.7 + 0.3 * Math.sin(p.t * 6);
    ctx.globalAlpha = pulse;
    ctx.strokeStyle = '#39ff6a';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, TAU); ctx.stroke();
    ctx.fillStyle = '#39ff6a';
    ctx.font = 'bold 14px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('S', p.x, p.y + 5);
  }
  ctx.restore();
  for (const e of enemies) drawEnemy(e);
  drawPlayer();
  // Bullets with trails.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const b of bullets) {
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.40)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.x - b.vx * 0.035, b.y - b.vy * 0.035);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.fillStyle = '#aef6ff';
    ctx.beginPath(); ctx.arc(b.x, b.y, 3.5, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(0, 229, 255, 0.5)';
    ctx.beginPath(); ctx.arc(b.x, b.y, 7, 0, TAU); ctx.fill();
  }
  for (const b of enemyBullets) {
    ctx.fillStyle = '#ff5c8a';
    ctx.beginPath(); ctx.arc(b.x, b.y, 5, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255, 45, 120, 0.45)';
    ctx.beginPath(); ctx.arc(b.x, b.y, 10, 0, TAU); ctx.fill();
  }
  // Particles.
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.restore();
  // Floating score text.
  ctx.textAlign = 'center';
  for (const f of floaters) {
    ctx.globalAlpha = clamp(f.life, 0, 1);
    ctx.fillStyle = f.color;
    ctx.font = 'bold 15px "Segoe UI", sans-serif';
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;
  // Hit flash.
  if (Game.flash > 0) {
    ctx.fillStyle = 'rgba(255, 30, 60, ' + Game.flash * 0.4 + ')';
    ctx.fillRect(0, 0, W, H);
  }
}

/* ------------------------------ HUD & screens ---------------------------- */
/* ------------------------------ HUD & screens ---------------------------- */
function comboGrade() {
  const m = comboMultiplier();
  if (m >= 7) return 'S';
  if (m >= 5) return 'A';
  if (m >= 3) return 'B';
  return 'C';
}

/* Enemies still to clear this drift: alive on the field plus queued. */
function incomingCounts() {
  const c = { chaser: 0, shooter: 0, splitter: 0, mini: 0, boss: 0 };
  for (const e of enemies) { if (!e.decor && c[e.type] !== undefined) c[e.type]++; }
  for (const t of Game.spawnQueue) { if (c[t] !== undefined) c[t]++; }
  return c;
}

function hudPanel(x, y, w, h) {
  ctx.fillStyle = 'rgba(2, 6, 18, 0.72)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(127, 163, 209, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function typeGlyph(type, x, y) {
  const col = ENEMY_STATS[type].color;
  ctx.fillStyle = col;
  ctx.beginPath();
  if (type === 'chaser') {
    ctx.moveTo(x + 7, y); ctx.lineTo(x - 5, y + 5); ctx.lineTo(x - 5, y - 5);
  } else if (type === 'shooter') {
    ctx.rect(x - 5, y - 5, 10, 10);
  } else if (type === 'splitter') {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU - Math.PI / 2;
      const px = x + Math.cos(a) * 6, py = y + Math.sin(a) * 6;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
  } else {
    ctx.arc(x, y, 4, 0, TAU);
  }
  ctx.closePath(); ctx.fill();
}

function drawHUD() {
  // Top-left: score and best.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#eafcff';
  ctx.font = 'bold 26px "Segoe UI", sans-serif';
  ctx.fillText('SCORE ' + Game.score.toLocaleString('en-US'), 22, 38);
  ctx.font = '13px "Segoe UI", sans-serif';
  ctx.fillStyle = '#7fa3d1';
  ctx.fillText('BEST ' + Game.best.toLocaleString('en-US'), 22, 58);
  // Top-centre: campaign progress — DRIFT n / 10 with segment pips.
  ctx.textAlign = 'center';
  ctx.fillStyle = '#eafcff';
  ctx.font = 'bold 22px "Segoe UI", sans-serif';
  ctx.fillText('DRIFT ' + Game.wave + ' / ' + DRIFT_TOTAL, W / 2, 38);
  for (let i = 0; i < DRIFT_TOTAL; i++) {
    const px = W / 2 - (DRIFT_TOTAL * 18) / 2 + i * 18;
    ctx.fillStyle = i < Game.wave ? '#00e5ff' : 'rgba(127, 163, 209, 0.30)';
    if (i === Game.wave - 1) ctx.fillStyle = '#ffe14d';
    ctx.fillRect(px, 48, 14, 6);
  }
  // Top-right: lives (ship icons) and the HULL bar.
  ctx.textAlign = 'right';
  for (let i = 0; i < 3; i++) {
    const x = W - 30 - i * 30, y = 30;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = i < Game.lives ? '#00e5ff' : 'rgba(120, 140, 170, 0.25)';
    ctx.beginPath();
    ctx.moveTo(11, 0); ctx.lineTo(-8, 6); ctx.lineTo(-4, 0); ctx.lineTo(-8, -6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = 'rgba(127, 163, 209, 0.8)';
  ctx.font = 'bold 12px "Segoe UI", sans-serif';
  ctx.fillText('HULL', W - 132, 56);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(W - 124, 48, 100, 8);
  ctx.fillStyle = Game.lives === 1 ? '#ff5c5c' : '#00e5ff';
  ctx.fillRect(W - 124, 48, 100 * (Game.lives / 3), 8);
  // WIN / LOSE strip, in the leaders' style.
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(24, 110, 58, 0.85)';
  ctx.fillRect(22, 66, 272, 18);
  ctx.fillStyle = '#bfffd9';
  ctx.font = 'bold 12px "Segoe UI", sans-serif';
  ctx.fillText('WIN   SURVIVE 10 DRIFTS', 32, 79);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(140, 30, 50, 0.85)';
  ctx.fillRect(W - 294, 66, 272, 18);
  ctx.fillStyle = '#ffd7de';
  ctx.fillText('LOSE   HULL 0', W - 32, 79);
  // Named flagship bar, top centre, while the boss lives.
  const boss = enemies.find((e) => e.type === 'boss');
  if (boss) {
    const bw = 480, bx = (W - bw) / 2, by = 104;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f3e8ff';
    ctx.font = 'bold 14px "Segoe UI", sans-serif';
    ctx.fillText(BOSS_NAME, W / 2, by - 4);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx - 2, by, bw + 4, 14);
    ctx.fillStyle = '#2a0a3d';
    ctx.fillRect(bx, by + 2, bw, 10);
    ctx.fillStyle = '#b14bff';
    ctx.fillRect(bx, by + 2, bw * clamp(boss.hp / boss.maxHp, 0, 1), 10);
    ctx.strokeStyle = 'rgba(243, 232, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 2.5, by - 0.5, bw + 5, 15);
  }
  // INCOMING panel, left: the drift's enemy roster with counts.
  const inc = incomingCounts();
  const leftTotal = inc.chaser + inc.shooter + inc.splitter + inc.mini;
  hudPanel(22, 100, 196, 172);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#eafcff';
  ctx.font = 'bold 14px "Segoe UI", sans-serif';
  ctx.fillText('INCOMING', 34, 122);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffe14d';
  ctx.fillText(leftTotal + ' LEFT', 206, 122);
  ctx.strokeStyle = 'rgba(127, 163, 209, 0.3)';
  ctx.beginPath(); ctx.moveTo(34, 130); ctx.lineTo(206, 130); ctx.stroke();
  const rows = [
    ['chaser', 'Chaser'],
    ['shooter', 'Shooter'],
    ['splitter', 'Splitter'],
  ];
  rows.forEach((r, i) => {
    const ry = 152 + i * 26;
    typeGlyph(r[0], 42, ry);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#d7e9ff';
    ctx.font = '14px "Segoe UI", sans-serif';
    ctx.fillText(r[1], 56, ry + 5);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#eafcff';
    ctx.font = 'bold 14px "Segoe UI", sans-serif';
    ctx.fillText('x' + inc[r[0]], 206, ry + 5);
  });
  ctx.textAlign = 'left';
  ctx.fillStyle = inc.boss > 0 ? '#f3e8ff' : '#7fa3d1';
  ctx.font = 'bold 12px "Segoe UI", sans-serif';
  ctx.fillText(inc.boss > 0 ? 'FLAGSHIP ACTIVE' : (Game.wave < DRIFT_TOTAL ? 'NEXT: DRIFT ' + (Game.wave + 1) : 'FINAL DRIFT'), 34, 252);
  // Systems panel, right: combo + grade, cores, kills, dash, shield.
  hudPanel(1062, 100, 196, 172);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#7fa3d1';
  ctx.font = 'bold 12px "Segoe UI", sans-serif';
  ctx.fillText('COMBO', 1074, 122);
  if (Game.combo >= 2) {
    const mult = comboMultiplier();
    ctx.fillStyle = mult >= 5 ? '#ffe14d' : '#ffb84d';
    ctx.font = 'bold 26px "Segoe UI", sans-serif';
    ctx.fillText('x' + mult, 1074, 152);
    ctx.fillStyle = 'rgba(255, 225, 77, 0.5)';
    ctx.fillRect(1074, 158, 100 * clamp(Game.comboTimer / 3, 0, 1), 4);
    // Grade circle.
    ctx.beginPath();
    ctx.arc(1228, 142, 17, 0, TAU);
    ctx.fillStyle = comboGrade() === 'S' ? '#ffe14d' : 'rgba(255, 225, 77, 0.25)';
    ctx.fill();
    ctx.strokeStyle = '#ffe14d';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#1a1200';
    ctx.font = 'bold 18px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(comboGrade(), 1228, 148);
    ctx.textAlign = 'left';
  } else {
    ctx.fillStyle = '#5f7ba6';
    ctx.font = 'bold 22px "Segoe UI", sans-serif';
    ctx.fillText('—', 1074, 152);
  }
  ctx.strokeStyle = 'rgba(127, 163, 209, 0.3)';
  ctx.beginPath(); ctx.moveTo(1074, 170); ctx.lineTo(1246, 170); ctx.stroke();
  ctx.fillStyle = '#d7e9ff';
  ctx.font = '14px "Segoe UI", sans-serif';
  ctx.fillText('◆ NOVA CORES', 1074, 194);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#7df9ff';
  ctx.font = 'bold 15px "Segoe UI", sans-serif';
  ctx.fillText(String(Game.cores), 1246, 194);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#d7e9ff';
  ctx.font = '14px "Segoe UI", sans-serif';
  ctx.fillText('KILLS', 1074, 216);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#eafcff';
  ctx.font = 'bold 15px "Segoe UI", sans-serif';
  ctx.fillText(String(Game.kills), 1246, 216);
  ctx.textAlign = 'left';
  const dashFrac = 1 - clamp(player.dashCd / 2.2, 0, 1);
  ctx.fillStyle = 'rgba(127, 163, 209, 0.8)';
  ctx.font = 'bold 12px "Segoe UI", sans-serif';
  ctx.fillText('DASH', 1074, 240);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(1120, 232, 80, 7);
  ctx.fillStyle = dashFrac >= 1 ? '#00e5ff' : '#2e6f8e';
  ctx.fillRect(1120, 232, 80 * dashFrac, 7);
  ctx.fillStyle = player.shield ? '#39ff6a' : '#5f7ba6';
  ctx.font = 'bold 12px "Segoe UI", sans-serif';
  ctx.fillText(player.shield ? '◆ SHIELD UP' : '◇ SHIELD —', 1074, 262);
  // Wave banner.
  if (Game.bannerTimer > 0) {
    const a = clamp(Game.bannerTimer / 0.4, 0, 1);
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffe14d';
    ctx.font = 'bold 54px "Segoe UI", sans-serif';
    ctx.fillText(Game.bannerText, W / 2, H / 2 - 20);
    ctx.fillStyle = '#9fd8ff';
    ctx.font = '18px "Segoe UI", sans-serif';
    ctx.fillText(Game.bannerText.indexOf('FLAGSHIP') === 0 ? 'BREAK THE FLAGSHIP' : 'CLEAR THE FIELD — DRIFT ' + Game.wave + ' OF ' + DRIFT_TOTAL, W / 2, H / 2 + 16);
    ctx.globalAlpha = 1;
  }
  if (Game.paused) {
    ctx.fillStyle = 'rgba(2, 2, 12, 0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#eafcff';
    ctx.font = 'bold 48px "Segoe UI", sans-serif';
    ctx.fillText('PAUSED', W / 2, H / 2);
    ctx.font = '16px "Segoe UI", sans-serif';
    ctx.fillStyle = '#7fa3d1';
    ctx.fillText('Press P to resume', W / 2, H / 2 + 36);
  }
}

function drawTitle() {
  drawBackground();
  // A busy drifting backdrop: glowing ships and hunters on the move.
  for (const e of enemies) drawEnemy(e);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const tg = ctx.createRadialGradient(W / 2, 240, 0, W / 2, 240, 260);
  tg.addColorStop(0, 'rgba(0, 229, 255, 0.10)');
  tg.addColorStop(1, 'rgba(0, 229, 255, 0)');
  ctx.fillStyle = tg;
  ctx.beginPath(); ctx.arc(W / 2, 240, 260, 0, TAU); ctx.fill();
  ctx.restore();
  ctx.textAlign = 'center';
  const pulse = 0.75 + 0.25 * Math.sin(Game.time * 2.4);
  ctx.globalAlpha = pulse;
  ctx.fillStyle = '#00e5ff';
  ctx.font = 'bold 92px "Segoe UI", sans-serif';
  ctx.fillText('NOVA DRIFT', W / 2, 240);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#b14bff';
  ctx.font = 'bold 92px "Segoe UI", sans-serif';
  ctx.globalAlpha = 0.25;
  ctx.fillText('NOVA DRIFT', W / 2 + 4, 244);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 22px "Segoe UI", sans-serif';
  ctx.fillText('10 DRIFTS — BREAK THE FLAGSHIP', W / 2, 286);
  ctx.fillStyle = '#ffe14d';
  ctx.font = '20px "Segoe UI", sans-serif';
  ctx.fillText('Survive the swarm. Chain kills. Break the flagship.', W / 2, 320);
  ctx.fillStyle = '#d7e9ff';
  ctx.font = '17px "Segoe UI", sans-serif';
  ctx.fillText('WASD / arrows — move      Mouse — aim      Hold click / Space — shoot', W / 2, 388);
  ctx.fillText('Shift — dash (brief invulnerability)      P — pause      M — mute      R — restart', W / 2, 418);
  ctx.fillStyle = '#7fa3d1';
  ctx.font = '15px "Segoe UI", sans-serif';
  ctx.fillText('Chasers hunt you. Shooters snipe. Splitters break in two. The flagship', W / 2, 462);
  ctx.fillText('THE HOLLOW STAR guards drifts 5 and 10 — and the drift is won at 10.', W / 2, 486);
  ctx.fillStyle = '#d7e9ff';
  ctx.font = '15px "Segoe UI", sans-serif';
  ctx.fillText('Grab NOVA CORES, keep your combo alive, and do not let your hull reach 0.', W / 2, 522);
  if (Game.best > 0) {
    ctx.fillStyle = '#ffe14d';
    ctx.font = 'bold 18px "Segoe UI", sans-serif';
    ctx.fillText('BEST SCORE  ' + Game.best.toLocaleString('en-US'), W / 2, 556);
  }
  const blink = (Game.time % 1.2) < 0.85;
  if (blink) {
    ctx.fillStyle = '#eafcff';
    ctx.font = 'bold 24px "Segoe UI", sans-serif';
    ctx.fillText('CLICK OR PRESS ENTER TO START', W / 2, 618);
  }
}

function drawGameOver() {
  drawBackground();
  for (const e of enemies) drawEnemy(e);
  ctx.fillStyle = 'rgba(2, 2, 12, 0.55)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ff2d55';
  ctx.font = 'bold 72px "Segoe UI", sans-serif';
  ctx.fillText('GAME OVER', W / 2, 240);
  ctx.fillStyle = '#9fd8ff';
  ctx.font = '20px "Segoe UI", sans-serif';
  ctx.fillText('THE HOLLOW STAR KEEPS THE DRIFT — FOR NOW', W / 2, 282);
  ctx.fillStyle = '#eafcff';
  ctx.font = 'bold 34px "Segoe UI", sans-serif';
  ctx.fillText('FINAL SCORE  ' + Game.score.toLocaleString('en-US'), W / 2, 340);
  ctx.font = '22px "Segoe UI", sans-serif';
  ctx.fillStyle = '#9fd8ff';
  ctx.fillText('DRIFT REACHED  ' + Game.wave + ' / ' + DRIFT_TOTAL + '      KILLS  ' + Game.kills + '      NOVA CORES  ' + Game.cores, W / 2, 388);
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 20px "Segoe UI", sans-serif';
  ctx.fillText('BEST SCORE  ' + Game.best.toLocaleString('en-US'), W / 2, 430);
  const blink = (Game.time % 1.2) < 0.85;
  if (blink) {
    ctx.fillStyle = '#eafcff';
    ctx.font = 'bold 24px "Segoe UI", sans-serif';
    ctx.fillText('PRESS R TO PLAY AGAIN', W / 2, 508);
  }
}

function drawVictory() {
  drawBackground();
  for (const e of enemies) drawEnemy(e);
  ctx.fillStyle = 'rgba(2, 2, 12, 0.45)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 64px "Segoe UI", sans-serif';
  ctx.fillText('CAMPAIGN COMPLETE', W / 2, 240);
  ctx.fillStyle = '#eafcff';
  ctx.font = '20px "Segoe UI", sans-serif';
  ctx.fillText('ALL 10 DRIFTS CLEARED — THE HOLLOW STAR IS BROKEN', W / 2, 282);
  ctx.fillStyle = '#eafcff';
  ctx.font = 'bold 34px "Segoe UI", sans-serif';
  ctx.fillText('FINAL SCORE  ' + Game.score.toLocaleString('en-US'), W / 2, 340);
  ctx.font = '22px "Segoe UI", sans-serif';
  ctx.fillStyle = '#9fd8ff';
  ctx.fillText('KILLS  ' + Game.kills + '      NOVA CORES  ' + Game.cores + '      HULL LEFT  ' + Game.lives + ' / 3', W / 2, 388);
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 20px "Segoe UI", sans-serif';
  ctx.fillText('BEST SCORE  ' + Game.best.toLocaleString('en-US'), W / 2, 430);
  const blink = (Game.time % 1.2) < 0.85;
  if (blink) {
    ctx.fillStyle = '#eafcff';
    ctx.font = 'bold 24px "Segoe UI", sans-serif';
    ctx.fillText('PRESS R TO DRIFT AGAIN', W / 2, 508);
  }
}

/* ------------------------------ main loop -------------------------------- */
let lastT = 0;
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.033, (t - lastT) / 1000 || 0.016);
  lastT = t;
  Game.time += dt;
  Game.shake = Math.max(0, Game.shake - 30 * dt);
  Game.flash = Math.max(0, Game.flash - 1.4 * dt);

  if (Game.state === 'title') {
    for (const e of enemies) { e.t += dt; e.x += e.vx * dt; e.y += e.vy * dt; if (e.x < -60) e.x = W + 50; if (e.x > W + 60) e.x = -50; if (e.y < -60) e.y = H + 50; if (e.y > H + 60) e.y = -50; }
    drawTitle();
    return;
  }
  if (Game.state === 'gameover') {
    updateParticles(dt);
    for (const e of enemies) { e.t += dt; e.x += e.vx * dt; e.y += e.vy * dt; if (e.x < -60) e.x = W + 50; if (e.x > W + 60) e.x = -50; if (e.y < -60) e.y = H + 50; if (e.y > H + 60) e.y = -50; }
    drawGameOver();
    return;
  }
  if (Game.state === 'victory') {
    updateParticles(dt);
    for (const e of enemies) { e.t += dt; e.x += e.vx * dt; e.y += e.vy * dt; if (e.x < -60) e.x = W + 50; if (e.x > W + 60) e.x = -50; if (e.y < -60) e.y = H + 50; if (e.y > H + 60) e.y = -50; }
    drawVictory();
    return;
  }
  // Playing.
  if (!Game.paused) {
    updatePlayer(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updateOrbs(dt);
    updateParticles(dt);
    checkCollisions();
    updateWaves(dt);
    if (Game.comboTimer > 0) {
      Game.comboTimer -= dt;
      if (Game.comboTimer <= 0) Game.combo = 0;
    }
  }
  ctx.save();
  if (Game.shake > 0.3) ctx.translate(rand(-Game.shake, Game.shake) * 0.5, rand(-Game.shake, Game.shake) * 0.5);
  drawWorld();
  drawHUD();
  ctx.restore();
}

/* ------------------------------ demo hooks ------------------------------- */
/* URL params used ONLY to stage screenshots. They never affect normal play.
   ?demo=1        start at drift 3 with the autopilot flying the ship
   ?state=boss    jump straight into the drift-5 flagship fight (autopilot on)
   ?state=gameover show the game-over screen with a plausible score          */
function applyDemoParams() {
  const q = new URLSearchParams(window.location.search);
  if (q.get('state') === 'gameover') {
    Game.score = 12480;
    Game.wave = 7;
    Game.kills = 96;
    Game.cores = 118;
    if (Game.best < 12480) Game.best = 12480;
    Game.state = 'gameover';
    seedDecorDrift();
    return;
  }
  if (q.get('state') === 'boss') {
    Game.autopilot = true;
    startGame();
    Game.wave = 5;
    Game.score = 9800;
    Game.kills = 58;
    Game.cores = 73;
    Game.combo = 8;
    Game.comboTimer = 3;
    Game.spawnQueue = ['chaser', 'chaser', 'shooter', 'chaser', 'shooter', 'splitter'];
    Game.bannerTimer = 0;
    const boss = spawnBoss();
    boss.burstTimer = 0.8; // open with a radial burst while the shot is taken
    boss.hp = Math.round(boss.maxHp * 0.62); // stage it mid-fight, bar partly spent
    // A busy flagship fight: escorts already in, orbs and wreckage on field.
    // Escorts start spread across the play area (not at the edges) so the
    // frame is busy the moment the shot is taken.
    for (const t of ['chaser', 'shooter', 'splitter', 'chaser', 'shooter', 'mini', 'mini']) stageEnemy(t);
    spawnOrbs(W / 2 - 200, H / 2 + 80, 5);
    spawnOrbs(W / 2 + 240, H / 2 - 40, 4);
    explode(W / 2 - 260, 300, '#ff2d78', 26);
    explode(W / 2 + 300, 420, '#ff9f1c', 22);
    return;
  }
  if (q.get('demo') === '1') {
    Game.autopilot = true;
    startGame();
    Game.wave = 3;
    Game.score = 5150;
    Game.kills = 34;
    Game.cores = 41;
    Game.combo = 6;
    Game.comboTimer = 3;
    Game.spawnQueue = buildWave(3);
    Game.bannerTimer = 0;
    // Stage a busy field at once: twenty enemies spread across the play
    // area (not trickling in from the edges), with the drift's queue still
    // feeding reinforcements behind them, plus orbs and a fresh explosion
    // so the frame reads as mid-battle.
    const demoTypes = ['chaser', 'chaser', 'shooter', 'splitter', 'chaser',
      'shooter', 'chaser', 'splitter', 'chaser', 'shooter', 'chaser',
      'shooter', 'splitter', 'mini', 'mini', 'chaser', 'shooter',
      'splitter', 'chaser', 'mini'];
    for (const t of demoTypes) stageEnemy(t);
    spawnOrbs(W / 2 - 160, H / 2 + 60, 6);
    spawnOrbs(W / 2 + 200, H / 2 - 60, 5);
    explode(W / 2 - 220, 260, '#ff2d78', 30);
    explode(W / 2 + 260, 430, '#39ff6a', 26);
    return;
  }
}

// Spawn one enemy at a random interior position, clear of the HUD panels,
// so screenshot staging shows a field that is busy from the first frame.
function stageEnemy(type) {
  return spawnEnemy(type, rand(170, W - 170), rand(150, H - 70));
}

/* Decorative drifting enemies for the title / game-over backdrops. */
function seedDecorDrift() {
  enemies = [];
  const types = ['chaser', 'shooter', 'splitter', 'mini'];
  for (let i = 0; i < 14; i++) {
    const e = spawnEnemy(pick(types), rand(0, W), rand(0, H));
    e.decor = true;
    const a = rand(0, TAU);
    e.vx = Math.cos(a) * 26;
    e.vy = Math.sin(a) * 26;
  }
}

/* ------------------------------ boot ------------------------------------- */
initStars();
seedDecorDrift();
applyDemoParams();
requestAnimationFrame(loop);
