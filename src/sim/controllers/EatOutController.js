// src/sim/controllers/EatOutController.js
//
// FULL REWRITE (simple, deterministic, matches your latest spec)
//
// Rules implemented:
// 1) Before calling strategy.acquireTarget(...), we UNBIND npc ARRIVED/STUCK.
//    Strategy owns movement/stuck handling during search.
// 2) We keep visited restaurants to avoid repeats. On "fresh restart" we clear visited.
// 3) Once we get a store:
//    - call store.requestEnter(npc) ONCE
//      - ASSIGNED => move to target, then on ARRIVED:
//          TABLE: table.seatNpcAt(npc, seatIdx) if exists else table.seatNpc(npc)
//          INDOORS: store.pulseDoor();
//        wait eatMs, then:
//          TABLE: table.unseatNpc(npc)
//          INDOORS: npc.takeOutToTile(entryTile.x, entryTile.y)
//        store.npcDoneEating(npc.id)
//        move to nearest free tile, WAIT until ARRIVED/STUCK, then handoff to wander for a bit,
//        then pop wander and restart fresh (clear visited).
//      - QUEUED => loiter around store and listen for NPC_EVENTS.CALLED_TO_ENTER.
//        When called, treat payload as ASSIGNED (no re-request).
//      - QUEUE_FULL => mark store visited, search again; if no store found => wander then restart fresh.
// 4) Controller can remove itself from queue when abandoning the store (store.removeFromQueue(npc))
//
// Assumptions (explicit, minimal):
// - store.requestEnter(npc) returns:
//   - { ok:true, status:'ASSIGNED', kind:'TABLE'|'INDOORS', targetTile:{x,y}, table?, seatIdx?, storeId? }
//   - { ok:false,status:'QUEUED' }
//   - { ok:false,status:'QUEUE_FULL' }
// - store.entryTile exists
// - store.removeFromQueue(npc) exists (for queue cancellation)
// - store.npcDoneEating(npcId) exists
// - NPC emits events via npc.on/off (your NPC.js provides that)
// - called-to-enter payload uses NPC_EVENTS.CALLED_TO_ENTER
//
// NOTE: This controller NEVER depends on Store's internal table state.
//       It only uses the assignment payload given by the Store.

import { NPC_EVENTS } from '../npc/NPCEvents.js';
import { findClosestFreeTile } from '../../pathfinding/findPath.js';

export class EatOutController {
  constructor(
    scene,
    npc,
    GRID,
    storesById,
    strategy,
    {
      queueLoiterRadius = 4,
      queueLoiterStepMinMs = 700,
      queueLoiterStepMaxMs = 1800,
      loiterMaxRadiusSearch = 25,

      eatMinMs = 4000,
      eatMaxMs = 5000,

      exhaustedWanderMinMs = 2000,
      exhaustedWanderMaxMs = 6000,

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
      queueLoiterRadius,
      queueLoiterStepMinMs,
      queueLoiterStepMaxMs,
      loiterMaxRadiusSearch,
      eatMinMs,
      eatMaxMs,
      exhaustedWanderMinMs,
      exhaustedWanderMaxMs,
      postEatWanderMinMs,
      postEatWanderMaxMs,
      wanderFactory
    };

    this._active = false;

    // State machine:
    // IDLE | SEARCHING | QUEUED | MOVING_TO_TARGET | EATING | MOVING_AWAY | WANDERING
    this.state = 'IDLE';

    this.store = null;
    this._assignment = null;        // latest assignment (immediate or called_to_enter)
    this._visited = [];             // array of storeIds visited this cycle

    // timers
    this._timer = null;
    this._queueTimer = null;
    this._handoffTimer = null;

    // internal "await arrival" promise hooks
    this._await = null; // { resolve, reject, tag }

    // bindings
    this._onArrived = (payload) => this._handleArrived(payload);
    this._onStuck = (payload) => this._handleStuck(payload);
    this._onCalledToEnter = (payload) => this._handleCalledToEnter(payload);
  }

  // ---------------- lifecycle ----------------
  onStart() {
    this._active = true;
    this._bindNpcCore();
    this._restartFresh();
  }

  onPause() {
    this._active = false;
    this._unbindNpcCore();
    this._clearTimers();
  }

  onResume() {
    this._active = true;
    this._bindNpcCore();

    // Resume queue pacing if needed, otherwise restart safely.
    if (this.state === 'QUEUED') this._queueStep();
    else if (this.state === 'IDLE') this._restartFresh();
  }

