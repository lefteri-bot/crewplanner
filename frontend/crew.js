// Minimal crew UI: one-time phone pairing + clean team chooser

const $ = (id) => document.getElementById(id);

const FALLBACK_TEAM_CODES = ["GROEN1","GROEN2","GROEN3","GROEN4"];

function teamLabel(t){
  // User-facing label
  const n = (t || "").toString().toUpperCase().replace("GROEN", "");
  return `Ploeg ${n || "—"}`;
}

function today(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function deviceId(){
  let id = localStorage.getItem("sc_deviceId");
  if (id) return id;
  id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `dev_${Math.random().toString(16).slice(2)}${Date.now()}`;
  localStorage.setItem("sc_deviceId", id);
  return id;
}

try { localStorage.removeItem("sc_teamLocked"); } catch(e) {}

const state = {
  deviceId: deviceId(),
  employee: null,
  team: localStorage.getItem("sc_crewTeam") || "GROEN1",
  teamLocked: false,
  teamEditUntil: 0,
  dueDate: today(),
  tasks: [],
  teams: {},
  teamVehicles: {},
  vehicles: [],
  activeTaskId: null,
  noteDraft: "",
  notesTaskId: null,
  notes: []
};

// --- Startup splash helpers ---
let __splashHidden = false;
function hideSplash(){
  if (__splashHidden) return;
  __splashHidden = true;
  try {
    const s = document.getElementById("splash");
    if (!s) return;
    s.classList.add("hide");
    setTimeout(() => { try { s.remove(); } catch {} }, 320);
  } catch {}
}



function setTeamLock(locked){
  state.teamLocked = !!locked;
  try { localStorage.setItem("sc_teamLocked", state.teamLocked ? "1" : "0"); } catch {}
  updateLockUI();
  renderTeams();
}

function updateLockUI(){
  const btn = $("teamLockBtn");
  if (btn) { btn.style.display = "none"; }
  if (!btn) return;
  if (!state.employee) { btn.style.display = "none"; return; }
  btn.style.display = "flex";
  btn.textContent = state.teamLocked ? "🔒" : "🔓";
  btn.title = state.teamLocked ? "Ploeg vergrendeld (tik om te ontgrendelen)" : "Ploeg niet vergrendeld (tik om te vergrendelen)";
  btn.onclick = () => {
    if (state.teamLocked) {
      if (confirm("Ontgrendelen om ploeg te wijzigen?")) setTeamLock(false);
    } else {
      setTeamLock(false);
    }
  };
}

function teamCodes(){
  return (state.teamCodes && state.teamCodes.length) ? state.teamCodes : FALLBACK_TEAM_CODES;
}

function headers(){
  // Crew app never sends admin headers
  return {
    "Content-Type": "application/json",
    "x-role": "crew",
    // Use the employee *id* (not the display name) so permissions work for
    // employees created via admin UI (their id may be a generated token).
    "x-user-id": state.employee ? (state.employee.id || state.employee.name) : state.deviceId,
    "x-user-name": state.employee ? (state.employee.name || "") : ""
  };
}

async function api(path, opts = {}){
  const res = await fetch(path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}


async function apiAsForeman(path, opts = {}){
  const key = (state.foremanKey || "").trim();
  const res = await fetch(path, {
    ...opts,
    headers: {
      ...headers(),
      "x-role": "foreman",
      "x-foreman-key": key,
      ...(opts.headers || {})
    }
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function validateForeman(){
  if (!state.foremanKey) { state.foreman = null; state.foremanError=""; renderForemanUI(); return; }
  try{
    const me = await apiAsForeman("/api/foremen/me", { method:"GET" });
    if (me && me.role === "foreman"){
      state.foreman = me;
      state.foremanError = "";
    } else {
      state.foreman = null;
      state.foremanError = "Code ongeldig.";
    }
  }catch(e){
    state.foreman = null;
    state.foremanError = "Server error bij code.";
  }
  renderForemanUI();
}

function renderForemanUI(){
  const st = $("foremanStatus");
  const nt = $("foremanNewTask");
  const code = $("foremanCode");
  if (!st || !nt || !code) return;

  if (state.foreman){
    st.textContent = `Actief als ploegbaas: ${state.foreman.name}`;
    nt.style.display = "block";
    code.value = "";
  } else {
    st.textContent = state.foremanError ? `Niet actief. ${state.foremanError}` : "Niet actief.";
    nt.style.display = "none";
  }
}

async function activateForeman(){
  const inp = $("foremanCode");
  if (!inp) return;
  const key = (inp.value || "").trim();
  if (!key) return;
  state.foremanKey = key;
  state.foremanError = "Bezig…";
  renderForemanUI();
  try { localStorage.setItem("sc_foremanKey", key); } catch {}
  await validateForeman();
}

async function addForemanTask(){
  if (!state.foreman) return alert("Activeer eerst je ploegbaas code.");
  const streetEl = $("fmStreet");
  const descEl = $("fmDesc");
  const prioEl = $("fmPrio");
  const impEl = $("fmImposeTeam");
  const street = streetEl ? streetEl.value.trim() : "";
  const description = descEl ? descEl.value.trim() : "";
  const priority = prioEl ? prioEl.value : "GREEN";
  const imposeTeam = impEl ? impEl.value : "";
  if (!street) return alert("Straat invullen.");
  try{
    await apiAsForeman("/api/tasks", {
      method:"POST",
      body: JSON.stringify({ street, description, priority, dueDate: state.dueDate, imposeTeam: imposeTeam || null })
    });
    if (streetEl) streetEl.value = "";
    if (descEl) descEl.value = "";
    await loadTasks();
    await loadActiveTasks();
    alert(imposeTeam ? "Taak opgelegd." : "Taak toegevoegd.");
  }catch(e){
    alert(`Nieuwe taak: ${e.message}`);
  }
}


function renderTeamHint(){
  const btn = $("teamSwitchBtn");
  const hint = $("teamHint");
  if (!btn || !hint) return;
  const canSwitch = Date.now() < (state.teamEditUntil || 0);
  if (canSwitch){
    btn.textContent = "✅ Kies ploeg (15s)";
    hint.textContent = "Je kan nu 15 seconden van ploeg wisselen.";
  } else {
    btn.textContent = "🔒 Wijzig ploeg";
    hint.textContent = "Ploeg is vergrendeld om vergissingen te voorkomen.";
  }
}
function escHtml(s){
  return String(s||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function showTeamInfo(code){
  const box = $("teamInfo");
  if (!box) return;

  const members = membersForTeam(code);
  const vehiclesAssigned = vehiclesForTeam(code);
  const vehicleNames = Array.isArray(vehiclesAssigned)
    ? vehiclesAssigned.map(v => {
        const nm = v && v.name ? v.name : '';
        const drv = v && v.driverName ? ` (${v.driverName})` : '';
        return `${nm}${drv}`.trim();
      }).filter(Boolean)
    : [];
  const active = activeForTeam(code);
  const isOwnTeam = code === state.team;

  const options = (state.vehicles || []).map(v => {
    const usedBy = Object.entries(state.teamVehicles || {}).find(([team, arr]) =>
      Array.isArray(arr) && arr.some(x => String(x.id) === String(v.id))
    );
    const blockedBy = usedBy && usedBy[0] !== code ? usedBy[0] : '';
    return `<option value="${escHtml(v.id)}" ${blockedBy ? 'disabled' : ''}>${escHtml(v.name)}${blockedBy ? ' — bezet door ' + escHtml(teamLabel(blockedBy)) : ''}</option>`;
  }).join('');

  const driverOptions = members.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
  const assigned = Array.isArray(vehiclesAssigned) && vehiclesAssigned.length ? vehiclesAssigned[0] : null;

  box.innerHTML = `
    <div style="font-weight:900; margin-bottom:6px">${escHtml(teamLabel(code))}</div>
    <div class="mini" style="margin-bottom:4px">📋 <b>Actieve taak:</b> ${active ? `${escHtml(active.street)}${active.description ? ' — ' + escHtml(active.description) : ''}` : 'geen actieve opdracht'}</div>
    <div class="mini" style="margin-bottom:4px">👥 <b>Ploegleden:</b> ${members.length ? escHtml(members.join(', ')) : '—'}</div>
    <div class="mini" style="margin-bottom:8px">🚗 <b>Voertuig:</b> ${vehicleNames.length ? escHtml(vehicleNames.join(', ')) : '—'}</div>
    ${isOwnTeam ? `
      <div style="display:grid; gap:8px; margin-top:8px;">
        <select id="teamVehicleSelect">
          <option value="">Voertuig kiezen (optioneel)</option>
          ${options}
        </select>
        <select id="teamDriverSelect">
          <option value="">Chauffeur kiezen (optioneel)</option>
          ${driverOptions}
        </select>
        <button id="saveTeamVehicleBtn" class="tinybtn">Opslaan voertuig</button>
      </div>
      <div class="mini" id="teamVehicleHint" style="margin-top:6px"></div>
    ` : ''}
  `;

  if (isOwnTeam) {
    const vSel = $("teamVehicleSelect");
    const dSel = $("teamDriverSelect");
    const hint = $("teamVehicleHint");
    if (vSel && assigned && assigned.id) vSel.value = String(assigned.id);
    if (dSel && assigned && assigned.driverName) dSel.value = String(assigned.driverName);
    const saveBtn = $("saveTeamVehicleBtn");
    if (saveBtn) saveBtn.onclick = async () => {
      try {
        const assignments = vSel && vSel.value ? [{ vehicleId: vSel.value, driverName: dSel && dSel.value ? dSel.value : '' }] : [];
        await api('/api/planning/team-vehicles', {
          method: 'POST',
          body: JSON.stringify({ date: state.dueDate, team: code, assignments })
        });
        if (hint) hint.textContent = 'Opgeslagen ✅';
        await loadTasks();
      } catch (e) {
        if (hint) hint.textContent = e.message || 'Opslaan mislukt';
        alert(`Voertuig/chauffeur: ${e.message}`);
      }
    };
  }
}

async function loadActiveTasks(){
  if (!state.dueDate) return;
  try{
    const r = await api(`/api/tasks?date=${encodeURIComponent(state.dueDate)}&status=active`);
    const rows = (r && r.rows) ? r.rows : [];
    const map = {};
    for (const t of rows){
      if (!t.team) continue;
      if (!map[t.team]) map[t.team] = [];
      map[t.team].push(t);
    }
    for (const k of Object.keys(map)){
      map[k].sort((a,b)=> String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")));
    }
    state.activeTasksByTeam = map;
  }catch(e){
    state.activeTasksByTeam = {};
  }
}

function setSub(){
  const el = $("crewSub");
  if (!el) return;
  const name = state.employee ? state.employee.name : "nog niet gekoppeld";
  el.textContent = `Toestel: gekoppeld aan ${name}`;
}

async function checkMe(){
  const me = await api(`/api/pairing/me?deviceId=${encodeURIComponent(state.deviceId)}`);
  if (me && me.linked) state.employee = me.employee;
  else state.employee = null;
  setSub();
}

async function pairNow(){
  const code = ($("pairCode").value || "").trim();
  if (!code) return;
  $("pairHint").textContent = "Koppelen...";
  try {
    const r = await api("/api/pairing/link", {
      method: "POST",
      body: JSON.stringify({ code, deviceId: state.deviceId })
    });
    state.employee = r.employee;
    $("pairCode").value = "";
    $("pairHint").textContent = "Gekoppeld ✅";
    showMain();
  } catch (e) {
    $("pairHint").textContent = "Code fout of verlopen. Vraag een nieuwe code.";
  }
}

function renderTeams(){
  const grid = $("teamGrid");
  grid.innerHTML = "";
  if (state.team) showTeamInfo(state.team);
  for (const code of teamCodes()) {
    const b = document.createElement("button");
    b.className = "teamBtn" + (state.team === code ? " selected" : "");
    b.textContent = teamLabel(code);
    b.disabled = false;
    b.onclick = async () => {
      const canSwitch = (!state.team) || (Date.now() < (state.teamEditUntil || 0));
      if (!canSwitch) {
        // Locked: show what this team is doing instead of switching
        showTeamInfo(code);
        return;
      }
      const prev = state.team;
      state.team = code;
      try { localStorage.setItem("sc_crewTeam", code); } catch {}
      renderTeams();
      try {
        await joinTeam();
        await loadTasks();
        await loadActiveTasks();
      } catch (e) {
        state.team = prev;
        try { localStorage.setItem("sc_crewTeam", prev); } catch {}
        renderTeams();
        throw e;
      } finally {
        // after switch, lock again
        if (state.team) state.teamEditUntil = 0;
        renderTeamHint();
      }
    };
    grid.appendChild(b);
  }
}

async function joinTeam(){
  try {
    await api("/api/planning/join-team", {
      method: "POST",
      body: JSON.stringify({ date: state.dueDate, team: state.team })
    });
  } catch (e) {
    if (e.data && e.data.error === "team_full") {
      alert("Deze ploeg is al vol (max 4). Kies een andere ploeg.");
    }
    throw e;
  }
}

function statusLabel(s){
  if (s === "FREE") return "VRIJ";
  if (s === "CLAIMED") return "IN UITVOERING";
  if (s === "IMPOSED") return "OPGELEGD";
  if (s === "DONE") return "KLAAR";
  return s || "—";
}

function prioNl(p){
  const x = (p || "").toString().toUpperCase();
  if (x === "RED") return "Rood";
  if (x === "YELLOW") return "Geel";
  if (x === "GREEN") return "Groen";
  if (x === "WHITE") return "Wit";
  return x || "—";
}

function prioRank(p){
  p = (p || "GREEN").toString().toUpperCase();
  if (p === "RED") return 1;
  if (p === "YELLOW") return 2;
  return 3;
}

function requiredPriorityForClaim(rows){
  const free = (rows || []).filter(t => t && t.status === "FREE");
  if (!free.length) return null;
  let best = free[0].priority;
  for (const t of free){
    if (prioRank(t.priority) < prioRank(best)) best = t.priority;
  }
  return best;
}

function prioClassForTask(t){
  if (!t) return "";
  if (t.status === "DONE") return "prio-white";
  const p = (t.priority || "GREEN").toString().toUpperCase();
  if (p === "RED") return "prio-red";
  if (p === "YELLOW") return "prio-yellow";
  return "prio-green";
}

function activeForMyTeam(){
  return state.tasks.find(t => t.team === state.team && (t.status === "CLAIMED" || t.status === "IMPOSED")) || null;
}

function activeForTeam(team){
  return state.tasks.find(t => t.team === team && (t.status === "CLAIMED" || t.status === "IMPOSED")) || null;
}

function membersForTeam(team){
  return (state.teams && state.teams[team]) ? state.teams[team] : [];
}

function vehiclesForTeam(team){
  return (state.teamVehicles && state.teamVehicles[team]) ? state.teamVehicles[team] : [];
}

function fmtTime(iso){
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}


function readFileAsDataUrl(file){
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("read_failed"));
    fr.readAsDataURL(file);
  });
}

function compressDataUrlToJpeg(dataUrl, maxW, quality){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / (img.width || maxW));
        const w = Math.max(1, Math.round((img.width || maxW) * scale));
        const h = Math.max(1, Math.round((img.height || maxW) * scale));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      } catch {
        reject(new Error("compress_failed"));
      }
    };
    img.onerror = () => reject(new Error("invalid_image"));
    img.src = dataUrl;
  });
}

