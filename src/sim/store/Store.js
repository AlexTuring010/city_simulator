// src/sim/store/Store.js (simple, log-driven)
//
// RULES (as requested):
// - Store has indoor capacity + outside tables (2 seats each).
// - On requestEnter(npc):
//   - Randomly choose INDOORS vs TABLE, subject to availability rules.
//   - Immediately log assignment (indoors-- or table seat taken).
//   - Return ok + coordinates + table/seat if table.
// - If no space: queue (bounded).
// - When space becomes available (npcDoneEating):
//   - Pop from queue and assign immediately.
//   - Emit npc event: NPC_EVENTS.CALLED_TO_ENTER with the payload.
// - Controller may remove an npc from queue at any time.
//
// IMPORTANT:
// - We do NOT call table.seatNpc here.
// - We do NOT inspect table internal state.
// - Store logs are source of truth.

import { NPC_EVENTS } from '../npc/NPCEvents.js';

const STORE_TYPE_CONFIG = {
  left_restaurant: {
    row: 0,
    footprint: { w: 4, h: 4, ox: 1, oy: 0 },
    insideTileOffset: { x: 1, y: 1 },
    DepthOffset: 32
  },
  right_restaurant: {
    row: 1,
    footprint: { w: 4, h: 4, ox: 0, oy: 1 },
    entryOffset: { x: 2, y: 2 },
    insideTileOffset: { x: 2, y: 1 },
    DepthOffset: 18
  }
};

// Tiny O(1) amortized queue (lazy deletion supported)
class Deque {
  constructor() { this._a = []; this._h = 0; }
  get length() { return this._a.length - this._h; }
  push(v) { this._a.push(v); }
  shift() {
    if (this._h >= this._a.length) return undefined;
    const v = this._a[this._h++];
    if (this._h > 1024 && this._h * 2 > this._a.length) {
      this._a = this._a.slice(this._h);
      this._h = 0;
    }
    return v;
  }
  clear() { this._a.length = 0; this._h = 0; }
}

export class Store {
  constructor(scene, GRID, tileX, tileY, {
    storeId,
    indoorsCapacity = 0,
    storeType = 'left_restaurant',
    maxQueue = null
  } = {}) {
    this.scene = scene;
    this.GRID = GRID;

    this.storeId = storeId;
    this.storeType = storeType;

    this.tileX = tileX;
    this.tileY = tileY;

    // --- visuals config (KEEP) ---
    this._typeCfg = STORE_TYPE_CONFIG[storeType] ?? null;

    this.X = tileX + (this._typeCfg?.footprint?.ox ?? 0);
    this.Y = tileY + (this._typeCfg?.footprint?.oy ?? 0);

    const p = GRID.tileToWorld(this.X, this.Y);
    this.sprite = scene.add.sprite(p.x, p.y, 'stores', this._frameClosed());
    this.sprite.setOrigin(0.5, 1);
    this.sprite.setDepth(p.y - (this._typeCfg?.DepthOffset ?? 0));

    this._stampCollisionOnce();

    // --- door timer ---
    this._doorTimer = null;

    // --- capacity logs (source of truth) ---
    this.indoorsCapacity = Math.max(0, indoorsCapacity);
    this._freeIndoor = this.indoorsCapacity;

    // --- tables (outside) ---
    // We keep references, but never inspect table.seats for availability.
    this.tables = [];                 // array<Table>
    this._tableById = new Map();      // tableId -> Table
    this._tableSeats = new Map();     // tableId -> [npcId|null, npcId|null]

    // npcId -> { kind:'INDOORS' } OR { kind:'TABLE', tableId, seatIdx }
    this._npcPlacement = new Map();

    // --- queue ---
    // Queue stores NPC refs so we can emit events directly later.
    this.queue = new Deque();         // npc refs
    this.queued = new Set();          // npcId membership (lazy deletion)
    this._autoMaxQueue = (maxQueue == null);
    this.maxQueue = maxQueue ?? 4;
    this._recomputeDefaultMaxQueue();
  }

  // ---------------- visuals/collision ----------------
  _frameClosed() {
    const row = this._typeCfg?.row ?? 0;
    return row * 2 + 0;
  }

  _frameOpen() {
    const row = this._typeCfg?.row ?? 0;
    return row * 2 + 1;
  }

  _stampCollisionOnce() {
    const fp = this._typeCfg?.footprint;
    if (!fp) return;
    if (typeof this.GRID.setBlocked !== 'function') return;

    for (let dy = 0; dy < fp.h; dy++) {
      for (let dx = 0; dx < fp.w; dx++) {
        const tx = this.X - dx;
        const ty = this.Y - dy;
        if (this.GRID.inBounds(tx, ty)) this.GRID.setBlocked(tx, ty, true, { mirrorToLayer: true });
      }
    }
  }

