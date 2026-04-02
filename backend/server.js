const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { initDb, getDb } = require("./db");
const tasksRouter = require("./routes/tasks");
const planningRouter = require("./routes/planning");
const libraryRouter = require("./routes/library");
const pairingRouter = require("./routes/pairing");
const foremenRouter = require("./routes/foremen");

const app = express();
const PORT = process.env.PORT || 3000;

// Photo uploads (served to clients)
const uploadDir = path.join(__dirname, "data", "uploads");
try { if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true }); } catch {}

// Basic middleware
app.use(express.json({ limit: "6mb" }));

const frontendDir = path.join(__dirname, "..", "frontend");
app.use("/", express.static(frontendDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".webmanifest")) {
      res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    }
  }
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendDir, "admin.html"));
});


// DB init (needed for foreman auth)
initDb();


// "MVP auth": role via headers, but admin requires a shared key (ADMIN_KEY)
app.use((req, res, next) => {
  const requestedRole = (req.header("x-role") || "crew").toLowerCase();
  const adminKey = req.header("x-admin-key") || "";
  const expectedKey = process.env.ADMIN_KEY || "1234"; // CHANGE THIS for real use

  // Admin
  if (requestedRole === "admin" && adminKey === expectedKey) {
    req.user = { id: req.header("x-user-id") || "admin", role: "admin", name: req.header("x-user-name") || "" };
    return next();
  }

  // Foreman (ploegbaas) - verify code against DB
  if (requestedRole === "foreman") {
    const key = (req.header("x-foreman-key") || "").toString().trim();
    if (key) {
      try{
        const h = crypto.createHash("sha256").update(key).digest("hex");
        const db = getDb();
        const row = db.prepare("SELECT id, name FROM foremen WHERE codeHash = ? AND deletedAt IS NULL").get(h);
        if (row) {
          req.user = { id: `foreman:${row.id}`, role: "foreman", name: row.name };
          return next();
        }
      }catch{}
    }
  }

  // Default crew
  req.user = { id: req.header("x-user-id") || "anon", role: "crew", name: req.header("x-user-name") || "" };
  next();
});

// API
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/api/whoami", (req, res) => res.json({ id: req.user.id, role: req.user.role }));
app.use("/api/tasks", tasksRouter);
app.use("/api/planning", planningRouter);
app.use("/api/library", libraryRouter);
app.use("/api/foremen", foremenRouter);
app.use("/api/pairing", pairingRouter);

// Historiek export (Excel) - SpreadsheetML 2003 (.xls)

function fmtExportDateTime(value){
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value).replace('T', ' ').slice(0, 16);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function resolveByUserLabel(db, raw){
  const id = String(raw || '').trim();
  if (!id) return '';
  if (id === 'admin') return 'admin';
  if (id.startsWith('foreman:')) {
    try {
      const foremanId = id.split(':')[1] || '';
      const row = db.prepare('SELECT name FROM foremen WHERE id = ? AND deletedAt IS NULL').get(foremanId);
      if (row && row.name) return row.name;
    } catch {}
    return id;
  }
  try {
    const byDevice = db.prepare(`
      SELECT e.name
      FROM device_links dl
      JOIN employees e ON e.id = dl.employeeId
      WHERE dl.deviceId = ? AND e.deletedAt IS NULL
      LIMIT 1
    `).get(id);
    if (byDevice && byDevice.name) return byDevice.name;
  } catch {}
  try {
    const byEmployeeId = db.prepare(`
      SELECT name FROM employees
      WHERE id = ? AND deletedAt IS NULL
      LIMIT 1
    `).get(id);
    if (byEmployeeId && byEmployeeId.name) return byEmployeeId.name;
  } catch {}
  return id;
}


