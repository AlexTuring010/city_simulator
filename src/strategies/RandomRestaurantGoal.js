import { NPC_EVENTS } from '../sim/npc/NPCEvents.js';
import { findClosestFreeTile } from '../pathfinding/findPath.js'; 

export class RandomRestaurantGoal {
  constructor(scene, GRID, storesById, {
    maxAttempts = 30,
    stepMinWaitMs = 250,
    stepMaxWaitMs = 800,
    storeTypes = ['left_restaurant', 'right_restaurant'],
    closestTileMaxRadius = 50,        // maps to your helper’s maxRadius
    allowSame = true
  } = {}) {
    this.scene = scene;
    this.GRID = GRID;
    this.storesById = storesById;

    this.maxAttempts = maxAttempts;
    this.stepMinWaitMs = stepMinWaitMs;
    this.stepMaxWaitMs = stepMaxWaitMs;
    this.storeTypes = new Set(storeTypes);

    this.closestTileMaxRadius = closestTileMaxRadius;
    this.allowSame = allowSame;
  }

  acquireTarget(npc) {
    const stores = Object.values(this.storesById || {})
      .filter(s => this.storeTypes.has(s.storeType));
    if (!stores.length) return Promise.resolve(null);

    const pickRandomStore = () =>
      stores[Phaser.Math.Between(0, stores.length - 1)];

    let attempts = 0;
    let timer = null;
    let targetStore = null;

    return new Promise((resolve) => {
      const cleanup = () => {
        npc.off(NPC_EVENTS.ARRIVED, onArrived);
        npc.off(NPC_EVENTS.STUCK, onStuck);
        if (timer) { timer.remove(false); timer = null; }
      };

      const goToRandomRestaurant = () => {
        if (++attempts > this.maxAttempts) {
          cleanup();
          resolve(null);
          return;
        }

        targetStore = pickRandomStore();
        const e = targetStore.entryTile;

        const goal = findClosestFreeTile(this.GRID, e.x, e.y, {
          maxRadius: this.closestTileMaxRadius,
          allowSame: this.allowSame,
          passable: (tx, ty) => !this.GRID.isBlocked(tx, ty)
        });

        // If we can’t find any free tile near this store, try another quickly
        if (!goal) {
          console.warn(`No free tile found near store entry (${e.x}, ${e.y}) for NPC ${npc.id}; picking another store...`);
          timer = this.scene.time.delayedCall(0, goToRandomRestaurant);
          return;
        }

        // For defense purposes, if we are inside a blocked tile, lets move outside it instead of giving up
        const outsideGoal = findClosestFreeTile(this.GRID, npc.tileX, npc.tileY);
        if (outsideGoal && (outsideGoal.x !== npc.tileX || outsideGoal.y !== npc.tileY)) {
          npc.goToTile(outsideGoal.x, outsideGoal.y, {
            allowBlockedPath: true,
          });
        }

        npc.goToTile(goal.x, goal.y, {
        });
      };

      const onArrived = () => {
        cleanup();
        resolve({ store: targetStore });
      };

      const onStuck = () => {
        // pick another restaurant after a short random delay
        const wait = Phaser.Math.Between(this.stepMinWaitMs, this.stepMaxWaitMs);
        timer = this.scene.time.delayedCall(wait, goToRandomRestaurant);
      };

      npc.on(NPC_EVENTS.ARRIVED, onArrived);
      npc.on(NPC_EVENTS.STUCK, onStuck);

      goToRandomRestaurant();
    });
  }
}