const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { DEFAULT_POOL } = require("./pools");

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "app.db");

let db;

function getDb() {
  if (!db) throw new Error("DB not initialized");
  return db;
}

function hasTable(db, table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table);
}

function hasCol(db, table, col) {
  if (!hasTable(db, table)) return false;
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === col);
}

function migrateSchema(db) {
  if (hasTable(db, "tasks")) {
    const taskCols = [
      ["photoPath", "TEXT"],
      ["startedAt", "TEXT"],
      ["startedBy", "TEXT"],
      ["startedMode", "TEXT"],
      ["startRosterHash", "TEXT"],
      ["durationSec", "INTEGER"],
      ["pool", `TEXT NOT NULL DEFAULT '${DEFAULT_POOL}'`]
    ];
    for (const [col, def] of taskCols) {
      if (!hasCol(db, "tasks", col)) {
        try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${def}`); } catch {}
      }
    }
    try { db.exec(`UPDATE tasks SET pool='${DEFAULT_POOL}' WHERE pool IS NULL OR TRIM(pool)=''`); } catch {}
  }

  if (hasTable(db, "task_library")) {
    if (!hasCol(db, "task_library", "pool")) {
      try { db.exec(`ALTER TABLE task_library ADD COLUMN pool TEXT NOT NULL DEFAULT '${DEFAULT_POOL}'`); } catch {}
    }
    try { db.exec(`UPDATE task_library SET pool='${DEFAULT_POOL}' WHERE pool IS NULL OR TRIM(pool)=''`); } catch {}
  }

  if (hasTable(db, "employees")) {
    if (!hasCol(db, "employees", "deletedAt")) {
      try { db.exec("ALTER TABLE employees ADD COLUMN deletedAt TEXT"); } catch {}
    }
    if (!hasCol(db, "employees", "deletedBy")) {
      try { db.exec("ALTER TABLE employees ADD COLUMN deletedBy TEXT"); } catch {}
    }
  }

  if (!hasTable(db, "device_pool_access")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS device_pool_access (
        deviceId TEXT NOT NULL,
        poolCode TEXT NOT NULL,
        PRIMARY KEY(deviceId, poolCode),
        FOREIGN KEY(deviceId) REFERENCES device_links(deviceId)
      );
      CREATE INDEX IF NOT EXISTS idx_device_pool_access_device ON device_pool_access(deviceId);
    `);
  }

  if (!hasTable(db, "team_action_history")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_action_history (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        teamCode TEXT NOT NULL,
        teamLabel TEXT,
        sortOrder INTEGER,
        createdAt TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        undoneAt TEXT,
        undoneBy TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_team_action_history_createdAt ON team_action_history(createdAt DESC);
    `);
  }


  if (hasTable(db, "team_vehicles")) {
    const tvCols = [
      ["driverName", "TEXT"],
      ["driverSetAt", "TEXT"],
      ["driverSetBy", "TEXT"]
    ];
    for (const [col, def] of tvCols) {
      if (!hasCol(db, "team_vehicles", col)) {
        try { db.exec(`ALTER TABLE team_vehicles ADD COLUMN ${col} ${def}`); } catch {}
      }
    }
  }

  if (!hasTable(db, "vehicle_driver_log")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vehicle_driver_log (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        team TEXT NOT NULL,
        vehicleId TEXT NOT NULL,
        vehicleName TEXT NOT NULL,
        driverName TEXT,
        action TEXT NOT NULL,
        at TEXT NOT NULL,
        byUser TEXT,
        FOREIGN KEY(vehicleId) REFERENCES vehicles(id)
      );
      CREATE INDEX IF NOT EXISTS idx_vehicle_driver_log_date ON vehicle_driver_log(date);
      CREATE INDEX IF NOT EXISTS idx_vehicle_driver_log_team ON vehicle_driver_log(team, at DESC);
    `);
  }

  if (!hasTable(db, "undo_actions")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS undo_actions (
        id TEXT PRIMARY KEY,
        actionType TEXT NOT NULL,
        entityType TEXT NOT NULL,
        entityId TEXT,
        payloadJson TEXT,
        createdAt TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        undoneAt TEXT,
        undoneBy TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_undo_actions_createdAt ON undo_actions(createdAt DESC);
    `);
  }
}

function initDb() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      street TEXT NOT NULL,
      zone TEXT,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'GREEN',
      status TEXT NOT NULL DEFAULT 'FREE',
      team TEXT,
      dueDate TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      createdBy TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      updatedBy TEXT NOT NULL,
      doneAt TEXT,
      doneBy TEXT,
      deletedAt TEXT,
      deletedBy TEXT,
      lockReason TEXT,
      lastNote TEXT,
      lat REAL,
      lng REAL,
      photoPath TEXT,
      startedAt TEXT,
      startedBy TEXT,
      startedMode TEXT,
      startRosterHash TEXT,
      durationSec INTEGER,
      pool TEXT NOT NULL DEFAULT '${DEFAULT_POOL}'
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_dueDate ON tasks(dueDate);
    CREATE INDEX IF NOT EXISTS idx_tasks_team_status ON tasks(team, status);

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      deletedAt TEXT,
      deletedBy TEXT
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      deletedAt TEXT,
      deletedBy TEXT
    );

    CREATE TABLE IF NOT EXISTS foremen (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      codeHash TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      createdBy TEXT NOT NULL,
      deletedAt TEXT,
      deletedBy TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_foremen_name ON foremen(name);

    CREATE TABLE IF NOT EXISTS day_attendance (
      date TEXT NOT NULL,
      employeeId TEXT NOT NULL,
      present INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL,
      updatedBy TEXT NOT NULL,
      PRIMARY KEY(date, employeeId),
      FOREIGN KEY(employeeId) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS team_members (
      date TEXT NOT NULL,
      team TEXT NOT NULL,
      employeeId TEXT NOT NULL,
      PRIMARY KEY(date, team, employeeId),
      FOREIGN KEY(employeeId) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS team_vehicles (
      date TEXT NOT NULL,
      team TEXT NOT NULL,
      vehicleId TEXT NOT NULL,
      driverName TEXT,
      driverSetAt TEXT,
      driverSetBy TEXT,
      PRIMARY KEY(date, team, vehicleId),
      FOREIGN KEY(vehicleId) REFERENCES vehicles(id)
    );

    CREATE TABLE IF NOT EXISTS vehicle_driver_log (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      team TEXT NOT NULL,
      vehicleId TEXT NOT NULL,
      vehicleName TEXT NOT NULL,
      driverName TEXT,
      action TEXT NOT NULL,
      at TEXT NOT NULL,
      byUser TEXT,
      FOREIGN KEY(vehicleId) REFERENCES vehicles(id)
    );
    CREATE INDEX IF NOT EXISTS idx_vehicle_driver_log_date ON vehicle_driver_log(date);
    CREATE INDEX IF NOT EXISTS idx_vehicle_driver_log_team ON vehicle_driver_log(team, at DESC);

    CREATE TABLE IF NOT EXISTS teams (
      code TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      deletedAt TEXT,
      deletedBy TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_teams_sort ON teams(sortOrder);
    CREATE INDEX IF NOT EXISTS idx_team_members_date_team ON team_members(date, team);
    CREATE INDEX IF NOT EXISTS idx_team_vehicles_date_team ON team_vehicles(date, team);
    CREATE INDEX IF NOT EXISTS idx_attendance_date ON day_attendance(date);

    CREATE TABLE IF NOT EXISTS team_action_history (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      teamCode TEXT NOT NULL,
      teamLabel TEXT,
      sortOrder INTEGER,
      createdAt TEXT NOT NULL,
      createdBy TEXT NOT NULL,
      undoneAt TEXT,
      undoneBy TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_team_action_history_createdAt ON team_action_history(createdAt DESC);

    CREATE TABLE IF NOT EXISTS undo_actions (
      id TEXT PRIMARY KEY,
      actionType TEXT NOT NULL,
      entityType TEXT NOT NULL,
      entityId TEXT,
      payloadJson TEXT,
      createdAt TEXT NOT NULL,
      createdBy TEXT NOT NULL,
      undoneAt TEXT,
      undoneBy TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_undo_actions_createdAt ON undo_actions(createdAt DESC);

    CREATE TABLE IF NOT EXISTS task_library (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      street TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      pool TEXT NOT NULL DEFAULT '${DEFAULT_POOL}',
      active INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      createdBy TEXT NOT NULL,
      deletedAt TEXT,
      deletedBy TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_library_active ON task_library(active);
    CREATE INDEX IF NOT EXISTS idx_task_library_street ON task_library(street);

    CREATE TABLE IF NOT EXISTS team_bonus (
      date TEXT NOT NULL,
      team TEXT NOT NULL,
      greenPassAvailable INTEGER NOT NULL DEFAULT 0,
      grantedAt TEXT,
      grantedTaskId TEXT,
      rosterHash TEXT,
      usedAt TEXT,
      PRIMARY KEY(date, team)
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      at TEXT NOT NULL,
      by TEXT NOT NULL,
      type TEXT NOT NULL,
      fromJson TEXT,
      toJson TEXT,
      note TEXT,
      FOREIGN KEY(taskId) REFERENCES tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_taskId ON task_events(taskId);

    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      employeeId TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      createdBy TEXT NOT NULL,
      FOREIGN KEY(employeeId) REFERENCES employees(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pairing_codes_expiresAt ON pairing_codes(expiresAt);

    CREATE TABLE IF NOT EXISTS device_links (
      deviceId TEXT PRIMARY KEY,
      employeeId TEXT NOT NULL,
      linkedAt TEXT NOT NULL,
      linkedBy TEXT,
      lastSeenAt TEXT,
      userAgent TEXT,
      FOREIGN KEY(employeeId) REFERENCES employees(id)
    );
    CREATE INDEX IF NOT EXISTS idx_device_links_employeeId ON device_links(employeeId);

    CREATE TABLE IF NOT EXISTS device_pool_access (
      deviceId TEXT NOT NULL,
      poolCode TEXT NOT NULL,
      PRIMARY KEY(deviceId, poolCode),
      FOREIGN KEY(deviceId) REFERENCES device_links(deviceId)
    );
    CREATE INDEX IF NOT EXISTS idx_device_pool_access_device ON device_pool_access(deviceId);
  `);

  migrateSchema(db);

  try {
    const tr = db.prepare("SELECT COUNT(*) AS c FROM teams").get();
    if (tr && tr.c === 0) {
      const insT = db.prepare("INSERT INTO teams (code, label, sortOrder) VALUES (?, ?, ?)");
      const defaults = [
        ["GROEN1", "Ploeg 1", 1],
        ["GROEN2", "Ploeg 2", 2],
        ["GROEN3", "Ploeg 3", 3],
        ["GROEN4", "Ploeg 4", 4]
      ];
      for (const d of defaults) insT.run(d[0], d[1], d[2]);
      console.log("[DB] Seeded teams:", defaults.length);
    }
  } catch {}

  const row = db.prepare("SELECT COUNT(*) AS c FROM employees").get();
  if (row && row.c === 0) {
    const ins = db.prepare("INSERT INTO employees (id, name) VALUES (?, ?)");
    const names = ["Danny", "Wim", "Dennis", "Kenneth", "Pieter-Jan", "Sofie", "Mast", "Kevin", "Johan", "Ilian", "Bert"];
    for (const n of names) ins.run(n, n);
    console.log("[DB] Seeded employees:", names.length);
  }
}

module.exports = { initDb, getDb };
