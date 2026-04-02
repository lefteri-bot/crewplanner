const express = require("express");
const { getDb } = require("../db");
const { nanoid, nowIso, todayDate, requireAdmin } = require("../helpers");
const { normalizePool } = require("../pools");
const { recordUndoAction } = require("../undo");

const router = express.Router();

function norm(s){ return (s || "").toString().trim(); }
function mkKey(street, description){
  return `${norm(street).toLowerCase()}|${norm(description).toLowerCase()}`;
}

router.get("/", (req, res) => {
  const db = getDb();
  const includeInactive = (req.query.includeInactive || "").toString() === "1";
  const rows = db.prepare(`
    SELECT id, street, description, pool, active, deletedAt
    FROM task_library
    ${includeInactive ? "" : "WHERE deletedAt IS NULL AND active = 1"}
    ORDER BY street COLLATE NOCASE ASC, description COLLATE NOCASE ASC
  `).all();
  res.json({ items: rows });
});

router.post("/", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const body = req.body || {};
  const street = norm(body.street);
  const description = norm(body.description || "");
  const pool = normalizePool(body.pool);
  if (!street) return res.status(400).json({ error: "street_required" });

  const key = mkKey(street, description);
  const now = nowIso();
  const existing = db.prepare("SELECT id, deletedAt FROM task_library WHERE key = ?").get(key);
  if (existing) {
    if (existing.deletedAt) {
      db.prepare("UPDATE task_library SET deletedAt=NULL, deletedBy=NULL, active=1, pool=? WHERE id=?").run(pool, existing.id);
      return res.json({ ok: true, id: existing.id, reactivated: true });
    }
    db.prepare("UPDATE task_library SET active=1, pool=? WHERE id=?").run(pool, existing.id);
    return res.status(409).json({ error: "exists" });
  }

  const id = nanoid();
  db.prepare(`
    INSERT INTO task_library (id, key, street, description, pool, active, createdAt, createdBy)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, key, street, description, pool, now, req.user.id);
  res.status(201).json({ id, street, description, pool });
});

router.post("/:id/release", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const id = (req.params.id || "").toString();
  const body = req.body || {};
  const date = (body.date || todayDate()).toString();

  const item = db.prepare(`
    SELECT id, street, description, pool
    FROM task_library
    WHERE id = ? AND deletedAt IS NULL AND active = 1
  `).get(id);
  if (!item) return res.status(404).json({ error: "not_found" });

  const taskId = nanoid();
  const now = nowIso();
  db.prepare(`
    INSERT INTO tasks (id, street, zone, description, priority, status, team, dueDate,
      createdAt, createdBy, updatedAt, updatedBy, lat, lng, pool)
    VALUES (?, ?, NULL, ?, 'GREEN', 'FREE', NULL, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `).run(taskId, item.street, item.description || "", date, now, req.user.id, now, req.user.id, normalizePool(item.pool));

  res.status(201).json({ ok: true, taskId });
});

router.post("/:id/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const id = (req.params.id || "").toString();
  const now = nowIso();
  const item = db.prepare(`
    SELECT id, key, street, description, pool, active, createdAt, createdBy
    FROM task_library
    WHERE id = ? AND deletedAt IS NULL
  `).get(id);
  if (!item) return res.status(404).json({ error: "not_found" });
  try { recordUndoAction(db, "LIBRARY_DELETE", "library", id, item, req.user.id); } catch {}
  db.prepare("UPDATE task_library SET deletedAt=?, deletedBy=?, active=0 WHERE id=?").run(now, req.user.id, id);
  res.json({ ok: true });
});

module.exports = router;
