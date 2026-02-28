// src/sim/world/Table.js
// Table owns seat assignment + seat transforms (position/depth offsets) for NPCs.
// Updated: adds seat reservation (claim/commit) so many NPCs don't pick the same seat and race-fail.

export class Table {
  constructor(scene, GRID, tileX, tileY, { belongsTo, frame = 0, blocks = true } = {}) {
    this.scene = scene;
    this.GRID = GRID;
    this.tileX = tileX;
    this.tileY = tileY;
    this.id = `table_${tileX}_${tileY}`;

    this.belongsTo = belongsTo;

    // Actual seated NPCs (committed occupancy)
    this.seats = [null, null];

    // Reservations to prevent races:
    // Map<npcId, { seatIdx:number, expiresAt:number }>
    this._claims = new Map();

    // Default claim TTL (ms): reservation expires if NPC never arrives/commits
    this._claimTtlMs = 12000;

    // Seat transforms relative to the table tile.
    this.seatTransforms = [
      { pos: { x: 0, y: 0 }, depth: -1, facing: 'right' },
      { pos: { x: 8, y: 3 }, depth: 0, facing: 'left' }
    ];

    // stamp collision
    this._blocks = blocks;
    if (blocks && typeof GRID.setBlocked === 'function') {
      GRID.setBlocked(tileX, tileY, true, { mirrorToLayer: true, weak: true });
    }

    const p = GRID.tileToWorld(tileX, tileY);
    this.sprite = scene.add.sprite(p.x, p.y, 'table', frame);
    this.sprite.setOrigin(0.5, 1);
    this.sprite.setDepth(this.sprite.y);
  }

  destroy() {
    // Un-seat any NPCs safely (restore their offsets)
    for (const npc of this.seats) {
      if (npc) this._clearSeatTransform(npc);
    }
    this.seats[0] = null;
    this.seats[1] = null;

    // clear reservations
    this._claims.clear();

    // un-stamp collision
    if (this._blocks && typeof this.GRID?.setBlocked === 'function') {
      this.GRID.setBlocked(this.tileX, this.tileY, false, { mirrorToLayer: true });
    }

    if (this.sprite) this.sprite.destroy();
    this.sprite = null;
  }

  // -------- internal: claims --------
  _now() {
    // Prefer scene time if available (stable in Phaser); fallback to Date.now
    return (this.scene?.time?.now != null) ? this.scene.time.now : Date.now();
  }

  _purgeExpiredClaims() {
    if (!this._claims.size) return;
    const now = this._now();
    for (const [npcId, c] of this._claims.entries()) {
      if (!c || c.expiresAt <= now) this._claims.delete(npcId);
    }
  }

  _isSeatClaimedByOther(seatIdx, npc) {
    if (seatIdx == null) return false;
    const npcId = npc?.id;
    for (const [id, c] of this._claims.entries()) {
      if (!c) continue;
      if (id === npcId) continue;
      if (c.seatIdx === seatIdx) return true;
    }
    return false;
  }

  // -------- stats --------
  get occupiedCount() {
    return (this.seats[0] ? 1 : 0) + (this.seats[1] ? 1 : 0);
  }

  get claimedCount() {
    this._purgeExpiredClaims();
    return this._claims.size;
  }

