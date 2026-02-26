/**
 * GRID + ISO ADAPTER (single source of truth)
 * ------------------------------------------
 * Conventions:
 * - Game logic uses BASE-1 tile coords everywhere: (1,1) is origin tile
 * - Only GRID talks to Phaser tile layers (base-0) internally
 * - Only GRID knows how Tiled object snapping -> tile coords works
 */
export function makeGridIso(map, collisionLayer, originX, originY) {
  const tileW = map.tileWidth;
  const tileH = map.tileHeight;

  // Observed Tiled snap-to-grid for object layers steps by tileHeight
  const step = tileH;

  return {
    // geometry
    tileW,
    tileH,
    originX,
    originY,

    // tilemap dimensions (tiles, not pixels)
    width: map.width,
    height: map.height,

    // object snapping step (pixels)
    step,

    // ---------------------------
    // Base-1 bounds
    // ---------------------------
    inBounds(tX, tY) {
      return tX >= 1 && tY >= 1 && tX <= map.width && tY <= map.height;
    },

    // ---------------------------
    // Base-1 -> Phaser layer (base-0)
    // Only GRID touches layers directly.
    // ---------------------------
    getTile(tX, tY) {
      if (!this.inBounds(tX, tY)) return null;
      return collisionLayer.getTileAt(tX - 1, tY - 1);
    },

    isBlocked(tX, tY) {
      const tile = this.getTile(tX, tY);
      return !!(tile && tile.properties && tile.properties.collides);
    },

    // ---------------------------
    // Base-1 tile -> world pixels (iso projection + origin)
    // ---------------------------
    tileToWorld(tX, tY) {
      return {
        x: (tX - tY) * tileW * 0.5 + originX,
        y: (tX + tY) * tileH * 0.5 + originY
      };
    },

    // ---------------------------
    // Tiled object pixel position -> base-1 tile coords
    // Based on observed behavior:
    //   first tile anchor is at (step, step) => tile (1,1)
    // ---------------------------
    objectToTile(objX, objY) {
      return {
        x: Math.floor(objX / step),
        y: Math.floor(objY / step)
      };
    }
  };
}