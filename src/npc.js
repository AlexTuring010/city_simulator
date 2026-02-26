/**
 * NPC Class (Simulation-first, Rendering-optional)
 * ------------------------------------------------
 * Goal:
 * - Keep this class usable in both "rendered" mode (Phaser sprites/graphics)
 *   and future "headless" mode (no Phaser objects, fast simulation).
 *
 * IMPORTANT DESIGN RULES (so headless is easy later):
 *
 * 1) Do NOT depend on Phaser display objects outside this file.
 *    - Other systems should NOT read/write npc.sprite, npc.arrowG, npc.pathSegments.
 *    - Treat sprite/graphics as an internal implementation detail of NPC.
 *
 * 2) Prefer simulation state as the source of truth:
 *    - Use npc.tileX / npc.tileY (and ideally npc.x / npc.y if you add them later)
 *      as the authoritative position.
 *    - Avoid using npc.sprite.x / npc.sprite.y in external code.
 *
 * 3) Interact via public API + events, not visuals:
 *    - Use npc.goToTile(...) / npc.stop() / npc.wait(...) / npc.isBusy()
 *    - Subscribe to npc events: 'arrived', 'stuck', 'stateChanged', etc.
 *
 * 4) Rendering features are optional/debug-only:
 *    - Path indicator (scribble/arrow) must remain optional via showIndicator.
 *    - In headless mode we will skip drawPathIndicator() entirely.
 *
 * 5) Avoid tying game logic to per-frame movement or draw rate:
 *    - External systems should not assume the NPC advances one node per frame.
 *    - In headless mode movement may be replaced by ETA scheduling
 *      (compute travel time and emit 'arrived' later without step-by-step walking).
 *
 * 6) Pathfinding usage should remain inside NPC (or behind an abstraction):
 *    - External code should not call findPath() directly for NPC travel.
 *    - In headless mode we may replace tile A* with Manhattan ETA + small obstacle penalty,
 *      or coarse graph routing + caching, without changing external systems.
 *
 * Allowed external reads:
 * - npc.tileX, npc.tileY, npc.state, npc.facing (optional), npc._goal (prefer not)
 *
 * Avoid external reads:
 * - npc.sprite.*, npc.pathCache/pathSegments/arrowG, npc.path (internal / render-specific)
 *
 * If you later add: constructor(..., { render = true } = {})
 * - When render=false:
 *   - Do not create sprite/graphics, skip drawPathIndicator, and drive movement by ETA.
 */

// I have not yet implemented the renderless mode, but I want to keep the code organized so that it's easy to remove Phaser dependencies later. 
// Hence, all Phaser-related code (sprite creation, graphics drawing) is contained within this NPC class, and external systems should only interact 
// with it via the public API and events.

// This may become essential later if we decide that we wanna run the simulator for 500k people in a city the size of Athens for
// example to calculate useful metrics. In that case, we can run the simulation in a headless mode without rendering, and only use
// the NPC class for its pathfinding and movement logic, while skipping all the Phaser-related code. 

import { findPath } from './pathfinding.js';
import {
  ARROW_ALPHA,
  buildScribblePoints,
  catmullRomInterpolate,
  decimatePoints,
  strokeMarkerFast
} from './scribble.js';

