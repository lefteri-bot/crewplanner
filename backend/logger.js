const fs = require("fs");
const path = require("path");
const { todayDate, nowIso } = require("./helpers");

const dataDir = path.join(__dirname, "data");
try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true }); } catch {}

function logFileFor(date){
  const d = (date || todayDate()).toString();
  return path.join(dataDir, `activity-${d}.jsonl`);
}

function appendEvent(evt){
  try{
    const e = Object.assign({ at: nowIso() }, evt || {});
    const file = logFileFor(e.date);
    fs.appendFileSync(file, JSON.stringify(e) + "\n", "utf-8");
  }catch{}
}

module.exports = { appendEvent, logFileFor };
