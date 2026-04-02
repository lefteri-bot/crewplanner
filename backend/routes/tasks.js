const fs = require("fs");
const path = require("path");
const express = require("express");
const { getDb } = require("../db");
const { nanoid, nowIso, todayDate, requireAdmin, requireAdminOrForeman, pick } = require("../helpers");
const { appendEvent } = require("../logger");
const { isValidTeam } = require("../teams");
const { normalizePool, getPoolsForDevice } = require("../pools");
const { recordUndoAction } = require("../undo");

const router = express.Router();

const VALID_PRIORITY = new Set(["GREEN", "YELLOW", "RED"]);
const VALID_STATUS = new Set(["FREE", "CLAIMED", "IMPOSED", "DONE", "DELETED"]);

function norm(s){ return (s || "").toString().trim(); }
function mkLibKey(street, description){ return `${norm(street).toLowerCase()}|${norm(description).toLowerCase()}`; }

// Photo uploads
const uploadDir = path.join(__dirname, "..", "data", "uploads");
try { if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true }); } catch {}

function parseImageDataUrl(dataUrl){
  const s = (dataUrl || "").toString();
  const m = /^data:(image\/(jpeg|jpg|png|webp));base64,(.+)$/i.exec(s);
  if (!m) return null;
  const kind = (m[2] || "jpeg").toLowerCase();
  const ext = (kind === "jpeg" || kind === "jpg") ? "jpg" : kind;
  try {
    const buf = Buffer.from(m[3], "base64");
    if (!buf || !buf.length) return null;
    return { ext, buf };
  } catch {
    return null;
  }
}

