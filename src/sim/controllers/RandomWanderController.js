// src/sim/controllers/RandomWanderController.js
import { NPC_EVENTS } from '../npc/NPCEvents.js';

/**
 * RandomWanderController
 * ---------------------
 * Stack-friendly controller:
 * - onStart: becomes active (binds events, schedules movement)
 * - onPause: loses control (unbinds, clears timers)
 * - onResume: regains control
 * - onStop: permanently removed
 */
export class RandomWanderController {
  constructor(scene, npc, GRID, { minWaitMs = 1000, maxWaitMs = 4000 } = {}) {
    this.scene = scene;
    this.npc = npc;
    this.GRID = GRID;
    this.minWaitMs = minWaitMs;
    this.maxWaitMs = maxWaitMs;

    this._timer = null;
    this._active = false;

    this._onArrived = () => this.scheduleNext();
    this._onStuck = () => this.scheduleNext();
  }

  onStart() {
    this._active = true;
    this._bind();
    this.scheduleNext();
  }

  onPause() {
    this._active = false;
    this._unbind();
    this._clearTimer();
  }

  onResume() {
    this._active = true;
    this._bind();
    this.scheduleNext();
  }

  onStop() {
    this._active = false;
    this._unbind();
    this._clearTimer();
  }

  update() {
    // Wander is purely event/timer driven; nothing per-frame needed.
  }

  _bind() {
    if (!this.npc) return;
    this.npc.on(NPC_EVENTS.ARRIVED, this._onArrived);
    this.npc.on(NPC_EVENTS.STUCK, this._onStuck);
  }

  _unbind() {
    if (!this.npc) return;
    this.npc.off(NPC_EVENTS.ARRIVED, this._onArrived);
    this.npc.off(NPC_EVENTS.STUCK, this._onStuck);
  }

  _clearTimer() {
    if (this._timer) {
      this._timer.remove(false);
      this._timer = null;
    }
  }

  scheduleNext() {
    if (!this._active) return;

    this._clearTimer();
    const waitMs = Phaser.Math.Between(this.minWaitMs, this.maxWaitMs);

    this._timer = this.scene.time.delayedCall(waitMs, () => {
      this._timer = null;
      this.pickAndSendGoal();
    });
  }

  pickAndSendGoal() {
    if (!this._active) return;

    let attempts = 0;
    while (attempts++ < 10) {
      const goalX = Phaser.Math.Between(1, this.GRID.width);
      const goalY = Phaser.Math.Between(1, this.GRID.height);

      if (this.GRID.isBlocked(goalX, goalY)) continue;

      if (this.npc.goToTile(goalX, goalY, {
        showIndicator: true,
        indicatorColor: 0x00FFFF
      })) {
        return;
      }
    }

    this.scheduleNext();
  }
}