function getHistorySnapshot(date){
  const db = getDb();
  const target = (date || todayDate()).toString();

  const tasks = db.prepare(`
    SELECT t.id, t.dueDate, t.street, t.description, t.priority, t.pool, t.status, t.team,
           t.startedAt, t.doneAt, t.durationSec
    FROM tasks t
    WHERE t.deletedAt IS NULL
      AND t.status IN ('CLAIMED','IMPOSED','DONE')
      AND (
        t.dueDate = ?
        OR substr(COALESCE(t.startedAt,''),1,10) = ?
        OR substr(COALESCE(t.doneAt,''),1,10) = ?
      )
    ORDER BY COALESCE(t.startedAt, t.doneAt, t.dueDate) ASC, t.street COLLATE NOCASE ASC
  `).all(target, target, target);

  const teamMembersAt = (team) => db.prepare(`
    SELECT e.name
    FROM team_members tm
    JOIN employees e ON e.id = tm.employeeId
    WHERE tm.date = ? AND tm.team = ? AND e.deletedAt IS NULL
    ORDER BY e.name COLLATE NOCASE ASC
  `).all(target, team).map(x => x.name);

  const teamVehiclesAt = (team) => db.prepare(`
    SELECT v.name, tv.driverName
    FROM team_vehicles tv
    JOIN vehicles v ON v.id = tv.vehicleId
    WHERE tv.date = ? AND tv.team = ? AND v.deletedAt IS NULL
    ORDER BY v.name COLLATE NOCASE ASC
  `).all(target, team).map(x => x.driverName ? `${x.name} (${x.driverName})` : x.name);

  const taskRows = tasks.map(t => {
    let durationMin = null;
    if (t.durationSec != null && !Number.isNaN(Number(t.durationSec))) durationMin = Math.round(Number(t.durationSec) / 60);
    else if (t.startedAt && t.doneAt) {
      const a = Date.parse(t.startedAt), b = Date.parse(t.doneAt);
      if (!isNaN(a) && !isNaN(b) && b >= a) durationMin = Math.round((b-a)/60000);
    }
    return {
      ...t,
      members: t.team ? teamMembersAt(t.team) : [],
      vehicles: t.team ? teamVehiclesAt(t.team) : [],
      startedAt: t.startedAt || null,
      doneAt: t.doneAt || null,
      durationMin
    };
  });

  return { date: target, tasks: taskRows };
}

app.get("/api/history/day", (req, res) => {
  try{
    if (req.user.role !== "admin") return res.status(403).json({ error: "forbidden" });
    const date = (req.query.date || todayDate()).toString();
    res.json(getHistorySnapshot(date));
  }catch(e){
    res.status(500).json({ error: "history_failed" });
  }
});

