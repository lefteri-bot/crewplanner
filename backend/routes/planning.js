const express = require("express");
const { getDb } = require("../db");
const { nanoid, nowIso, todayDate, requireAdmin } = require("../helpers");
const { listTeams, teamCodes, isValidTeam, addTeam, undeleteTeam, deleteTeam } = require("../teams");
const { recordUndoAction, getLatestUndoAction, markUndoActionDone } = require("../undo");
const { appendEvent } = require("../logger");

const router = express.Router();

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

function recordTeamAction(db, action, team, by){
  try {
    db.prepare(`
      INSERT INTO team_action_history (id, action, teamCode, teamLabel, sortOrder, createdAt, createdBy, undoneAt, undoneBy)
      SELECT ?, ?, code, label, sortOrder, ?, ?, NULL, NULL
      FROM teams
      WHERE code = ?
    `).run(nanoid(), action, nowIso(), by || "system", team);
  } catch {}
}


function carryOverOpenTasksToToday(db, date){
  // Same behaviour as in /api/tasks: catch-up rollover for weekends/holidays.
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


function ensureDefaultAttendance(db, date, userId) {
  // Ensure every ACTIVE employee has an attendance row for this date.
  const now = nowIso();
  const upsert = db.prepare(`
    INSERT INTO day_attendance (date, employeeId, present, updatedAt, updatedBy)
    SELECT ?, e.id, 1, ?, ?
    FROM employees e
    WHERE e.deletedAt IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM day_attendance a
        WHERE a.date = ? AND a.employeeId = e.id
      )
  `);
  upsert.run(date, now, userId || "system", date);
}


function normTeam(team) {
  return (team || "").toString().toUpperCase();
}
function normName(name) {
  return (name || "").toString().trim();
}


function resolveActorLabel(db, user) {
  const rawId = ((user && user.id) || '').toString().trim();
  const rawName = ((user && user.name) || '').toString().trim();
  if (rawName) return rawName;
  if (!rawId) return 'onbekend';
  if (rawId === 'admin') return 'admin';
  if (rawId.startsWith('foreman:')) {
    try {
      const foremanId = rawId.split(':')[1] || '';
      const row = db.prepare('SELECT name FROM foremen WHERE id = ? AND deletedAt IS NULL').get(foremanId);
      if (row && row.name) return row.name;
    } catch {}
    return rawId;
  }
  try {
    const byDevice = db.prepare(`
      SELECT e.name
      FROM device_links dl
      JOIN employees e ON e.id = dl.employeeId
      WHERE dl.deviceId = ? AND e.deletedAt IS NULL
      LIMIT 1
    `).get(rawId);
    if (byDevice && byDevice.name) return byDevice.name;
  } catch {}
  try {
    const byEmployeeId = db.prepare(`
      SELECT name FROM employees
      WHERE id = ? AND deletedAt IS NULL
      LIMIT 1
    `).get(rawId);
    if (byEmployeeId && byEmployeeId.name) return byEmployeeId.name;
  } catch {}
  return rawId;
}

function getEmployees(db) {
  return db.prepare("SELECT id, name FROM employees WHERE deletedAt IS NULL ORDER BY name COLLATE NOCASE ASC").all();
}

function getVehicles(db) {
  return db.prepare("SELECT id, name FROM vehicles WHERE deletedAt IS NULL ORDER BY name COLLATE NOCASE ASC").all();
}

function getTeamMemberNames(db, date, team) {
  return db.prepare(`
    SELECT e.name
    FROM team_members tm
    JOIN employees e ON e.id = tm.employeeId
    WHERE tm.date = ? AND tm.team = ? AND e.deletedAt IS NULL
    ORDER BY e.name COLLATE NOCASE ASC
  `).all(date, team).map(r => r.name);
}

function getAttendance(db, date) {
  const rows = db.prepare(`
    SELECT e.name, COALESCE(a.present, 0) AS present
    FROM employees e
    LEFT JOIN day_attendance a
      ON a.employeeId = e.id AND a.date = ?
    ORDER BY e.name COLLATE NOCASE ASC
  `).all(date);
  const map = {};
  for (const r of rows) map[r.name] = !!r.present;
  return map;
}

function initTeamMap(codes){
  const out = {};
  for (const c of (codes || [])) out[c] = [];
  return out;
}

function getTeamMembers(db, date, codes) {
  const rows = db.prepare(`
    SELECT tm.team, e.name
    FROM team_members tm
    JOIN employees e ON e.id = tm.employeeId
    WHERE tm.date = ?
    ORDER BY tm.team ASC, e.name COLLATE NOCASE ASC
  `).all(date);

  const out = initTeamMap(codes);
  for (const r of rows) {
    if (!out[r.team]) out[r.team] = [];
    out[r.team].push(r.name);
  }
  return out;
}

function getTeamVehicles(db, date, codes) {
  const rows = db.prepare(`
    SELECT tv.team, v.id, v.name, tv.driverName, tv.driverSetAt, tv.driverSetBy
    FROM team_vehicles tv
    JOIN vehicles v ON v.id = tv.vehicleId
    WHERE tv.date = ? AND v.deletedAt IS NULL
    ORDER BY tv.team ASC, v.name COLLATE NOCASE ASC
  `).all(date);

  const out = initTeamMap(codes);
  for (const r of rows) {
    if (!out[r.team]) out[r.team] = [];
    out[r.team].push({ id: r.id, name: r.name, driverName: r.driverName || '', driverSetAt: r.driverSetAt || '', driverSetBy: r.driverSetBy || '' });
  }
  return out;
}

// Get planning snapshot
router.get("/", (req, res) => {
  const db = getDb();
  const date = (req.query.date || todayDate()).toString();

  // Move unfinished tasks from yesterday into today so both crew and admin see them.
  carryOverOpenTasksToToday(db, date);

  const teamsMeta = listTeams(db);
  const codes = teamsMeta.map(t => t.code);

  // Ensure everyone is present by default (new day)
  ensureDefaultAttendance(db, date, req.user && req.user.id ? req.user.id : 'system');
  const employees = getEmployees(db);
  const vehicles = getVehicles(db);
  const attendance = getAttendance(db, date);
  const teams = getTeamMembers(db, date, codes);
  const teamVehicles = getTeamVehicles(db, date, codes);

  res.json({ date, employees, vehicles, attendance, teams, teamVehicles, teamCodes: codes, teamsMeta });
});

// Teams list (public for crew UI)
router.get("/teams", (req, res) => {
  const db = getDb();
  const teamsMeta = listTeams(db);
  res.json({ teamsMeta, teamCodes: teamsMeta.map(t => t.code) });
});

// Add a new team (admin only). Auto-adds the next number (Ploeg 5, 6, ...)
router.post("/teams", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const team = addTeam(db, req.user.id);
  recordTeamAction(db, "ADD", team.code, req.user.id);
  try { recordUndoAction(db, "TEAM_ADD", "team", team.code, team, req.user.id); } catch {}
  const teamsMeta = listTeams(db);
  res.status(201).json({ ok: true, team, teamsMeta, teamCodes: teamsMeta.map(t => t.code) });
});

