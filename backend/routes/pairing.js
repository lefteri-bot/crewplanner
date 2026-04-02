const express = require("express");
const { getDb } = require("../db");
const { nowIso, requireAdmin } = require("../helpers");
const { POOLS, getPoolsForDevice, setPoolsForDevice } = require("../pools");

const router = express.Router();

function norm(s){ return (s || "").toString().trim(); }

function randomCode6(){
  const n = Math.floor(Math.random() * 1000000);
  return String(n).padStart(6, "0");
}

function addMinutesIso(minutes){
  const d = new Date();
  d.setMinutes(d.getMinutes() + minutes);
  return d.toISOString();
}

function cleanupExpired(db){
  db.prepare("DELETE FROM pairing_codes WHERE expiresAt <= ?").run(nowIso());
}

router.post("/code", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  cleanupExpired(db);

  const body = req.body || {};
  const employeeId = norm(body.employeeId);
  const name = norm(body.name);

  let emp = null;
  if (employeeId) emp = db.prepare("SELECT id, name FROM employees WHERE id = ? AND deletedAt IS NULL").get(employeeId);
  else if (name) emp = db.prepare("SELECT id, name FROM employees WHERE name = ? AND deletedAt IS NULL").get(name);
  if (!emp) return res.status(404).json({ error: "unknown_employee" });

  let code = null;
  for (let i = 0; i < 10; i++) {
    const c = randomCode6();
    const exists = db.prepare("SELECT code FROM pairing_codes WHERE code = ?").get(c);
    if (!exists) { code = c; break; }
  }
  if (!code) return res.status(500).json({ error: "code_generation_failed" });

  const createdAt = nowIso();
  const expiresAt = addMinutesIso(10);
  db.prepare(
    "INSERT INTO pairing_codes (code, employeeId, expiresAt, createdAt, createdBy) VALUES (?, ?, ?, ?, ?)"
  ).run(code, emp.id, expiresAt, createdAt, req.user.id);

  res.json({ ok: true, code, expiresAt, employee: { id: emp.id, name: emp.name } });
});

router.post("/link", (req, res) => {
  const db = getDb();
  cleanupExpired(db);

  const body = req.body || {};
  const code = norm(body.code);
  const deviceId = norm(body.deviceId);
  const userAgent = norm(req.header("user-agent"));

  if (!code) return res.status(400).json({ error: "code_required" });
  if (!deviceId) return res.status(400).json({ error: "deviceId_required" });

  const row = db.prepare(
    `SELECT pc.code, pc.employeeId, pc.expiresAt, e.name
     FROM pairing_codes pc
     JOIN employees e ON e.id = pc.employeeId
     WHERE pc.code = ? AND e.deletedAt IS NULL`
  ).get(code);
  if (!row) return res.status(404).json({ error: "invalid_or_expired_code" });

  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM pairing_codes WHERE code = ?").run(code);
    db.prepare(
      `INSERT INTO device_links (deviceId, employeeId, linkedAt, linkedBy, lastSeenAt, userAgent)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(deviceId) DO UPDATE SET
         employeeId = excluded.employeeId,
         lastSeenAt = excluded.lastSeenAt,
         userAgent = excluded.userAgent`
    ).run(deviceId, row.employeeId, now, row.employeeId, now, userAgent || null);

    const existing = db.prepare("SELECT COUNT(*) AS c FROM device_pool_access WHERE deviceId = ?").get(deviceId);
    if (!existing || !existing.c) setPoolsForDevice(db, deviceId, ["GRND"]);
  });
  tx();

  res.json({ ok: true, employee: { id: row.employeeId, name: row.name }, pools: getPoolsForDevice(db, deviceId) });
});

router.get("/me", (req, res) => {
  const db = getDb();
  const deviceId = norm(req.query.deviceId);
  if (!deviceId) return res.status(400).json({ error: "deviceId_required" });

  const row = db.prepare(
    `SELECT dl.deviceId, dl.employeeId, e.name
     FROM device_links dl
     JOIN employees e ON e.id = dl.employeeId
     WHERE dl.deviceId = ? AND e.deletedAt IS NULL`
  ).get(deviceId);

  if (!row) return res.json({ linked: false, pools: [] });
  db.prepare("UPDATE device_links SET lastSeenAt = ? WHERE deviceId = ?").run(nowIso(), deviceId);
  res.json({ linked: true, employee: { id: row.employeeId, name: row.name }, pools: getPoolsForDevice(db, deviceId), availablePools: POOLS });
});

router.get("/links", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const rows = db.prepare(
    `SELECT dl.deviceId,
            dl.employeeId AS employeeId,
            e.name AS employeeName,
            dl.linkedAt,
            dl.lastSeenAt,
            dl.userAgent
     FROM device_links dl
     JOIN employees e ON e.id = dl.employeeId
     WHERE e.deletedAt IS NULL
     ORDER BY e.name COLLATE NOCASE ASC`
  ).all().map(row => ({ ...row, pools: getPoolsForDevice(db, row.deviceId) }));
  res.json({ rows, availablePools: POOLS });
});

router.post("/device-pools", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const body = req.body || {};
  const deviceId = norm(body.deviceId);
  const pools = Array.isArray(body.pools) ? body.pools : [];
  if (!deviceId) return res.status(400).json({ error: "deviceId_required" });
  const link = db.prepare("SELECT deviceId FROM device_links WHERE deviceId = ?").get(deviceId);
  if (!link) return res.status(404).json({ error: "unknown_device" });
  const saved = setPoolsForDevice(db, deviceId, pools);
  res.json({ ok: true, deviceId, pools: saved });
});

router.post("/unlink", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const body = req.body || {};
  const deviceId = norm(body.deviceId);
  if (!deviceId) return res.status(400).json({ error: "deviceId_required" });
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM device_pool_access WHERE deviceId = ?").run(deviceId);
    db.prepare("DELETE FROM device_links WHERE deviceId = ?").run(deviceId);
  });
  tx();
  res.json({ ok: true });
});

module.exports = router;