app.get("/api/history.xls", async (req, res) => {
  try{
    if (req.user.role !== "admin") return res.status(403).send("forbidden");
    const db = getDb();
    const date = (req.query.date || todayDate()).toString();
    const year = /^\d{4}/.exec(date)?.[0] || String(new Date().getFullYear());

    const escXml = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const cell = (v, type='String', style='') => `<Cell${style ? ` ss:StyleID="${style}"` : ''}><Data ss:Type="${type}">${escXml(v)}</Data></Cell>`;
    const row = (cells) => `<Row>${cells.join('')}</Row>`;

    const tasks = db.prepare(`
      SELECT id, dueDate, street, description, priority, pool, status, team, startedAt, doneAt, durationSec
      FROM tasks
      WHERE deletedAt IS NULL
        AND status IN ('CLAIMED','IMPOSED','DONE')
        AND (
          substr(COALESCE(startedAt, dueDate),1,4) = ?
          OR substr(COALESCE(doneAt,''),1,4) = ?
        )
      ORDER BY substr(COALESCE(startedAt, dueDate),1,10) ASC, street COLLATE NOCASE ASC
    `).all(year, year);

    const membersFor = db.prepare(`
      SELECT e.name
      FROM team_members tm
      JOIN employees e ON e.id = tm.employeeId
      WHERE tm.date = ? AND tm.team = ? AND e.deletedAt IS NULL
      ORDER BY e.name COLLATE NOCASE ASC
    `);
    const vehiclesFor = db.prepare(`
      SELECT v.name, tv.driverName
      FROM team_vehicles tv
      JOIN vehicles v ON v.id = tv.vehicleId
      WHERE tv.date = ? AND tv.team = ? AND v.deletedAt IS NULL
      ORDER BY v.name COLLATE NOCASE ASC
    `);

    let taskRows = '';
    for (const t of tasks){
      const workDate = String(t.startedAt || t.dueDate || '').slice(0,10);
      const members = t.team ? membersFor.all(workDate, t.team).map(r => r.name).join(' | ') : '';
      const vehicles = t.team ? vehiclesFor.all(workDate, t.team) : [];
      const vehicleNames = vehicles.map(v => v.name).join(' | ');
      const driverNames = vehicles.map(v => v.driverName).filter(Boolean).join(' | ');
      let durationMin = '';
      if (t.durationSec != null && !Number.isNaN(Number(t.durationSec))) durationMin = String(Math.round(Number(t.durationSec)/60));
      else if (t.startedAt && t.doneAt) {
        const a = Date.parse(t.startedAt), b = Date.parse(t.doneAt);
        if (!isNaN(a) && !isNaN(b) && b >= a) durationMin = String(Math.round((b-a)/60000));
      }
      taskRows += row([
        cell(workDate), cell(t.street), cell(t.description || ''), cell(t.priority), cell(t.pool || ''),
        cell(t.status), cell(t.team || ''), cell(members), cell(vehicleNames), cell(driverNames),
        cell(fmtExportDateTime(t.startedAt || '')), cell(fmtExportDateTime(t.doneAt || '')), cell(durationMin)
      ]);
    }

    const vlogs = db.prepare(`
      SELECT date, at, team, vehicleName, driverName, action, byUser
      FROM vehicle_driver_log
      WHERE substr(date,1,4) = ?
      ORDER BY date ASC, at ASC
    `).all(year);

    let logRows = '';
    for (const v of vlogs){
      logRows += row([
        cell(v.date),
        cell(fmtExportDateTime(v.at).slice(11,16)),
        cell(v.team || ''),
        cell(v.vehicleName || ''),
        cell(v.driverName || ''),
        cell(v.action || ''),
        cell(resolveByUserLabel(db, v.byUser || ''))
      ]);
    }

    const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="title"><Font ss:Bold="1" ss:Size="14"/></Style>
  <Style ss:ID="section"><Font ss:Bold="1" ss:Size="12"/><Interior ss:Color="#EDEDED" ss:Pattern="Solid"/></Style>
  <Style ss:ID="header"><Font ss:Bold="1"/><Interior ss:Color="#D9E2F3" ss:Pattern="Solid"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>
  <Style ss:ID="wrap"><Alignment ss:Vertical="Top" ss:WrapText="1"/></Style>
  <Style ss:ID="text"><Alignment ss:Vertical="Top" ss:WrapText="1"/></Style>
 </Styles>
 <Worksheet ss:Name="Taken">
  <Table>
   <Column ss:Width="95"/><Column ss:Width="140"/><Column ss:Width="280"/><Column ss:Width="85"/><Column ss:Width="75"/><Column ss:Width="95"/>
   <Column ss:Width="95"/><Column ss:Width="240"/><Column ss:Width="125"/><Column ss:Width="125"/><Column ss:Width="120"/><Column ss:Width="120"/><Column ss:Width="70"/>
   ${row([cell(`Historiek ${year}`, 'String', 'title')])}
   ${row([cell('Uitgevoerde / lopende taken', 'String', 'section')])}
   ${row([cell('Datum','String','header'),cell('Straat','String','header'),cell('Beschrijving','String','header'),cell('Prioriteit','String','header'),cell('Pool','String','header'),cell('Status','String','header'),cell('Ploeg','String','header'),cell('Mensen','String','header'),cell('Voertuig','String','header'),cell('Chauffeur','String','header'),cell('Start','String','header'),cell('Einde','String','header'),cell('Duur min','String','header')])}
   ${taskRows}
   ${row([cell('')])}
   ${row([cell('Chauffeur- en voertuigwissels', 'String', 'section')])}
   ${row([cell('Datum','String','header'),cell('Tijd','String','header'),cell('Ploeg','String','header'),cell('Voertuig','String','header'),cell('Chauffeur','String','header'),cell('Actie','String','header'),cell('Gekozen door','String','header')])}
   ${logRows}
  </Table>
 </Worksheet>
</Workbook>`;

    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="historiek-${year}.xls"`);
    res.send(xml);
  }catch(e){
    console.error(e);
    res.status(500).send('history_failed');
  }
});