// Delete a team (admin only) - soft delete
router.post("/teams/:code/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const code = normTeam(req.params.code);
  if (!code) return res.status(400).json({ error: "invalid_team" });
  if (!isValidTeam(db, code)) return res.status(400).json({ error: "invalid_team" });
  const snapshot = db.prepare("SELECT code, label, sortOrder FROM teams WHERE code = ?").get(code);
  deleteTeam(db, code, req.user.id, nowIso);
  recordTeamAction(db, "DELETE", code, req.user.id);
  try { recordUndoAction(db, "TEAM_DELETE", "team", code, snapshot || { code }, req.user.id); } catch {}
  const teamsMeta = listTeams(db);
  res.json({ ok: true, teamsMeta, teamCodes: teamsMeta.map(t => t.code) });
});

router.post("/undo", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const row = getLatestUndoAction(db);
  if (!row) return res.status(404).json({ error: "nothing_to_undo" });

  let payload = null;
  try { payload = row.payloadJson ? JSON.parse(row.payloadJson) : null; } catch { payload = null; }

  if (row.actionType === "TEAM_DELETE") {
    undeleteTeam(db, row.entityId);
  } else if (row.actionType === "TEAM_ADD") {
    deleteTeam(db, row.entityId, req.user.id, nowIso);
  } else if (row.actionType === "LIBRARY_DELETE") {
    const p = payload || {};
    const existing = db.prepare("SELECT id FROM task_library WHERE id = ?").get(row.entityId);
    if (existing) {
      db.prepare(`UPDATE task_library SET key=?, street=?, description=?, pool=?, active=?, createdAt=?, createdBy=?, deletedAt=NULL, deletedBy=NULL WHERE id=?`)
        .run(p.key || null, p.street || '', p.description || '', p.pool || 'GRND', p.active ? 1 : 1, p.createdAt || nowIso(), p.createdBy || req.user.id, row.entityId);
    } else {
      db.prepare(`INSERT INTO task_library (id, key, street, description, pool, active, createdAt, createdBy, deletedAt, deletedBy)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
        .run(row.entityId, p.key || row.entityId, p.street || '', p.description || '', p.pool || 'GRND', 1, p.createdAt || nowIso(), p.createdBy || req.user.id);
    }
  } else if (row.actionType === "TASK_DELETE") {
    const p = payload || {};
    const fields = [
      p.street || '', p.zone || null, p.description || '', p.priority || 'GREEN', p.status || 'FREE', p.team || null,
      p.dueDate || todayDate(), p.createdAt || nowIso(), p.createdBy || req.user.id, p.updatedAt || nowIso(), p.updatedBy || req.user.id,
      p.doneAt || null, p.doneBy || null, p.lockReason || null, p.lastNote || null, p.lat ?? null, p.lng ?? null,
      p.photoPath || null, p.startedAt || null, p.startedBy || null, p.startedMode || null, p.startRosterHash || null, p.durationSec ?? null,
      p.pool || 'GRND', row.entityId
    ];
    db.prepare(`UPDATE tasks SET street=?, zone=?, description=?, priority=?, status=?, team=?, dueDate=?, createdAt=?, createdBy=?, updatedAt=?, updatedBy=?, doneAt=?, doneBy=?, lockReason=?, lastNote=?, lat=?, lng=?, photoPath=?, startedAt=?, startedBy=?, startedMode=?, startRosterHash=?, durationSec=?, pool=?, deletedAt=NULL, deletedBy=NULL WHERE id=?`).run(...fields);
  } else if (row.actionType === "VEHICLE_DELETE") {
    const p = payload || {};
    const vehicle = p.vehicle || {};
    const teamVehicleRows = Array.isArray(p.teamVehicleRows) ? p.teamVehicleRows : [];

    const tx = db.transaction(() => {
      const exists = db.prepare("SELECT id FROM vehicles WHERE id = ?").get(row.entityId);
      if (exists) {
        db.prepare("UPDATE vehicles SET name=?, deletedAt=NULL, deletedBy=NULL WHERE id=?")
          .run(vehicle.name || '', row.entityId);
      } else {
        db.prepare("INSERT INTO vehicles (id, name, deletedAt, deletedBy) VALUES (?, ?, NULL, NULL)")
          .run(row.entityId, vehicle.name || '');
      }
      const insTv = db.prepare("INSERT OR IGNORE INTO team_vehicles (date, team, vehicleId) VALUES (?, ?, ?)");
      for (const r of teamVehicleRows) {
        if (!r || !r.date || !r.team || !r.vehicleId) continue;
        insTv.run(r.date, r.team, r.vehicleId);
      }
    });
    tx();

  } else if (row.actionType === "EMPLOYEE_DELETE") {
    const p = payload || {};
    const employee = p.employee || {};
    const attendanceRows = Array.isArray(p.attendanceRows) ? p.attendanceRows : [];
    const teamMemberRows = Array.isArray(p.teamMemberRows) ? p.teamMemberRows : [];
    const pairingRows = Array.isArray(p.pairingRows) ? p.pairingRows : [];
    const deviceLinkRows = Array.isArray(p.deviceLinkRows) ? p.deviceLinkRows : [];
    const poolAccessRows = Array.isArray(p.poolAccessRows) ? p.poolAccessRows : [];

    const tx = db.transaction(() => {
      db.prepare(`INSERT OR REPLACE INTO employees (id, name, deletedAt, deletedBy) VALUES (?, ?, NULL, NULL)`)
        .run(employee.id || row.entityId, employee.name || '',);

      const insAttendance = db.prepare(`
        INSERT OR REPLACE INTO day_attendance (date, employeeId, present, updatedAt, updatedBy)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const r of attendanceRows) insAttendance.run(r.date, r.employeeId, r.present, r.updatedAt, r.updatedBy);

      const insTeam = db.prepare(`
        INSERT OR REPLACE INTO team_members (date, team, employeeId)
        VALUES (?, ?, ?)
      `);
      for (const r of teamMemberRows) insTeam.run(r.date, r.team, r.employeeId);

      const insPair = db.prepare(`
        INSERT OR REPLACE INTO pairing_codes (code, employeeId, expiresAt, createdAt, createdBy)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const r of pairingRows) insPair.run(r.code, r.employeeId, r.expiresAt, r.createdAt, r.createdBy);

      const insLink = db.prepare(`
        INSERT OR REPLACE INTO device_links (deviceId, employeeId, linkedAt, linkedBy, lastSeenAt, userAgent)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const r of deviceLinkRows) insLink.run(r.deviceId, r.employeeId, r.linkedAt, r.linkedBy || null, r.lastSeenAt || null, r.userAgent || null);

      const insPool = db.prepare(`
        INSERT OR REPLACE INTO device_pool_access (deviceId, poolCode)
        VALUES (?, ?)
      `);
      for (const r of poolAccessRows) insPool.run(r.deviceId, r.poolCode);
    });
    tx();
  } else {
    return res.status(400).json({ error: "unsupported_undo" });
  }

  markUndoActionDone(db, row.id, req.user.id);
  const teamsMeta = listTeams(db);
  res.json({ ok: true, undone: { actionType: row.actionType, entityType: row.entityType, entityId: row.entityId }, teamsMeta, teamCodes: teamsMeta.map(t => t.code) });
});