  openDoor() { this.sprite?.setFrame?.(this._frameOpen()); }
  closeDoor() { this.sprite?.setFrame?.(this._frameClosed()); }

  pulseDoor(ms = 120) {
    this.openDoor();

    if (this._doorTimer) {
      this._doorTimer.remove(false);
      this._doorTimer = null;
    }

    if (!this.scene?.time?.delayedCall) return;
    this._doorTimer = this.scene.time.delayedCall(ms, () => {
      this._doorTimer = null;
      this.closeDoor();
    });
  }

  destroy() {
    if (this._doorTimer) {
      this._doorTimer.remove(false);
      this._doorTimer = null;
    }

    if (this.sprite) {
      this.sprite.destroy();
      this.sprite = null;
    }

    this.queue.clear();
    this.queued.clear();

    this._npcPlacement.clear();
    this._tableSeats.clear();
    this._tableById.clear();
    this.tables.length = 0;
  }

  // ---------------- basic tiles ----------------
  get entryTile() {
    return { x: this.tileX, y: this.tileY };
  }

  get insideTile() {
    const off = this._typeCfg?.insideTileOffset ?? { x: 0, y: 0 };
    return { x: this.tileX + off.x, y: this.tileY + off.y };
  }

  // ---------------- capacity helpers ----------------
  getServiceCapacity() {
    return this.indoorsCapacity + this.tables.length * 2;
  }

  _recomputeDefaultMaxQueue() {
    if (!this._autoMaxQueue) return;
    const cap = this.getServiceCapacity();
    this.maxQueue = Math.max(4, Math.ceil(cap / 2));
  }

  // ---------------- tables ----------------
  addTable(table) {
    // Ensure stable id
    const tid = table.id ?? `table_${table.tileX}_${table.tileY}`;
    table.id = tid;

    this.tables.push(table);
    this._tableById.set(tid, table);

    // Store-owned seats: 2 per table
    if (!this._tableSeats.has(tid)) this._tableSeats.set(tid, [null, null]);

    this._recomputeDefaultMaxQueue();
  }

  // ---------------- queue management ----------------
  removeFromQueue(npc) {
    const npcId = npc?.id;
    if (npcId == null) return false;
    return this.queued.delete(npcId); // lazy deletion
  }

  // ---------------- main API ----------------
  requestEnter(npc) {
    const npcId = npc?.id;
    if (npcId == null) return { ok: false, status: 'BAD_NPC_ID' };

    // Idempotent: if already assigned, return same assignment.
    const existing = this._npcPlacement.get(npcId);
    if (existing) {
      return { ok: true, status: 'ALREADY_ASSIGNED', ...this._buildPayload(npcId, existing) };
    }

    // Already queued?
    if (this.queued.has(npcId)) {
      return { ok: false, status: 'ALREADY_QUEUED' };
    }

    // Try assign immediately
    const placement = this._assignNow(npcId);
    if (placement) {
      return { ok: true, status: 'ASSIGNED', ...this._buildPayload(npcId, placement) };
    }

    // No space -> queue (bounded)
    if (this.queued.size >= this.maxQueue) {
      return { ok: false, status: 'QUEUE_FULL' };
    }

    this.queued.add(npcId);
    this.queue.push(npc);

    return { ok: false, status: 'QUEUED' };
  }

  npcDoneEating(npcOrId) {
    const npcId = (typeof npcOrId === 'object') ? npcOrId?.id : npcOrId;
    if (npcId == null) return false;

    const placement = this._npcPlacement.get(npcId);
    if (!placement) return false;

    this._releasePlacement(npcId, placement);

    // now that space exists, call from queue immediately
    this._drainQueue();

    return true;
  }

  // ---------------- internal: assignment policy ----------------
  _assignNow(npcId) {
    // Rules:
    // - Random choose INDOORS vs TABLE
    // - If no indoors space => TABLE (if any)
    // - If no tables => INDOORS (if any)
    // - If neither => null

    const indoorAvailable = this._freeIndoor > 0;
    const tableSeat = this._pickRandomFreeTableSeat(); // { tableId, seatIdx } or null
    const tableAvailable = !!tableSeat;

    if (!indoorAvailable && !tableAvailable) return null;

    if (!indoorAvailable && tableAvailable) return this._takeTableSeat(npcId, tableSeat);
    if (indoorAvailable && !tableAvailable) return this._takeIndoors(npcId);

    // both available: random
    return (Math.random() < 0.5)
      ? this._takeIndoors(npcId)
      : this._takeTableSeat(npcId, tableSeat);
  }

  _takeIndoors(npcId) {
    this._freeIndoor -= 1;
    const placement = { kind: 'INDOORS' };
    this._npcPlacement.set(npcId, placement);
    return placement;
  }

