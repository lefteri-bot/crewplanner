const { nanoid, nowIso } = require('./helpers');

function recordUndoAction(db, actionType, entityType, entityId, payload, by) {
  db.prepare(`
    INSERT INTO undo_actions (id, actionType, entityType, entityId, payloadJson, createdAt, createdBy, undoneAt, undoneBy)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    nanoid(),
    actionType,
    entityType,
    entityId || null,
    payload ? JSON.stringify(payload) : null,
    nowIso(),
    by || 'system'
  );
}

function getLatestUndoAction(db) {
  return db.prepare(`
    SELECT *
    FROM undo_actions
    WHERE undoneAt IS NULL
      AND actionType IN ('TEAM_ADD','TEAM_DELETE','LIBRARY_DELETE','TASK_DELETE','EMPLOYEE_DELETE','VEHICLE_DELETE')
    ORDER BY createdAt DESC
    LIMIT 1
  `).get();
}

function markUndoActionDone(db, id, by) {
  db.prepare('UPDATE undo_actions SET undoneAt = ?, undoneBy = ? WHERE id = ?')
    .run(nowIso(), by || 'system', id);
}

module.exports = { recordUndoAction, getLatestUndoAction, markUndoActionDone };