// Attendance: set present/absent
router.post("/attendance", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const body = req.body || {};
  const date = (body.date || todayDate()).toString();
  const name = normName(body.name);
  const present = !!body.present;

  if (!name) return res.status(400).json({ error: "name_required" });

  const emp = db.prepare("SELECT id, name FROM employees WHERE name = ?").get(name);
  if (!emp) return res.status(404).json({ error: "unknown_employee" });

  const now = nowIso();
  db.prepare(`
    INSERT INTO day_attendance (date, employeeId, present, updatedAt, updatedBy)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date, employeeId) DO UPDATE SET
      present = excluded.present,
      updatedAt = excluded.updatedAt,
      updatedBy = excluded.updatedBy
  `).run(date, emp.id, present ? 1 : 0, now, req.user.id);

  try { appendEvent({ date, type: "ATTENDANCE_SET", by: req.user.id, employeeId: emp.id, employee: emp.name, present }); } catch {}
  res.json({ ok: true, date, name: emp.name, present });
});

// Set team members for a team (crew can do it)
router.post("/team-members", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const body = req.body || {};
  const date = (body.date || todayDate()).toString();
  const team = normTeam(body.team);
  const members = Array.isArray(body.members) ? body.members.map(normName).filter(Boolean) : [];

  if (!isValidTeam(db, team)) return res.status(400).json({ error: "invalid_team" });

  // Allowed sizes depend on role
  // - crew: 0 (unused) OR 2..4
  // - admin: 0..4 (so admin can send someone solo)
  const n = members.length;
  const isAdmin = req.user.role === "admin";
  const okSize = isAdmin ? (n >= 0 && n <= 4) : (n === 0 || (n >= 2 && n <= 4));
  if (!okSize) {
    return res.status(409).json({
      error: "team_size_invalid",
      hint: isAdmin ? "0..4 members" : "0 or 2..4 members"
    });
  }

  // Validate all names exist
  const seen = new Set();
  for (const n of members) {
    if (seen.has(n)) return res.status(409).json({ error: "duplicate_member_in_team", name: n });
    seen.add(n);
    const emp = db.prepare("SELECT id FROM employees WHERE name = ?").get(n);
    if (!emp) return res.status(404).json({ error: "unknown_employee", name: n });
  }

  // Write: clear existing members for this team/date, then insert
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM team_members WHERE date = ? AND team = ?").run(date, team);
    const ins = db.prepare("INSERT INTO team_members (date, team, employeeId) VALUES (?, ?, ?)");

    for (const n of members) {
      const emp = db.prepare("SELECT id FROM employees WHERE name = ?").get(n);
      ins.run(date, team, emp.id);
    }
  });
  tx();

  res.json({ ok: true, date, team, members });
});