export class NPC {
  constructor(scene, GRID, startTileX, startTileY) {
    this.pathCacheIdx = 0;
    this.pathSeed = (Math.random() * 1e9) | 0;
    this.scene = scene;
    this.GRID = GRID;

    // events API
    this.events = new Phaser.Events.EventEmitter();

    this.facing = 'down';
    this.tileX = startTileX;
    this.tileY = startTileY;

    const pos = GRID.tileToWorld(this.tileX, this.tileY);

    this.sprite = scene.add.sprite(pos.x, pos.y, 'npc_sprite', 15);
    this.sprite.setOrigin(0.5, 1);

    // path indicator graphics
    this.pathSegments = [];
    this.arrowG = null;

    // path state
    this.pathDirty = true;
    this.pathCache = null;

    // movement state
    this.state = 'IDLE'; // 'IDLE' | 'WAITING' | 'MOVING'
    this.path = [];
    this.targetNode = null;
    this.speed = 1;

    this._waitTimer = null;
    this._goal = null; // {x,y} of the final destination (optional)

    // -----------------------------------------
    // Path indicator options (per-goal configurable)
    // -----------------------------------------
    this.showPathIndicator = true;      // can be toggled per goToTile()
    this.pathIndicatorColor = 0x33ff77; // can be set per goToTile()

    // -----------------------------------------
    // Indicator redraw state (avoid clear+stroke unless needed)
    // -----------------------------------------
    this._indicatorState = {
      lastIdx: -1,
      lastStartX: 0,
      lastStartY: 0,
      lastColor: null,
      lastCacheRef: null,
      lastArrowY: 0
    };

    this.setIdleFacing();
  }

  // ---------------------------
  // External API (events)
  // ---------------------------
  on(eventName, fn, context) {
    this.events.on(eventName, fn, context);
    return this;
  }
  off(eventName, fn, context) {
    this.events.off(eventName, fn, context);
    return this;
  }

  // ---------------------------
  // External API (controls)
  // ---------------------------
  stop(reason = 'stopped') {
    if (this._waitTimer) {
      this._waitTimer.remove(false);
      this._waitTimer = null;
    }

    this.state = 'IDLE';
    this.path = [];
    this.targetNode = null;
    this._goal = null;

    this.pathCache = null;
    this.pathCacheIdx = 0;
    this.pathDirty = true;

    // reset indicator state too
    if (this._indicatorState) {
      this._indicatorState.lastIdx = -1;
      this._indicatorState.lastCacheRef = null;
    }

    // When stopping, also hide indicator immediately
    for (const g of this.pathSegments) g.setVisible(false);
    if (this.arrowG) this.arrowG.setVisible(false);

    this.setIdleFacing();
    this.events.emit('stateChanged', this.state);
    this.events.emit('stopped', { reason });
  }

  wait(ms = 1000) {
    if (this._waitTimer) this._waitTimer.remove(false);

    this.state = 'WAITING';
    this.setIdleFacing();
    this.events.emit('stateChanged', this.state);

    this._waitTimer = this.scene.time.delayedCall(ms, () => {
      this._waitTimer = null;
      this.state = 'IDLE';
      this.events.emit('stateChanged', this.state);
      this.events.emit('waitDone');
    });

    return true;
  }

  /**
   * Go to a tile.
   *
   * Options:
   * - allowBlocked: if true, allow goal even if blocked
   * - showIndicator: if false, do NOT render path/arrow indicator for this go
   * - indicatorColor: 0xRRGGBB (Phaser color int), used for line + arrow
   */
  goToTile(
    goalX,
    goalY,
    {
      allowBlocked = false,
      showIndicator = true,
      indicatorColor = 0x33ff77
    } = {}
  ) {
    // Apply per-goal indicator settings
    this.showPathIndicator = !!showIndicator;
    this.pathIndicatorColor = indicatorColor;

    // If indicator is disabled, hide any existing indicator now
    if (!this.showPathIndicator) {
      for (const g of this.pathSegments) g.setVisible(false);
      if (this.arrowG) this.arrowG.setVisible(false);
    }

    if (!allowBlocked && this.GRID.isBlocked(goalX, goalY)) {
      this.events.emit('stuck', { reason: 'goal_blocked', goalX, goalY });
      return false;
    }

    const path = findPath(this.GRID, this.tileX, this.tileY, goalX, goalY);
    if (!path || path.length <= 1) {
      this.events.emit('stuck', { reason: 'no_path', goalX, goalY });
      return false;
    }

    // cancel any wait
    if (this._waitTimer) {
      this._waitTimer.remove(false);
      this._waitTimer = null;
    }

    // update state/path
    this._goal = { x: goalX, y: goalY };

    // stable scribble seed per-goal
    this.pathSeed = (this.pathSeed ^ (goalX * 73856093) ^ (goalY * 19349663)) | 0;

    this.path = path.slice();
    this.path.shift(); // remove current tile
    this.targetNode = this.path.shift();

    this.state = 'MOVING';
    this.pathCache = null;
    this.pathCacheIdx = 0;
    this.pathDirty = true;

    // force next indicator draw
    if (this._indicatorState) {
      this._indicatorState.lastIdx = -1;
      this._indicatorState.lastCacheRef = null;
    }

    this.events.emit('stateChanged', this.state);
    this.events.emit('goalSet', { goalX, goalY });
    return true;
  }

