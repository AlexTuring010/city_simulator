import { NPC_EVENTS } from '../sim/npc/NPCEvents.js';

// Greedy nearest-available strategy with shared per-scene reservations.
// Fixes the bug where each NPC had its own private "on the way" counters.

export class AIRecsRestaurantGoal {
  constructor(scene, GRID, storesById, {
    maxAttempts = 10,
    stepMinWaitMs = 250,
    stepMaxWaitMs = 800,
    storeTypes = ['left_restaurant', 'right_restaurant'],
    maxDistance = 40
  } = {}) {
    this.scene = scene;
    this.GRID = GRID;
    this.storesById = storesById;

    this.maxAttempts = maxAttempts;
    this.stepMinWaitMs = stepMinWaitMs;
    this.stepMaxWaitMs = stepMaxWaitMs;
    this.storeTypes = new Set(storeTypes);
    this.maxDistance = maxDistance;

    // Shared across all AIRecsRestaurantGoal instances in this scene.
    // This is the key fix.
    if (!scene.__restaurantGoalSharedState) {
      scene.__restaurantGoalSharedState = {
        reservedByStore: new Map(),   // storeId -> count of NPCs en route
        reservedStoreByNpc: new Map() // npcId -> storeId
      };
    }

    this._shared = scene.__restaurantGoalSharedState;
  }

  _getReservedCount(storeId) {
    return this._shared.reservedByStore.get(storeId) ?? 0;
  }

  _reserve(npcId, storeId) {
    if (npcId == null || storeId == null) return;

    const prevStoreId = this._shared.reservedStoreByNpc.get(npcId);
    if (prevStoreId === storeId) return;

    if (prevStoreId != null) {
      this._releaseByNpcId(npcId);
    }

    this._shared.reservedStoreByNpc.set(npcId, storeId);
    this._shared.reservedByStore.set(
      storeId,
      this._getReservedCount(storeId) + 1
    );
  }

  _releaseByNpcId(npcId) {
    if (npcId == null) return;

    const storeId = this._shared.reservedStoreByNpc.get(npcId);
    if (storeId == null) return;

    this._shared.reservedStoreByNpc.delete(npcId);

    const next = this._getReservedCount(storeId) - 1;
    if (next <= 0) this._shared.reservedByStore.delete(storeId);
    else this._shared.reservedByStore.set(storeId, next);
  }

  releaseReservation(npcOrId) {
    const npcId = typeof npcOrId === 'object' ? npcOrId?.id : npcOrId;
    this._releaseByNpcId(npcId);
  }

  _pickBestStore(npc, exclude) {
    const restaurants = Object.values(this.storesById || {})
      .filter(s => s && this.storeTypes.has(s.storeType))
      .filter(s => !exclude.has(s.storeId))
      .filter(s => s.nav && s.goalTile);

    let best = null;
    let bestDistance = Infinity;

    for (const s of restaurants) {
      const d = s.nav.getDistance(npc.tileX, npc.tileY);
      if (d < 0) continue;
      if (this.maxDistance != null && d > this.maxDistance) continue;

      const freeNow = s.getAvailableServiceSlots?.() ?? 0;
      const reserved = this._getReservedCount(s.storeId);
      const projectedFree = freeNow - reserved;

      // Only consider stores that still have at least one slot
      // after accounting for NPCs already heading there.
      if (projectedFree <= 0) continue;

      if (d < bestDistance) {
        bestDistance = d;
        best = s;
      }
    }

    return best;
  }

  acquireTarget(npc, { excludeStoreIds = [] } = {}) {
    const npcId = npc?.id;
    const exclude = new Set(excludeStoreIds);

    if (npcId == null) return Promise.resolve(null);

    let attempts = 0;
    let timer = null;
    let targetStore = null;

    return new Promise((resolve) => {
      const cleanup = () => {
        npc.off(NPC_EVENTS.ARRIVED, onArrived);
        npc.off(NPC_EVENTS.STUCK, onStuck);
        if (timer) {
          timer.remove(false);
          timer = null;
        }
      };

      const failAndResolve = () => {
        cleanup();
        this._releaseByNpcId(npcId);
        resolve(null);
      };

      const tryPickAndMove = () => {
        if (++attempts > this.maxAttempts) {
          failAndResolve();
          return;
        }

        targetStore = this._pickBestStore(npc, exclude);

        if (!targetStore) {
          const wait = Phaser.Math.Between(this.stepMinWaitMs, this.stepMaxWaitMs);
          timer = this.scene.time.delayedCall(wait, () => {
            timer = null;
            tryPickAndMove();
          });
          return;
        }

        // Reserve BEFORE movement so other NPCs see this one as already committed.
        this._reserve(npcId, targetStore.storeId);

        const ok = npc.goToStoreNav(targetStore);

        if (!ok) {
          this._releaseByNpcId(npcId);
          exclude.add(targetStore.storeId);

          const wait = Phaser.Math.Between(this.stepMinWaitMs, this.stepMaxWaitMs);
          timer = this.scene.time.delayedCall(wait, () => {
            timer = null;
            tryPickAndMove();
          });
        }
      };

      const onArrived = () => {
        cleanup();
        resolve({ store: targetStore });
      };

      const onStuck = () => {
        if (targetStore) {
          this._releaseByNpcId(npcId);
          exclude.add(targetStore.storeId);
        }

        const wait = Phaser.Math.Between(this.stepMinWaitMs, this.stepMaxWaitMs);
        timer = this.scene.time.delayedCall(wait, () => {
          timer = null;
          tryPickAndMove();
        });
      };

      npc.on(NPC_EVENTS.ARRIVED, onArrived);
      npc.on(NPC_EVENTS.STUCK, onStuck);

      tryPickAndMove();
    });
  }
}