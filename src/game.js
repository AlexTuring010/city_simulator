/**
 * Game Entry Point — A/B Comparison Mode
 * ----------------------------------------
 * - Two Phaser instances (Baseline vs AI)
 * - Two Google Maps with heatmaps
 * - Metrics collection + Chart.js rendering
 */

import { createBootScene } from './scenes/bootScene.js';
import { createMainScene } from './scenes/mainScene.js';
import { NearestRestaurantGoal } from './strategies/NearestRestaurantGoal.js';
import { AIRecsRestaurantGoal } from './strategies/AIRecsRestaurantGoal.js';
import { MetricsCollector } from './metrics/MetricsCollector.js';
import { renderAllCharts } from './metrics/charts.js';

// ----------------------------------------------------
// Deterministic seed for both sims
// ----------------------------------------------------
const SEED = 'crowdless2026';

// ----------------------------------------------------
// Google Maps — dual instance registry
// ----------------------------------------------------
window.__simMaps__ = {};

function waitForGoogleMaps() {
  return new Promise((resolve) => {
    const tick = () => {
      if (window.google?.maps?.visualization?.HeatmapLayer) return resolve();
      requestAnimationFrame(tick);
    };
    tick();
  });
}

function makeTileToLatLngFromViewport(map) {
  return function tileToLatLngFromViewport(tileX, tileY, mapW, mapH, opts = {}) {
    const base1 = opts.base1 ?? true;

    const tx0 = base1 ? (tileX - 1) : tileX;
    const ty0 = base1 ? (tileY - 1) : tileY;

    const u = (tx0 + 0.5) / mapW;
    const v = (ty0 + 0.5) / mapH;

    const bounds = map.getBounds();
    const proj = map.getProjection();
    if (!bounds || !proj) return null;

    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();

    const pSW = proj.fromLatLngToPoint(sw);
    const pNE = proj.fromLatLngToPoint(ne);

    const pTL = new google.maps.Point(pSW.x, pNE.y);
    const pBR = new google.maps.Point(pNE.x, pSW.y);

    const x = pTL.x + u * (pBR.x - pTL.x);
    const y = pTL.y + v * (pBR.y - pTL.y);

    return proj.fromPointToLatLng(new google.maps.Point(x, y));
  };
}

const MAP_CONFIG = {
  center: { lat: 37.9838, lng: 23.7275 },
  zoom: 15,
  mapTypeId: "hybrid",
  disableDefaultUI: true,
  zoomControl: false,
  streetViewControl: false,
  mapTypeControl: false,
  fullscreenControl: false,
  gestureHandling: "none",
  keyboardShortcuts: false,
  clickableIcons: false,
  disableDoubleClickZoom: true,
  scrollwheel: false,
  draggable: false
};

async function initMapForSim(domId, simKey) {
  await waitForGoogleMaps();
  const map = new google.maps.Map(document.getElementById(domId), { ...MAP_CONFIG });
  const heatmap = new google.maps.visualization.HeatmapLayer({
    data: [],
    radius: 35,
    opacity: 0.7
  });
  heatmap.setMap(map);
  window.__simMaps__[simKey] = {
    map,
    heatmap,
    tileToLatLng: makeTileToLatLngFromViewport(map)
  };
}

// Init both maps (non-blocking)
initMapForSim('map-A', 'baseline');
initMapForSim('map-B', 'ai');

// ----------------------------------------------------
// Metrics collector
// ----------------------------------------------------
const collector = new MetricsCollector();
collector.onUpdate = (data) => renderAllCharts(data);

// ----------------------------------------------------
// Episode coordinator — barrier-sync for A/B fairness
// ----------------------------------------------------
const coordinator = {
  scenes: {},
  readyCount: 0,
  finishedCount: 0,
  episodeCfg: null,

  onSceneReady(simKey, scene) {
    this.scenes[simKey] = scene;
    if (!this.episodeCfg) this.episodeCfg = scene._episodeCfg;
    this.readyCount++;
    if (this.readyCount >= 2) this._startBoth();
  },

  onSceneEpisodeEnd(simKey, npcStats, storeStats) {
    collector.collect(simKey, npcStats, storeStats);
    this.finishedCount++;
    if (this.finishedCount >= 2) this._startBoth();
  },

  _startBoth() {
    this.finishedCount = 0;
    setTimeout(() => {
      for (const scene of Object.values(this.scenes)) {
        scene.episode.startEpisode(this.episodeCfg);
      }
    }, 300);
  }
};

// ----------------------------------------------------
// Two Phaser instances
// ----------------------------------------------------
const population = 1000;

// Baseline
new Phaser.Game({
  type: Phaser.AUTO,
  width: 700,
  height: 500,
  parent: 'game-container-A',
  pixelArt: true,
  scene: [
    createBootScene(),
    createMainScene({
      simKey: 'baseline',
      strategyFactory: (sc, G, st) => new NearestRestaurantGoal(sc, G, st),
      hudElementId: 'hud-npcs-A',
      deferStart: true,
      autoRestart: false,
      onReady: (scene) => coordinator.onSceneReady('baseline', scene),
      onEpisodeEnd: (n, s) => coordinator.onSceneEpisodeEnd('baseline', n, s),
      onLiveUpdate: (n, s) => collector.collect('baseline', n, s),
      population,
    })
  ],
  callbacks: {
    preBoot: (game) => {
      game.registry.set('rngSeed', SEED);
    }
  }
});

// AI
new Phaser.Game({
  type: Phaser.AUTO,
  width: 700,
  height: 500,
  parent: 'game-container-B',
  pixelArt: true,
  scene: [
    createBootScene(),
    createMainScene({
      simKey: 'ai',
      strategyFactory: (sc, G, st) => new AIRecsRestaurantGoal(sc, G, st),
      hudElementId: 'hud-npcs-B',
      deferStart: true,
      autoRestart: false,
      onReady: (scene) => coordinator.onSceneReady('ai', scene),
      onEpisodeEnd: (n, s) => coordinator.onSceneEpisodeEnd('ai', n, s),
      onLiveUpdate: (n, s) => collector.collect('ai', n, s),
      population,
    })
  ],
  callbacks: {
    preBoot: (game) => {
      game.registry.set('rngSeed', SEED);
    }
  }
});
