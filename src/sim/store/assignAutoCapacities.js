export function assignAutoIndoorsCapacities(storesById, totalNPCs, opts = {}) {
  const {
    storeTypes = ['left_restaurant', 'right_restaurant'],
    seatsPerTable = 2,

    // Total "service capacity" target per store (indoors + outside tables)
    targetTotalPerStore = null, // default = ceil(totalNPCs / #stores)

    // New: pressure factor
    // 1.0 = current behavior
    // 0.7 = tighter capacities
    // 0.5 = aggressive crowding
    targetLoadFactor = 0.6,

    // Cap indoors so it never gets silly
    maxIndoorsAbs = 30,
    maxIndoorsMult = 1.0,

    // Minimum indoors you still want even if many tables
    minIndoors = 0
  } = opts;

  const types = new Set(storeTypes);
  const stores = Object.values(storesById || {}).filter(s => s && types.has(s.storeType));
  if (!stores.length) return;

  const baseTarget = targetTotalPerStore ?? Math.ceil(totalNPCs / stores.length);
  const target = Math.max(0, Math.ceil(baseTarget * targetLoadFactor));

  for (const s of stores) {
    // If indoorsCapacity is explicitly set (>0), keep it
    if (Number.isFinite(s.indoorsCapacity) && s.indoorsCapacity > 0) continue;

    const tableCount = (s.tables?.length ?? 0) | 0;
    const outdoorSeats = tableCount * seatsPerTable;

    // Meet reduced target after accounting for outdoor seats
    let indoors = target - outdoorSeats;

    if (indoors < minIndoors) indoors = minIndoors;

    const capByOutdoor = Math.ceil(outdoorSeats * maxIndoorsMult);
    const cap = Math.min(maxIndoorsAbs, capByOutdoor || maxIndoorsAbs);

    if (indoors > cap) indoors = cap;

    s.setIndoorsCapacity(indoors, { resetFree: true });
  }
}