  isBusy() {
    return this.state === 'MOVING' || this.state === 'WAITING';
  }

  // ---------------------------
  // Animation helper
  // ---------------------------
  setIdleFacing() {
    const key =
      this.facing === 'right' ? 'npc_walk_right' :
      this.facing === 'left'  ? 'npc_walk_left'  :
      this.facing === 'up'    ? 'npc_walk_up'    :
                                'npc_walk_down';

    this.sprite.anims.play(key, true);
    this.sprite.anims.pause();
    this.sprite.anims.setProgress(0);
  }

  // ---------------------------
  // Per-frame update
  // ---------------------------
  update() {
    if (this.state !== 'MOVING' || !this.targetNode) {
      for (const g of this.pathSegments) g.setVisible(false);
      if (this.arrowG) this.arrowG.setVisible(false);
      this.sprite.setDepth(this.sprite.y);
      return;
    }

    const targetWorld = this.GRID.tileToWorld(this.targetNode.x, this.targetNode.y);
    const distance = Phaser.Math.Distance.Between(
      this.sprite.x, this.sprite.y,
      targetWorld.x, targetWorld.y
    );

    if (distance < this.speed) {
      // snap to target node
      this.sprite.x = targetWorld.x;
      this.sprite.y = targetWorld.y;
      this.tileX = this.targetNode.x;
      this.tileY = this.targetNode.y;

      if (this.path.length > 0) {
        this.targetNode = this.path.shift();
      } else {
        // arrived at final tile
        const arrivedGoal = this._goal;
        this.targetNode = null;
        this._goal = null;

        this.pathCache = null;
        this.pathCacheIdx = 0;

        // reset indicator draw state
        if (this._indicatorState) {
          this._indicatorState.lastIdx = -1;
          this._indicatorState.lastCacheRef = null;
        }

        this.state = 'IDLE';
        this.setIdleFacing();
        this.events.emit('stateChanged', this.state);
        this.events.emit('arrived', {
          tileX: this.tileX,
          tileY: this.tileY,
          goal: arrivedGoal
        });
      }
    } else {
      // move toward node
      const angle = Phaser.Math.Angle.Between(
        this.sprite.x, this.sprite.y,
        targetWorld.x, targetWorld.y
      );

      this.sprite.x += Math.cos(angle) * this.speed;
      this.sprite.y += Math.sin(angle) * this.speed;

      // update facing (tile-based intent)
      if (this.targetNode.x > this.tileX) { this.facing = 'right'; this.sprite.anims.play('npc_walk_right', true); }
      else if (this.targetNode.x < this.tileX) { this.facing = 'left'; this.sprite.anims.play('npc_walk_left', true); }
      else if (this.targetNode.y > this.tileY) { this.facing = 'down'; this.sprite.anims.play('npc_walk_down', true); }
      else if (this.targetNode.y < this.tileY) { this.facing = 'up'; this.sprite.anims.play('npc_walk_up', true); }
    }

    // Draw indicator only if enabled for this goal
    if (this.showPathIndicator && this.targetNode) {
      const nextWorld = this.GRID.tileToWorld(this.targetNode.x, this.targetNode.y);
      this.drawPathIndicator(nextWorld);
    } else {
      // ensure hidden when disabled
      this.drawPathIndicator(null);
    }

    this.sprite.setDepth(this.sprite.y);
  }

