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
  // Strong always blocks, weak blocks unless allowWeak=true in isBlocked()
  const blockedExtraStrong = new Set();
  const blockedExtraWeak = new Set();
  const keyOf = (tX, tY) => `${tX},${tY}`;

  // Optional: if you want to “paint” collision tiles into the layer too.
  // Pick a tile index that exists in your collision tileset.
  // If your collisionLayer is invisible anyway, any valid index works.
  const DEFAULT_COLLIDE_TILE_INDEX = 1;

  // Property keys (keep as constants to avoid inconsistent casing)
  const PROP_COLLIDES = "collides";
  const PROP_WEAK = "WeakCollision";

  // Tiny helper: safely read a tile boolean property
  const tilePropBool = (tile, key) => !!(tile && tile.properties && tile.properties[key]);

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
    isBlockedExtra(tX, tY, { allowWeak = false } = {}) {
      const k = keyOf(tX, tY);

      // Strong runtime block always blocks
      if (blockedExtraStrong.has(k)) return true;

      // Weak runtime block blocks unless allowWeak
      if (blockedExtraWeak.has(k) && !allowWeak) return true;

      return false;
    },

    /**
     * Set runtime blocked override.
     * - strong blocks always
     * - weak blocks only when allowWeak=false in isBlocked()
     *
     * Optionally mirror to tile layer and mark weak/strong there too.
     */
    setBlocked(
      tX,
      tY,
      blocked = true,
      {
        mirrorToLayer = false,
        tileIndex = DEFAULT_COLLIDE_TILE_INDEX,
        weak = false
      } = {}
    ) {
      if (!this.inBounds(tX, tY)) return false;
      const k = keyOf(tX, tY);

      // Always clear from both sets first (so flipping weak/strong is clean)
      blockedExtraStrong.delete(k);
      blockedExtraWeak.delete(k);

      if (blocked) {
        (weak ? blockedExtraWeak : blockedExtraStrong).add(k);
      }

      // Optional: mirror to collision layer so other code that still reads the layer works unchanged
      if (mirrorToLayer && collisionLayer) {
        const lx = tX - 1;
        const ly = tY - 1;

        if (blocked) {
          const tile = collisionLayer.putTileAt(tileIndex, lx, ly);

          // Phaser version-safe: some builds don't have tile.setProperties()
          if (tile) {
            tile.properties = tile.properties || {};
            // Strong vs weak collision flags
            tile.properties[PROP_COLLIDES] = !weak;
            tile.properties[PROP_WEAK] = !!weak;
          }
        } else {
          // cleanest: actually remove the tile
          collisionLayer.removeTileAt(lx, ly);

          // If you prefer not removing, do:
          // const tile = collisionLayer.getTileAt(lx, ly);
          // if (tile) {
          //   tile.properties = tile.properties || {};
          //   tile.properties[PROP_COLLIDES] = false;
          //   tile.properties[PROP_WEAK] = false;
          // }
        }
      }

      return true;
    },

    clearBlocked(tX, tY, opts) {
      return this.setBlocked(tX, tY, false, opts);
    },

    resetBlockedExtra() {
      blockedExtraStrong.clear();
      blockedExtraWeak.clear();
    },

    /**
     * Collision query.
     * - Out-of-bounds is blocked.
     * - Runtime strong blocks always block.
     * - Runtime weak blocks block unless allowWeak is true.
     * - Tile-layer "collides" always blocks.
     * - Tile-layer "WeakCollision" blocks unless allowWeak is true.
     */
    isBlocked(tX, tY, { allowWeak = false } = {}) {
      if (!this.inBounds(tX, tY)) return true; // treat out-of-bounds as blocked

      // Runtime overrides (strong/weak aware)
      if (this.isBlockedExtra(tX, tY, { allowWeak })) return true;

      const tile = this.getTile(tX, tY);
      if (!tile) return false;

      // Strong tile collision always blocks
      if (tilePropBool(tile, PROP_COLLIDES)) return true;

      // Weak tile collision blocks unless allowWeak
      const isWeak = tilePropBool(tile, PROP_WEAK);
      if (isWeak && !allowWeak) return true;

      return false;
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
    // World pixels -> base-1 tile coords
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