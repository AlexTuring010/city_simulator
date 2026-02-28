// src/sim/controllers/EatOutController.js
import { NPC_EVENTS } from '../npc/NPCEvents.js';
import { STORE_EVENTS } from '../store/Store.js';
import { findClosestFreeTile } from '../../pathfinding/findPath.js';

export class EatOutController {
  constructor(
    scene,
    npc,
    GRID,
    storesById,
    strategy,
    {
      graceMs = 1500,

      queueLoiterRadius = 4,
      queueLoiterStepMinMs = 700,
      queueLoiterStepMaxMs = 1800,
      loiterMaxRadiusSearch = 25,

      eatMinMs = 4000,
      eatMaxMs = 12000,

      postEatWanderMinMs = 4000,
      postEatWanderMaxMs = 10000,

      wanderFactory = null
    } = {}
  ) {
    this.scene = scene;
    this.npc = npc;
    this.GRID = GRID;
    this.storesById = storesById;
    this.strategy = strategy;

    this.cfg = {
      graceMs,
      queueLoiterRadius,
      queueLoiterStepMinMs,
      queueLoiterStepMaxMs,
      loiterMaxRadiusSearch,
      eatMinMs,
      eatMaxMs,
      postEatWanderMinMs,
      postEatWanderMaxMs,
      wanderFactory
    };

    this._active = false;

    this._timer = null;
    this._queuePaceTimer = null;
    this._handoffTimer = null; // survives pause

    this._suspendNpcEvents = false;

    // IDLE | SEARCHING | QUEUED_PACING | ENTERING | EATING
    this.state = 'IDLE';

    this.store = null;

    // bindings
    this._onArrived = () => this._handleArrived();
    this._onStuck = (data) => this._handleStuck(data);
    this._onStoreReady = (payload) => this._handleStoreReady(payload);

    this._cid = EatOutController._idCounter = (EatOutController._idCounter || 0) + 1;
  }

  // -------- lifecycle --------
  onStart() {
    this._active = true;
    this._bindNpc();
    this._kick();
  }

  onPause() {
    this._active = false;
    this._unbindNpc();
    this._clearTimer();
    this._clearQueuePace();
    // do NOT clear _handoffTimer here
  }

  onResume() {
    this._active = true;
    this._bindNpc();

    if (this.state === 'IDLE') this._kick();
    else if (this.state === 'QUEUED_PACING') this._queuePaceStep();
    // ENTERING/EATING are promise-driven
  }

  onStop() {
    this._active = false;
    this._unbindNpc();
    this._clearTimer();
    this._clearQueuePace();

    if (this._handoffTimer) {
      this._handoffTimer.remove(false);
      this._handoffTimer = null;
    }

    this._abandonStore({ keepQueue: false });
    this.state = 'IDLE';
  }

  update() {
    // event/timer driven
  }

  // -------- bindings / timers --------
  _bindNpc() {
    if (!this.npc) return;
    this.npc.on(NPC_EVENTS.ARRIVED, this._onArrived);
    this.npc.on(NPC_EVENTS.STUCK, this._onStuck);
  }

  _unbindNpc() {
    if (!this.npc) return;
    this.npc.off(NPC_EVENTS.ARRIVED, this._onArrived);
    this.npc.off(NPC_EVENTS.STUCK, this._onStuck);
  }

  _bindStore(store) {
    this._unbindStore();
    this.store = store;
    this.store?.on?.(STORE_EVENTS.READY, this._onStoreReady);
  }

  _unbindStore() {
    if (this.store?.off) {
      try { this.store.off(STORE_EVENTS.READY, this._onStoreReady); } catch (_) {}
    }
  }

  _clearTimer() {
    if (this._timer) {
      this._timer.remove(false);
      this._timer = null;
    }
  }

  _clearQueuePace() {
    if (this._queuePaceTimer) {
      this._queuePaceTimer.remove(false);
      this._queuePaceTimer = null;
    }
  }

  _abandonStore({ keepQueue = false } = {}) {
    if (!keepQueue) {
      try { this.store?.leaveQueue?.(this.npc); } catch (_) {}
    }
    this._unbindStore();
    this.store = null;
  }

