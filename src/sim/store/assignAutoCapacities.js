export function assignAutoIndoorsCapacities(storesById, totalNPCs, opts = {}) {
  const {
    storeTypes = ['left_restaurant', 'right_restaurant'],
    seatsPerTable = 2,

    // Total "service capacity" target per store (indoors + outside tables)
    targetTotalPerStore = null, // default = ceil(totalNPCs / #stores)

    // Cap indoors so it never gets silly
    maxIndoorsAbs = 50,     // hard cap indoors
    maxIndoorsMult = 2.0,   // indoors <= outdoorSeats * mult (helps table-heavy stores)

    // Minimum indoors you still want even if many tables
    minIndoors = 0
  } = opts;

  const types = new Set(storeTypes);
  const stores = Object.values(storesById || {}).filter(s => s && types.has(s.storeType));
  if (!stores.length) return;

  const target = targetTotalPerStore ?? Math.ceil(totalNPCs / stores.length);

  for (const s of stores) {
    // If indoorsCapacity is explicitly set (>0), keep it
    if (Number.isFinite(s.indoorsCapacity) && s.indoorsCapacity > 0) continue;

    const tableCount = (s.tables?.length ?? 0) | 0;
    const outdoorSeats = tableCount * seatsPerTable;

    // base: meet target total by filling indoors after outdoor is counted
    let indoors = target - outdoorSeats;

    // clamp to at least minIndoors
    if (indoors < minIndoors) indoors = minIndoors;

    // cap indoors based on outdoorSeats and absolute cap
    const capByOutdoor = Math.ceil(outdoorSeats * maxIndoorsMult);
    const cap = Math.min(maxIndoorsAbs, capByOutdoor || maxIndoorsAbs);

    if (indoors > cap) indoors = cap;

    s.setIndoorsCapacity(indoors, { resetFree: true });
  }
}