  onStop() {
    this._active = false;
    this._unbindNpcCore();
    this._clearTimers();

    if (this._handoffTimer) {
      this._handoffTimer.remove(false);
      this._handoffTimer = null;
    }

    this._awaitCancel('controller_stop');

    this._leaveQueueIfNeeded();
    this.store = null;
    this._assignment = null;
    this._visited.length = 0;
    this.state = 'IDLE';
  }

  update() {
    // event/timer driven
  }

  // ---------------- npc bindings ----------------
  _bindNpcCore() {
    if (!this.npc) return;
    this.npc.on(NPC_EVENTS.ARRIVED, this._onArrived);
    this.npc.on(NPC_EVENTS.STUCK, this._onStuck);
    this.npc.on(NPC_EVENTS.CALLED_TO_ENTER, this._onCalledToEnter);
  }

  _unbindNpcCore() {
    if (!this.npc) return;
    this.npc.off(NPC_EVENTS.ARRIVED, this._onArrived);
    this.npc.off(NPC_EVENTS.STUCK, this._onStuck);
    this.npc.off(NPC_EVENTS.CALLED_TO_ENTER, this._onCalledToEnter);
  }

  // ---------------- timers/helpers ----------------
  _clearTimers() {
    if (this._timer) { this._timer.remove(false); this._timer = null; }
    if (this._queueTimer) { this._queueTimer.remove(false); this._queueTimer = null; }
  }

  _delay(ms, fn) {
    if (this._timer) { this._timer.remove(false); this._timer = null; }
    this._timer = this.scene.time.delayedCall(ms, () => {
      this._timer = null;
      if (!this._active) return;
      fn?.();
    });
  }

  _countCandidateStores() {
    return this.storesById ? Object.keys(this.storesById).length : 0;
  }

  _restartFresh() {
    if (!this._active) return;
    this._clearTimers();
    this._awaitCancel('restart_fresh');

    this._leaveQueueIfNeeded();
    this.store = null;
    this._assignment = null;

    // "starting fresh" means clear visited
    this._visited.length = 0;

    this.state = 'SEARCHING';
    this._searchNextStore();
  }

  // ---------------- store search ----------------
  async _searchNextStore() {
    if (!this._active) return;

    const excludeStoreIds = this._visited.slice();

    this._unbindNpcCore();
    let res = null;
    try {
      res = await this.strategy.acquireTarget(this.npc, { excludeStoreIds });
    } catch (_) {
      res = null;
    } finally {
      this._bindNpcCore();
    }

    if (!this._active) return;

    const store = res?.store ?? null;
    if (!store) {
      this._handleNoStoresAvailable();
      return;
    }

    this.store = store;
    if (store.storeId != null) this._visited.push(store.storeId);

    this._requestEnterCurrentStore();
  }

  _handleNoStoresAvailable() {
    // no stores found (likely visited all)
    this._handoffToWanderThenRestart({
      minMs: this.cfg.exhaustedWanderMinMs,
      maxMs: this.cfg.exhaustedWanderMaxMs
    });
  }

  // ---------------- store request/queue ----------------
  _requestEnterCurrentStore() {
    if (!this._active || !this.store) return;

    const res = this.store.requestEnter?.(this.npc);

    if (!res || !res.status) {
      // Defensive: treat as queued
      console.warn(`store.requestEnter returned invalid response for NPC ${this.npc.id}; treating as QUEUED.`);
      this._enterQueued();
      return;
    }

    if (res.status === 'QUEUE_FULL') {
      // Try another store
      this._leaveQueueIfNeeded();
      this.store = null;
      this._assignment = null;

      // If we've tried all candidates, wander and restart fresh
      if (this._visited.length >= this._countCandidateStores()) {
        this._handleNoStoresAvailable();
      } else {
        this.state = 'SEARCHING';
        this._searchNextStore();
      }
      return;
    }

    if (res.status === 'QUEUED') {
      this._enterQueued();
      return;
    }

    if (res.status === 'ASSIGNED' || res.status === 'ALREADY_ASSIGNED') {
      this._assignment = res;
      this._goToAssignment(res);
      return;
    }

    // Unknown -> queued
    console.warn(`store.requestEnter returned unknown status "${res.status}" for NPC ${this.npc.id}; treating as QUEUED.`);
    this._enterQueued();
  }

