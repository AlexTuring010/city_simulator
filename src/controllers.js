/**
 * Controllers
 * -----------
 * Uses NPC + GRID as black boxes.
 */

export class RandomWanderController {
  constructor(scene, npc, GRID, { minWaitMs = 1000, maxWaitMs = 4000 } = {}) {
    this.scene = scene;
    this.npc = npc;
    this.GRID = GRID;
    this.minWaitMs = minWaitMs;
    this.maxWaitMs = maxWaitMs;

    // When npc arrives or fails, schedule next wander
    npc.on('arrived', () => this.scheduleNext());
    npc.on('stuck', () => this.scheduleNext());

    // Kick off
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
      if (this.npc.goToTile(goalX, goalY)) return;
    }

    // fallback: just wait and try later
    this.scheduleNext();
  }
}