  _takeTableSeat(npcId, { tableId, seatIdx }) {
    const seats = this._tableSeats.get(tableId);
    if (!seats) return null;

    // Must be free (it should be, because we picked from logs)
    if (seats[seatIdx] != null) return null;

    seats[seatIdx] = npcId;
    this._tableSeats.set(tableId, seats);

    const placement = { kind: 'TABLE', tableId, seatIdx };
    this._npcPlacement.set(npcId, placement);
    return placement;
  }

  _pickRandomFreeTableSeat() {
    if (!this.tables.length) return null;

    // Build candidates based ONLY on store logs
    const candidates = [];
    for (const t of this.tables) {
      const tid = t.id;
      const seats = this._tableSeats.get(tid) ?? [null, null];

      if (seats[0] == null) candidates.push({ tableId: tid, seatIdx: 0 });
      if (seats[1] == null) candidates.push({ tableId: tid, seatIdx: 1 });

      if (!this._tableSeats.has(tid)) this._tableSeats.set(tid, seats);
    }

    if (!candidates.length) return null;
    return candidates[(Math.random() * candidates.length) | 0];
  }

  _releasePlacement(npcId, placement) {
    this._npcPlacement.delete(npcId);

    if (placement.kind === 'INDOORS') {
      this._freeIndoor += 1;
      return;
    }

    if (placement.kind === 'TABLE') {
      const seats = this._tableSeats.get(placement.tableId);
      if (!seats) return;

      if (seats[placement.seatIdx] === npcId) seats[placement.seatIdx] = null;
      this._tableSeats.set(placement.tableId, seats);
    }
  }

  // ---------------- internal: queue -> called_to_enter ----------------
  _drainQueue() {
    // Keep assigning while we have space and queue has members.
    while (true) {
      // If nobody queued, stop.
      if (this.queued.size <= 0) return;

      // If no space, stop.
      const canAssign = this._canAssignAnything();
      if (!canAssign) return;

      const npc = this.queue.shift();
      if (!npc) return;

      const npcId = npc?.id;
      if (npcId == null) continue;

      // lazy deletion: controller removed them
      if (!this.queued.has(npcId)) continue;

      // If somehow already assigned, just unqueue them and continue.
      if (this._npcPlacement.has(npcId)) {
        this.queued.delete(npcId);
        continue;
      }

      const placement = this._assignNow(npcId);
      if (!placement) {
        // No space after all -> push back and stop.
        this.queue.push(npc);
        return;
      }

      this.queued.delete(npcId);

      // Emit: called_to_enter (your rule: no handshake)
      this._emitCalledToEnter(npc, placement);
    }
  }

  _canAssignAnything() {
    if (this._freeIndoor > 0) return true;
    for (const seats of this._tableSeats.values()) {
      if (seats[0] == null || seats[1] == null) return true;
    }
    return false;
  }

  _emitCalledToEnter(npc, placement) {
    const payload = this._buildPayload(npc?.id, placement);

    // Your NPC class uses npc.events.emit(...)
    if (npc?.events && typeof npc.events.emit === 'function') {
      npc.events.emit(NPC_EVENTS.CALLED_TO_ENTER, payload);
      return;
    }

    // If you ever add npc.emit sugar, this supports it too.
    if (typeof npc?.emit === 'function') {
      npc.emit(NPC_EVENTS.CALLED_TO_ENTER, payload);
      return;
    }

    console.warn('[Store] NPC has no emitter; cannot emit called_to_enter', npc, payload);
  }

  _buildPayload(npcId, placement) {
    if (placement.kind === 'INDOORS') {
      return {
        storeId: this.storeId,
        npcId,
        kind: 'INDOORS',
        targetTile: this.entryTile,    // controller moves here then putInside/openDoor
        insideTile: this.insideTile    // optional (if you want to use it)
      };
    }

    // TABLE
    const table = this._tableById.get(placement.tableId) ?? null;
    const targetTile = table ? { x: table.tileX, y: table.tileY } : this.entryTile;

    return {
      storeId: this.storeId,
      npcId,
      kind: 'TABLE',
      tableId: placement.tableId,
      seatIdx: placement.seatIdx,
      targetTile,
      table // controller uses this to call table.seatNpc on ARRIVED
    };
  }

  // optional debug
  debugSnapshot() {
    const tableOcc = {};
    for (const [tid, seats] of this._tableSeats.entries()) tableOcc[tid] = seats.slice();

    return {
      storeId: this.storeId,
      freeIndoor: this._freeIndoor,
      queued: this.queued.size,
      maxQueue: this.maxQueue,
      placements: this._npcPlacement.size,
      tableOcc
    };
  }
}