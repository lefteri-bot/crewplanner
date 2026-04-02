const POOLS = ["GRND", "POLY", "WGNW", "TRNSPRT", "KRKHF"];
const DEFAULT_POOL = "GRND";

function normalizePool(value) {
  const v = (value || "").toString().trim().toUpperCase();
  return POOLS.includes(v) ? v : DEFAULT_POOL;
}

function sanitizePools(values) {
  const set = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const v = (value || "").toString().trim().toUpperCase();
    if (POOLS.includes(v)) set.add(v);
  }
  return Array.from(set);
}

function getPoolsForDevice(db, deviceId) {
  if (!deviceId) return [DEFAULT_POOL];
  try {
    const rows = db.prepare(
      "SELECT poolCode FROM device_pool_access WHERE deviceId = ? ORDER BY poolCode ASC"
    ).all(deviceId);
    const pools = sanitizePools(rows.map(r => r.poolCode));
    return pools.length ? pools : [DEFAULT_POOL];
  } catch {
    return [DEFAULT_POOL];
  }
}

function setPoolsForDevice(db, deviceId, pools) {
  const clean = sanitizePools(pools);
  const finalPools = clean.length ? clean : [DEFAULT_POOL];
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM device_pool_access WHERE deviceId = ?").run(deviceId);
    const ins = db.prepare("INSERT INTO device_pool_access (deviceId, poolCode) VALUES (?, ?)");
    for (const pool of finalPools) ins.run(deviceId, pool);
  });
  tx();
  return finalPools;
}

module.exports = { POOLS, DEFAULT_POOL, normalizePool, sanitizePools, getPoolsForDevice, setPoolsForDevice };