function prevDate(yyyyMmDd){
  const s = (yyyyMmDd || "").toString();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const dt = new Date(y, mo - 1, d);
  if (isNaN(dt.getTime())) return null;
  dt.setDate(dt.getDate() - 1);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function carryOverOpenTasksToToday(db, date){
  // Catch-up rollover: move ALL unfinished tasks from past dates into today (keep team assignment).
  // Only do this when requesting TODAY, so historical views don't mutate data.
  const target = (date || todayDate()).toString();
  if (target !== todayDate()) return;

  const rows = db.prepare(`
    SELECT id
    FROM tasks
    WHERE dueDate < ?
      AND deletedAt IS NULL
      AND status IN ('FREE','CLAIMED','IMPOSED')
  `).all(target);
  if (!rows || !rows.length) return;

  const now = nowIso();
  const upd = db.prepare(`UPDATE tasks SET dueDate = ?, updatedAt = ?, updatedBy = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    for (const r of rows) upd.run(target, now, "system_rollover_catchup", r.id);
  });
  tx();
}


function activeTaskForTeam(team, dueDate) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM tasks
    WHERE team = ?
      AND dueDate = ?
      AND deletedAt IS NULL
      AND status IN ('CLAIMED','IMPOSED')
    ORDER BY updatedAt DESC
    LIMIT 1
  `).get(team, dueDate);
}

function addEvent(taskId, by, type, fromObj, toObj, note) {
  const db = getDb();
  db.prepare(`
    INSERT INTO task_events (id, taskId, at, by, type, fromJson, toJson, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nanoid(), taskId, nowIso(), by, type,
        fromObj ? JSON.stringify(fromObj) : null,
        toObj ? JSON.stringify(toObj) : null,
        note || null);
  try{
    appendEvent({ date: (toObj && toObj.dueDate) || (fromObj && fromObj.dueDate) || todayDate(), type, by, taskId, from: fromObj || null, to: toObj || null, note: note || null });
  }catch{}
}

function canUserWriteNote(db, reqUser, task) {
  // Admin can always write.
  if (reqUser && reqUser.role === "admin") return true;

  // Crew must be paired and must belong to the assigned team for this task/date.
  const name = (reqUser && reqUser.id) ? reqUser.id.toString().trim() : "";
  if (!name || name === "anon") return false;
  if (!task || !task.team) return false;
  if (!(task.status === "CLAIMED" || task.status === "IMPOSED")) return false;

  const emp = db.prepare("SELECT id FROM employees WHERE (id = ? OR name = ?) AND deletedAt IS NULL").get(name, name);
  if (!emp) return false;

  const ok = db.prepare(
    "SELECT 1 AS ok FROM team_members WHERE date = ? AND team = ? AND employeeId = ?"
  ).get(task.dueDate, task.team, emp.id);
  return !!ok;
}

function crewEmployee(db, reqUser) {
  if (!reqUser || reqUser.role !== "crew") return null;
  const name = (reqUser.id || "").toString().trim();
  if (!name || name === "anon") return null;
  const emp = db.prepare("SELECT id, name FROM employees WHERE (id = ? OR name = ?) AND deletedAt IS NULL").get(name, name);
  return emp || null;
}

function crewInTeam(db, reqUser, date, team) {
  const emp = crewEmployee(db, reqUser);
  if (!emp) return { ok: false, error: "not_paired" };
  const row = db.prepare("SELECT 1 AS ok FROM team_members WHERE date = ? AND team = ? AND employeeId = ?")
    .get(date, team, emp.id);
  if (!row) return { ok: false, error: "not_in_team", employee: emp.name };
  return { ok: true, employee: emp };
}

function greenPassAvailable(db, date, team){
  if (!team) return false;
  const row = db.prepare("SELECT greenPassAvailable FROM team_bonus WHERE date=? AND team=?").get(date, team);
  return !!(row && row.greenPassAvailable);
}
function consumeGreenPass(db, date, team){
  db.prepare("UPDATE team_bonus SET greenPassAvailable=0, usedAt=? WHERE date=? AND team=?").run(nowIso(), date, team);
}
function grantGreenPass(db, date, team, taskId){
  const now = nowIso();
  db.prepare(`
    INSERT INTO team_bonus (date, team, greenPassAvailable, grantedAt, grantedTaskId)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(date, team) DO UPDATE SET
      greenPassAvailable=1,
      grantedAt=excluded.grantedAt,
      grantedTaskId=excluded.grantedTaskId,
      usedAt=NULL
  `).run(date, team, now, taskId);
}


function highestFreePriorityInPools(db, dueDate, pools) {
  const clean = Array.isArray(pools) ? pools.filter(Boolean) : [];
  if (!clean.length) return null;
  const placeholders = clean.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT priority
    FROM tasks
    WHERE dueDate = ?
      AND status = 'FREE'
      AND deletedAt IS NULL
      AND pool IN (${placeholders})
    ORDER BY CASE priority WHEN 'RED' THEN 1 WHEN 'YELLOW' THEN 2 ELSE 3 END
    LIMIT 1
  `).get(dueDate, ...clean);
  return row ? row.priority : null;
}

function highestFreePriority(db, dueDate) {
  const row = db.prepare(`
    SELECT priority
    FROM tasks
    WHERE dueDate = ?
      AND status = 'FREE'
      AND deletedAt IS NULL
    ORDER BY CASE priority WHEN 'RED' THEN 1 WHEN 'YELLOW' THEN 2 ELSE 3 END
    LIMIT 1
  `).get(dueDate);
  return row ? row.priority : null;
}

function teamSnapshot(db, date, team){
  const members = db.prepare(`
    SELECT e.id, e.name
    FROM team_members tm
    JOIN employees e ON e.id = tm.employeeId
    WHERE tm.date = ? AND tm.team = ? AND e.deletedAt IS NULL
    ORDER BY e.name COLLATE NOCASE ASC
  `).all(date, team);
  const vehicles = db.prepare(`
    SELECT v.id, v.name
    FROM team_vehicles tv
    JOIN vehicles v ON v.id = tv.vehicleId
    WHERE tv.date = ? AND tv.team = ? AND v.deletedAt IS NULL
    ORDER BY v.name COLLATE NOCASE ASC
  `).all(date, team);
  return {
    memberIds: members.map(x=>x.id),
    memberNames: members.map(x=>x.name),
    vehicleIds: vehicles.map(x=>x.id),
    vehicleNames: vehicles.map(x=>x.name),
  };
}

function rosterHashOf(snapshot){
  try{
    const s = JSON.stringify({
      m: (snapshot.memberIds||[]).slice().sort(),
      v: (snapshot.vehicleIds||[]).slice().sort()
    });
    // fast stable hash
    let h = 0; for (let i=0;i<s.length;i++){ h = ((h<<5)-h) + s.charCodeAt(i); h |= 0; }
    return String(h);
  }catch{
    return "";
  }
}

function canUseGreenPass(db, date, team, currentHash){
  const row = db.prepare("SELECT * FROM team_bonus WHERE date = ? AND team = ?").get(date, team);
  if (!row) return false;
  if (!row.greenPassAvailable) return false;
  if (row.rosterHash && String(row.rosterHash) !== String(currentHash)) return false;
  return true;
}

function consumeGreenPass(db, date, team){
  db.prepare("UPDATE team_bonus SET greenPassAvailable=0, usedAt=? WHERE date=? AND team=?").run(nowIso(), date, team);
}

function grantGreenPass(db, date, team, taskId, rosterHash){
  const now = nowIso();
  db.prepare(`
    INSERT INTO team_bonus (date, team, greenPassAvailable, grantedAt, grantedTaskId, rosterHash)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(date, team) DO UPDATE SET
      greenPassAvailable=1,
      grantedAt=excluded.grantedAt,
      grantedTaskId=excluded.grantedTaskId,
      rosterHash=excluded.rosterHash,
      usedAt=NULL
  `).run(date, team, now, taskId, rosterHash);

  try{
    // Simple file log (for analyses)
    appendEvent({ date: (toObj && toObj.dueDate) || (fromObj && fromObj.dueDate) || todayDate(), type, by, taskId, from: fromObj || null, to: toObj || null, note: note || null });
  }catch{}
}



// List tasks
router.get("/", (req, res) => {
  const db = getDb();
  const dueDate = (req.query.date || todayDate()).toString();
  // Ensure unfinished tasks from yesterday show up today (including assigned team tasks)
  carryOverOpenTasksToToday(db, dueDate);
  const status = (req.query.status || "open").toString(); // open|done|all
  const filterTeam = req.query.team ? req.query.team.toString().toUpperCase() : null;
  const metaTeam = req.query.metaTeam ? req.query.metaTeam.toString().toUpperCase() : filterTeam;
  const priority = req.query.priority ? req.query.priority.toString().toUpperCase() : null;

  const where = ["dueDate = ?", "deletedAt IS NULL"];
  const params = [dueDate];

  if (filterTeam) {
    where.push("team = ?");
    params.push(filterTeam);
  }
  if (priority && VALID_PRIORITY.has(priority)) {
    where.push("priority = ?");
    params.push(priority);
  }

  if (status === "open") where.push("status IN ('FREE','CLAIMED','IMPOSED')");
  else if (status === "done") where.push("status = 'DONE'");
  else if (status === "all") where.push("status IN ('FREE','CLAIMED','IMPOSED','DONE')");

  let allowedPools = null;
  if (req.user.role === "crew") {
    const deviceId = (req.header("x-device-id") || req.query.deviceId || "").toString().trim();
    allowedPools = getPoolsForDevice(db, deviceId);
  }

  const rows = db.prepare(`
    SELECT * FROM tasks
    WHERE ${where.join(" AND ")}
    ORDER BY
      CASE priority WHEN 'RED' THEN 1 WHEN 'YELLOW' THEN 2 ELSE 3 END,
      CASE status WHEN 'IMPOSED' THEN 1 WHEN 'CLAIMED' THEN 2 WHEN 'FREE' THEN 3 ELSE 4 END,
      street COLLATE NOCASE ASC
  `).all(...params);

  let outRows = rows;
  if (req.user.role === "crew" && allowedPools && allowedPools.length && (status === "open" || status === "all")) {
    outRows = rows.filter(t => t.status !== "FREE" || allowedPools.includes(normalizePool(t.pool)));
  }

  const requiredPriority = (req.user.role === "crew" && allowedPools && allowedPools.length)
    ? highestFreePriorityInPools(db, dueDate, allowedPools)
    : highestFreePriority(db, dueDate);
  const greenPass = metaTeam ? greenPassAvailable(db, dueDate, metaTeam) : false;
  res.json({ dueDate, rows: outRows, requiredPriority, greenPass, allowedPools: allowedPools || undefined });
});

// Create task
router.post("/", (req, res) => {
  if (!requireAdminOrForeman(req, res)) return;
  const db = getDb();
  const body = req.body || {};
  const street = (body.street || "").toString().trim();
  if (!street) return res.status(400).json({ error: "street_required" });

  const dueDate = (body.dueDate || todayDate()).toString();
  const priority = (body.priority || "GREEN").toString().toUpperCase();
  const zone = body.zone ? body.zone.toString() : null;
  const description = body.description ? body.description.toString() : null;
  const pool = normalizePool(body.pool);
  const imposeTeam = body.imposeTeam ? body.imposeTeam.toString().toUpperCase().trim() : null;
  if (imposeTeam && !isValidTeam(db, imposeTeam)) return res.status(400).json({ error: "invalid_team" });


  const id = nanoid();
  const now = nowIso();

  const row = {
    id,
    street,
    zone,
    description,
    priority: VALID_PRIORITY.has(priority) ? priority : "GREEN",
    status: (imposeTeam ? "IMPOSED" : "FREE"),
    team: (imposeTeam ? imposeTeam : null),
    dueDate,
    createdAt: now,
    createdBy: req.user.id,
    updatedAt: now,
    updatedBy: req.user.id,
    lat: null,
    lng: null,
    pool
  };

  db.prepare(`
    INSERT INTO tasks (id, street, zone, description, priority, status, team, dueDate,
      createdAt, createdBy, updatedAt, updatedBy, lat, lng, pool)
    VALUES (@id, @street, @zone, @description, @priority, @status, @team, @dueDate,
      @createdAt, @createdBy, @updatedAt, @updatedBy, @lat, @lng, @pool)
  `).run(row);

  addEvent(id, req.user.id, "CREATE", null, pick(row, ["status","team","priority","dueDate"]), null);
  if (row.status === "IMPOSED") {
    addEvent(id, req.user.id, "IMPOSE", null, pick(row, ["status","team","priority","dueDate"]), "opgelegd bij creatie");
  }


  // Also store in library (so you can "vrijgeven" later)
  try {
    const key = mkLibKey(row.street, row.description || "");
    const existing = db.prepare("SELECT id, deletedAt FROM task_library WHERE key = ?").get(key);
    if (existing) {
      if (existing.deletedAt) {
        db.prepare("UPDATE task_library SET deletedAt=NULL, deletedBy=NULL, active=1, pool=? WHERE id=?").run(row.pool, existing.id);
      } else {
        db.prepare("UPDATE task_library SET active=1, pool=? WHERE id=?").run(row.pool, existing.id);
      }
    } else {
      db.prepare(`
        INSERT INTO task_library (id, key, street, description, pool, active, createdAt, createdBy)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(nanoid(), key, row.street, row.description || "", row.pool, now, req.user.id);
    }
  } catch (e) {
    // ignore library errors for MVP
  }

  res.status(201).json(row);
});

// Claim task (crew)
router.post("/:id/claim", (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const body = req.body || {};
  const team = (body.team || "").toString().toUpperCase();
  const dueDate = (body.dueDate || req.query.date || todayDate()).toString();

  if (!isValidTeam(db, team)) return res.status(400).json({ error: "invalid_team" });

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });
  if (task.status === "DONE") return res.status(409).json({ error: "already_done" });
  if (task.status === "DELETED") return res.status(409).json({ error: "deleted" });
  if (task.status !== "FREE") return res.status(409).json({ error: "not_free", status: task.status });

  // Crew: only act for your own team (paired + joined)
  if (req.user.role !== "admin") {
    const chk = crewInTeam(db, req.user, task.dueDate, team);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
  }

  let allowedPools = null;
  if (req.user.role !== "admin") {
    const deviceId = (req.header("x-device-id") || body.deviceId || "").toString().trim();
    allowedPools = getPoolsForDevice(db, deviceId);
    if (!allowedPools.includes(normalizePool(task.pool))) {
      return res.status(403).json({ error: "pool_forbidden" });
    }
  }

  // Priority rule: normally take tasks in order (RED → YELLOW → GREEN)
const requiredPriority = (req.user.role !== "admin" && allowedPools && allowedPools.length)
  ? highestFreePriorityInPools(db, task.dueDate, allowedPools)
  : highestFreePriority(db, task.dueDate);

// Exception ("groene pas"): if this team stayed unchanged and finished a self-chosen RED/YELLOW,
// they may pick ONE GREEN next, even if there are still RED/YELLOW free tasks.
const snapNow = teamSnapshot(db, task.dueDate, team);
const hashNow = rosterHashOf(snapNow);

const allowPriorityPass = (
  requiredPriority &&
  requiredPriority !== task.priority &&
  canUseGreenPass(db, task.dueDate, team, hashNow)
);

if (requiredPriority && requiredPriority !== task.priority && !allowPriorityPass) {
  return res.status(409).json({ error: "priority_blocked", requiredPriority });
}

  // Anti-chaos: only 1 active task per team per date
  const active = activeTaskForTeam(team, task.dueDate);
  if (active) {
    return res.status(409).json({
      error: "team_already_has_active_task",
      activeTask: { id: active.id, street: active.street, status: active.status }
    });
  }

  const now = nowIso();
  const fromObj = pick(task, ["status","team","priority","dueDate"]);
  db.prepare(`
    UPDATE tasks
    SET status = 'CLAIMED', team = ?,
        startedAt = COALESCE(startedAt, ?), startedBy = ?, startedMode = 'CLAIM', startRosterHash = ?,
        updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(team, now, req.user.id, hashNow, now, req.user.id, id);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  addEvent(id, req.user.id, "CLAIM", fromObj, pick(updated, ["status","team","priority","dueDate"]), null);

  if (allowPriorityPass) {
    try { consumeGreenPass(db, task.dueDate, team); } catch {}
    addEvent(id, req.user.id, "GREEN_PASS_USED", null, { dueDate: task.dueDate, team, priority: task.priority }, "vrijkaart gebruikt");
  }
  res.json(updated);
});

// Impose task (admin)
router.post("/:id/impose", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const db = getDb();
  const id = req.params.id;
  const body = req.body || {};
  const team = (body.team || "").toString().toUpperCase();
  const reason = body.reason ? body.reason.toString() : null;
  const override = !!body.override;
  const dueDate = (body.dueDate || req.query.date || todayDate()).toString();

  if (!isValidTeam(db, team)) return res.status(400).json({ error: "invalid_team" });

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });
  if (task.status === "DONE") return res.status(409).json({ error: "already_done" });
  if (task.status === "DELETED") return res.status(409).json({ error: "deleted" });

  const active = activeTaskForTeam(team, task.dueDate);
  if (active && active.id !== id) {
    if (!override) {
      return res.status(409).json({
        error: "team_already_has_active_task",
        activeTask: { id: active.id, street: active.street, status: active.status },
        hint: "set override=true to replace active task"
      });
    }

    // Override: free the active task first (unless it's the same)
    const now = nowIso();
    const fromActive = pick(active, ["status","team","priority","dueDate"]);
    db.prepare(`
      UPDATE tasks
      SET status = 'FREE', team = NULL,
          startedAt = NULL, startedBy = NULL, startedMode = NULL, startRosterHash = NULL, durationSec = NULL,
          updatedAt = ?, updatedBy = ?, lockReason = NULL
      WHERE id = ?
    `).run(now, req.user.id, active.id);
    const freed = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(active.id);
    addEvent(active.id, req.user.id, "UNASSIGN", fromActive, pick(freed, ["status","team","priority","dueDate"]), "admin override");
  }

  const now = nowIso();
  const fromObj = pick(task, ["status","team","priority","dueDate"]);
  db.prepare(`
    UPDATE tasks
    SET status = 'IMPOSED', team = ?, lockReason = ?,
        startedAt = ?, startedBy = ?, startedMode = 'IMPOSE', startRosterHash = ?,
        updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(team, reason, now, req.user.id, rosterHashOf(teamSnapshot(db, task.dueDate, team)), now, req.user.id, id);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  addEvent(id, req.user.id, "IMPOSE", fromObj, pick(updated, ["status","team","priority","dueDate"]), reason || null);

  res.json(updated);
});

// Unassign (free) task (crew or admin)
router.post("/:id/unassign", (req, res) => {
  const db = getDb();
  const id = req.params.id;

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });

  if (task.status === "IMPOSED" && req.user.role !== "admin") {
    return res.status(403).json({ error: "imposed_task_admin_only" });
  }
  if (task.status === "DONE") return res.status(409).json({ error: "already_done" });
  if (task.status === "FREE") return res.status(409).json({ error: "already_free" });

  // Crew: only unassign tasks of your own team
  if (req.user.role !== "admin") {
    const chk = crewInTeam(db, req.user, task.dueDate, task.team);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
  }

  const now = nowIso();
  const fromObj = pick(task, ["status","team","priority","dueDate"]);
  db.prepare(`
    UPDATE tasks
    SET status = 'FREE', team = NULL, lockReason = NULL,
        startedAt = NULL, startedBy = NULL, startedMode = NULL, startRosterHash = NULL, durationSec = NULL,
        updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(now, req.user.id, id);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  addEvent(id, req.user.id, "UNASSIGN", fromObj, pick(updated, ["status","team","priority","dueDate"]), null);

  res.json(updated);
});

// Set priority
router.post("/:id/priority", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const id = req.params.id;
  const body = req.body || {};
  const priority = (body.priority || "").toString().toUpperCase();

  if (!VALID_PRIORITY.has(priority)) return res.status(400).json({ error: "invalid_priority" });

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });

  const now = nowIso();
  const fromObj = pick(task, ["status","team","priority","dueDate"]);
  db.prepare(`
    UPDATE tasks
    SET priority = ?, updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(priority, now, req.user.id, id);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  addEvent(id, req.user.id, "SET_PRIORITY", fromObj, pick(updated, ["status","team","priority","dueDate"]), null);

  res.json(updated);
});

// Set pool
router.post("/:id/pool", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const id = req.params.id;
  const pool = normalizePool((req.body || {}).pool);

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });

  const now = nowIso();
  db.prepare(`
    UPDATE tasks
    SET pool = ?, updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(pool, now, req.user.id, id);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  addEvent(id, req.user.id, "SET_POOL", { pool: task.pool, dueDate: task.dueDate }, { pool: updated.pool, dueDate: updated.dueDate }, null);
  res.json(updated);
});

