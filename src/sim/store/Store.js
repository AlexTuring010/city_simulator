import { findClosestFreeTile } from '../../pathfinding/findPath.js';
import { NPC_EVENTS } from '../../sim/npc/NPCEvents.js';

export const STORE_EVENTS = {
  READY: 'READY',                 // invited to enter (includes inviteId)
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  INVITE_ACCEPTED: 'INVITE_ACCEPTED',
  INVITE_REJECTED: 'INVITE_REJECTED',

  QUEUED: 'QUEUED',
  DEQUEUED: 'DEQUEUED',
  ENTERED: 'ENTERED',
  LEFT: 'LEFT',
  TABLE_SEATED: 'TABLE_SEATED',
  TABLE_LEFT: 'TABLE_LEFT',
  FULL: 'FULL'
};

// --- You must define how store_type maps to sprite rows + collision footprint.
// Assumption: stores_160x138.png has 2 columns per type: [doorClosed, doorOpen]
// Row i => frames: i*2 (closed), i*2+1 (open)
const STORE_TYPE_CONFIG = {
  left_restaurant: {
    row: 0,
    footprint: { w: 4, h: 4, ox: 1, oy: 0 },
    insideTileOffset: { x: 1, y: 1 },
    DepthOffset: 18
  },
  right_restaurant: {
    row: 1,
    footprint: { w: 4, h: 4, ox: 0, oy: 1 },
    entryOffset: { x: 2, y: 2 },
    insideTileOffset: { x: 2, y: 1 },
    DepthOffset: 18
  }
};

export class Store {
  constructor(scene, GRID, tileX, tileY, { storeId, indoorsCapacity = 0, storeType }) {
    this.scene = scene;
    this.GRID = GRID;

    this.storeId = storeId;

    // IMPORTANT:
    // indoorsCapacity only caps NPCs that occupy "indoors spots".
    // Store queue / invites are STORE-WIDE: tables + indoors.
    this.indoorsCapacity = indoorsCapacity;

    this.storeType = storeType;

    this.tileX = tileX;
    this.tileY = tileY;

    this.events = new Phaser.Events.EventEmitter();

    this.tables = [];

    // --- occupancy / queue state ---
    this.indoors = new Set();   // NPCs currently inside (after putInside)
    this.queue = [];            // FIFO waiting to be invited into ANY available spot

    // --- Option B: multiple outstanding invites + reservation ---
    // activeInvites: npc -> { inviteId, timer, reservation }
    this.activeInvites = new Map();

    // reserved: npc -> reservation
    // reservation = { kind: 'TABLE', table, claimIdx } OR { kind: 'INDOORS' }
    this.reserved = new Map();

    this._inviteSeq = 0;

    this._typeCfg = STORE_TYPE_CONFIG[storeType] ?? null;

    // Sprite (store building)
    this.X = tileX + this._typeCfg.footprint.ox
    this.Y = tileY + this._typeCfg.footprint.oy;
    const p = GRID.tileToWorld(this.X, this.Y);
    const frame = this._frameClosed();

    this.sprite = scene.add.sprite(p.x, p.y, 'stores', frame);
    this.sprite.setOrigin(0.5, 1);
    this.sprite.setDepth(p.y - this._typeCfg.DepthOffset);

    // stamp collisions once
    this._stampCollisionOnce();
  }

  destroy() {
    this._clearAllInvites();
    this.events.removeAllListeners();
    if (this.sprite) this.sprite.destroy();
    this.sprite = null;
    for (const t of this.tables) t.destroy?.();
    this.tables.length = 0;
  }

  on(event, fn, ctx) { this.events.on(event, fn, ctx); return this; }
  off(event, fn, ctx) { this.events.off(event, fn, ctx); return this; }

  // ---------- config helpers ----------
  _frameClosed() {
    const row = this._typeCfg?.row ?? 0;
    return row * 2 + 0;
  }
  _frameOpen() {
    const row = this._typeCfg?.row ?? 0;
    return row * 2 + 1;
  }