async function uploadTaskPhoto(taskId, file){
  const original = await readFileAsDataUrl(file);
  const tries = [
    { w: 1024, q: 0.75 },
    { w: 800, q: 0.65 },
    { w: 640, q: 0.60 }
  ];
  let out = original;
  for (const t of tries) {
    try {
      out = await compressDataUrlToJpeg(original, t.w, t.q);
      if ((out || "").length < 900000) break;
    } catch {
      out = original;
      break;
    }
  }
  if ((out || "").length >= 1000000) {
    const err = new Error("photo_too_large");
    err.status = 413;
    throw err;
  }
  await api(`/api/tasks/${taskId}/photo`, {
    method: "POST",
    body: JSON.stringify({ dataUrl: out })
  });
}

function setActiveUI(active){
  const box = $("activeBox");
  if (!active) {
    box.innerHTML = "—";
    return;
  }

  if (state.activeTaskId !== active.id) {
    // New active task: reset draft + notes cache
    state.activeTaskId = active.id;
    state.noteDraft = "";
    state.notesTaskId = null;
    state.notes = [];
  }

  const members = membersForTeam(active.team);
  const memberLine = members && members.length ? members.join(", ") : "—";
  const veh = vehiclesForTeam(active.team);
  const vehLine = veh && veh.length ? veh.map(v => v.name).join(", ") : "—";
  box.innerHTML = `
    <div><strong>${active.street}</strong> <span style="opacity:.9">(${statusLabel(active.status)})</span></div>
    <div style="margin-top:6px;color:var(--muted)">${active.description || ""}</div>
    <div style="margin-top:6px;color:var(--muted)">Leden: ${memberLine}</div>
    <div style="margin-top:6px;color:var(--muted)">Voertuig: ${vehLine}</div>
    <div class="row" style="margin-top:10px">
      <button class="smallbtn" id="cDone">Klaar</button>
      <button class="smallbtn" id="cFree">Vrijgeven</button>
    </div>

    <div class="noteBox">
      <div class="noteMeta">Foto</div>
      <div class="mini" style="margin-bottom:8px">Neem een foto of kies uit je galerij, en verstuur ze naar de admin.</div>

      <input id="photoCam" type="file" accept="image/*" capture="environment" style="display:none" />
      <input id="photoGal" type="file" accept="image/*" style="display:none" />

      <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center">
        <button class="smallbtn" id="photoTake">Neem foto</button>
        <button class="smallbtn" id="photoPick">Galerij</button>
        <button class="smallbtn" id="photoSend">Versturen</button>
        <span class="mini" id="photoHint"></span>
      </div>

      <div id="photoPrev" style="margin-top:8px"></div>
    </div>

    <div class="noteBox">
      <div class="noteMeta">Opmerkingen (briefing)</div>
      <textarea id="noteTxt" placeholder="Schrijf hier je opmerkingen..."></textarea>
      <div class="row" style="margin-top:8px; justify-content:space-between">
        <button class="smallbtn" id="noteSend">Versturen</button>
        <span class="mini" id="noteHint"></span>
      </div>
      <div id="noteList" style="margin-top:8px; display:flex; flex-direction:column; gap:8px"></div>
    </div>
`;
  $("cDone").onclick = () => doneTask(active.id);
  $("cFree").onclick = () => unassignTask(active.id);

  const ta = $("noteTxt");
  if (ta) {
    ta.value = state.noteDraft || "";
    ta.oninput = () => { state.noteDraft = ta.value; };
  }
  const send = $("noteSend");
  if (send) send.onclick = () => sendNote(active.id);

  // Photo (crew can send a photo for the active task)
  const pPrev = $("photoPrev");
  if (pPrev) {
    if (active.photoPath) {
      pPrev.innerHTML = `<img src="${active.photoPath}" alt="Taak foto" style="width:100%; border-radius:14px; border:1px solid var(--line)" />`;
    } else {
      pPrev.innerHTML = `<div class="mini">Nog geen foto.</div>`;
    }
  }

  let pickedFile = null;
  const pCam = $("photoCam");
  const pGal = $("photoGal");
  const pTake = $("photoTake");
  const pPick = $("photoPick");
  const pSend = $("photoSend");
  const pHint = $("photoHint");

  const showPreview = (f) => {
    if (!pPrev) return;
    try {
      const url = URL.createObjectURL(f);
      pPrev.innerHTML = `<img src="${url}" alt="Voorbeeld" style="width:100%; border-radius:14px; border:1px solid var(--line)" />`;
    } catch {
      pPrev.innerHTML = `<div class="mini">Voorbeeld niet beschikbaar.</div>`;
    }
  };

  const onPicked = (input) => {
    const f = input && input.files ? input.files[0] : null;
    if (!f) return;
    pickedFile = f;
    showPreview(f);
    if (pHint) pHint.textContent = `${f.name || 'foto'} geselecteerd.`;
  };

  if (pCam) pCam.onchange = () => onPicked(pCam);
  if (pGal) pGal.onchange = () => onPicked(pGal);

  if (pTake) pTake.onclick = () => { try { if (pCam) pCam.click(); } catch {} };
  if (pPick) pPick.onclick = () => { try { if (pGal) pGal.click(); } catch {} };

  if (pSend) {
    pSend.onclick = async () => {
      const f = pickedFile;
      if (!f) { if (pHint) pHint.textContent = "Kies eerst een foto."; return; }

      const t = (f.type || '').toLowerCase();
      if (t.includes('heic') || t.includes('heif')) {
        if (pHint) pHint.textContent = "iPhone HEIC gedetecteerd. Zet Camera op 'Most Compatible (JPEG)' of kies een JPEG.";
        return;
      }

      if (pHint) pHint.textContent = "Versturen...";
      try {
        await uploadTaskPhoto(active.id, f);
        if (pHint) pHint.textContent = "Verstuurd ✅";
        // Clear selection so they don't double-send by accident
        pickedFile = null;
        if (pCam) pCam.value = '';
        if (pGal) pGal.value = '';
        await loadTasks();
  await loadActiveTasks();
      } catch (e) {
        const code = (e && e.data && e.data.error) ? e.data.error : '';
        if (e && e.status === 413) {
          if (pHint) pHint.textContent = "Foto te groot. Neem een kleinere foto.";
        } else if (code === 'not_in_team') {
          if (pHint) pHint.textContent = "Je zit vandaag niet in deze ploeg (check dagplanning).";
        } else if (code === 'not_paired') {
          if (pHint) pHint.textContent = "Niet gekoppeld. Koppel je gsm opnieuw via code.";
        } else if (code === 'invalid_image') {
          if (pHint) pHint.textContent = "Ongeldige foto. Probeer opnieuw (JPEG/PNG).";
        } else {
          if (pHint) pHint.textContent = "Versturen mislukt.";
        }
      }
    };
  }


  // Load notes for active task
  loadNotes(active.id).catch(() => {});
}