// Done
router.post("/:id/done", (req, res) => {
  const db = getDb();
  const id = req.params.id;

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });
  if (task.status === "DONE") return res.status(409).json({ error: "already_done" });

  // Only admin or the assigned team can mark done
  if (!task.team && req.user.role !== "admin") {
    return res.status(403).json({ error: "admin_only" });
  }
  if (req.user.role !== "admin") {
    const chk = crewInTeam(db, req.user, task.dueDate, task.team);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
  }

  const now = nowIso();
  const fromObj = pick(task, ["status","team","priority","dueDate"]);
  db.prepare(`
    UPDATE tasks
    SET status = 'DONE', doneAt = ?, doneBy = ?, durationSec = CASE WHEN startedAt IS NOT NULL THEN CAST((julianday(?) - julianday(startedAt)) * 86400 AS INTEGER) ELSE NULL END,
        updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(now, req.user.id, now, now, req.user.id, id);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  addEvent(id, req.user.id, "DONE", fromObj, pick(updated, ["status","team","priority","dueDate"]), null);
try{
  const snap = task.team ? teamSnapshot(db, task.dueDate, task.team) : null;
  appendEvent({
    date: task.dueDate,
    type: "TASK_DONE_SUMMARY",
    by: req.user.id,
    taskId: task.id,
    street: task.street,
    priority: task.priority,
    pool: task.pool,
    team: task.team,
    startedAt: updated.startedAt || null,
    doneAt: updated.doneAt || null,
    durationSec: updated.durationSec || null,
    memberNames: snap ? snap.memberNames : [],
    vehicleNames: snap ? snap.vehicleNames : []
  });
}catch{}

  
// If this was a self-chosen RED/YELLOW task, grant ONE vrijkaart for the same roster.
try {
  const wasSelf = (task.startedMode === "CLAIM" || task.status === "CLAIMED");
  const high = (task.priority === "RED" || task.priority === "YELLOW");
  if (wasSelf && high && task.team) {
    grantGreenPass(db, task.dueDate, task.team, task.id, task.startRosterHash || null);
    addEvent(id, req.user.id, "GREEN_PASS_GRANTED", null, { dueDate: task.dueDate, team: task.team, priority: "ANY" }, "vrijkaart gekregen");
  }
} catch {}

  res.json(updated);
});

// Reopen
router.post("/:id/reopen", (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const body = req.body || {};
  const priority = body.priority ? body.priority.toString().toUpperCase() : null;

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });
  if (task.status !== "DONE") return res.status(409).json({ error: "not_done" });

  const newPriority = (priority && VALID_PRIORITY.has(priority)) ? priority : task.priority;

  const now = nowIso();
  const fromObj = pick(task, ["status","team","priority","dueDate"]);
  db.prepare(`
    UPDATE tasks
    SET status = 'FREE', team = NULL, lockReason = NULL,
        doneAt = NULL, doneBy = NULL, startedAt = NULL, startedBy = NULL, durationSec = NULL,
        startedAt = NULL, startedBy = NULL, startedMode = NULL, startRosterHash = NULL, durationSec = NULL,
        priority = ?, updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(newPriority, now, req.user.id, id);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  addEvent(id, req.user.id, "REOPEN", fromObj, pick(updated, ["status","team","priority","dueDate"]), null);

  res.json(updated);
});

