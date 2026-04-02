// Team helpers: dynamic teams list stored in SQLite (table: teams)

function listAllTeams(db) {
  try {
    return db.prepare(
      "SELECT code, label, sortOrder, deletedAt, deletedBy FROM teams ORDER BY sortOrder ASC, code ASC"
    ).all();
  } catch {
    return listTeams(db).map(t => ({ ...t, deletedAt: null, deletedBy: null }));
  }
}


function listTeams(db) {
  try {
    return db.prepare(
      "SELECT code, label, sortOrder FROM teams WHERE deletedAt IS NULL ORDER BY sortOrder ASC, code ASC"
    ).all();
  } catch {
    // Fallback for older DBs (should not happen after v20.5)
    return [
      { code: "GROEN1", label: "Ploeg 1", sortOrder: 1 },
      { code: "GROEN2", label: "Ploeg 2", sortOrder: 2 },
      { code: "GROEN3", label: "Ploeg 3", sortOrder: 3 },
      { code: "GROEN4", label: "Ploeg 4", sortOrder: 4 }
    ];
  }
}

function teamCodes(db) {
  return listTeams(db).map(t => t.code);
}

function isValidTeam(db, code) {
  const c = (code || "").toString().toUpperCase();
  try {
    const row = db.prepare("SELECT 1 AS ok FROM teams WHERE code = ? AND deletedAt IS NULL").get(c);
    return !!row;
  } catch {
    return ["GROEN1","GROEN2","GROEN3","GROEN4"].includes(c);
  }
}

function nextTeamNumber(db) {
  const rows = listTeams(db);
  const used = new Set();
  for (const r of rows) {
    const m = (r.code || "").toString().toUpperCase().match(/(\d+)$/);
    const n = m ? parseInt(m[1], 10) : 0;
    if (Number.isFinite(n) && n > 0) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

function addTeam(db, by) {
  const n = nextTeamNumber(db);
  const code = `GROEN${n}`;
  const label = `Ploeg ${n}`;
  const sortOrder = n;
  const existing = db.prepare("SELECT code FROM teams WHERE code = ?").get(code);
  if (existing) {
    db.prepare("UPDATE teams SET label = ?, sortOrder = ?, deletedAt = NULL, deletedBy = NULL WHERE code = ?")
      .run(label, sortOrder, code);
  } else {
    db.prepare("INSERT INTO teams (code, label, sortOrder, deletedAt, deletedBy) VALUES (?, ?, ?, NULL, NULL)")
      .run(code, label, sortOrder);
  }
  return { code, label, sortOrder };
}

function undeleteTeam(db, code) {
  const c = (code || "").toString().toUpperCase();
  db.prepare("UPDATE teams SET deletedAt = NULL, deletedBy = NULL WHERE code = ?").run(c);
  const row = db.prepare("SELECT code, label, sortOrder FROM teams WHERE code = ?").get(c);
  return row || { code: c };
}

function deleteTeam(db, code, by, nowIso) {
  const c = (code || "").toString().toUpperCase();
  const now = nowIso();
  db.prepare("UPDATE teams SET deletedAt = ?, deletedBy = ? WHERE code = ?")
    .run(now, by || "system", c);
  // Cleanup planning assignments for this team
  db.prepare("DELETE FROM team_members WHERE team = ?").run(c);
  db.prepare("DELETE FROM team_vehicles WHERE team = ?").run(c);
  // Do not auto-edit tasks.team (historical), but team will disappear from dropdown
  return { ok: true, code: c };
}

module.exports = { listTeams, listAllTeams, teamCodes, isValidTeam, addTeam, undeleteTeam, deleteTeam };
