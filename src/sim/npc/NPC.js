// NPC.js
import { findPath } from '../../pathfinding/findPath.js';
import {
  ARROW_ALPHA,
  buildScribblePoints,
  catmullRomInterpolate,
  decimatePoints,
  strokeMarkerFast
} from '../../render/indicators/scribble.js';

import { NPC_EVENTS, NPC_STUCK_REASONS, NPC_STOP_REASONS } from './NPCEvents.js';

export class NPC {
  constructor(scene, GRID, startTileX, startTileY, { type = 'type1' } = {}) {

    this.controllerStack = [];

    // "put inside" state
    this.isInside = false;
    this.insideData = null; // optional: { containerId, reason, ... }

    // render offsets
    this.posOffsetX = 0;     // world-space pixel offsets
    this.posOffsetY = 0;
    this.depthOffset = 0;    // added to depth sorting
    this.shadowOffsetY = -8; // feet->shadow offset

    this.id = (NPC._idCounter = (NPC._idCounter || 0) + 1);

    // simulation identity
    this.type = type;               // <-- remember what type this NPC is
    this.spriteKey = NPC.getSpriteKeyForType(type); // <-- resolve to spritesheet key

    this.animSuffix = (this.type === 'type2') ? '2' : '';

    this.scene = scene;
    this.GRID = GRID;

    // events API
    this.events = new Phaser.Events.EventEmitter();

    // simulation state
    this.facing = 'down';
    this.tileX = startTileX;
    this.tileY = startTileY;

    // movement state
    this.state = 'IDLE'; // 'IDLE' | 'WAITING' | 'MOVING'
    this.path = [];
    this.targetNode = null;
    this.speed = 1;

    // navfield-follow movement (no A*)
    this._moveMode = 'PATH'; // 'PATH' | 'NAV'
    this._navStore = null;   // Store reference while following nav
    this._navStuckFrames = 0;

    this._waitTimer = null;
    this._goal = null; // {x,y} of the final destination (optional)

    // path indicator options (per-goal configurable)
    this.showPathIndicator = true;
    this.pathIndicatorColor = 0x33ff77;

    // scribble caching
    this.pathDirty = true;
    this.pathCache = null;
    this.pathCacheIdx = 0;
    this.pathSeed = (Math.random() * 1e9) | 0;

    // render objects (internal)
    const pos = GRID.tileToWorld(this.tileX, this.tileY);

    this.sprite = scene.add.sprite(pos.x + this.posOffsetX, pos.y + this.posOffsetY, this.spriteKey, 15);
    this.sprite.setOrigin(0.5, 1);

    // --- Soft ground shadow (very cheap) ---
    // (Ellipse is a lightweight Shape object; no redraw unless style changes)
    this.shadow = scene.add.ellipse(
      pos.x,
      pos.y - 8,           // slight "feet" offset
      GRID.tileW * 0.4,    // width
      GRID.tileH * 0.4,    // height
      0x000000,
      0.25                // alpha
    );
    this.shadow.setOrigin(0.5, 0.5);
    this.shadow.setDepth(this.sprite.y - 1);

    // path indicator graphics
    this.pathSegments = [];
    this.arrowG = null;

    // indicator redraw state (avoid clear+stroke unless needed)
    this._indicatorState = {
      lastIdx: -1,
      lastStartX: 0,
      lastStartY: 0,
      lastColor: null,
      lastCacheRef: null,
      lastArrowY: 0
    };

    this.lastPathDraw = 0;

    this.setIdleFacing();
    this._syncDepthAndShadow();

  }

  _animKey(dir) {
    return `npc_walk_${dir}${this.animSuffix}`;
  }

  static getSpriteKeyForType(type) {
    return type === 'type2' ? 'npc_sprite2' : 'npc_sprite';
  }

  setController(controller) {
    // replace whole stack with one controller
    this.clearControllers();
    this.pushController(controller);
  }

  pushController(controller) {
    const current = this.getController();
    if (current?.onPause) current.onPause();

    this.controllerStack.push(controller);
    controller?.onStart?.();
  }