  get entryTile() {
    return { x: this.tileX, y: this.tileY };
  }

  // ---------- stats ----------
  get indoorsCount() { return this.indoors.size; }
  get queueCount() { return this.queue.length; }
  get tablesCount() { return this.tables.length; }
  get tablesPeopleCount() {
    let n = 0;
    for (const t of this.tables) n += (t.occupiedCount ?? 0);
    return n;
  }

  // ---------- collisions ----------
  _stampCollisionOnce() {
    const fp = this._typeCfg?.footprint;
    if (!fp) return;
    if (typeof this.GRID.setBlocked !== 'function') return; // fail-safe

    for (let dy = 0; dy < fp.h; dy++) {
      for (let dx = 0; dx < fp.w; dx++) {
        const tx = this.X - dx;
        const ty = this.Y - dy;
        if (this.GRID.inBounds(tx, ty)) this.GRID.setBlocked(tx, ty, true, { mirrorToLayer: true });
      }
    }
  }

  // ---------- door ----------
  openDoor() { this.sprite?.setFrame?.(this._frameOpen()); }
  closeDoor() { this.sprite?.setFrame?.(this._frameClosed()); }

  // ---------- tables ----------
  addTable(table) { this.tables.push(table); }
  findAvailableTable() { return this.tables.find(t => t.hasFreeSeat?.()) ?? null; }

  // ---------- spot accounting (STORE-WIDE capacity) ----------
  _countReserved(kind) {
    let n = 0;
    for (const r of this.reserved.values()) if (r?.kind === kind) n++;
    return n;
  }

  _countInvited(kind) {
    let n = 0;
    for (const e of this.activeInvites.values()) if (e?.reservation?.kind === kind) n++;
    return n;
  }

  _getFreeTableSeatCount() {
    // Try exact per-seat counts if the Table exposes them
    let total = 0;

    for (const t of this.tables) {
      if (!t) continue;

      // Best: table.getFreeSeatCount()
      if (typeof t.getFreeSeatCount === 'function') {
        total += Math.max(0, t.getFreeSeatCount());
        continue;
      }

      // Next best: seatCount - occupiedCount - claimedCount
      const seatCount = t.seatCount ?? t.capacity ?? null;
      const occupied = t.occupiedCount ?? 0;
      const claimed = t.claimedCount ?? 0;

      if (typeof seatCount === 'number') {
        total += Math.max(0, seatCount - occupied - claimed);
        continue;
      }

      // Fallback: boolean hasFreeSeat() => count as 1 "spot" per table
      if (typeof t.hasFreeSeat === 'function') {
        total += t.hasFreeSeat() ? 1 : 0;
      }
    }

    return total;
  }

  // Indoor spots available for NEW invites AFTER accounting for indoors + reserved + active invites
  get freeIndoorSpots() {
    const used = this.indoors.size + this._countReserved('INDOORS') + this._countInvited('INDOORS');
    return Math.max(0, this.indoorsCapacity - used);
  }

  // Table spots available for NEW invites AFTER accounting for reserved + active invites
  get freeTableSpots() {
    const freeSeats = this._getFreeTableSeatCount();
    const held = this._countReserved('TABLE') + this._countInvited('TABLE');
    return Math.max(0, freeSeats - held);
  }

  // STORE-WIDE spots: if either tables OR indoors has room, we can invite from the store queue
  get freeStoreSpots() {
    return this.freeTableSpots + this.freeIndoorSpots;
  }

  // ---------- reservations ----------
  _tryReserveSpotForNpc(npc) {
    // Prefer TABLE first (outdoor/any table counts as store capacity)
    for (const t of this.tables) {
      const idx = t?.claimSeat?.(npc);
      if (idx >= 0) {
        return { kind: 'TABLE', table: t, claimIdx: idx };
      }
    }

    // Otherwise reserve INDOORS if available
    if (this.freeIndoorSpots > 0) return { kind: 'INDOORS' };

    return null;
  }