function renderNotes(){
  const list = $("noteList");
  const hint = $("noteHint");
  if (!list) return;

  const rows = Array.isArray(state.notes) ? state.notes : [];
  if (!rows.length) {
    list.innerHTML = `<div class="mini">Nog geen opmerkingen.</div>`;
    if (hint) hint.textContent = "";
    return;
  }

  list.innerHTML = "";
  for (const r of rows.slice(0, 8)) {
    const div = document.createElement("div");
    div.className = "noteItem";
    const by = (r.by || "").toString();
    const at = fmtTime(r.at);
    div.innerHTML = `
      <div class="mini" style="margin-bottom:4px">${at} • ${by}</div>
      <div style="white-space:pre-wrap">${(r.note || "").toString()}</div>
    `;
    list.appendChild(div);
  }
  if (hint) hint.textContent = "";
}

async function loadNotes(taskId){
  if (!taskId) return;
  state.notesTaskId = taskId;
  const r = await api(`/api/tasks/${taskId}/notes?limit=30`);
  state.notes = r.rows || [];
  renderNotes();
}

async function sendNote(taskId){
  const txt = (state.noteDraft || "").trim();
  const hint = $("noteHint");
  if (!txt) {
    if (hint) hint.textContent = "(leeg)";
    return;
  }
  if (hint) hint.textContent = "Versturen...";
  try {
    await api(`/api/tasks/${taskId}/notes`, {
      method: "POST",
      body: JSON.stringify({ note: txt })
    });
    state.noteDraft = "";
    const ta = $("noteTxt");
    if (ta) ta.value = "";
    if (hint) hint.textContent = "Verstuurd ✅";
    await loadNotes(taskId);
    // refresh tasks so lastNote is visible elsewhere
    await loadTasks();
  await loadActiveTasks();
  } catch (e) {
    if (hint) hint.textContent = "Niet gelukt.";
  }
}