  popController() {
    const current = this.controllerStack.pop();
    current?.onStop?.();

    const next = this.getController();
    if (next?.onResume) next.onResume();

    return current;
  }

  getController() {
    return this.controllerStack[this.controllerStack.length - 1] ?? null;
  }

  clearControllers() {
    while (this.controllerStack.length) {
      const c = this.controllerStack.pop();
      c?.onStop?.();
    }
  }

  putInside({ containerId = null, reason = 'INSIDE' } = {}) {
    // If already inside, do nothing
    if (this.isInside) return;

    // Stop movement + timers + indicators
    this.stop(reason);

    this.isInside = true;
    this.insideData = { containerId, reason };

    // Hide + disable rendering objects
    if (this.sprite) {
      this.sprite.setVisible(false);
      this.sprite.setActive(false); // won't run preUpdate / etc
    }
    if (this.shadow) {
      this.shadow.setVisible(false);
      this.shadow.setActive(false);
    }

    this._hideIndicator();
    for (const g of this.pathSegments) g.setActive(false);
    if (this.arrowG) this.arrowG.setActive(false);
  }

  putOutside({ containerId = null, reason = 'TAKEN_OUT' } = {}) {
    // If already outside, do nothing
    if (!this.isInside) return;

    this.isInside = false;
    this.insideData = { containerId, reason };

    if (this.sprite) {
      this.sprite.setVisible(true);
      this.sprite.setActive(true);
    }
    if (this.shadow) {
      this.shadow.setVisible(true);
      this.shadow.setActive(true);
    }

    for (const g of this.pathSegments) g.setActive(true);
    if (this.arrowG) this.arrowG.setActive(true);
  }

