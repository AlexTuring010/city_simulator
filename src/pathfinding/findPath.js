// src/pathfinding/findPath.js

/**
 * Lightweight A* Pathfinding (BASE-1)
 * ----------------------------------
 * Uses GRID as a black box:
 * - GRID.inBounds(x,y)
 * - GRID.isBlocked(x,y, { allowWeak? })
 */
export function findPath(GRID, startX, startY, endX, endY, opts = {}) {
  const {
    allowBlockedStart = true,   // start being blocked is usually fine (you can still step out)
    allowBlockedGoal = false,   // IMPORTANT for “sit on table” / “stand in doorway”
    allowBlockedPath = false,   // set true only if you really want to walk through walls
    allowWeakCollision = false  // NEW: if true, weak-collision tiles are treated as walkable
  } = opts;

  const blockedArgs = { allowWeak: allowWeakCollision };

  // If you want to *disallow* starting inside a blocked tile:
  if (!allowBlockedStart && GRID.isBlocked(startX, startY, blockedArgs)) return null;

  const openSet = [{ x: startX, y: startY, g: 0, f: 0, parent: null }];
  const closedSet = new Set();

  const key = (x, y) => `${x},${y}`;
  const heuristic = (x, y) => Math.abs(x - endX) + Math.abs(y - endY);

  while (openSet.length > 0) {
    openSet.sort((a, b) => a.f - b.f);
    const current = openSet.shift();

    if (current.x === endX && current.y === endY) {
      const path = [];
      for (let n = current; n; n = n.parent) path.push({ x: n.x, y: n.y });
      return path.reverse();
    }

    closedSet.add(key(current.x, current.y));

    const neighbors = [
      { x: current.x,     y: current.y - 1 },
      { x: current.x,     y: current.y + 1 },
      { x: current.x - 1, y: current.y },
      { x: current.x + 1, y: current.y }
    ];

    for (const n of neighbors) {
      if (!GRID.inBounds(n.x, n.y)) continue;
      if (closedSet.has(key(n.x, n.y))) continue;

      const isGoal = (n.x === endX && n.y === endY);

      // Block rule:
      // - normally blocked tiles are forbidden
      // - but allow the GOAL tile if allowBlockedGoal
      // - or allow all blocked tiles if allowBlockedPath
      if (GRID.isBlocked(n.x, n.y, blockedArgs)) {
        if (!allowBlockedPath && !(allowBlockedGoal && isGoal)) continue;
      }

      const gScore = current.g + 1;
      const existing = openSet.find(node => node.x === n.x && node.y === n.y);

      if (!existing || gScore < existing.g) {
        if (!existing) {
          openSet.push({
            x: n.x, y: n.y,
            g: gScore,
            f: gScore + heuristic(n.x, n.y),
            parent: current
          });
        } else {
          existing.g = gScore;
          existing.f = gScore + heuristic(n.x, n.y);
          existing.parent = current;
        }
      }
    }
  }

  return null;
}

/**
 * Debug pathfinding map (BASE-1 display)
 * -------------------------------------
 * Prints logical grid to console:
 * - x = blocked
 * - . = free
 * - p = start
 * - q = target
 * - * = path
 */
export function printDebugMap(GRID, startX, startY, targetX, targetY, path) {
  const mapWidth = GRID.width;
  const mapHeight = GRID.height;

  const grid = [];

  for (let y = 1; y <= mapHeight; y++) {
    const row = [];
    for (let x = 1; x <= mapWidth; x++) {
      row.push(GRID.isBlocked(x, y) ? 'x' : '.');
    }
    grid.push(row);
  }

  if (path) {
    path.forEach(node => {
      const gx = node.x - 1;
      const gy = node.y - 1;
      if (grid[gy] && grid[gy][gx] !== undefined) grid[gy][gx] = '*';
    });
  }

  const tGX = targetX - 1, tGY = targetY - 1;
  if (grid[tGY] && grid[tGY][tGX] !== undefined) grid[tGY][tGX] = 'q';

  const sGX = startX - 1, sGY = startY - 1;
  if (grid[sGY] && grid[sGY][sGX] !== undefined) grid[sGY][sGX] = 'p';

  console.log("--- A* Pathfinding Logical Grid (base-1 coords) ---");
  for (let y0 = 0; y0 < mapHeight; y0++) {
    const rowNum = (y0 + 1).toString().padStart(2, '0');
    console.log(`${rowNum}: ${grid[y0].join('  ')}`);
  }
  console.log("--------------------------------------------------");
}

/**
 * Find closest walkable (non-blocked) tile to (x,y).
 * Uses BFS so the first hit is guaranteed closest by Manhattan steps.
 *
 * Options:
 * - maxRadius: cap search distance (tiles)
 * - allowSame: if true and (x,y) is free, returns it immediately
 * - passable: custom passable check (defaults to !GRID.isBlocked)
 *
 * Returns: {x, y} or null
 */
export function findClosestFreeTile(
  GRID,
  x,
  y,
  {
    maxRadius = 50,
    allowSame = true,
    passable = (tx, ty) => !GRID.isBlocked(tx, ty)
  } = {}
) {
  if (!GRID.inBounds(x, y)) return null;

  // If current tile is already valid
  if (allowSame && passable(x, y)) return { x, y };

  const key = (tx, ty) => `${tx},${ty}`;
  const visited = new Set([key(x, y)]);

  // Each queue item also tracks distance from start
  const q = [{ x, y, d: 0 }];

  const dirs = [
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 }
  ];

  while (q.length) {
    const cur = q.shift();
    if (cur.d >= maxRadius) continue;

    for (const { dx, dy } of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!GRID.inBounds(nx, ny)) continue;

      const k = key(nx, ny);
      if (visited.has(k)) continue;
      visited.add(k);

      // First passable tile found is the closest (BFS property)
      if (passable(nx, ny)) return { x: nx, y: ny };

      q.push({ x: nx, y: ny, d: cur.d + 1 });
    }
  }

  return null;
}