  _enterQueued() {
    if (!this._active || !this.store) return;
    this.state = 'QUEUED';
    this._queueStep();
  }

  _queueStep() {
    if (!this._active || this.state !== 'QUEUED' || !this.store) return;

    const entry = this.store.entryTile;
    const r = this.cfg.queueLoiterRadius;

    const rx = entry.x + Phaser.Math.Between(-r, r);
    const ry = entry.y + Phaser.Math.Between(-r, r);

    const tx = Phaser.Math.Clamp(rx, 1, this.GRID.width);
    const ty = Phaser.Math.Clamp(ry, 1, this.GRID.height);

    const free = findClosestFreeTile(this.GRID, tx, ty, {
      maxRadius: this.cfg.loiterMaxRadiusSearch,
      allowSame: true
    });

    if (free) {
      this.npc.goToTile(free.x, free.y, {
        showIndicator: false,
        allowWeakCollision: false
      });
    }

    // pace
    const wait = Phaser.Math.Between(this.cfg.queueLoiterStepMinMs, this.cfg.queueLoiterStepMaxMs);
    if (this._queueTimer) { this._queueTimer.remove(false); this._queueTimer = null; }
    this._queueTimer = this.scene.time.delayedCall(wait, () => {
      this._queueTimer = null;
      if (!this._active) return;
      this._queueStep();
    });
  }

  _leaveQueueIfNeeded() {
    if (this.state === 'QUEUED' && this.store?.removeFromQueue) {
      try { this.store.removeFromQueue(this.npc); } catch (_) {}
    }
    if (this._queueTimer) { this._queueTimer.remove(false); this._queueTimer = null; }
  }

  _handleCalledToEnter(payload) {
    // Only act if we are queued.
    if (!this._active) return;
    if (this.state !== 'QUEUED') return;

    // stop queue pacing
    if (this._queueTimer) { this._queueTimer.remove(false); this._queueTimer = null; }

    // payload IS the assignment. Do not request again.
    this._assignment = payload;

    // If storeId provided and current store mismatch, best-effort resolve.
    if (payload?.storeId != null && this.store?.storeId !== payload.storeId && this.storesById) {
      const s = this.storesById[payload.storeId];
      if (s) this.store = s;
    }

    this._goToAssignment(payload);
  }

  // ---------------- movement / arrival waiting ----------------
  _goToAssignment(assign) {
    if (!this._active || !this.store || !assign?.targetTile) return;

    this.state = 'MOVING_TO_TARGET';

    // Ensure we stop any previous movement for determinism (optional but safer)
    try { this.npc.stop?.('eatout_move_to_target'); } catch (_) {}

    this.npc.goToTile(assign.targetTile.x, assign.targetTile.y, {
      allowWeakCollision: true,
      allowBlockedGoal: true,
      showIndicator: false
    });
  }

  _awaitArriveOrStuck(tag = 'await') {
    // We don't add extra listeners; we use the existing _handleArrived/_handleStuck
    // and resolve based on current state.
    return new Promise((resolve, reject) => {
      this._awaitCancel('new_await');
      this._await = { resolve, reject, tag };
    });
  }

  _awaitResolve(ok, payload) {
    if (!this._await) return;
    const a = this._await;
    this._await = null;
    a.resolve({ ok, payload, tag: a.tag });
  }

  _awaitCancel(reason) {
    if (!this._await) return;
    const a = this._await;
    this._await = null;
    a.reject?.({ reason, tag: a.tag });
  }

  _handleArrived(_payload) {
    if (!this._active) return;

    // If we're awaiting "move away", resolve that.
    if (this.state === 'MOVING_AWAY') {
      this._awaitResolve(true, _payload);
      return;
    }

    if (this.state !== 'MOVING_TO_TARGET') return;

    const store = this.store;
    const assign = this._assignment;

    if (!store || !assign) {
      this.state = 'IDLE';
      this._restartFresh();
      return;
    }

    // Enter / sit now.
    if (assign.kind === 'TABLE') {
      const table = assign.table;
      const seatIdx = assign.seatIdx;

      if (table?.seatNpcAt && seatIdx != null) table.seatNpcAt(this.npc, seatIdx);
      else table?.seatNpc?.(this.npc);
    } else if (assign.kind === 'INDOORS') {
      store.pulseDoor?.(120);
      this.npc.putInside?.();
    }

    this.state = 'EATING';
    const eatMs = Phaser.Math.Between(this.cfg.eatMinMs, this.cfg.eatMaxMs);

    this._delay(eatMs, () => this._finishEating());
  }

