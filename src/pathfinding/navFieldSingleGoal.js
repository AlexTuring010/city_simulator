// src/pathfinding/navFieldSingleGoal.js
// Single-goal BFS navfield (BASE-1).
// Stores dist + nextDir so you can step toward the goal in O(1).

const DIR_NONE  = 0;
const DIR_UP    = 1;
const DIR_DOWN  = 2;
const DIR_LEFT  = 3;
const DIR_RIGHT = 4;

function dirToward(nx, ny, cx, cy) {
  if (cx === nx && cy === ny - 1) return DIR_UP;
  if (cx === nx && cy === ny + 1) return DIR_DOWN;
  if (cx === nx - 1 && cy === ny) return DIR_LEFT;
  if (cx === nx + 1 && cy === ny) return DIR_RIGHT;
  return DIR_NONE;
}

function stepFromDir(x, y, dir) {
  switch (dir) {
    case DIR_UP:    return { x, y: y - 1 };
    case DIR_DOWN:  return { x, y: y + 1 };
    case DIR_LEFT:  return { x: x - 1, y };
    case DIR_RIGHT: return { x: x + 1, y };
    default:        return null;
  }
}

export function buildNavFieldToGoal(GRID, mapW, mapH, goalX, goalY, opts = {}) {
  const {
    allowWeakCollision = false,
    allowBlockedPath = false
  } = opts;

  const stride = mapW + 2;
  const rows = mapH + 2;
  const size = stride * rows;

  // If max distance could exceed 32767, use Int32Array. Here max ~ 300, so Int16 is perfect.
  const dist = new Int16Array(size);
  dist.fill(-1);

  const nextDir = new Uint8Array(size);
  const blockedArgs = { allowWeak: allowWeakCollision };

  const idx = (x, y) => y * stride + x;

  const passable = (x, y) => {
    if (!GRID.inBounds(x, y)) return false;
    if (allowBlockedPath) return true;
    return !GRID.isBlocked(x, y, blockedArgs);
  };

  if (!passable(goalX, goalY)) {
    return makeApi({ dist, nextDir, stride });
  }

  // BFS queue
  const qx = new Int16Array(size);
  const qy = new Int16Array(size);
  let qh = 0, qt = 0;

  dist[idx(goalX, goalY)] = 0;
  qx[qt] = goalX; qy[qt] = goalY; qt++;

  while (qh < qt) {
    const cx = qx[qh];
    const cy = qy[qh];
    qh++;

    const cIdx = idx(cx, cy);
    const cDist = dist[cIdx];

    const ns = [
      { x: cx,     y: cy - 1 },
      { x: cx,     y: cy + 1 },
      { x: cx - 1, y: cy },
      { x: cx + 1, y: cy }
    ];

    for (const n of ns) {
      if (!passable(n.x, n.y)) continue;

      const ni = idx(n.x, n.y);
      if (dist[ni] !== -1) continue;

      dist[ni] = cDist + 1;
      nextDir[ni] = dirToward(n.x, n.y, cx, cy);

      qx[qt] = n.x;
      qy[qt] = n.y;
      qt++;
    }
  }

  return makeApi({ dist, nextDir, stride });
}

function makeApi({ dist, nextDir, stride }) {
  const idx = (x, y) => y * stride + x;

  return {
    getDistance(x, y) {
      return dist[idx(x, y)];
    },
    getNextStep(x, y) {
      const d = dist[idx(x, y)];
      if (d <= 0) return null;
      const dir = nextDir[idx(x, y)];
      if (dir === 0) return null;
      return stepFromDir(x, y, dir);
    },
    _raw: { dist, nextDir, stride }
  };
}