  /**
   * Returns true if there exists a seat that is:
   * - not occupied AND
   * - not reserved by someone else (unexpired claim)
   */
  hasClaimableSeat() {
    this._purgeExpiredClaims();
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i]) continue;
      if (this._isSeatClaimedByOther(i, null)) continue;
      // the helper above expects npc; using null means "any claim counts"
      // but we implemented _isSeatClaimedByOther to skip only matching npc.id,
      // so with npc=null it will treat all claims as "other" which is correct here.
      return true;
    }
    return false;
  }

  /**
   * Backwards-compatible: true if a seat is not occupied (ignores claims).
   * Prefer hasClaimableSeat() in new code.
   */
  hasFreeSeat() {
    return this.occupiedCount < 2;
  }

  seatIndexFor(npc) {
    return this.seats[0] === npc ? 0 : this.seats[1] === npc ? 1 : -1;
  }

  // -------- seat transforms --------
  getSeatTransform(seatIdx) {
    return this.seatTransforms[seatIdx] ?? { pos: { x: 0, y: 0 }, depth: 0 };
  }

  _applySeatTransform(npc, seatIdx) {
    const t = this.getSeatTransform(seatIdx);
    npc.setDepthOffset?.(t.depth ?? 0);
    npc.setPositionOffset?.(t.pos?.x ?? 0, t.pos?.y ?? 0);
    // Your NPC has setFacing(direction) in your earlier convo
    if (t.facing) npc.setFacing?.(t.facing);
  }

  _clearSeatTransform(npc) {
    npc.setDepthOffset?.(0);
    npc.setPositionOffset?.(0, 0);
  }

  // -------- reservation API (prevents races) --------
  /**
   * Claims (reserves) a seat for this npc WITHOUT applying seat transforms.
   * This prevents other NPCs from selecting the same seat while this npc walks over.
   *
   * Returns seatIdx (0/1) or -1 if no seat could be claimed.
   */
  claimSeat(npc, { ttlMs = this._claimTtlMs } = {}) {
    if (!npc) return -1;
    this._purgeExpiredClaims();

    const npcId = npc.id;
    if (npcId == null) return -1;

    // Already claimed? keep it and extend TTL.
    const existing = this._claims.get(npcId);
    if (existing && existing.seatIdx != null) {
      existing.expiresAt = this._now() + (ttlMs ?? this._claimTtlMs);
      this._claims.set(npcId, existing);
      return existing.seatIdx;
    }

    // Already seated? treat as success (seatIdx).
    const already = this.seatIndexFor(npc);
    if (already >= 0) return already;

    // Find a seat that's not occupied and not claimed by anyone else.
    for (let i = 0; i < this.seats.length; i++) {
      if (this.seats[i]) continue;

      // Is this seat claimed by someone else?
      let claimedByOther = false;
      for (const [otherId, c] of this._claims.entries()) {
        if (otherId === npcId) continue;
        if (c?.seatIdx === i) { claimedByOther = true; break; }
      }
      if (claimedByOther) continue;

      this._claims.set(npcId, { seatIdx: i, expiresAt: this._now() + (ttlMs ?? this._claimTtlMs) });
      return i;
    }

    return -1;
  }

  /**
   * Releases this npc's claim (if any). Safe to call multiple times.
   */
  releaseClaim(npc) {
    if (!npc) return false;
    const npcId = npc.id;
    if (npcId == null) return false;
    return this._claims.delete(npcId);
  }

  /**
   * Converts an existing claim into an actual seated assignment AND applies transforms.
   * If the claim is missing/expired or the seat got occupied, returns -1.
   */
  commitClaim(npc) {
    if (!npc) return -1;
    this._purgeExpiredClaims();

    // Already seated here -> keep seat
    const already = this.seatIndexFor(npc);
    if (already >= 0) return already;

    const npcId = npc.id;
    const claim = (npcId != null) ? this._claims.get(npcId) : null;
    if (!claim) return -1;

    const seatIdx = claim.seatIdx;
    if (seatIdx == null) return -1;

    // Seat must still be free.
    if (this.seats[seatIdx]) return -1;

    // Commit occupancy
    this._claims.delete(npcId);
    this.seats[seatIdx] = npc;
    this._applySeatTransform(npc, seatIdx);
    return seatIdx;
  }

  // -------- seating API (kept for compatibility) --------
  /**
   * Immediate seat assignment (no reservation) + applies transform.
   * This can race if multiple NPCs approach the same table.
   * Prefer claimSeat() + commitClaim() flow in Store.
   */
  seatNpc(npc) {
    if (!npc) return -1;

    // Already seated here -> keep seat
    const already = this.seatIndexFor(npc);
    if (already >= 0) return already;

    if (!this.seats[0]) {
      this.seats[0] = npc;
      this._applySeatTransform(npc, 0);
      return 0;
    }

    if (!this.seats[1]) {
      this.seats[1] = npc;
      this._applySeatTransform(npc, 1);
      return 1;
    }

    return -1;
  }

  /**
   * Unseats npc AND clears its seat transform.
   * Returns previous seat index or -1 if npc wasn't seated here.
   */
  unseatNpc(npc) {
    const idx = this.seatIndexFor(npc);
    if (idx < 0) {
      // Safety: ensure we don't keep a stale claim either
      this.releaseClaim(npc);
      return -1;
    }

    this._clearSeatTransform(npc);
    this.seats[idx] = null;

    // Safety: clear claim if any
    this.releaseClaim(npc);
    return idx;
  }
}