// Crew/mobile: join a team with your linked name (no full-team editing needed)
router.post("/join-team", (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const date = (body.date || todayDate()).toString();
  const team = normTeam(body.team);
  if (!isValidTeam(db, team)) return res.status(400).json({ error: "invalid_team" });

  const name = normName(req.user.id);
  if (!name || name === "anon") return res.status(401).json({ error: "not_paired" });

  const emp = db.prepare("SELECT id, name FROM employees WHERE (id = ? OR name = ?) AND deletedAt IS NULL").get(name, name);
  if (!emp) return res.status(404).json({ error: "unknown_employee" });

  // Enforce max 4 members per team
  const current = db.prepare(
    "SELECT COUNT(*) AS c FROM team_members WHERE date = ? AND team = ?"
  ).get(date, team);
  // If user is already in this team, allow
  const already = db.prepare(
    "SELECT 1 AS ok FROM team_members WHERE date = ? AND team = ? AND employeeId = ?"
  ).get(date, team, emp.id);
  if (!already && current && current.c >= 4) {
    return res.status(409).json({ error: "team_full", hint: "max 4" });
  }

  const tx = db.transaction(() => {
    // Remove from any other team for that date
    db.prepare("DELETE FROM team_members WHERE date = ? AND employeeId = ?").run(date, emp.id);
    // Add to chosen team
    db.prepare("INSERT OR IGNORE INTO team_members (date, team, employeeId) VALUES (?, ?, ?)").run(date, team, emp.id);
  });
  tx();

  const teams = getTeamMembers(db, date);
  try { appendEvent({ date, type: "TEAM_JOIN", by: req.user.id, team, employeeId: emp.id, employee: emp.name }); } catch {}
  res.json({ ok: true, date, team, name: emp.name, teams });
});

