import { NPC_EVENTS } from '../npc/NPCEvents.js';

// Mainly made this for testing purposes during early development to play around and 
// see that NPCs move around correctly and arrow indicators are rendered well. A real
// controller such as EatOutController will be using a strategy from ./../strategies/ 
// folder to find a place to eat at. Strategies can be using google map recommendations,
// using our own app where our AI recommends them places, or, just walk around scanning
// tiles near them till they spot a place, backtracking if they dont find any place,
// this specific strategy will need to define what the scan radius is, like, how close
// should the NPC be to a store to detect it as his target. All those are different than
// path finding algorithms cause you arent searching for stores and then moving the NPC, 
// you are moving the NPC as he is searching for stores, or in the case where we are using
// recommendations, we know where the store is at then we can just move the NPC there

export class RandomWanderController {
  constructor(scene, npc, GRID, { minWaitMs = 1000, maxWaitMs = 4000 } = {}) {
    this.scene = scene;
    this.npc = npc;
    this.GRID = GRID;
    this.minWaitMs = minWaitMs;
    this.maxWaitMs = maxWaitMs;

    npc.on(NPC_EVENTS.ARRIVED, () => this.scheduleNext());
    npc.on(NPC_EVENTS.STUCK, () => this.scheduleNext());

    this.scheduleNext();
  }

  scheduleNext() {
    const waitMs = Phaser.Math.Between(this.minWaitMs, this.maxWaitMs);
    this.scene.time.delayedCall(waitMs, () => this.pickAndSendGoal());
  }

  pickAndSendGoal() {
    let attempts = 0;

    while (attempts++ < 10) {
      const goalX = Phaser.Math.Between(1, this.GRID.width);
      const goalY = Phaser.Math.Between(1, this.GRID.height);

      if (this.GRID.isBlocked(goalX, goalY)) continue;

      if (this.npc.goToTile(goalX, goalY, {
        showIndicator: true,
        indicatorColor: 0x00FFFF
      })) return;
    }

    this.scheduleNext();
  }
}