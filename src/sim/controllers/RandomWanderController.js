import { NPC_EVENTS } from '../npc/NPCEvents.js';

/**
 * RandomWanderController (NO pathfinding)
 * --------------------------------------
 * - Moves by stepping to adjacent tiles only (O(1))
 * - Avoids ping-pong (A<->B) via:
 *    - no immediate backtrack (unless dead-end)
 *    - short-term memory of recent tiles (tabu)
 * - Momentum: continues direction for a burst of steps
 */
export class RandomWanderController {
  constructor(scene, npc, GRID, {
    minWaitMs = 300,
    maxWaitMs = 900,

    // "burst" length: how many steps before re-choosing behavior
    burstMinSteps = 4,
    burstMaxSteps = 14,

    // chance to try keep going straight when possible
    keepDirChance = 0.75,

    // remember last N tiles and avoid them when picking next step
    memorySize = 10,

    // if true, slightly prefer tiles with more exits (less dead-end bouncing)
    preferOpenAreas = true
  } = {}) {
    this.scene = scene;
    this.npc = npc;
    this.GRID = GRID;

    this.minWaitMs = minWaitMs;
    this.maxWaitMs = maxWaitMs;

    this.burstMinSteps = burstMinSteps;
    this.burstMaxSteps = burstMaxSteps;
    this.keepDirChance = keepDirChance;

    this.memorySize = memorySize;
    this.preferOpenAreas = preferOpenAreas;

    this._timer = null;
    this._active = false;

    this._dir = null; // {dx,dy}
    this._stepsLeft = 0;

    this._mem = [];          // queue of "x,y"
    this._memSet = new Set(); // fast lookup

    this._onArrived = () => this._continueBurstOrSchedule();
    this._onStuck = () => this._handleStuck();
  }

  onStart() {
    this._active = true;
    this._bind();
    this.scheduleNext();
  }

  onPause() {
    this._active = false;
    this._unbind();
    this._clearTimer();
  }

  onResume() {
    this._active = true;
    this._bind();
    this.scheduleNext();
  }

  onStop() {
    this._active = false;
    this._unbind();
    this._clearTimer();
    this.npc?.stop?.('wander_stop');
  }

  update() {}

  _bind() {
    if (!this.npc) return;
    this.npc.on(NPC_EVENTS.ARRIVED, this._onArrived);
    this.npc.on(NPC_EVENTS.STUCK, this._onStuck);
  }

  _unbind() {
    if (!this.npc) return;
    this.npc.off(NPC_EVENTS.ARRIVED, this._onArrived);
    this.npc.off(NPC_EVENTS.STUCK, this._onStuck);
  }

  _clearTimer() {
    if (this._timer) {
      this._timer.remove(false);
      this._timer = null;
    }
  }

  scheduleNext() {
    if (!this._active) return;

    this._clearTimer();
    const waitMs = Phaser.Math.Between(this.minWaitMs, this.maxWaitMs);

    this._timer = this.scene.time.delayedCall(waitMs, () => {
      this._timer = null;
      this._startBurst();
      this._stepOnce();
    });
  }

  _startBurst() {
    this._stepsLeft = Phaser.Math.Between(this.burstMinSteps, this.burstMaxSteps);
  }

  _continueBurstOrSchedule() {
    if (!this._active) return;

    // Record tile into memory when we "arrive" at it
    this._rememberTile(this.npc.tileX, this.npc.tileY);

    this._stepsLeft--;
    if (this._stepsLeft <= 0) {
      this.scheduleNext();
      return;
    }

    // Small jitter delay so it doesn’t feel robotic
    this._clearTimer();
    this._timer = this.scene.time.delayedCall(0, () => this._stepOnce());
  }

  _handleStuck() {
    if (!this._active) return;
    // If stuck, break momentum and try a new direction soon
    this._dir = null;
    this._stepsLeft = Math.min(this._stepsLeft, 2);
    this.scheduleNext();
  }