// Assign vehicles to a team (max 2). A vehicle may only belong to one team per day.
router.post("/team-vehicles", (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const date = (body.date || todayDate()).toString();
  const team = normTeam(body.team);

  const role = (req.user && req.user.role) || 'crew';
  if (role !== 'admin') {
    const me = db.prepare(`SELECT e.name
      FROM employees e
      WHERE e.id = ? AND e.deletedAt IS NULL
      LIMIT 1`).get(req.user && req.user.id ? req.user.id : '');
    const memberNames = getTeamMemberNames(db, date, team);
    if (!me || !memberNames.includes(me.name)) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }

  const assignments = Array.isArray(body.assignments)
    ? body.assignments.map(a => ({
        vehicleId: (a && a.vehicleId ? String(a.vehicleId) : '').trim(),
        driverName: (a && a.driverName ? String(a.driverName) : '').trim()
      })).filter(a => a.vehicleId)
    : Array.from(new Set((Array.isArray(body.vehicleIds) ? body.vehicleIds : []).map(v => String(v || '').trim()).filter(Boolean))).map(id => ({ vehicleId: id, driverName: '' }));

  if (!isValidTeam(db, team)) return res.status(400).json({ error: "invalid_team" });
  if (assignments.length > 2) return res.status(409).json({ error: "max_2_vehicles" });

  const memberNames = getTeamMemberNames(db, date, team);

  for (const a of assignments) {
    const v = db.prepare("SELECT id, name FROM vehicles WHERE id = ? AND deletedAt IS NULL").get(a.vehicleId);
    if (!v) return res.status(404).json({ error: "unknown_vehicle", id: a.vehicleId });

    const other = db.prepare(`
      SELECT tv.team, v.name
      FROM team_vehicles tv
      JOIN vehicles v ON v.id = tv.vehicleId
      WHERE tv.date = ? AND tv.vehicleId = ? AND tv.team <> ?
      LIMIT 1
    `).get(date, a.vehicleId, team);

    if (other) {
      return res.status(409).json({
        error: "vehicle_already_assigned",
        vehicleId: a.vehicleId,
        vehicleName: other.name,
        assignedTeam: other.team
      });
    }

    if (a.driverName && !memberNames.includes(a.driverName)) {
      return res.status(409).json({ error: "driver_not_in_team", driverName: a.driverName });
    }
  }

  const currentRows = db.prepare(`
    SELECT tv.vehicleId, tv.driverName, v.name
    FROM team_vehicles tv
    JOIN vehicles v ON v.id = tv.vehicleId
    WHERE tv.date = ? AND tv.team = ? AND v.deletedAt IS NULL
  `).all(date, team);
  const currentMap = new Map(currentRows.map(r => [r.vehicleId, r]));

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM team_vehicles WHERE date = ? AND team = ?").run(date, team);
    const ins = db.prepare("INSERT INTO team_vehicles (date, team, vehicleId, driverName, driverSetAt, driverSetBy) VALUES (?, ?, ?, ?, ?, ?)");
    const insLog = db.prepare("INSERT INTO vehicle_driver_log (id, date, team, vehicleId, vehicleName, driverName, action, at, byUser) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const now = nowIso();
    for (const a of assignments) {
      const v = db.prepare("SELECT id, name FROM vehicles WHERE id = ? AND deletedAt IS NULL").get(a.vehicleId);
      const actorLabel = resolveActorLabel(db, req.user);
      ins.run(date, team, a.vehicleId, a.driverName || null, now, actorLabel);
      const prev = currentMap.get(a.vehicleId);
      const changed = !prev || String(prev.driverName || '') !== String(a.driverName || '');
      if (changed) {
        insLog.run(nanoid(), date, team, a.vehicleId, v.name, a.driverName || null, prev ? 'driver_changed' : 'vehicle_set', now, actorLabel);
      }
    }
  });
  tx();

  try { appendEvent({ date, type: "TEAM_VEHICLES_SET", by: resolveActorLabel(db, req.user), team, vehicleIds: assignments.map(a => a.vehicleId), drivers: assignments.map(a => a.driverName || '') }); } catch {}
  res.json({ ok: true, date, team, assignments });
});

