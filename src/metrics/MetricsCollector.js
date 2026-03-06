// src/metrics/MetricsCollector.js

export class MetricsCollector {
  constructor() {
    this.data = {
      baseline: null,
      ai: null
    };
    this.onUpdate = null;
  }

  collect(simKey, npcStats, storeStats) {
    this.data[simKey] = { npcStats, storeStats };

    // Fire callback when both sims have reported
    if (this.data.baseline && this.data.ai && this.onUpdate) {
      this.onUpdate(this.data);
    }
  }

  reset() {
    this.data.baseline = null;
    this.data.ai = null;
  }
}