// Serve uploaded task photos
app.use("/uploads", express.static(uploadDir));

// Frontend static (+ proper content-type for PWA manifest)
const frontendDir = path.join(__dirname, "..", "frontend");
app.use("/", express.static(frontendDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".webmanifest")) {
      res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    }
  }
}));

// Clean crew UI (mobile)
app.get("/crew", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "crew.html"));
});

// Admin shortcut (intended for PC use):
// - This does NOT grant admin rights; it only opens the admin UI.
// - Admin rights still require the correct PIN/ADMIN_KEY.
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "admin.html"));
});

/** Analytics: day summary (simple JSON) */
app.get("/api/analytics/day", async (req, res) => {
  try{
    const db = getDb();
    const date = (req.query.date || todayDate()).toString();

    const tasks = db.prepare(`
      SELECT id, street, zone, description, priority, pool, status, team, dueDate, createdAt, createdBy, updatedAt, updatedBy,
             startedAt, startedBy, startedMode, durationSec, doneAt, doneBy
      FROM tasks
      WHERE dueDate = ? AND deletedAt IS NULL AND status IN ('FREE','CLAIMED','IMPOSED','DONE','DELETED')
      ORDER BY CASE priority WHEN 'RED' THEN 1 WHEN 'YELLOW' THEN 2 ELSE 3 END, street COLLATE NOCASE ASC
    `).all(date);

    // Team snapshots
    const teams = db.prepare("SELECT code, label FROM teams WHERE deletedAt IS NULL ORDER BY code").all();
    const teamSnapshots = {};
    for (const t of teams){
      const members = db.prepare(`
        SELECT e.name
        FROM team_members tm
        JOIN employees e ON e.id = tm.employeeId
        WHERE tm.date = ? AND tm.team = ? AND e.deletedAt IS NULL
        ORDER BY e.name COLLATE NOCASE ASC
      `).all(date, t.code).map(x=>x.name);

      const vehicles = db.prepare(`
        SELECT v.name
        FROM team_vehicles tv
        JOIN vehicles v ON v.id = tv.vehicleId
        WHERE tv.date = ? AND tv.team = ? AND v.deletedAt IS NULL
        ORDER BY v.name COLLATE NOCASE ASC
      `).all(date, t.code).map(x=>x.name);

      teamSnapshots[t.code] = { members, vehicles };
    }

    res.json({ date, tasks, teamSnapshots });
  }catch(e){
    res.status(500).json({ error: "analytics_failed" });
  }
});

/** Weather (Schelle) - cached in memory/file-like behavior via SQLite table */
app.get("/api/weather", async (req, res) => {
  const date = (req.query.date || todayDate()).toString();
  // Schelle centroid (WGS84)
  const lat = 51.1269186;
  const lon = 4.3388412;

  try{
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&timezone=Europe%2FBrussels&start_date=${date}&end_date=${date}`;
    const r = await fetch(url, { method: "GET" });
    const j = await r.json();
    const out = {
      date,
      source: "open-meteo",
      lat, lon,
      daily: j && j.daily ? j.daily : null
    };
    res.json(out);
  }catch(e){
    res.status(200).json({ date, error: "weather_unavailable" });
  }
});

app.listen(PORT, () => {
  console.log(`\nSchelle Crew Planner running on http://localhost:${PORT}\n`);
});