  // ---------------------------
  // Path indicator (scribble + trimming)
  // ---------------------------
  drawPathIndicator(nextWorld) {
    // If indicator is disabled, force hide and exit
    if (!this.showPathIndicator) {
      for (const g of this.pathSegments) g.setVisible(false);
      if (this.arrowG) this.arrowG.setVisible(false);
      return;
    }

    // Per-goal (or default) color
    const color = this.pathIndicatorColor ?? 0x33ff77;

    const yOffset = this.GRID.tileH * 0.5;

    // Ensure fields exist
    if (this.lastPathDraw === undefined) this.lastPathDraw = 0;
    if (this.pathSeed === undefined) this.pathSeed = ((Math.random() * 1e9) | 0);
    if (this.pathCacheIdx === undefined) this.pathCacheIdx = 0;
    if (!this._indicatorState) {
      this._indicatorState = {
        lastIdx: -1,
        lastStartX: 0,
        lastStartY: 0,
        lastColor: null,
        lastCacheRef: null,
        lastArrowY: 0
      };
    }

    // If no target, hide and exit
    if (!nextWorld) {
      for (const g of this.pathSegments) g.setVisible(false);
      if (this.arrowG) this.arrowG.setVisible(false);
      return;
    }

    // Start point anchored to *current* sprite position
    const startPt = { x: this.sprite.x, y: this.sprite.y - yOffset };

    // Throttle drawing (keep visibility correct regardless)
    const now = this.scene.time.now;
    const canRedraw = (now - this.lastPathDraw) >= 50; // ~20 FPS
    if (canRedraw) this.lastPathDraw = now;

    // 1) Build cached scribble curve only when dirty
    if ((this.pathDirty || !this.pathCache) && canRedraw) {
      const raw = [];
      raw.push(startPt);

      // Always include the immediate next node
      const first = { x: nextWorld.x, y: nextWorld.y - yOffset };
      raw.push(first);

      // Cap by pixel length so huge paths don’t lag
      const MAX_PIXELS = 500;
      let acc = 0;
      let last = first;

      for (let i = 0; i < this.path.length; i++) {
        const wp = this.GRID.tileToWorld(this.path[i].x, this.path[i].y);
        const pt = { x: wp.x, y: wp.y - yOffset };

        acc += Math.hypot(pt.x - last.x, pt.y - last.y);
        if (acc > MAX_PIXELS) break;

        raw.push(pt);
        last = pt;
      }

      const nodeCount = raw.length;

      // Adaptive sampling for performance
      const samplesPerSegment = nodeCount > 20 ? 2 : nodeCount > 12 ? 3 : 5;
      const splineSamples     = nodeCount > 20 ? 2 : nodeCount > 12 ? 3 : 5;

      // IMPORTANT: stable seed (do NOT use sprite position)
      const jittered = buildScribblePoints(raw, 2, samplesPerSegment, this.pathSeed);
      const smooth   = catmullRomInterpolate(jittered, splineSamples);

      const minDist = nodeCount > 20 ? 10 : 8;
      this.pathCache = decimatePoints(smooth, minDist);

      // reset trimming position when a new cached curve is built
      this.pathCacheIdx = 0;
      this.pathDirty = false;

      // force a redraw next section
      this._indicatorState.lastIdx = -1;
      this._indicatorState.lastCacheRef = null;
    }

    if (!this.pathCache || this.pathCache.length < 2) return;

    // 2) Compute new trimming index WITHOUT committing yet
    let newIdx = this.pathCacheIdx;
    while (newIdx < this.pathCache.length - 2) {
      const pNext = this.pathCache[newIdx + 1];
      const d = Phaser.Math.Distance.Between(startPt.x, startPt.y, pNext.x, pNext.y);
      if (d > 12) break;
      newIdx++;
    }

    // 2.5) Decide if we should redraw this frame
    const st = this._indicatorState;

    // thresholds (tune)
    const START_STEP_PX = 6; // redraw only if start moved enough
    const IDX_STEP = 2;      // redraw only if trimming advanced enough

    const startMoved =
      Math.hypot(startPt.x - st.lastStartX, startPt.y - st.lastStartY) >= START_STEP_PX;

    const idxMoved = Math.abs(newIdx - st.lastIdx) >= IDX_STEP;

    const cacheChanged = (st.lastCacheRef !== this.pathCache);
    const colorChanged = (st.lastColor !== color);

    const needRedraw = canRedraw && (cacheChanged || colorChanged || idxMoved || startMoved);

    if (!needRedraw) {
      // Do NOT clear+stroke. Keep previous graphics as-is.
      // (optional) keep arrow depth roughly correct without redrawing:
      if (this.arrowG) this.arrowG.setDepth((st.lastArrowY || startPt.y) + 1);
      return;
    }

    // Commit trimming index only when we redraw
    this.pathCacheIdx = newIdx;

    const pts = this.pathCache.slice(this.pathCacheIdx);
    if (pts.length < 2) return;
    pts[0] = startPt;

    // 3) Draw chunked segments
    for (const g of this.pathSegments) g.setVisible(false);

    const MAX_LEN = 16; // already improved from 1
    let segIndex = 0;
    let chunk = [pts[0]];
    let accLen = 0;

    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      accLen += Math.hypot(cur.x - prev.x, cur.y - prev.y);
      chunk.push(cur);

      const isLast = (i === pts.length - 1);

      if (accLen >= MAX_LEN || isLast) {
        let g = this.pathSegments[segIndex];
        if (!g) {
          g = this.scene.add.graphics();
          this.pathSegments.push(g);
        }
        segIndex++;

        g.clear();
        g.setVisible(true);

        // depth by average y of chunk
        let sumY = 0;
        for (const p of chunk) sumY += p.y;
        g.setDepth(sumY / chunk.length);

        strokeMarkerFast(g, chunk, color);

        chunk = [cur];
        accLen = 0;
      }
    }