function renderTasks(){
  const list = $("crewTasks");
  list.innerHTML = "";

  const active = activeForMyTeam();
  setActiveUI(active);
  const requiredPriority = state.requiredPriority || requiredPriorityForClaim(state.tasks);
  const allowPriorityPass = !!state.greenPass && !!requiredPriority;
  const hint = $("taskHint");
  if (hint) hint.textContent = allowPriorityPass ? "✅ Vrijkaart actief: deze ploeg mag nu 1 volgende taak vrij kiezen." : "";

  // Show: my active (if any) + free tasks
  const rows = state.tasks.filter(t => (t.status === "FREE") || (active && t.id === active.id));

  for (const t of rows) {
    const item = document.createElement("div");
    item.className = "item";
    const cls = prioClassForTask(t);
    if (cls) item.classList.add(cls);

    const main = document.createElement("div");
    main.className = "itemMain";

    const info = document.createElement("div");
    info.innerHTML = `
      <div class="street">${t.street}</div>
      <div class="desc">${t.description || ""}</div>
      <div class="badges">
        <span class="badge strong">${statusLabel(t.status)}</span>
        <span class="badge">${prioNl(t.priority)}</span>
        ${t.status === "FREE" && requiredPriority && t.priority !== requiredPriority && !allowPriorityPass ? `<span class="badge">Eerst ${prioNl(requiredPriority)}</span>` : ""}
      </div>
    `;
    main.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "actions";

    if (t.status === "FREE") {
      const btn = document.createElement("button");
      btn.className = "smallbtn";
      btn.textContent = "Neem";
      const okPrio = (!requiredPriority || t.priority === requiredPriority || allowPriorityPass);
      btn.disabled = !!active || !okPrio;
      btn.onclick = () => claimTask(t.id);
      actions.appendChild(btn);
    } else {
      const b1 = document.createElement("button");
      b1.className = "smallbtn";
      b1.textContent = "Klaar";
      b1.onclick = () => doneTask(t.id);
      actions.appendChild(b1);
    }

    item.appendChild(main);
    item.appendChild(actions);
    list.appendChild(item);
  }
}

