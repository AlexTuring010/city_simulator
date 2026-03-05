import { NPC } from '../npc/index.js';
import { NPC_EVENTS } from '../npc/NPCEvents.js';
import { EatOutController } from '../controllers/EatOutController.js';
import { RandomWanderController } from '../controllers/RandomWanderController.js';
import { NearestRestaurantGoal } from '../../strategies/NearestRestaurantGoal.js';

export class EpisodeManager {
  constructor(scene, { GRID, stores, spawners, wanderFactory } = {}) {
    this.scene = scene;
    this.GRID = GRID;
    this.stores = stores;
    this.spawners = spawners || [];

    this.wanderFactory =
      wanderFactory ||
      ((scene, npc, GRID) => new RandomWanderController(scene, npc, GRID, { minWaitMs: 800, maxWaitMs: 2500 }));

    // episode state
    this.episodeId = 0;
    this.running = false;

    this.activeNpcs = new Map(); // npcId -> npc
    this.spawnedCount = 0;

    this._spawnTimer = null;
    this._episodeTimer = null;

    // config defaults
    this.cfg = {
      population: 2000,
      spawnMode: 'rate',           // 'rate' | 'waves' | 'allAtOnce'
      spawnRatePerSec: 60,         // for 'rate'
      spawnBurst: 50,              // for 'waves'
      spawnBurstEveryMs: 800,      // for 'waves'
      maxEpisodeMs: 3 * 60_000,    // safety timeout
    };
  }

  startEpisode(overrides = {}) {
    if (this.running) return;

    this.episodeId++;
    this.running = true;

    // merge config for this episode
    this.cfg = { ...this.cfg, ...overrides };

    this.spawnedCount = 0;

    // optional: clear any leftovers (safe)
    this._clearTimers();

    // start timeout
    this._episodeTimer = this.scene.time.delayedCall(this.cfg.maxEpisodeMs, () => {
      this.endEpisode({ reason: 'TIMEOUT' });
    });

    // start spawning policy
    if (this.cfg.spawnMode === 'allAtOnce') {
      this._spawnN(this.cfg.population);
    } else if (this.cfg.spawnMode === 'waves') {
      this._scheduleWaveSpawn();
    } else {
      this._scheduleRateSpawn();
    }
  }

  endEpisode({ reason = 'DONE' } = {}) {
    if (!this.running) return;
    this.running = false;

    this._clearTimers();

    // If you want: force-despawn anything still alive on episode end
    // (or keep them to "finish leaving", up to you)
    for (const npc of this.activeNpcs.values()) {
      npc?.despawn?.('EPISODE_END');
    }
    this.activeNpcs.clear();

    // reset world state between episodes (important for training determinism)
    this._resetStores();

    // small delay then start next (or let caller decide)
    this.scene.time.delayedCall(250, () => {
      this.startEpisode(); // or comment out and call manually
    });
  }

  // Call this from MainScene.update if you want; not required.
  update() {
    // episode manager is timer/event driven; nothing per-frame required yet.
  }

  // ---------------- internal spawning policies ----------------

  _scheduleRateSpawn() {
    if (!this.running) return;
    const intervalMs = Math.max(10, Math.floor(1000 / this.cfg.spawnRatePerSec));

    this._spawnTimer = this.scene.time.addEvent({
      delay: intervalMs,
      loop: true,
      callback: () => {
        if (!this.running) return;
        if (this.spawnedCount >= this.cfg.population) {
          // stop spawning; episode ends when all have left
          this._clearSpawnTimer();
          return;
        }
        this._spawnN(1);
      }
    });
  }

  _scheduleWaveSpawn() {
    if (!this.running) return;

    this._spawnTimer = this.scene.time.addEvent({
      delay: this.cfg.spawnBurstEveryMs,
      loop: true,
      callback: () => {
        if (!this.running) return;
        if (this.spawnedCount >= this.cfg.population) {
          this._clearSpawnTimer();
          return;
        }
        const remaining = this.cfg.population - this.spawnedCount;
        const n = Math.min(this.cfg.spawnBurst, remaining);
        this._spawnN(n);
      }
    });
  }

  _spawnN(n) {
    if (!this.running) return;
    if (!this.spawners.length) return;

    for (let i = 0; i < n; i++) {
      if (this.spawnedCount >= this.cfg.population) break;

      const spawner = Phaser.Utils.Array.GetRandom(this.spawners);
      const t = this.GRID.objectToTile(spawner.x, spawner.y);

      const type = Phaser.Utils.Array.GetRandom(['type1', 'type2', 'type3']);
      const npc = new NPC(this.scene, this.GRID, t.x, t.y, { type });

      // Attach controllers for this episode
      const strategy = new NearestRestaurantGoal(this.scene, this.GRID, this.stores);

      const eatCtrl = new EatOutController(this.scene, npc, this.GRID, this.stores, strategy, {
        eatMode: 'auto',
        queueLoiterRadius: 4,
        queueLoiterStepMinMs: 700,
        queueLoiterStepMaxMs: 1800,
        loiterMaxRadiusSearch: 25,
        postEatWanderMinMs: 5000,
        postEatWanderMaxMs: 12000,
        wanderFactory: this.wanderFactory
      });

      npc.setController(eatCtrl);

      this._trackNpc(npc);
      this.spawnedCount++;
    }
  }

  _trackNpc(npc) {
    this.activeNpcs.set(npc.id, npc);

    const onDespawn = () => {
      npc.off(NPC_EVENTS.DESPAWNED, onDespawn);

      this.activeNpcs.delete(npc.id);

      // Episode ends when we've spawned everyone AND nobody is left alive
      if (this.running && this.spawnedCount >= this.cfg.population && this.activeNpcs.size === 0) {
        this.endEpisode({ reason: 'ALL_LEFT' });
      }
    };

    npc.on(NPC_EVENTS.DESPAWNED, onDespawn);
  }

  _resetStores() {
    // You should add Store.reset() later.
    // For now, do minimal safe reset if you have methods.
    for (const s of Object.values(this.stores || {})) {
      s?.queue?.clear?.();
      s?.queued?.clear?.();
      // If you add a proper store.reset(): call it here.
    }
  }

  _clearSpawnTimer() {
    if (this._spawnTimer) {
      this._spawnTimer.remove(false);
      this._spawnTimer = null;
    }
  }

  _clearTimers() {
    this._clearSpawnTimer();
    if (this._episodeTimer) {
      this._episodeTimer.remove(false);
      this._episodeTimer = null;
    }
  }
}