/**
 * Game Entry Point
 * ----------------
 * Wires scenes into Phaser and starts the game.
 */

import { bootScene } from './scenes/bootScene.js';
import { mainScene } from './scenes/mainScene.js';
import { HeatOverlay } from './heat/heatOverlay.js';

// ----------------------------------------------------
// 1️⃣  Create Leaflet map (right side)
// ----------------------------------------------------
const map = L.map('map', {
  zoomControl: true
}).setView([37.9838, 23.7275], 13); // change to your default location

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OpenStreetMap'
}).addTo(map);

// ----------------------------------------------------
// 2️⃣  Create heat overlay canvas
// ----------------------------------------------------
const heatCanvas = document.getElementById('heat-canvas');

const heat = new HeatOverlay(heatCanvas, {
  gridW: 60,     // change anytime dynamically
  gridH: 60,
  throttleMs: 50 // ~20fps
});

// keep overlay sized correctly
map.on('resize move zoom', () => {
  heat.resize();
});

// Expose to Phaser scene (simple bridge)
window.__HEAT__ = heat;

// After map + heat created:
function syncSizes() {
  map.invalidateSize();
  heat.resize();
}

// Run once after first layout
requestAnimationFrame(() => {
  syncSizes();
});

// Run on window resize
window.addEventListener("resize", () => {
  syncSizes();
});

// Also when leaflet changes view (optional, but good)
map.on("zoom move resize", () => {
  heat.resize();
});

// ----------------------------------------------------
// 3️⃣  Phaser config (your original config preserved)
// ----------------------------------------------------
const config = {
  type: Phaser.AUTO,
  width: 800,
  height: 600,
  parent: 'game-container',
  pixelArt: true,
  scene: [bootScene, mainScene]
};

new Phaser.Game(config);