async function loadActiveTasks(){
  if (!state.dueDate) return;
  try{
    const r = await api(`/api/tasks?date=${encodeURIComponent(state.dueDate)}&status=active`);
    const rows = (r && r.rows) ? r.rows : [];
    const map = {};
    for (const t of rows){
      if (!t.team) continue;
      if (!map[t.team]) map[t.team] = [];
      map[t.team].push(t);
    }
    // sort per team by updatedAt (latest first)
    for (const k of Object.keys(map)){
      map[k].sort((a,b)=> String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")));
    }
    state.activeTasksByTeam = map;
  }catch(e){
    state.activeTasksByTeam = {};
  }
}

async function loadTasks(){
  // Load planning (teams) + all open tasks for the day
  const [p, t] = await Promise.all([
    api(`/api/planning?date=${encodeURIComponent(state.dueDate)}`),
    api(`/api/tasks?date=${encodeURIComponent(state.dueDate)}&status=open&metaTeam=${encodeURIComponent(state.team)}`)
  ]);
  state.teamCodes = (p && Array.isArray(p.teamCodes)) ? p.teamCodes : null;
  // If current team disappeared (admin removed), fallback to the first available team
  const codes = teamCodes();
  if (!codes.includes(state.team)) {
    state.team = codes[0] || state.team;
    try { localStorage.setItem("sc_crewTeam", state.team); } catch {}
    renderTeams();
  }
  state.teams = (p && p.teams) ? p.teams : {};
  state.teamVehicles = (p && p.teamVehicles) ? p.teamVehicles : {};
  state.vehicles = (p && p.vehicles) ? p.vehicles : [];
  state.tasks = (t && t.rows) ? t.rows : [];
  state.requiredPriority = (t && t.requiredPriority) ? t.requiredPriority : null;
  state.greenPass = !!(t && t.greenPass);
  renderTasks();
  await loadActiveTasks();
  renderTeams();
}

async function claimTask(id){
  try {
    await api(`/api/tasks/${id}/claim`, {
      method: "POST",
      body: JSON.stringify({ team: state.team, dueDate: state.dueDate })
    });
    await loadTasks();
  await loadActiveTasks();
  } catch (e) {
    // Friendly message
    if (e.data && e.data.error === "team_already_has_active_task") {
      alert("Je ploeg heeft al een actieve taak.");
    } else if (e.data && e.data.error === "priority_blocked") {
      alert(`Volgorde: eerst ${prioNl(e.data.requiredPriority)} taken.`);
    } else {
      alert("Taak nemen lukt niet.");
    }
  }
}

async function unassignTask(id){
  try {
    await api(`/api/tasks/${id}/unassign`, { method: "POST" });
    await loadTasks();
  await loadActiveTasks();
  } catch {
    alert("Vrijgeven lukt niet.");
  }
}

async function doneTask(id){
  try {
    await api(`/api/tasks/${id}/done`, { method: "POST" });
    await loadTasks();
  await loadActiveTasks();
  } catch {
    alert("Klaar zetten lukt niet.");
  }
}

function showMain(){
  $("pairCard").style.display = state.employee ? "none" : "block";
  $("mainCard").style.display = state.employee ? "block" : "none";
  const unlinkBtn = $("crewUnlink");
  // Crew cannot unlink on the phone. Only admin can unlink devices.
  if (unlinkBtn) {
    unlinkBtn.style.display = "none";
    unlinkBtn.onclick = null;
  }

  if (state.employee) {
    $("meLine").textContent = `${state.employee.name} (gekoppeld)`;
    // If a team was already chosen earlier and there is no explicit lock setting yet,
    // default to locked to prevent accidental switches on the phone.
    if (localStorage.getItem("sc_teamLocked") == null) {
      setTeamLock(false);
    } else {
      updateLockUI();
    }
    renderTeams();
    joinTeam().then(() => loadTasks()).catch(() => loadTasks()).finally(() => hideSplash());
  }
}

async function boot(){

// Team switch lock: must unlock first to change teams (prevents accidental switches)
const sw = $("teamSwitchBtn");
if (sw){
  sw.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = Date.now() < (state.teamEditUntil || 0);
    if (open){
      state.teamEditUntil = 0;
    } else {
      state.teamEditUntil = Date.now() + 15000;
      setTimeout(() => {
        if (Date.now() >= (state.teamEditUntil || 0)) {
          state.teamEditUntil = 0;
          renderTeamHint();
        }
      }, 16000);
    }
    renderTeamHint();
  };
}
renderTeamHint();

  $("pairBtn").onclick = pairNow;
  $("pairCode").addEventListener("keydown", (e) => { if (e.key === "Enter") pairNow(); });

  // PC-only admin shortcut (no visible button): Ctrl+Alt+A
  // This does NOT grant admin rights; it only opens the admin UI.
  document.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    if (e.ctrlKey && e.altKey && k === "a") {
      e.preventDefault();
      // Open a dedicated admin shortcut page that forces the admin UI for this browser.
      window.location.href = "/admin";
    }
  });

  await checkMe();
  showMain();
// Foreman UI (ploegbaas)
const ft = $("foremanToggle");
const fw = $("foremanWrap");
if (ft && fw){
  ft.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    fw.style.display = (fw.style.display === "none" || !fw.style.display) ? "block" : "none";
  };
}
const fsBtn = $("foremanSave");
if (fsBtn) fsBtn.onclick = () => activateForeman();
const faBtn = $("fmAdd");
if (faBtn) faBtn.onclick = () => addForemanTask();
await validateForeman();
  // Hide startup splash
  setTimeout(() => hideSplash(), 900);


  // Keep tasks fresh (lightweight)
  setInterval(() => {
    if (state.employee) loadTasks().catch(() => {});
  }, 15000);
}

boot();function __legacyShowTeamInfo_unused(code){
  const box = $("teamInfo");
  if (!box) return;
  const arr = (state.activeTasksByTeam && state.activeTasksByTeam[code]) ? state.activeTasksByTeam[code] : [];
  if (!arr.length){
    box.textContent = `${code}: geen actieve opdracht.`;
    return;
  }
  const t = arr[0];
  const pr = (t.priority || "").toUpperCase();
  box.textContent = `${code}: bezig met ${t.street}${t.description ? " — " + t.description : ""} (${pr}).`;
}