  _releaseReservation(npc, reservation) {
    if (!reservation) return;
    if (reservation.kind === 'TABLE') {
      reservation.table?.releaseClaim?.(npc);
    }
  }

  // ---------- NEW: nearest-free-tile helper ----------
  _goToNearestFreeTile(npc, nearX, nearY, {
    // These keys are passed through; adjust to your findClosestFreeTile signature
    findOpts = { maxRadius: 8 },
    pathOpts = {}
  } = {}) {
    const t = findClosestFreeTile(this.GRID, nearX, nearY, { ...findOpts });
    const target = t ?? this.entryTile;

    npc.goToTile(target.x, target.y, {
      allowWeakCollision: true,
      showIndicator: false,
      ...pathOpts
    });

    return target;
  }

  // ---------- Option B: invite filling logic (STORE-WIDE) ----------
  _fillInvites({ graceMs = 1500 } = {}) {
    // Invite up to current freeStoreSpots (multiple at once)
    while (this.freeStoreSpots > 0) {
      const next = this.queue.shift();
      if (!next) break;

      // If they somehow got reserved/indoors/invited already, skip
      if (this.indoors.has(next) || this.reserved.has(next) || this.activeInvites.has(next)) continue;

      const reservation = this._tryReserveSpotForNpc(next);
      if (!reservation) break;

      this._inviteNpc(next, reservation, graceMs);
    }
  }

  _inviteNpc(npc, reservation, graceMs) {
    const inviteId = (++this._inviteSeq) | 0;

    const timer = this.scene.time.delayedCall(graceMs, () => {
      const cur = this.activeInvites.get(npc);
      if (!cur || cur.inviteId !== inviteId) return;

      this.activeInvites.delete(npc);

      // Release held spot if invite expires
      this._releaseReservation(npc, cur.reservation);

      this.events.emit(STORE_EVENTS.INVITE_EXPIRED, { store: this, npc, inviteId });
      this._fillInvites({ graceMs });
    });

    this.activeInvites.set(npc, { inviteId, timer, reservation });

    // READY still emitted (good for other listeners / UI)
    this.events.emit(STORE_EVENTS.READY, { store: this, npc, inviteId });

    return inviteId;
  }

  _clearInviteForNpc(npc) {
    const entry = this.activeInvites.get(npc);
    if (!entry) return;

    entry?.timer?.remove?.(false);

    // Release held spot (table claim) if canceling invite
    this._releaseReservation(npc, entry.reservation);

    this.activeInvites.delete(npc);
  }

  _clearAllInvites() {
    for (const [, entry] of this.activeInvites.entries()) {
      entry?.timer?.remove?.(false);
      this._releaseReservation(null, entry?.reservation);
    }
    this.activeInvites.clear();

    // Release any reservations (especially table claims)
    for (const [npc, r] of this.reserved.entries()) {
      this._releaseReservation(npc, r);
    }
    this.reserved.clear();
  }

  // ---------- queue handshake ----------
  requestEnter(npc, { graceMs = 1500 } = {}) {
    if (this.indoors.has(npc)) return { ok: true, status: 'ALREADY_INSIDE' };
    if (this.reserved.has(npc)) return { ok: true, status: 'ALREADY_RESERVED' };
    if (this.activeInvites.has(npc)) return { ok: true, status: 'ALREADY_INVITED' };

    // STORE-WIDE: if ANY spot available (table or indoors), invite now
    if (this.freeStoreSpots > 0) {
      const reservation = this._tryReserveSpotForNpc(npc);
      if (reservation) {
        const inviteId = this._inviteNpc(npc, reservation, graceMs);
        return { ok: true, status: 'INVITED', inviteId };
      }
    }

    if (this.queue.includes(npc)) return { ok: true, status: 'ALREADY_QUEUED' };
    this.queue.push(npc);

    this.events.emit(STORE_EVENTS.QUEUED, { store: this, npc });
    this.events.emit(STORE_EVENTS.FULL, { store: this, npc });

    return { ok: false, status: 'QUEUED' };
  }

