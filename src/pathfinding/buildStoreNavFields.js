// src/pathfinding/buildStoreNavFields.js

import { findClosestFreeTile } from './findPath.js';
import { buildNavFieldToGoal } from './navFieldSingleGoal.js';

export function buildRestaurantNavFields(GRID, storesById, mapW, mapH, opts = {}) {
  const {
    storeTypes = ['left_restaurant', 'right_restaurant'],
    closestTileMaxRadius = 50,
    allowSame = true,
    allowWeakCollision = false
  } = opts;

  const types = new Set(storeTypes);

  for (const store of Object.values(storesById || {})) {
    if (!store || !types.has(store.storeType)) continue;

    const e = store.entryTile;
    if (!e) continue;

    const goal = findClosestFreeTile(GRID, e.x, e.y, {
      maxRadius: closestTileMaxRadius,
      allowSame,
      passable: (tx, ty) => !GRID.isBlocked(tx, ty, { allowWeak: allowWeakCollision })
    });

    store.goalTile = goal || null;

    if (!goal) {
      store.nav = null;
      continue;
    }

    store.nav = buildNavFieldToGoal(GRID, mapW, mapH, goal.x, goal.y, {
      allowWeakCollision,
      allowBlockedPath: false
    });
  }
}