  _handleStuck(_payload) {
    if (!this._active) return;

    // If we were moving away, treat stuck as "done enough"
    if (this.state === 'MOVING_AWAY') {
      this._awaitResolve(false, _payload);
      return;
    }

    // If stuck while moving to target, we can:
    // - release assignment immediately to avoid deadlocks
    // - notify store done (frees capacity for queue)
    const store = this.store;
    const assign = this._assignment;

    if (this.state === 'MOVING_TO_TARGET' && store && assign) {
      // If table, unseat defensively (might not have seated yet; unseatNpc is safe in your Table)
      if (assign.kind === 'TABLE') {
        assign.table?.unseatNpc?.(this.npc);
      } else if (assign.kind === 'INDOORS') {
        // ensure visible if we had been put inside (probably not yet)
        // no-op
      }

      store.npcDoneEating?.(this.npc.id);
      this._handoffToWanderThenRestart({
        minMs: this.cfg.exhaustedWanderMinMs,
        maxMs: this.cfg.exhaustedWanderMaxMs
      });
      return;
    }

    // Otherwise ignore.
  }

  // ---------------- eating finish -> release -> move away -> wander ----------------
  async _finishEating() {
    if (!this._active) return;

    this.store.pulseDoor?.(120);
    this.npc.putOutside?.();
  
    const store = this.store;
    const assign = this._assignment;

    if (!store || !assign) {
      this.state = 'IDLE';
      this._restartFresh();
      return;
    }

    // 1) Visual / table internal cleanup is controller-owned:
    if (assign.kind === 'TABLE') {
      assign.table?.unseatNpc?.(this.npc);
    } else if (assign.kind === 'INDOORS') {
      // Bring them back out at entry tile (simple).
      const entry = store.entryTile;
      this.npc.takeOutToTile?.(entry.x, entry.y, { containerId: `store:${store.storeId}` });
    }

    // 2) Notify store so it frees logs + calls next from queue
    store.npcDoneEating?.(this.npc.id);

    // 3) Move away to nearest free tile and WAIT until it's done
    const base = assign.targetTile ?? store.entryTile;
    const out = findClosestFreeTile(this.GRID, base.x, base.y, {
      maxRadius: 50,
      allowSame: false
    });

    // cleanup current store context now (we're done with it)
    this._leaveQueueIfNeeded();
    this._assignment = null;
    this.store = null;

    if (out) {
      this.state = 'MOVING_AWAY';
      try { this.npc.stop?.('eatout_move_away'); } catch (_) {}

      this.npc.goToTile(out.x, out.y, {
        allowWeakCollision: true,
        allowBlockedGoal: true,
        showIndicator: false
      });

      try {
        await this._awaitArriveOrStuck('move_away');
      } catch (_) {
        // ignore
      }
    }

    // 4) Handoff to wander for a bit, then restart fresh
    this._handoffToWanderThenRestart({
      minMs: this.cfg.postEatWanderMinMs,
      maxMs: this.cfg.postEatWanderMaxMs
    });
  }

  _handoffToWanderThenRestart({ minMs, maxMs }) {
    if (!this._active) return;

    const factory = this.cfg.wanderFactory;
    const wanderMs = Phaser.Math.Between(minMs, maxMs);

    // If no wander controller, just restart after delay
    if (typeof factory !== 'function') {
      this.state = 'IDLE';
      this._delay(wanderMs, () => this._restartFresh());
      return;
    }

    this.state = 'WANDERING';

    const wanderController = factory(this.scene, this.npc, this.GRID);

    // Cancel previous handoff timer if any
    if (this._handoffTimer) {
      this._handoffTimer.remove(false);
      this._handoffTimer = null;
    }

    // Push wanderer
    this.npc.pushController?.(wanderController);

    // Pop wanderer later, then restart fresh (clear visited)
    this._handoffTimer = this.scene.time.delayedCall(wanderMs, () => {
      this._handoffTimer = null;

      // pop only if it's still on top
      if (this.npc.getController && this.npc.getController() === wanderController) {
        this.npc.popController?.();
      }

      if (!this._active) return;

      this.state = 'IDLE';
      this._restartFresh();
    });
  }
}