// Delete (soft)
router.post("/:id/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const id = req.params.id;

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });

  const now = nowIso();
  const fromObj = pick(task, ["status","team","priority","dueDate"]);
  try { recordUndoAction(db, "TASK_DELETE", "task", id, task, req.user.id); } catch {}
  db.prepare(`
    UPDATE tasks
    SET status = 'DELETED', deletedAt = ?, deletedBy = ?, updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(now, req.user.id, now, req.user.id, id);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  addEvent(id, req.user.id, "DELETE", fromObj, pick(updated, ["status","team","priority","dueDate"]), null);

  res.json({ ok: true });
});

// Restore
router.post("/:id/restore", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const id = req.params.id;

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });
  if (task.status !== "DELETED") return res.status(409).json({ error: "not_deleted" });

  const now = nowIso();
  const fromObj = pick(task, ["status","team","priority","dueDate"]);
  db.prepare(`
    UPDATE tasks
    SET status = 'FREE', team = NULL, lockReason = NULL,
        deletedAt = NULL, deletedBy = NULL,
        updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(now, req.user.id, id);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  addEvent(id, req.user.id, "RESTORE", fromObj, pick(updated, ["status","team","priority","dueDate"]), null);

  res.json(updated);
});


// Set / persist location (lat/lng) for a task (crew or admin; MVP)
router.post("/:id/location", (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const body = req.body || {};
  const lat = typeof body.lat === "number" ? body.lat : parseFloat(body.lat);
  const lng = typeof body.lng === "number" ? body.lng : parseFloat(body.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "invalid_location" });
  }

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });

  const now = nowIso();
  const fromObj = pick(task, ["status","team","priority","dueDate"]);
  db.prepare(`
    UPDATE tasks
    SET lat = ?, lng = ?, updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(lat, lng, now, req.user.id, id);

  const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  addEvent(id, req.user.id, "SET_LOCATION", fromObj, pick(updated, ["status","team","priority","dueDate"]), `lat=${lat},lng=${lng}`);

  res.json({ ok: true, lat, lng });
});

// Events for task
router.get("/:id/events", (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const rows = db.prepare(`
    SELECT * FROM task_events WHERE taskId = ? ORDER BY at DESC
  `).all(id);
  res.json({ rows });
});

// Notes for task (briefing / opmerkingen)
router.get("/:id/notes", (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit || "30", 10) || 30));

  const rows = db.prepare(`
    SELECT at, by, note
    FROM task_events
    WHERE taskId = ? AND type = 'NOTE' AND note IS NOT NULL
    ORDER BY at DESC
    LIMIT ?
  `).all(id, limit);

  res.json({ rows });
});

router.post("/:id/notes", (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const body = req.body || {};
  const note = (body.note || "").toString().trim();

  if (!note) return res.status(400).json({ error: "note_required" });
  if (note.length > 800) return res.status(409).json({ error: "note_too_long", hint: "max 800 tekens" });

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });

  if (!canUserWriteNote(db, req.user, task)) {
    return res.status(403).json({ error: "not_allowed" });
  }

  const now = nowIso();
  // Update task quick-access note
  db.prepare(`
    UPDATE tasks
    SET lastNote = ?, updatedAt = ?, updatedBy = ?
    WHERE id = ?
  `).run(note, now, req.user.id, id);

  addEvent(id, req.user.id, "NOTE", null, null, note);
  res.json({ ok: true });
});

// Photo for task (admin or assigned crew)
router.post("/:id/photo", (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const body = req.body || {};
  const dataUrl = (body.dataUrl || "").toString();

  if (!dataUrl) return res.status(400).json({ error: "dataUrl_required" });
  // Keep within JSON body limit + reasonable storage
  if (dataUrl.length > 2800000) return res.status(413).json({ error: "photo_too_large" });

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ? AND deletedAt IS NULL`).get(id);
  if (!task) return res.status(404).json({ error: "not_found" });

  // Permissions: admin always; crew only for own team task on that date
  if (req.user.role !== "admin") {
    if (!task.team) return res.status(403).json({ error: "not_allowed" });
    const chk = crewInTeam(db, req.user, task.dueDate, task.team);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
  }

  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) return res.status(400).json({ error: "invalid_image" });

  // Remove old photo file (best-effort)
  try {
    if (task.photoPath && task.photoPath.startsWith("/uploads/")) {
      const oldName = task.photoPath.replace("/uploads/", "");
      const oldAbs = path.join(uploadDir, oldName);
      if (fs.existsSync(oldAbs)) fs.unlinkSync(oldAbs);
    }
  } catch {}

  const fileName = `${id}-${Date.now()}.${parsed.ext}`;
  const abs = path.join(uploadDir, fileName);
  try {
    fs.writeFileSync(abs, parsed.buf);
  } catch {
    return res.status(500).json({ error: "save_failed" });
  }

  const photoPath = `/uploads/${fileName}`;
  const now = nowIso();
  db.prepare(`UPDATE tasks SET photoPath = ?, updatedAt = ?, updatedBy = ? WHERE id = ?`)
    .run(photoPath, now, req.user.id, id);

  addEvent(id, req.user.id, "PHOTO", null, null, photoPath);
  res.json({ ok: true, photoPath });
});

module.exports = router;
