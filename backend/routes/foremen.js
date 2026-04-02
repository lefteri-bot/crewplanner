const express = require("express");
const crypto = require("crypto");
const { getDb } = require("../db");
const { nanoid, nowIso, requireAdmin } = require("../helpers");

const router = express.Router();

function hashCode(code){
  return crypto.createHash("sha256").update(String(code || "").trim()).digest("hex");
}

// Admin list
router.get("/", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, name, createdAt, createdBy, deletedAt, deletedBy
    FROM foremen
    ORDER BY deletedAt IS NOT NULL, name COLLATE NOCASE ASC
  `).all();
  res.json({ foremen: rows });
});

// Admin create
router.post("/", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const body = req.body || {};
  const name = (body.name || "").toString().trim();
  const code = (body.code || "").toString().trim();
  if (!name) return res.status(400).json({ error: "name_required" });
  if (!code) return res.status(400).json({ error: "code_required" });

  const id = nanoid();
  const now = nowIso();
  try{
    db.prepare(`
      INSERT INTO foremen (id, name, codeHash, createdAt, createdBy, deletedAt, deletedBy)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
    `).run(id, name, hashCode(code), now, req.user.id);
  }catch(e){
    return res.status(409).json({ error: "name_exists" });
  }
  res.json({ ok: true, foreman: { id, name, createdAt: now } });
});

// Admin delete (soft)
router.post("/:id/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const id = req.params.id;
  const now = nowIso();
  const r = db.prepare("SELECT id FROM foremen WHERE id = ? AND deletedAt IS NULL").get(id);
  if (!r) return res.status(404).json({ error: "not_found" });
  db.prepare("UPDATE foremen SET deletedAt=?, deletedBy=? WHERE id=?").run(now, req.user.id, id);
  res.json({ ok: true });
});

// Foreman whoami
router.get("/me", (req, res) => {
  if (req.user.role !== "foreman") return res.json({ role: req.user.role });
  res.json({ role: "foreman", id: req.user.id, name: req.user.name || null });
});

module.exports = router;