  // -------- main loop --------
  async _kick() {
    if (!this._active) return;

    // Prevent ghost queue if we re-search
    if (this.store) this._abandonStore({ keepQueue: false });

    this.state = 'SEARCHING';

    const res = await this.strategy.acquireTarget(this.npc);
    if (!this._active) return;

    if (!res?.store) {
      this.state = 'IDLE';
      this._timer = this.scene.time.delayedCall(1500, () => {
        this._timer = null;
        this._kick();
      });
      return;
    }

    this._bindStore(res.store);

    // Ask for a store-wide spot from wherever we are.
    await this._tryJoinOrQueue();
  }

  async _tryJoinOrQueue() {
    if (!this._active || !this.store) return;

    const res =
      this.store.requestEnter?.(this.npc, { graceMs: this.cfg.graceMs }) ??
      { ok: false, status: 'QUEUED' };

    // If we are already reserved, we should go immediately.
    if (res.status === 'ALREADY_RESERVED') {
      this._clearQueuePace();
      await this._stopNpcNow();
      this._enterAndEatNow().catch(() => this._restartSearchSoon(700));
      return;
    }

    // If already inside, proceed (Store may have been older semantics).
    if (res.status === 'ALREADY_INSIDE') {
      this._clearQueuePace();
      await this._stopNpcNow();
      this._enterAndEatNow().catch(() => this._restartSearchSoon(700));
      return;
    }

    // Immediate invite: accept FIRST using inviteId, then go.
    if (res.status === 'INVITED') {
      if (res.inviteId != null) {
        const ok = this.store.acceptInvite?.(this.npc, res.inviteId);
        if (!ok) {
          this._enterQueuePacing();
          return;
        }

        this._clearQueuePace();
        await this._stopNpcNow();
        this._enterAndEatNow().catch(() => this._enterQueuePacing());
      }
      // If inviteId ever missing, READY will handle it.
      return;
    }

    // QUEUED / ALREADY_QUEUED / ALREADY_INVITED
    // If already invited, READY will arrive soon; pace meanwhile.
    this._enterQueuePacing();
  }

  // -------- READY (store invite) --------
  _handleStoreReady({ store, npc, inviteId }) {
    if (!this._active) return;
    if (store !== this.store) return;
    if (npc !== this.npc) return;

    // If we're mid-enter/eat, ignore duplicates
    if (this.state === 'ENTERING' || this.state === 'EATING') return;

    // ACCEPT FIRST (fast reservation) so we don't miss grace window.
    const ok = this.store?.acceptInvite?.(this.npc, inviteId);
    if (!ok) {
      // late/expired/mismatch
      if (this.state !== 'QUEUED_PACING') this._enterQueuePacing();
      return;
    }

    // Now preempt pacing/movement and enter
    this._clearQueuePace();

    (async () => {
      await this._stopNpcNow();
      this._enterAndEatNow().catch(() => this._enterQueuePacing());
    })();
  }

  // -------- movement preemption --------
  _stopNpcNow() {
    return new Promise((resolve) => {
      try {
        this.npc.stop?.('nav_stop');
      } catch (_) {}
      this.scene.time.delayedCall(0, resolve);
    });
  }

  // -------- entering + eating (reservation-driven) --------
  async _enterAndEatNow() {
    if (!this._active || !this.store) return false;

    const eatMs = Phaser.Math.Between(this.cfg.eatMinMs, this.cfg.eatMaxMs);

    try {
        this.state = 'ENTERING';

        // ignore our ARRIVED/STUCK while Store does its own temporary listeners
        this._suspendNpcEvents = true;

        const res = await this.store.moveNpcToReservedSpot(this.npc, { tableDurationMs: eatMs });

        // moveNpcToReservedSpot handles table sit/unseat internally.
        // For INDOORS it only enters; we still need to wait + release.
        if (res?.kind === 'INDOORS') {
            this.state = 'EATING';
            await this._delay(eatMs);
            this.store.releaseNpcFromIndoors?.(this.npc);
        }

        this.state = 'IDLE';
        this._suspendNpcEvents = false;

        // Done with this store; ensure not queued/invited/reserved anymore.
        this._abandonStore({ keepQueue: false });

        this._handoffToWander();
        return true;
    } catch (err) {
        // If we fail during entering/eating, abandon store + restart.
        try { this._abandonStore({ keepQueue: false }); } catch (_) {}
        this._restartSearchSoon(700);
        return false;
    } finally {
        this._suspendNpcEvents = false;
    }
  }

