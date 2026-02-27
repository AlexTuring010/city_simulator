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

  // Runtime collision overrides (base-1 tile keys)
  const blockedExtra = new Set();
  const keyOf = (tX, tY) => `${tX},${tY}`;

  // Optional: if you want to “paint” collision tiles into the layer too.
  // Pick a tile index that exists in your collision tileset.
  // If your collisionLayer is invisible anyway, any valid index works.
  const DEFAULT_COLLIDE_TILE_INDEX = 1;

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
      return collisionLayer?.getTileAt(tX - 1, tY - 1) ?? null;
    },

    // ---------------------------
    // Runtime blocked overrides
    // ---------------------------
    isBlockedExtra(tX, tY) {
      return blockedExtra.has(keyOf(tX, tY));
    },

    setBlocked(tX, tY, blocked = true, { mirrorToLayer = false, tileIndex = DEFAULT_COLLIDE_TILE_INDEX } = {}) {
      if (!this.inBounds(tX, tY)) return false;

      const k = keyOf(tX, tY);

      if (blocked) blockedExtra.add(k);
      else blockedExtra.delete(k);

      // Optional: mirror to collision layer so your current player collision code works unchanged
      if (mirrorToLayer && collisionLayer) {
        const lx = tX - 1;
        const ly = tY - 1;

        if (blocked) {
          const tile = collisionLayer.putTileAt(tileIndex, lx, ly);
          // Make sure properties exist and are set
          tile.setProperties({ ...(tile.properties || {}), collides: true });
        } else {
          // remove tile or at least clear collides property
          const tile = collisionLayer.getTileAt(lx, ly);
          if (tile) tile.setProperties({ ...(tile.properties || {}), collides: false });
          // or: collisionLayer.removeTileAt(lx, ly);
        }
      }

      return true;
    },

    clearBlocked(tX, tY, opts) {
      return this.setBlocked(tX, tY, false, opts);
    },

    resetBlockedExtra() {
      blockedExtra.clear();
    },

    isBlocked(tX, tY) {
      if (!this.inBounds(tX, tY)) return true; // treat out-of-bounds as blocked (usually what you want)
      if (this.isBlockedExtra(tX, tY)) return true;

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
    // (Optional but VERY useful)
    // World pixels -> base-1 tile coords
    // Lets player collision use GRID too.
    // ---------------------------
    worldToTile(worldX, worldY) {
      // Inverse of:
      // x = (tX - tY) * tileW/2 + originX
      // y = (tX + tY) * tileH/2 + originY
      const dx = worldX - originX;
      const dy = worldY - originY;

      const a = dx / (tileW * 0.5); // tX - tY
      const b = dy / (tileH * 0.5); // tX + tY

      const tX = (a + b) / 2;
      const tY = (b - a) / 2;

      // Convert to base-1 integer tile coords
      return {
        x: Math.round(tX),
        y: Math.round(tY)
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