const { nanoid } = require("nanoid");

function nowIso() {
  return new Date().toISOString();
}

function todayDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function requireAdmin(req, res) {
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "admin_required" });
    return false;
  }
  return true;
}

function requireAdminOrForeman(req, res) {
  if (req.user.role !== "admin" && req.user.role !== "foreman") {
    res.status(403).json({ error: "admin_or_foreman_only" });
    return false;
  }
  return true;
}



function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = { nanoid, nowIso, todayDate, requireAdmin, requireAdminOrForeman, pick };