    for (let k = segIndex; k < this.pathSegments.length; k++) {
      this.pathSegments[k].setVisible(false);
    }

    // 4) Arrowhead
    const lastPt = pts[pts.length - 1];
    const prevPt = pts[pts.length - 2];
    const angle = Phaser.Math.Angle.Between(prevPt.x, prevPt.y, lastPt.x, lastPt.y);

    if (!this.arrowG) this.arrowG = this.scene.add.graphics();
    this.arrowG.clear();
    this.arrowG.setVisible(true);
    this.arrowG.setDepth(lastPt.y + 1);

    const arrowSize = 10;
    this.arrowG.lineStyle(4, color, ARROW_ALPHA);
    this.arrowG.beginPath();
    this.arrowG.moveTo(lastPt.x, lastPt.y);
    this.arrowG.lineTo(
      lastPt.x - arrowSize * Math.cos(angle - Math.PI / 6),
      lastPt.y - arrowSize * Math.sin(angle - Math.PI / 6)
    );
    this.arrowG.moveTo(lastPt.x, lastPt.y);
    this.arrowG.lineTo(
      lastPt.x - arrowSize * Math.cos(angle + Math.PI / 6),
      lastPt.y - arrowSize * Math.sin(angle + Math.PI / 6)
    );
    this.arrowG.strokePath();

    // Save redraw state
    st.lastIdx = this.pathCacheIdx;
    st.lastStartX = startPt.x;
    st.lastStartY = startPt.y;
    st.lastColor = color;
    st.lastCacheRef = this.pathCache;
    st.lastArrowY = lastPt.y;
  }
}