  // -------- queued pacing --------
  _enterQueuePacing() {
    if (!this._active || !this.store) return;
    this.state = 'QUEUED_PACING';
    this._queuePaceStep();
  }

  _queuePaceStep() {
    if (!this._active || !this.store) return;
    if (this.state !== 'QUEUED_PACING') return;

    const entry = this.store.entryTile;
    const r = this.cfg.queueLoiterRadius;

    const side = Phaser.Math.Between(0, 3);
    let rx = entry.x;
    let ry = entry.y;

    if (side === 0) { rx = entry.x + Phaser.Math.Between(-r, r); ry = entry.y - r; } // top
    if (side === 1) { rx = entry.x + Phaser.Math.Between(-r, r); ry = entry.y + r; } // bottom
    if (side === 2) { rx = entry.x - r; ry = entry.y + Phaser.Math.Between(-r, r); } // left
    if (side === 3) { rx = entry.x + r; ry = entry.y + Phaser.Math.Between(-r, r); } // right

    // 1-based grid clamp
    rx = Phaser.Math.Clamp(rx, 1, this.GRID.width);
    ry = Phaser.Math.Clamp(ry, 1, this.GRID.height);

    const free = findClosestFreeTile(this.GRID, rx, ry, {
      maxRadius: this.cfg.loiterMaxRadiusSearch,
      allowSame: true
    });

    if (free) {
      this.npc.goToTile?.(free.x, free.y, {
      });
    }

    // schedule next pacing step (READY can interrupt)
    this._clearQueuePace();
    const wait = Phaser.Math.Between(this.cfg.queueLoiterStepMinMs, this.cfg.queueLoiterStepMaxMs);
    this._queuePaceTimer = this.scene.time.delayedCall(wait, () => {
      this._queuePaceTimer = null;
      this._queuePaceStep();
    });
  }

  // -------- npc ARRIVED/STUCK (mostly irrelevant here now) --------
  _handleArrived() {
    if (!this._active) return;
    if (this._suspendNpcEvents) return;
    // Store owns movement for entry/table flows.
  }

  _handleStuck(_data) {
    if (!this._active) return;
    if (this._suspendNpcEvents) return;

    // If pacing got stuck, ignore (next pace step will choose new target)
    if (this.state === 'QUEUED_PACING') return;

    // Otherwise, abandon store and restart search
    this._abandonStore({ keepQueue: false });
    this._restartSearchSoon(700);
  }

  _restartSearchSoon(ms) {
    this.state = 'IDLE';
    this._clearTimer();
    this._timer = this.scene.time.delayedCall(ms, () => {
      this._timer = null;
      this._kick();
    });
  }

  // -------- post-eat wander handoff --------
  _handoffToWander() {
    if(!this._active){
        return;
    }
    if (!this._active) return;

    const factory = this.cfg.wanderFactory;
    if (typeof factory !== 'function') {
      this._restartSearchSoon(1200);
      return;
    }

    const wanderMs = Phaser.Math.Between(this.cfg.postEatWanderMinMs, this.cfg.postEatWanderMaxMs);
    const wanderController = factory(this.scene, this.npc, this.GRID);

    if (this._handoffTimer) {
      this._handoffTimer.remove(false);
      this._handoffTimer = null;
    }

    this.npc.pushController?.(wanderController);

    this._handoffTimer = this.scene.time.delayedCall(wanderMs, () => {
      this._handoffTimer = null;

      if (this.npc.getController && this.npc.getController() === wanderController) {
        this.npc.popController?.();
      }

      this.state = 'IDLE';
    });
  }

  _delay(ms) {
    return new Promise((resolve) => this.scene.time.delayedCall(ms, resolve));
  }
}