import { NPC_EVENTS } from '../npc/NPCEvents.js';

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