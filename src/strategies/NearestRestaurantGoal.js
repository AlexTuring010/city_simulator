// src/sim/strategies/NearestRestaurantGoal.js
//
// NearestRestaurantGoal
// ---------------------
// - Chooses the nearest (min distance) restaurant not in excludeStoreIds
// - Uses precomputed per-store nav fields (store.nav + store.goalTile)
// - Strategy still performs movement and waits for ARRIVED/STUCK
//
// Assumptions:
// - store.nav.getDistance(x,y) exists and returns:
//    >= 0 reachable distance, -1 unreachable
// - NPC has npc.goToStoreNav(store, opts) which starts following store.nav
//   toward store.goalTile (no A*).
//
// If you want "second nearest", you can take the 2nd best after sorting/keeping 2 best.

import { NPC_EVENTS } from '../sim/npc/NPCEvents.js';

export class NearestRestaurantGoal {
  constructor(scene, GRID, storesById, {
    maxAttempts = 10,
    stepMinWaitMs = 250, // This is just a retry delay if something goes wrong (e.g. path suddenly blocked).
    stepMaxWaitMs = 800, // Without it you might spam the pathfinding every frame, which will cause lag 
    storeTypes = ['left_restaurant', 'right_restaurant'],
    // optional: treat "too far" as invalid; set null to disable
    maxDistance = null
  } = {}) {
    this.scene = scene;
    this.GRID = GRID;
    this.storesById = storesById;

    this.maxAttempts = maxAttempts;
    this.stepMinWaitMs = stepMinWaitMs;
    this.stepMaxWaitMs = stepMaxWaitMs;
    this.storeTypes = new Set(storeTypes);
    this.maxDistance = maxDistance;
  }

  acquireTarget(npc, { excludeStoreIds = [] } = {}) {
    const exclude = new Set(excludeStoreIds);

    const restaurants = Object.values(this.storesById || {})
      .filter(s => s && this.storeTypes.has(s.storeType))
      .filter(s => !exclude.has(s.storeId))
      // must have precomputed nav
      .filter(s => s.nav && s.goalTile);

    if (!restaurants.length) return Promise.resolve(null);

    let attempts = 0;
    let timer = null;
    let targetStore = null;

    const pickNearestReachable = () => {
      let best = null;
      let bestD = Infinity;

      for (const s of restaurants) {
        // O(1) per store
        const d = s.nav.getDistance(npc.tileX, npc.tileY);
        if (d < 0) continue; // unreachable from here
        if (this.maxDistance != null && d > this.maxDistance) continue;

        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }

      return best;
    };

    return new Promise((resolve) => {
      const cleanup = () => {
        npc.off(NPC_EVENTS.ARRIVED, onArrived);
        npc.off(NPC_EVENTS.STUCK, onStuck);
        if (timer) { timer.remove(false); timer = null; }
      };

      const goToNearestRestaurant = () => {
        if (++attempts > this.maxAttempts) {
          cleanup();
          resolve(null);
          return;
        }

        targetStore = pickNearestReachable();

        if (!targetStore) {
          // No reachable restaurants (or all excluded); retry a bit later
          const wait = Phaser.Math.Between(this.stepMinWaitMs, this.stepMaxWaitMs);
          timer = this.scene.time.delayedCall(wait, goToNearestRestaurant);
          return;
        }

        // Start navfield-follow movement toward the chosen restaurant
        const ok = npc.goToStoreNav(targetStore);

        if (!ok) {
          // treat as a failure; exclude it for this attempt chain to avoid loops
          exclude.add(targetStore.storeId);
          const wait = Phaser.Math.Between(this.stepMinWaitMs, this.stepMaxWaitMs);
          timer = this.scene.time.delayedCall(wait, goToNearestRestaurant);
        }
      };

      const onArrived = () => {
        cleanup();
        resolve({ store: targetStore });
      };

      const onStuck = () => {
        // Mark this one as "bad for now" and pick the next nearest
        if (targetStore) exclude.add(targetStore.storeId);

        const wait = Phaser.Math.Between(this.stepMinWaitMs, this.stepMaxWaitMs);
        timer = this.scene.time.delayedCall(wait, goToNearestRestaurant);
      };

      npc.on(NPC_EVENTS.ARRIVED, onArrived);
      npc.on(NPC_EVENTS.STUCK, onStuck);

      goToNearestRestaurant();
    });
  }
}