// Randomly build teams from present employees (2-4 per team). Crew can do this.
router.post("/randomize", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const body = req.body || {};
  const date = (body.date || todayDate()).toString();

  ensureDefaultAttendance(db, date, req.user.id);

  const present = db.prepare(`
    SELECT e.id, e.name
    FROM employees e
    JOIN day_attendance a ON a.employeeId = e.id AND a.date = ?
    WHERE a.present = 1
    ORDER BY e.name COLLATE NOCASE ASC
  `).all(date);

  const names = present.map(x => x.name);
  const n = names.length;
  if (n < 2) return res.status(409).json({ error: "not_enough_people" });

  // Shuffle
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }

  const teamsMeta = listTeams(db);
  const teamList = teamsMeta.map(t => t.code);
  const capacity = teamList.length * 4;

  let warning = null;
  if (n > capacity) warning = `Meer dan ${capacity} aanwezigen voor ${teamList.length} ploegen. Extra personen blijven onverdeeld in MVP.`;

  const minNeeded = Math.ceil(n / 4); // to keep <=4 per team
  const maxAllowed = Math.min(teamList.length, Math.floor(n / 2)); // to keep >=2 per team
  let teamCount = Math.max(1, Math.min(maxAllowed, Math.max(minNeeded, 1)));
  if (teamCount < minNeeded) {
    // Not enough teams configured
    teamCount = Math.max(1, maxAllowed);
  }

  // Base sizes: 2 each
  const sizes = new Array(teamCount).fill(2);
  let remaining = n - 2 * teamCount;

  for (let i = 0; remaining > 0 && i < sizes.length; i = (i + 1) % sizes.length) {
    if (sizes[i] < 4) { sizes[i]++; remaining--; }
    else {
      // if all full, break
      if (sizes.every(s => s >= 4)) break;
    }
  }

  const out = initTeamMap(teamList);

  let idx = 0;
  for (let t = 0; t < teamCount; t++) {
    const team = teamList[t];
    out[team] = names.slice(idx, idx + sizes[t]);
    idx += sizes[t];
  }
  // leftover (if any) ignored (shouldn't unless >16)
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM team_members WHERE date = ?").run(date);
    const ins = db.prepare("INSERT INTO team_members (date, team, employeeId) VALUES (?, ?, ?)");
    for (const team of teamList) {
      for (const nm of out[team]) {
        const emp = db.prepare("SELECT id FROM employees WHERE name = ?").get(nm);
        if (emp) ins.run(date, team, emp.id);
      }
    }
  });
  tx();

  res.json({ ok: true, date, teams: out, warning });
});