  leaveQueue(npc) {
    let changed = false;

    const idx = this.queue.indexOf(npc);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.events.emit(STORE_EVENTS.DEQUEUED, { store: this, npc });
      changed = true;
    }

    if (this.activeInvites.has(npc)) {
      this._clearInviteForNpc(npc);
      changed = true;
    }

    if (this.reserved.has(npc)) {
      const r = this.reserved.get(npc);
      this.reserved.delete(npc);
      this._releaseReservation(npc, r);
      changed = true;
    }

    if (changed) this._fillInvites();
    return changed;
  }

  /**
   * Must echo inviteId from READY to be accepted.
   * Late responses are ignored safely (token mismatch).
   */
  acceptInvite(npc, inviteId) {
    const entry = this.activeInvites.get(npc);
    if (!entry) {
      this.events.emit(STORE_EVENTS.INVITE_REJECTED, { store: this, npc, inviteId, reason: 'NO_ACTIVE_INVITE' });
      return false;
    }
    if (entry.inviteId !== inviteId) {
      this.events.emit(STORE_EVENTS.INVITE_REJECTED, { store: this, npc, inviteId, reason: 'INVITE_ID_MISMATCH' });
      return false;
    }

    // Cancel invite timer and reserve the held spot
    entry?.timer?.remove?.(false);
    this.activeInvites.delete(npc);

    this.reserved.set(npc, entry.reservation);

    this.events.emit(STORE_EVENTS.INVITE_ACCEPTED, { store: this, npc, inviteId });

    // Accepting changes counts; we may still have other free slots to invite more
    this._fillInvites();

    return true;
  }

  _onSpotFreed() {
    this._fillInvites();
  }

  // ---------- flows ----------
  /**
   * Requires reservation (INDOORS) to prevent overbooking.
   * Promise resolves when putInside is done, rejects if not reserved or stuck.
   */
  moveNpcIndoors(npc) {
    const entry = this.entryTile;

    const r = this.reserved.get(npc);
    const isReservedIndoors = r?.kind === 'INDOORS';

    if (!isReservedIndoors && !this.indoors.has(npc)) {
      return Promise.reject({ reason: 'NOT_RESERVED_INDOORS' });
    }

    return new Promise((resolve, reject) => {
      const DOOR_OPEN_MS = 150;   // tweak
      const DOOR_CLOSE_MS = 150;

      const onArrived = () => {
        cleanup();

        this.openDoor();

        this.scene.time.delayedCall(DOOR_OPEN_MS, () => {
          npc.putInside?.({ containerId: `store:${this.storeId}`, reason: 'ENTER_STORE' });

          // consume reservation -> indoors
          this.reserved.delete(npc);
          this.indoors.add(npc);

          this.events.emit(STORE_EVENTS.ENTERED, { store: this, npc });

          this.scene.time.delayedCall(DOOR_CLOSE_MS, () => {
            this.closeDoor();
            this._fillInvites();
            resolve(true);
          });
        });
      };

      const onStuck = (data) => {
        cleanup();

        // release reservation so others can be invited
        const r2 = this.reserved.get(npc);
        if (r2) {
          this.reserved.delete(npc);
          this._releaseReservation(npc, r2);
          this._fillInvites();
        }

        reject(data);
      };

      const cleanup = () => {
        npc.off?.(NPC_EVENTS.ARRIVED, onArrived);
        npc.off?.(NPC_EVENTS.STUCK, onStuck);
      };

      npc.on?.(NPC_EVENTS.ARRIVED, onArrived);
      npc.on?.(NPC_EVENTS.STUCK, onStuck);

      npc.goToTile(entry.x, entry.y, {
        allowBlockedGoal: true,
      });
    });
  }

  /**
   * STORE-WIDE: move NPC to whatever spot they reserved (TABLE or INDOORS).
   * If TABLE: go to the table, commit the claim, optionally "sit" duration, then unseat.
   * If INDOORS: uses moveNpcIndoors().
   */
  async moveNpcToReservedSpot(npc, { tableDurationMs = 2000 } = {}) {
    const reservation = this.reserved.get(npc);
    if (!reservation) throw { reason: 'NOT_RESERVED' };

    if (reservation.kind === 'INDOORS') {
      await this.moveNpcIndoors(npc);
      return { ok: true, kind: 'INDOORS' };
    }

    // TABLE reservation
    const table = reservation.table;
    if (!table) {
      this.reserved.delete(npc);
      throw { reason: 'BAD_RESERVATION_TABLE' };
    }

    try {
      await this._goOnce(npc, table.tileX, table.tileY, {
        allowWeakCollision: true,
      });

      const seatIdx = table.commitClaim?.(npc) ?? table.commitSeat?.(npc);
      if (seatIdx < 0) {
        // claim got lost; release and fail
        throw { reason: 'CLAIM_LOST' };
      }

      // consume reservation now that we committed
      this.reserved.delete(npc);

      this.events.emit(STORE_EVENTS.TABLE_SEATED, { store: this, npc, table, seatIdx });

      // Optional "dine"
      if (tableDurationMs > 0) {
        await this._delay(tableDurationMs);

        table.unseatNpc?.(npc);
        this.events.emit(STORE_EVENTS.TABLE_LEFT, { store: this, npc, table });

        // NEW: walk away from table to nearest free tile
        this._goToNearestFreeTile(npc, table.tileX, table.tileY, {
          findOpts: { maxRadius: 8 },
          pathOpts: { allowWeakCollision: true, allowBlockedStart:true }
        });
      }

      // freeing a table seat can invite more
      this._onSpotFreed();

      return { ok: true, kind: 'TABLE', table, seatIdx };
    } catch (err) {
      // release reservation + claim on failure
      const r2 = this.reserved.get(npc);
      if (r2) {
        this.reserved.delete(npc);
        this._releaseReservation(npc, r2);
      } else {
        // If we already consumed reservation but failed later, still ensure claim released
        table.releaseClaim?.(npc);
      }

      this._fillInvites();
      throw err;
    }
  }

  releaseNpcFromIndoors(npc, { doorMs = 150 } = {}) {
    if (!this.indoors.has(npc)) return false;

    // Remove first so capacity frees immediately
    this.indoors.delete(npc);

    const entry = this.entryTile;

    // Visually open the door long enough to be rendered
    this.openDoor();

    // Give the renderer a moment before popping them out
    this.scene.time.delayedCall(doorMs, () => {
      // Pop out of container to the door tile
      npc.takeOutToTile?.(entry.x, entry.y, { containerId: `store:${this.storeId}` });

      // Walk away so they don't stack on the entry
      this._goToNearestFreeTile(npc, entry.x, entry.y, {
        findOpts: { maxRadius: 8 },
        pathOpts: { allowWeakCollision: true, allowBlockedStart: true }
      });

      this.events.emit(STORE_EVENTS.LEFT, { store: this, npc });

      // Close door after a short moment so the open frame is visible
      this.scene.time.delayedCall(doorMs, () => {
        this.closeDoor();

        // Leaving may allow more invites
        this._onSpotFreed();
      });
    });

    return true;
  }

  // ---------- internal helpers ----------
  _delay(ms) {
    return new Promise(res => this.scene.time.delayedCall(ms, res));
  }

  _goOnce(npc, x, y, goOpts) {
    return new Promise((resolve, reject) => {
      const onArrived = () => { cleanup(); resolve(true); };
      const onStuck = (data) => { cleanup(); reject(data); };

      const cleanup = () => {
        npc.off?.(NPC_EVENTS.ARRIVED, onArrived);
        npc.off?.(NPC_EVENTS.STUCK, onStuck);
      };

      npc.on?.(NPC_EVENTS.ARRIVED, onArrived);
      npc.on?.(NPC_EVENTS.STUCK, onStuck);

      npc.goToTile(x, y, goOpts);
    });
  }
}