  takeOutToTile(tileX, tileY, { containerId = null } = {}) {
    // Update logical tile + world position
    this.tileX = tileX;
    this.tileY = tileY;

    const pos = this.GRID.tileToWorld(tileX, tileY);

    if (this.sprite) {
      this.sprite.x = pos.x + this.posOffsetX;
      this.sprite.y = pos.y + this.posOffsetY;
      this.sprite.setVisible(true);
      this.sprite.setActive(true);
    }
    if (this.shadow) {
      this.shadow.setVisible(true);
      this.shadow.setActive(true);
    }

    // Reactivate indicator objects (they'll remain hidden until moving)
    for (const g of this.pathSegments) g.setActive(true);
    if (this.arrowG) this.arrowG.setActive(true);

    this.isInside = false;
    this.insideData = { containerId, reason: 'TAKEN_OUT' };

    this.setIdleFacing();
    this._syncDepthAndShadow();
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

  // Optional but useful for cleanup/despawn
  destroy() {
    if (this._waitTimer) {
      this._waitTimer.remove(false);
      this._waitTimer = null;
    }

    // destroy indicator graphics
    for (const g of this.pathSegments) g.destroy();
    this.pathSegments.length = 0;

    if (this.arrowG) {
      this.arrowG.destroy();
      this.arrowG = null;
    }

    // destroy shadow + sprite
    if (this.shadow) {
      this.shadow.destroy();
      this.shadow = null;
    }
    if (this.sprite) {
      this.sprite.destroy();
      this.sprite = null;
    }

    this.events.removeAllListeners();
  }

  // ---------------------------
  // External API (controls)
  // ---------------------------
  stop(reason = NPC_STOP_REASONS.STOPPED) {
    if (this._waitTimer) {
      this._waitTimer.remove(false);
      this._waitTimer = null;
    }

    this.state = 'IDLE';
    this.path = [];
    this.targetNode = null;
    this._goal = null;

    this._moveMode = 'PATH';
    this._navStore = null;
    this._navStuckFrames = 0;

    this.pathCache = null;
    this.pathCacheIdx = 0;
    this.pathDirty = true;

    // reset indicator state too
    if (this._indicatorState) {
      this._indicatorState.lastIdx = -1;
      this._indicatorState.lastCacheRef = null;
    }

    // hide indicator immediately
    this._hideIndicator();

    this.setIdleFacing();
    this.events.emit(NPC_EVENTS.STATE_CHANGED, this.state);
    this.events.emit(NPC_EVENTS.STOPPED, { reason });
  }

  wait(ms = 1000) {
    if (this._waitTimer) this._waitTimer.remove(false);

    this.state = 'WAITING';
    this.setIdleFacing();
    this.events.emit(NPC_EVENTS.STATE_CHANGED, this.state);

    this._waitTimer = this.scene.time.delayedCall(ms, () => {
      this._waitTimer = null;
      this.state = 'IDLE';
      this.events.emit(NPC_EVENTS.STATE_CHANGED, this.state);
      this.events.emit(NPC_EVENTS.WAIT_DONE);
    });

    return true;
  }

  stepToTile(goalX, goalY, { showIndicator = false, indicatorColor = 0x33ff77 } = {}) {
    // must be adjacent
    const dx = Math.abs(goalX - this.tileX);
    const dy = Math.abs(goalY - this.tileY);
    if (dx + dy !== 1) return false;

    if (this.GRID.isBlocked(goalX, goalY)) {
      this.events.emit(NPC_EVENTS.STUCK, { reason: NPC_STUCK_REASONS.GOAL_BLOCKED, goalX, goalY, npcX: this.tileX, npcY: this.tileY });
      return false;
    }

    // same “setup moving” as goToTile but without findPath
    this.showPathIndicator = !!showIndicator;
    this.pathIndicatorColor = indicatorColor;
    if (!this.showPathIndicator) this._hideIndicator();

    if (this._waitTimer) { this._waitTimer.remove(false); this._waitTimer = null; }

    this._moveMode = 'PATH'; // or a new 'STEP'
    this._goal = { x: goalX, y: goalY };

    this.path = [];             // no path
    this.targetNode = { x: goalX, y: goalY };
    this.state = 'MOVING';

    this.pathCache = null;
    this.pathCacheIdx = 0;
    this.pathDirty = true;

    if (this._indicatorState) {
      this._indicatorState.lastIdx = -1;
      this._indicatorState.lastCacheRef = null;
    }

    this.events.emit(NPC_EVENTS.STATE_CHANGED, this.state);
    this.events.emit(NPC_EVENTS.GOAL_SET, { goalX, goalY });

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
    allowBlockedStart = true,
    allowBlockedGoal = false,
    allowBlockedPath = false,
    allowWeakCollision = false,
    showIndicator = false,
    indicatorColor = 0x33ff77
  } = {}
  ) {
    // Apply per-goal indicator settings
    this.showPathIndicator = !!showIndicator;
    this.pathIndicatorColor = indicatorColor;

    // If indicator is disabled, hide any existing indicator now
    if (!this.showPathIndicator) this._hideIndicator();

    const blockedArgs = { allowWeak: allowWeakCollision };

    // If goal is blocked and you're not allowing blocked-goal/path, fail early.
    // NOTE: weak-collision tiles are treated as walkable if allowWeakCollision is true.
    if ((!allowBlockedGoal && !allowBlockedPath) && this.GRID.isBlocked(goalX, goalY, blockedArgs)) {
      // console.warn(`NPC ${this.id} cannot go to blocked goal tile (${goalX}, ${goalY}) with current pathfinding options.`);
      // console.log(`NpcX: ${this.tileX}, NpcY: ${this.tileY}, allowBlockedStart: ${allowBlockedStart}, allowBlockedGoal: ${allowBlockedGoal}, allowBlockedPath: ${allowBlockedPath}, allowWeakCollision: ${allowWeakCollision}`);
      this.events.emit(NPC_EVENTS.STUCK, {
        reason: NPC_STUCK_REASONS.GOAL_BLOCKED,
        goalX,
        goalY,
        npcX: this.tileX,
        npcY: this.tileY
      });
      return false;
    }

    const path = findPath(this.GRID, this.tileX, this.tileY, goalX, goalY, {
      allowBlockedStart,
      allowBlockedGoal,
      allowBlockedPath,
      allowWeakCollision // NEW: passed through
    });

    if (path && path.length === 1) {
      return true;
    }

    if (!path || path.length <= 0) {
      // console.warn(`NPC ${this.id} cannot find path to (${goalX}, ${goalY}) with current pathfinding options.`);
      // console.log(`NpcX: ${this.tileX}, NpcY: ${this.tileY}, allowBlockedStart: ${allowBlockedStart}, allowBlockedGoal: ${allowBlockedGoal}, allowBlockedPath: ${allowBlockedPath}, allowWeakCollision: ${allowWeakCollision}`);
      this.events.emit(NPC_EVENTS.STUCK, {
        reason: NPC_STUCK_REASONS.NO_PATH,
        goalX,
        goalY,
        npcX: this.tileX,
        npcY: this.tileY,
        allowBlockedStart,
        allowBlockedGoal,
        allowBlockedPath,
        allowWeakCollision 
      });
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

    this.events.emit(NPC_EVENTS.STATE_CHANGED, this.state);
    this.events.emit(NPC_EVENTS.GOAL_SET, { goalX, goalY });

    return true;
  }

    /**
   * Follow a precomputed per-store navfield (store.nav) toward store.goalTile.
   * This avoids A* entirely. Next step is O(1).
   *
   * Assumes:
   * - store.nav.getDistance(x,y) returns: -1 unreachable, 0 at goal, >0 steps away
   * - store.nav.getNextStep(x,y) returns next tile or null
   */
  goToStoreNav(
    store,
    {
      showIndicator = false,
      indicatorColor = 0x33ff77
    } = {}
  ) {
    if (!store || !store.nav || !store.goalTile) return false;

    // Apply per-goal indicator settings
    this.showPathIndicator = !!showIndicator;
    this.pathIndicatorColor = indicatorColor;
    if (!this.showPathIndicator) this._hideIndicator();

    // cancel any wait
    if (this._waitTimer) {
      this._waitTimer.remove(false);
      this._waitTimer = null;
    }

    // If unreachable, fail fast
    const d0 = store.nav.getDistance(this.tileX, this.tileY);
    if (d0 < 0) {
      this.events.emit(NPC_EVENTS.STUCK, {
        reason: NPC_STUCK_REASONS.NO_PATH,
        goalX: store.goalTile.x,
        goalY: store.goalTile.y,
        npcX: this.tileX,
        npcY: this.tileY
      });
      return false;
    }

    // Already there
    if (d0 === 0) return true;

    // Switch to NAV mode
    this._moveMode = 'NAV';
    this._navStore = store;
    this._navStuckFrames = 0;

    // Clear any existing path mode
    this.path = [];
    this.targetNode = null;

    // Keep goal metadata for ARRIVED event
    this._goal = { x: store.goalTile.x, y: store.goalTile.y, storeId: store.storeId };

    // Force indicator cache rebuild (path array not used; indicator will be "next step only")
    this.pathCache = null;
    this.pathCacheIdx = 0;
    this.pathDirty = true;

    if (this._indicatorState) {
      this._indicatorState.lastIdx = -1;
      this._indicatorState.lastCacheRef = null;
    }

    // Prime the first step
    const next = store.nav.getNextStep(this.tileX, this.tileY);
    if (!next) {
      // If distance was >0 but no next, treat as stuck (data inconsistency)
      this.events.emit(NPC_EVENTS.STUCK, {
        reason: NPC_STUCK_REASONS.NO_PATH,
        goalX: store.goalTile.x,
        goalY: store.goalTile.y,
        npcX: this.tileX,
        npcY: this.tileY
      });
      return false;
    }

    this.targetNode = next;
    this.state = 'MOVING';

    this.events.emit(NPC_EVENTS.STATE_CHANGED, this.state);
    this.events.emit(NPC_EVENTS.GOAL_SET, { goalX: store.goalTile.x, goalY: store.goalTile.y, storeId: store.storeId });

    return true;
  }

  isBusy() {
    return this.state === 'MOVING' || this.state === 'WAITING';
  }

  // ---------------------------
  // Animation helper
  // ---------------------------
  setIdleFacing() {
    if (!this.sprite) return;

    const dir =
      this.facing === 'right' ? 'right' :
      this.facing === 'left'  ? 'left'  :
      this.facing === 'up'    ? 'up'    :
                                'down';

    const key = this._animKey(dir);

    this.sprite.anims.play(key, true);
    this.sprite.anims.pause();
    this.sprite.anims.setProgress(0);
  }

  setFacing(direction) {
    if (!this.sprite) return;

    this.facing = direction; // update internal state

    const key = this._animKey(direction);

    this.sprite.anims.play(key, true);
    this.sprite.anims.pause();
}

  // ---------------------------
  // Per-frame update
  // ---------------------------
  update() {
    const c = this.getController();
    c?.update?.();
    
    if (!this.sprite) return;

    // If "inside", we do nothing and don’t even touch depth/indicator
    if (this.isInside) return;

    // If NAV-moving and targetNode is missing, compute next step now
    if (this.state === 'MOVING' && !this.targetNode && this._moveMode === 'NAV' && this._navStore?.nav) {
      const store = this._navStore;

      const d = store.nav.getDistance(this.tileX, this.tileY);

      if (d === 0) {
        // Arrived
        const arrivedGoal = this._goal;

        this.targetNode = null;
        this._goal = null;

        this._moveMode = 'PATH';
        this._navStore = null;
        this._navStuckFrames = 0;

        this.pathCache = null;
        this.pathCacheIdx = 0;

        if (this._indicatorState) {
          this._indicatorState.lastIdx = -1;
          this._indicatorState.lastCacheRef = null;
        }

        this.state = 'IDLE';
        this.setIdleFacing();

        this.events.emit(NPC_EVENTS.STATE_CHANGED, this.state);
        this.events.emit(NPC_EVENTS.ARRIVED, { tileX: this.tileX, tileY: this.tileY, goal: arrivedGoal });
        return;
      }

      const next = store.nav.getNextStep(this.tileX, this.tileY);

      if (!next) {
        // Could be temporarily jammed (NPCs are dynamic obstacles) or unreachable.
        // We’ll emit STUCK if it persists for a few frames.
        this._navStuckFrames++;
        if (this._navStuckFrames >= 10) {
          this._navStuckFrames = 0;
          this.events.emit(NPC_EVENTS.STUCK, {
            reason: NPC_STUCK_REASONS.NO_PATH,
            goalX: store.goalTile?.x,
            goalY: store.goalTile?.y,
            npcX: this.tileX,
            npcY: this.tileY
          });
        }

        this._hideIndicator();
        this._syncDepthAndShadow();
        return;
      }

      this._navStuckFrames = 0;
      this.targetNode = next;
    }

    // Not moving -> hide indicator + keep depth correct
    if (this.state !== 'MOVING' || !this.targetNode) {
      this._hideIndicator();
      this._syncDepthAndShadow();
      return;
    }

    const targetWorld = this.GRID.tileToWorld(this.targetNode.x, this.targetNode.y);
    const distance = Phaser.Math.Distance.Between(
      this.sprite.x, this.sprite.y,
      targetWorld.x, targetWorld.y
    );

    if (distance < this.speed) {
      // snap to target node
      this._setSpriteWorld(targetWorld.x, targetWorld.y);

      this.tileX = this.targetNode.x;
      this.tileY = this.targetNode.y;

      if (this._moveMode === 'PATH') {
        if (this.path.length > 0) {
          this.targetNode = this.path.shift();
        } else {
          // arrived at final tile (your existing code unchanged)
          const arrivedGoal = this._goal;

          this.targetNode = null;
          this._goal = null;

          this.pathCache = null;
          this.pathCacheIdx = 0;

          if (this._indicatorState) {
            this._indicatorState.lastIdx = -1;
            this._indicatorState.lastCacheRef = null;
          }

          this.state = 'IDLE';
          this.setIdleFacing();

          this.events.emit(NPC_EVENTS.STATE_CHANGED, this.state);
          this.events.emit(NPC_EVENTS.ARRIVED, {
            tileX: this.tileX,
            tileY: this.tileY,
            goal: arrivedGoal
          });
        }
      } else if (this._moveMode === 'NAV') {
        // In NAV mode, we do not store a path array.
        // Clear targetNode so top-of-update recomputes next step from navfield.
        this.targetNode = null;

        // Mark indicator dirty so it redraws correctly (optional)
        this.pathDirty = true;
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
      if (this.targetNode.x > this.tileX) {
        this.facing = 'right';
        this.sprite.anims.play(this._animKey('right'), true);
      } else if (this.targetNode.x < this.tileX) {
        this.facing = 'left';
        this.sprite.anims.play(this._animKey('left'), true);
      } else if (this.targetNode.y > this.tileY) {
        this.facing = 'down';
        this.sprite.anims.play(this._animKey('down'), true);
      } else if (this.targetNode.y < this.tileY) {
        this.facing = 'up';
        this.sprite.anims.play(this._animKey('up'), true);
      }
    }

    // Draw indicator only if enabled for this goal
    if (this.showPathIndicator && this.targetNode) {
      const nextWorld = this.GRID.tileToWorld(this.targetNode.x, this.targetNode.y);
      this.drawPathIndicator(nextWorld);
    } else {
      this.drawPathIndicator(null);
    }

    this._syncDepthAndShadow();
  }

  _syncDepthAndShadow() {
    if (!this.sprite) return;

    // depth uses sprite.y + optional depthOffset
    this.sprite.setDepth(this.sprite.y + this.depthOffset);

    if (!this.shadow) return;

    this.shadow.x = this.sprite.x;
    this.shadow.y = this.sprite.y + this.shadowOffsetY;

    // always under sprite
    this.shadow.setDepth((this.sprite.y + this.depthOffset) - 1);
  }

  _hideIndicator() {
    for (const g of this.pathSegments) g.setVisible(false);
    if (this.arrowG) this.arrowG.setVisible(false);
  }

  // ---------------------------
  // Path indicator (scribble + trimming)
  // ---------------------------
  drawPathIndicator(nextWorld) {
    // If indicator is disabled, force hide and exit
    if (!this.showPathIndicator) {
      this._hideIndicator();
      return;
    }

    // If no target, hide and exit
    if (!nextWorld) {
      this._hideIndicator();
      return;
    }

    const color = this.pathIndicatorColor ?? 0x33ff77;
    const yOffset = this.GRID.tileH * 0.5;

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
    const START_STEP_PX = 6; // redraw only if start moved enough
    const IDX_STEP = 2;      // redraw only if trimming advanced enough

    const startMoved =
      Math.hypot(startPt.x - st.lastStartX, startPt.y - st.lastStartY) >= START_STEP_PX;

    const idxMoved = Math.abs(newIdx - st.lastIdx) >= IDX_STEP;

    const cacheChanged = (st.lastCacheRef !== this.pathCache);
    const colorChanged = (st.lastColor !== color);

    const needRedraw = canRedraw && (cacheChanged || colorChanged || idxMoved || startMoved);

    if (!needRedraw) {
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

    const MAX_LEN = 16;
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

  setPositionOffset(px = 0, py = 0) {
  this.posOffsetX = px;
  this.posOffsetY = py;

  // immediately apply if visible
  if (this.sprite && !this.isInside) {
      // re-place from current tile to avoid drifting
      const pos = this.GRID.tileToWorld(this.tileX, this.tileY);
      this.sprite.x = pos.x + this.posOffsetX;
      this.sprite.y = pos.y + this.posOffsetY;
      this._syncDepthAndShadow();
    }
  }

  setDepthOffset(d = 0) {
    this.depthOffset = d;
    if (this.sprite && !this.isInside) this._syncDepthAndShadow();
  }

  _setSpriteWorld(x, y) {
    // All movement/teleports should go through this
    this.sprite.x = x + this.posOffsetX;
    this.sprite.y = y + this.posOffsetY;
  }
}