// Employees list management (admin only)
router.post("/employees", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const body = req.body || {};
  const name = normName(body.name);
  if (!name) return res.status(400).json({ error: "name_required" });

  const existing = db.prepare("SELECT id, name, deletedAt FROM employees WHERE name = ?").get(name);
  if (existing) {
    if (existing.deletedAt) {
      db.prepare("UPDATE employees SET deletedAt = NULL, deletedBy = NULL WHERE id = ?").run(existing.id);
      return res.json({ ok: true, id: existing.id, name: existing.name, reactivated: true });
    }
    return res.status(409).json({ error: "employee_exists" });
  }

  db.prepare("INSERT INTO employees (id, name) VALUES (?, ?)").run(nanoid(), name);
  res.status(201).json({ id: name, name });
});

router.post("/employees/:id/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const id = (req.params.id || "").toString();

  const e = db.prepare("SELECT id, name, deletedAt, deletedBy FROM employees WHERE id = ? AND deletedAt IS NULL").get(id);
  if (!e) return res.status(404).json({ error: "not_found" });

  const attendanceRows = db.prepare("SELECT * FROM day_attendance WHERE employeeId = ?").all(id);
  const teamMemberRows = db.prepare("SELECT * FROM team_members WHERE employeeId = ?").all(id);
  const pairingRows = db.prepare("SELECT * FROM pairing_codes WHERE employeeId = ?").all(id);
  const deviceLinkRows = db.prepare("SELECT * FROM device_links WHERE employeeId = ?").all(id);
  const deviceIds = deviceLinkRows.map(r => r.deviceId).filter(Boolean);
  const poolAccessRows = deviceIds.length
    ? db.prepare(`SELECT * FROM device_pool_access WHERE deviceId IN (${deviceIds.map(() => '?').join(',')})`).all(...deviceIds)
    : [];

  try {
    recordUndoAction(db, "EMPLOYEE_DELETE", "employee", id, {
      employee: e,
      attendanceRows,
      teamMemberRows,
      pairingRows,
      deviceLinkRows,
      poolAccessRows
    }, req.user.id);
  } catch {}

  const tx = db.transaction(() => {
    if (deviceIds.length) {
      db.prepare(`DELETE FROM device_pool_access WHERE deviceId IN (${deviceIds.map(() => '?').join(',')})`).run(...deviceIds);
    }
    db.prepare("DELETE FROM pairing_codes WHERE employeeId = ?").run(id);
    db.prepare("DELETE FROM device_links WHERE employeeId = ?").run(id);
    db.prepare("DELETE FROM day_attendance WHERE employeeId = ?").run(id);
    db.prepare("DELETE FROM team_members WHERE employeeId = ?").run(id);
    db.prepare("DELETE FROM employees WHERE id = ?").run(id);
  });
  tx();

  try { appendEvent({ date: todayDate(), type: "EMPLOYEE_DELETE", by: req.user.id, employeeId: e.id, employee: e.name }); } catch {}
  res.json({ ok: true });
});

