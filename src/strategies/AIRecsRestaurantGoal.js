// src/strategies/AIRecsRestaurantGoal.js
//
// AI-powered store selection: penalizes crowded/queued stores
// so NPCs spread across under-utilized "hidden gems".
//
// Same interface as NearestRestaurantGoal — only store selection differs.

import { NPC_EVENTS } from '../sim/npc/NPCEvents.js';

export class AIRecsRestaurantGoal {
  constructor(scene, GRID, storesById, {
    maxAttempts = 10,
    stepMinWaitMs = 250,
    stepMaxWaitMs = 800,
    storeTypes = ['left_restaurant', 'right_restaurant'],
    maxDistance = null,
    crowdThreshold = 0.6,
    occupancyPenaltyWeight = 2.0,
    queuePenaltyWeight = 5.0
  } = {}) {
    this.scene = scene;
    this.GRID = GRID;
    this.storesById = storesById;

    this.maxAttempts = maxAttempts;
    this.stepMinWaitMs = stepMinWaitMs;
    this.stepMaxWaitMs = stepMaxWaitMs;
    this.storeTypes = new Set(storeTypes);
    this.maxDistance = maxDistance;

    this.crowdThreshold = crowdThreshold;
    this.occupancyPenaltyWeight = occupancyPenaltyWeight;
    this.queuePenaltyWeight = queuePenaltyWeight;
  }

  acquireTarget(npc, { excludeStoreIds = [] } = {}) {
    const exclude = new Set(excludeStoreIds);

    const restaurants = Object.values(this.storesById || {})
      .filter(s => s && this.storeTypes.has(s.storeType))
      .filter(s => !exclude.has(s.storeId))
      .filter(s => s.nav && s.goalTile);

    if (!restaurants.length) return Promise.resolve(null);

    let attempts = 0;
    let timer = null;
    let targetStore = null;

    const pickBestScored = () => {
      let best = null;
      let bestScore = Infinity;

      for (const s of restaurants) {
        const d = s.nav.getDistance(npc.tileX, npc.tileY);
        if (d < 0) continue;
        if (this.maxDistance != null && d > this.maxDistance) continue;

        let score = d;

        // Occupancy penalty
        const crowdPct = (s._getCrowdnessPct?.() ?? 0) / 100;
        if (crowdPct > this.crowdThreshold) {
          score += (crowdPct - this.crowdThreshold) * d * this.occupancyPenaltyWeight;
        }

        // Queue penalty
        const queueLen = s.queued?.size ?? 0;
        score += queueLen * this.queuePenaltyWeight;

        if (score < bestScore) {
          bestScore = score;
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

      const goToBestRestaurant = () => {
        if (++attempts > this.maxAttempts) {
          cleanup();
          resolve(null);
          return;
        }

        targetStore = pickBestScored();

        if (!targetStore) {
          const wait = Phaser.Math.Between(this.stepMinWaitMs, this.stepMaxWaitMs);
          timer = this.scene.time.delayedCall(wait, goToBestRestaurant);
          return;
        }

        const ok = npc.goToStoreNav(targetStore);

        if (!ok) {
          exclude.add(targetStore.storeId);
          const wait = Phaser.Math.Between(this.stepMinWaitMs, this.stepMaxWaitMs);
          timer = this.scene.time.delayedCall(wait, goToBestRestaurant);
        }
      };

      const onArrived = () => {
        cleanup();
        resolve({ store: targetStore });
      };

      const onStuck = () => {
        if (targetStore) exclude.add(targetStore.storeId);
        const wait = Phaser.Math.Between(this.stepMinWaitMs, this.stepMaxWaitMs);
        timer = this.scene.time.delayedCall(wait, goToBestRestaurant);
      };

      npc.on(NPC_EVENTS.ARRIVED, onArrived);
      npc.on(NPC_EVENTS.STUCK, onStuck);

      goToBestRestaurant();
    });
  }
}
