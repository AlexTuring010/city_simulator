/**
 * Game Entry Point
 * ----------------
 * - Starts Phaser
 * - Initializes Google Maps + Heatmap
 * - Maps Phaser tile coords to the CURRENT visible Google Map viewport:
 *    tile (1,1)           -> top-left of the visible map
 *    tile (mapW, mapH)    -> bottom-right of the visible map
 *   so corners match corners.
 */

import { bootScene } from './scenes/bootScene.js';
import { mainScene } from './scenes/mainScene.js';

// ----------------------------------------------------
// Google Maps init (script is loaded async in index.html)
// ----------------------------------------------------
function waitForGoogleMaps() {
  return new Promise((resolve) => {
    const tick = () => {
      if (window.google?.maps?.visualization?.HeatmapLayer) return resolve();
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/**
 * Build a mapping function that converts (tileX,tileY) into a LatLng
 * inside the CURRENT visible viewport of Google Maps.
 *
 * Uses projection space (world points) for proper interpolation.
 */
function makeTileToLatLngFromViewport(map) {
  return function tileToLatLngFromViewport(tileX, tileY, mapW, mapH, opts = {}) {
    const base1 = opts.base1 ?? true; // your GRID comments suggest base-1

    // tile -> normalized [0..1] across entire tilemap
    const tx0 = base1 ? (tileX - 1) : tileX;
    const ty0 = base1 ? (tileY - 1) : tileY;

    // center-of-tile sampling
    const u = (tx0 + 0.5) / mapW; // left->right
    const v = (ty0 + 0.5) / mapH; // top->bottom

    const bounds = map.getBounds();
    const proj = map.getProjection();
    if (!bounds || !proj) return null;

    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();

    // Convert bounds corners to world points
    const pSW = proj.fromLatLngToPoint(sw);
    const pNE = proj.fromLatLngToPoint(ne);

    // Define top-left and bottom-right in world space
    // top-left  = (sw.x, ne.y)
    // bottom-right = (ne.x, sw.y)
    const pTL = new google.maps.Point(pSW.x, pNE.y);
    const pBR = new google.maps.Point(pNE.x, pSW.y);

    // Interpolate in projection space
    const x = pTL.x + u * (pBR.x - pTL.x);
    const y = pTL.y + v * (pBR.y - pTL.y);

    return proj.fromPointToLatLng(new google.maps.Point(x, y));
  };
}

async function initGoogleMapAndHeatmap() {
  await waitForGoogleMaps();

  // Create map
  const map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: 37.9838, lng: 23.7275 },
    zoom: 15,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false
    // If you want to "lock" the viewport so the mapping rectangle never changes:
    // draggable: false,
    // gestureHandling: "none",
    // zoomControl: false,
    // disableDefaultUI: true,
  });

  // Create heatmap
  const heatmap = new google.maps.visualization.HeatmapLayer({
    data: [],
    radius: 35,
    opacity: 0.7
  });
  heatmap.setMap(map);

  // Expose globals used by mainScene.update()
  window.__GM_MAP__ = map;
  window.__GM_HEAT__ = heatmap;
  window.__tileToLatLngViewport__ = makeTileToLatLngFromViewport(map);

  // Ensure projection/bounds are ready (first 'idle' fires when tiles are loaded)
  google.maps.event.addListenerOnce(map, 'idle', () => {
    // nothing required, but you could log readiness here
    // console.log("Google Maps ready");
  });
}

// Kick off Google map init (non-blocking)
initGoogleMapAndHeatmap();

// ----------------------------------------------------
// Phaser config (same as your original)
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