router.get("/employees/all", (req, res) => {
  const db = getDb();
  const rows = db.prepare("SELECT id, name FROM employees WHERE deletedAt IS NULL ORDER BY name COLLATE NOCASE ASC").all();
  res.json({ employees: rows });
});


// Vehicles list management (admin only)
router.post("/vehicles", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const body = req.body || {};
  const name = normName(body.name);
  if (!name) return res.status(400).json({ error: "name_required" });

  const existing = db.prepare("SELECT id, name, deletedAt FROM vehicles WHERE lower(name) = lower(?) LIMIT 1").get(name);
  if (existing && !existing.deletedAt) {
    return res.status(409).json({ error: "vehicle_exists" });
  }
  if (existing && existing.deletedAt) {
    db.prepare("UPDATE vehicles SET name = ?, deletedAt = NULL, deletedBy = NULL WHERE id = ?").run(name, existing.id);
    return res.status(201).json({ id: existing.id, name, reactivated: true });
  }

  const id = nanoid();
  try {
    db.prepare("INSERT INTO vehicles (id, name) VALUES (?, ?)").run(id, name);
  } catch (e) {
    return res.status(409).json({ error: "vehicle_exists" });
  }
  res.status(201).json({ id, name });
});

router.post("/vehicles/:id/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const db = getDb();
  const id = (req.params.id || "").toString();

  const v = db.prepare("SELECT id, name, deletedAt, deletedBy FROM vehicles WHERE id = ? AND deletedAt IS NULL").get(id);
  if (!v) return res.status(404).json({ error: "not_found" });

  const teamVehicleRows = db.prepare("SELECT date, team, vehicleId FROM team_vehicles WHERE vehicleId = ?").all(id);
  try {
    recordUndoAction(db, "VEHICLE_DELETE", "vehicle", id, { vehicle: v, teamVehicleRows }, req.user.id);
  } catch {}

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM team_vehicles WHERE vehicleId = ?").run(id);
    db.prepare("DELETE FROM vehicles WHERE id = ?").run(id);
  });
  tx();

  try { appendEvent({ date: todayDate(), type: "VEHICLE_DELETE", by: req.user.id, vehicleId: v.id, vehicle: v.name }); } catch {}
  res.json({ ok: true });
});

module.exports = router;