  _rememberTile(x, y) {
    if (this.memorySize <= 0) return;

    const k = `${x},${y}`;
    this._mem.push(k);
    this._memSet.add(k);

    while (this._mem.length > this.memorySize) {
      const old = this._mem.shift();
      // Only delete if not duplicated later in the queue
      if (!this._mem.includes(old)) this._memSet.delete(old);
    }
  }

  _stepOnce() {
    if (!this._active) return;
    if (!this.npc || this.npc.isBusy?.()) return;

    const next = this._pickNextNeighbor();
    if (!next) {
      this.scheduleNext();
      return;
    }

    // Requires NPC.stepToTile(x,y) (no pathfinding)
    const ok = this.npc.stepToTile(next.x, next.y, { showIndicator: false });
    if (!ok) {
      this.scheduleNext();
      return;
    }
  }

  _pickNextNeighbor() {
    const x = this.npc.tileX;
    const y = this.npc.tileY;

    const dirs = [
      { dx: 0, dy: -1 },
      { dx: 0, dy:  1 },
      { dx: -1, dy: 0 },
      { dx:  1, dy: 0 }
    ];

    const isBlocked = (tx, ty) => this.GRID.isBlocked(tx, ty);

    const back = this._dir ? { dx: -this._dir.dx, dy: -this._dir.dy } : null;

    // 1) Momentum: try keep direction
    if (this._dir && Math.random() < this.keepDirChance) {
      const nx = x + this._dir.dx;
      const ny = y + this._dir.dy;
      if (this.GRID.inBounds(nx, ny) && !isBlocked(nx, ny)) {
        const k = `${nx},${ny}`;
        // still respect memory if possible
        if (!this._memSet.has(k)) return { x: nx, y: ny };
      }
    }

    // 2) Build candidates, strongly avoid immediate backtrack and recent tiles
    let candidates = [];
    let fallback = []; // if we must ignore memory/backtrack

    for (const d of dirs) {
      const nx = x + d.dx;
      const ny = y + d.dy;

      if (!this.GRID.inBounds(nx, ny)) continue;
      if (isBlocked(nx, ny)) continue;

      const k = `${nx},${ny}`;

      const isBack = back && d.dx === back.dx && d.dy === back.dy;
      const inMemory = this._memSet.has(k);

      // fallback: any legal neighbor
      fallback.push({ d, nx, ny, score: 0 });

      // primary candidates: not back + not in memory
      if (!isBack && !inMemory) {
        candidates.push({ d, nx, ny, score: 0 });
      }
    }

    // If no candidates, relax memory constraint (still avoid back if possible)
    if (!candidates.length) {
      for (const item of fallback) {
        const isBack = back && item.d.dx === back.dx && item.d.dy === back.dy;
        if (!isBack) candidates.push(item);
      }
    }

    // If still none, allow backtracking (dead-end)
    if (!candidates.length) candidates = fallback;

    if (!candidates.length) return null;

    // 3) Optional: prefer open areas (reduces corner ping-pong)
    if (this.preferOpenAreas) {
      for (const c of candidates) {
        c.score = this._countFreeNeighbors(c.nx, c.ny);
      }
      const maxScore = Math.max(...candidates.map(c => c.score));
      const best = candidates.filter(c => c.score === maxScore);
      const pick = best[(Math.random() * best.length) | 0];
      this._dir = pick.d;
      return { x: pick.nx, y: pick.ny };
    }

    // 4) Pure random among candidates
    const pick = candidates[(Math.random() * candidates.length) | 0];
    this._dir = pick.d;
    return { x: pick.nx, y: pick.ny };
  }

  _countFreeNeighbors(x, y) {
    let n = 0;
    const checks = [
      { x, y: y - 1 },
      { x, y: y + 1 },
      { x: x - 1, y },
      { x: x + 1, y }
    ];
    for (const p of checks) {
      if (!this.GRID.inBounds(p.x, p.y)) continue;
      if (this.GRID.isBlocked(p.x, p.y)) continue;
      n++;
    }
    return n;
  }
}