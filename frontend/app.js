
function prioNl(p){
  const x = (p || "").toString().toUpperCase();
  if (x === "RED") return "Rood";
  if (x === "YELLOW") return "Geel";
  if (x === "GREEN") return "Groen";
  if (x === "WHITE") return "Wit";
  return x || "—";
}

function fmtDateTime(iso){
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso || '');
    return d.toLocaleString("nl-BE", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
  } catch {
    return String(iso || '');
  }
}


const $ = (id) => document.getElementById(id);

const state = {
  dueDate: "",
  status: "open",
  role: "crew",
  team: "GROEN1",
  userId: "lefteri",
  adminKey: "",
  tasks: [],
  selectedId: null,
  planning: { employees: [], vehicles: [], attendance: {}, teams: {}, teamVehicles: {} },
  foremenAll: { foremen: [] },
  historyDay: null,

  marker: null,
  teamMarkers: {}, // { GROEN1: layer, ... }

  boundaryLayer: null,
  maskLayer: null
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


// --- Phone pairing (crew login by one-time code) ---
async function createPairCode(employeeId, employeeName){
  try {
    const r = await api("/api/pairing/code", {
      method: "POST",
      body: JSON.stringify({ employeeId })
    });
    const code = r.code;
    const exp = r.expiresAt ? new Date(r.expiresAt).toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" }) : "";
    // Simple + robust: alert so admin can read it out loud
    alert(`Koppelcode voor ${employeeName || (r.employee && r.employee.name) || "werknemer"}:\n\n${code}\n\nGeldig tot ${exp}.\nCrew gaat naar: /crew en tikt deze code 1x in.`);
  } catch (e) {
    alert(`Koppelcode lukt niet: ${e.message}`);
  }
}

async function loadDeviceLinks(){
  const card = $("deviceLinksCard");
  if (card) {
    if (state.role === "admin") card.classList.remove("hidden"); else card.classList.add("hidden");
  }

  const list = $("deviceLinksList");
  const btn = $("reloadLinks");
  if (btn) btn.onclick = () => loadDeviceLinks();
  if (!list) return;

  // Only works with a valid admin PIN/ADMIN_KEY
  if (state._serverRole !== "admin") {
    list.innerHTML = `<div class="hint">Alleen admin.</div>`;
    return;
  }

  list.innerHTML = `<div class="hint">Laden…</div>`;
  try {
    const r = await api('/api/pairing/links');
    const rows = (r && r.rows) ? r.rows : [];
    if (!rows.length) {
      list.innerHTML = `<div class="hint">Geen gekoppelde gsm's.</div>`;
      return;
    }
    rows.sort((a,b) => (b.lastSeenAt||'').localeCompare(a.lastSeenAt||''));
    list.innerHTML = '';
    for (const it of rows) {
      const wrap = document.createElement('div');
      wrap.className = 'vehicleItem';
      const who = (it.employeeName || it.employeeId || '—').toString();
      const empId = (it.employeeId || '').toString();
      const dev = (it.deviceId || '').toString();
      const seen = it.lastSeenAt ? fmtTime(it.lastSeenAt) : '';
      const ua = (it.userAgent || '').toString().slice(0, 80);

      // Make device id readable for humans (admins don't need the full id to choose).
      const devShort = dev ? (dev.length > 10 ? `${dev.slice(0, 4)}…${dev.slice(-4)}` : dev) : '—';

      const left = document.createElement('div');
      left.innerHTML = `
        <strong>${who}</strong>
        <div class='mut'>Toestel: ${devShort}${seen ? ` • ${seen}` : ''}</div>
        ${empId && it.employeeName ? `<div class='mut'>ID: ${empId}</div>` : ''}
        ${ua ? `<div class='mut'>${ua}</div>` : ''}
      `;

      const right = document.createElement('div');
      right.className = 'row';
      right.style.gap = '8px';

      const ubtn = document.createElement('button');
      ubtn.className = 'smallbtn';
      ubtn.textContent = 'Ontkoppel';
      ubtn.onclick = () => unlinkDevice(dev, who);

      right.appendChild(ubtn);
      wrap.appendChild(left);
      wrap.appendChild(right);
      list.appendChild(wrap);
    }
  } catch (e) {
    list.innerHTML = `<div class="hint">Links laden lukt niet.</div>`;
  }
}

async function unlinkDevice(deviceId, label){
  if (!deviceId) return;
  if (!confirm(`Ontkoppelen: ${label}?`)) return;
  try {
    await api('/api/pairing/unlink', { method: 'POST', body: JSON.stringify({ deviceId }) });
    await loadDeviceLinks();
  } catch (e) {
    alert(`Ontkoppelen lukt niet: ${e.message}`);
  }
}

function headers() {
  return {
    "Content-Type": "application/json",
    "x-role": state.role,
    "x-user-id": state.userId,
    "x-admin-key": state.adminKey
  };
}

function prioColor(p) {
  if (p === "RED") return "var(--danger)";
  if (p === "YELLOW") return "var(--warn)";
  return "var(--ok)";
}

function statusLabel(s) {
  if (s === "FREE") return "VRIJ";
  if (s === "CLAIMED") return "IN UITVOERING";
  if (s === "IMPOSED") return "OPGELEGD";
  if (s === "DONE") return "KLAAR";
  return s;
}

function teamLabel(t) {
  if (!t) return "—";
  const code = (t || "").toString().toUpperCase();
  // Prefer server-provided labels (admin can add teams)
  const meta = state.planning && Array.isArray(state.planning.teamsMeta)
    ? state.planning.teamsMeta.find(x => (x.code || "").toString().toUpperCase() === code)
    : null;
  if (meta && meta.label) return meta.label;

  const n = code.replace("GROEN", "").trim();
  return `Ploeg ${n || "—"}`;
}


function teamColor(team) {
  // Consistent palette (MVP)
  switch (team) {
    case "GROEN1": return "#3ee28a";
    case "GROEN2": return "#1ea8ff";
    case "GROEN3": return "#ffd24d";
    case "GROEN4": return "#ff4d4d";
    default: return "#c7d2f0";
  }
}

function teamCodesList(){
  const codes = state.planning && Array.isArray(state.planning.teamCodes) ? state.planning.teamCodes : null;
  return (codes && codes.length) ? codes : ["GROEN1","GROEN2","GROEN3","GROEN4"];
}

function teamOptionsHTML(selected = ""){
  const pick = (selected || "").toString().toUpperCase();
  return teamCodesList().map((c) => {
    const sel = c === pick ? ' selected' : '';
    return `<option value="${c}"${sel}>${teamLabel(c)}</option>`;
  }).join("");
}

function rebuildTeamSelect(){
  const sel = $("team");
  if (!sel) return;
  const codes = teamCodesList();
  const prev = (sel.value || state.team || "").toString().toUpperCase();
  sel.innerHTML = teamOptionsHTML(prev);
  const pick = codes.includes(prev) ? prev : (codes[0] || prev || "");
  if (pick) sel.value = pick;
  state.team = sel.value || state.team;
}

async function api(path, opts = {}) {
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

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtTime(iso){
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}


function prioRank(p){
  p = (p || "GREEN").toString().toUpperCase();
  if (p === "RED") return 1;
  if (p === "YELLOW") return 2;
  return 3;
}

function requiredPriorityForClaim(){
  const free = (state.tasks || []).filter(t => t && t.status === "FREE");
  if (!free.length) return null;
  let best = free[0].priority;
  for (const t of free) {
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

function renderActiveTasks(activeByTeam){
  const el = $("activeTask");
  if (!el) return;

  const teams = teamCodesList();
  const rows = [];

  for (const tm of teams){
    const t = activeByTeam[tm] || null;
    const members = (teamMembers(tm) || []).join(", ");
    const memTxt = members ? ` <span class="mut">(${members})</span>` : ` <span class="mut">(—)</span>`;
    const veh = teamVehicles(tm);
    const vTxt = veh.length ? veh.map(v => v.name).join(", ") : "—";
    const pr = t ? prioNl(t.priority) : "—";
    const st = t ? statusLabel(t.status) : "—";
    const street = t ? t.street : "Geen actieve taak";

    const canAct = (state.role === "admin" || tm === state.team);
    const actions = [];

    if (t) {
      const btnMap = `<button class="smallbtn" data-act="map" data-id="${t.id}">Toon op kaart</button>`;
      actions.push(btnMap);

      if (canAct) {
        // Done is always allowed for own team; unassign only if CLAIMED (or admin)
        actions.push(`<button class="smallbtn" data-act="done" data-id="${t.id}">Klaar</button>`);
        if (t.status === "CLAIMED" || state.role === "admin") {
          actions.push(`<button class="smallbtn" data-act="free" data-id="${t.id}">Vrijgeven</button>`);
        }
      }
    }

    const itemCls = t ? `item ${prioClassForTask(t)}` : "item";
    rows.push(`
      <div class="${itemCls}" style="padding:10px">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <div>
            <div style="font-weight:900">${teamLabel(tm)}${memTxt}</div>
            <div class="street" style="font-size:13px;margin-top:3px">${street}</div>
            <div class="mut" style="margin-top:4px">Voertuig: ${vTxt}</div>
            <div class="badges" style="margin-top:6px">
              <span class="badge">${st}</span>
              <span class="badge">${pr}</span>
            </div>
          </div>
          <div class="actions" style="flex-wrap:wrap;justify-content:flex-end">
            ${actions.join("")}
          </div>
        </div>
      </div>
    `);
  }

  el.innerHTML = `<div class="list" style="margin-top:8px">${rows.join("")}</div>`;

  // Bind actions
  for (const btn of el.querySelectorAll("button[data-act]")){
    const act = btn.getAttribute("data-act");
    const id = btn.getAttribute("data-id");
    btn.onclick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (act === "done") return doneTask(id);
      if (act === "free") return unassignTask(id);
      if (act === "map") {
        const task = state.tasks.find(x => x.id === id);
        if (task) return focusOnMap(task);
      }
    };
  }
}

function renderList(activeForTeam) {
  const list = $("list");
  list.innerHTML = "";

  const hasActive = !!activeForTeam;
  const requiredPriority = (state.role === "crew") ? requiredPriorityForClaim() : null;

  for (const t of state.tasks) {
    const item = document.createElement("div");
    item.className = "item";
    const cls = prioClassForTask(t);
    if (cls) item.classList.add(cls);

    const bullet = document.createElement("div");
    bullet.className = "bullet";
    bullet.style.background = (t.status === "DONE") ? "var(--white)" : prioColor(t.priority);

    const main = document.createElement("div");
    main.className = "itemMain";

    const info = document.createElement("div");
    info.innerHTML = `
      <div class="street">${t.street}</div>
      <div class="desc">${t.description || ""}</div>
      <div class="badges">
        <span class="badge strong">${statusLabel(t.status)}</span>
        <span class="badge">${teamLabel(t.team)}</span>
        <span class="badge">${prioNl(t.priority)}</span>
      </div>
    `;

    main.appendChild(bullet);
    main.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "actions";

    const btnOpen = document.createElement("button");
    btnOpen.className = "smallbtn";
    btnOpen.textContent = "Detail";
    // Detail should not automatically move the map (use "Toon op kaart" or legend)
    btnOpen.onclick = () => selectTask(t.id, false);

    actions.appendChild(btnOpen);

    // Crew: claim only if FREE and no active task for this team
    if (state.role === "crew") {
      const btnClaim = document.createElement("button");
      btnClaim.className = "smallbtn";
      btnClaim.textContent = "Neem taak";
      const okPrio = (!requiredPriority || t.priority === requiredPriority);
      btnClaim.disabled = !(t.status === "FREE" && !hasActive && okPrio);
      btnClaim.onclick = () => claimTask(t.id);
      actions.appendChild(btnClaim);
    }

    // Admin: impose if FREE/CLAIMED/IMPOSED (allow re-impose), with override option in detail
    if (state.role === "admin") {
    try { localStorage.setItem("sc_forceAdmin", "1"); } catch {}
      const btnImpose = document.createElement("button");
      btnImpose.className = "smallbtn";
      btnImpose.textContent = "Opleggen";
      btnImpose.disabled = (t.status === "DONE");
      btnImpose.onclick = () => imposeTask(t.id, false);
      actions.appendChild(btnImpose);
    }

    item.onclick = (e) => {
      // don't steal button clicks
      if (e.target.tagName.toLowerCase() === "button") return;
      selectTask(t.id, false);
    };

    item.appendChild(main);
    item.appendChild(actions);
    list.appendChild(item);
  }
}

function renderDetail(t, activeForTeam) {
  const el = $("detail");
  if (!t) {
    el.textContent = "Klik links op een taak.";
    return;
  }

  const requiredPriority = (state.role === "crew") ? requiredPriorityForClaim() : null;
  const prColor = (t.status === "DONE") ? "var(--white)" : prioColor(t.priority);

  const vehForTeam = t.team ? teamVehicles(t.team) : [];
  const vehTxt = vehForTeam.length ? vehForTeam.map(v => v.name).join(", ") : "—";

  const isOwnTeam = !t.team || t.team === state.team;
  const canUnassign = (t.status === "CLAIMED") || (state.role === "admin" && (t.status === "IMPOSED" || t.status === "CLAIMED"));
  const canDone = (t.status === "CLAIMED" || t.status === "IMPOSED");
  const canClaim = (state.role === "crew" && t.status === "FREE" && !activeForTeam && (!requiredPriority || t.priority === requiredPriority));
  const canImpose = (state.role === "admin" && t.status !== "DONE");

  const crewCanDone = (state.role === "crew") ? (canDone && isOwnTeam) : canDone;
  const crewCanUnassign = (state.role === "crew") ? (canUnassign && isOwnTeam) : canUnassign;

  const prioRow = (state.role === "admin") ? `
    <div class="row">
      <label style="min-width:120px">Prioriteit:</label>
      <select id="prioSel">
        <option value="GREEN">Groen</option>
        <option value="YELLOW">Geel</option>
        <option value="RED">Rood</option>
      </select>
      <button class="smallbtn" id="savePrio">Opslaan</button>
    </div>
  ` : ``;

  const crewPrioHint = (state.role === "crew" && requiredPriority && t.status === "FREE" && t.priority !== requiredPriority)
    ? `<div class="hint" style="margin-top:8px">Volgorde: eerst <strong>${prioNl(requiredPriority)}</strong>.</div>`
    : ``;

  el.innerHTML = `
    <div class="row">
      <span class="pill" style="border-color:${prColor}; color:var(--text)">${prioNl(t.priority)}</span>
      <span class="pill">${statusLabel(t.status)}</span>
      <span class="pill">${teamLabel(t.team)}</span>
    </div>

    <div style="font-weight:900; font-size:18px; margin-top:6px">${t.street}</div>
    <div style="margin-top:6px;color:var(--muted)">Leden: ${(teamMembers(t.team) || []).join(", ") || "—"}</div>
    <div style="margin-top:6px;color:var(--muted)">Voertuig: ${vehTxt}</div>
    <div style="margin-top:6px">${t.description || ""}</div>
    <div class="sep"></div>

    ${prioRow}

    <div class="row">
      <button class="smallbtn" id="btnFocus">Toon op kaart</button>
      <button class="smallbtn" id="btnClaim" ${canClaim ? "" : "disabled"}>Neem taak</button>
      <button class="smallbtn" id="btnDone" ${crewCanDone ? "" : "disabled"}>Klaar</button>
      <button class="smallbtn" id="btnUnassign" ${crewCanUnassign ? "" : "disabled"}>Vrijgeven</button>
    </div>
    ${crewPrioHint}

    <div class="sep"></div>
    <div style="font-weight:800;margin-bottom:6px">Opmerkingen</div>
    <textarea id="detailNoteTxt" placeholder="Briefing / opmerkingen..." style="width:100%; min-height:72px"></textarea>
    <div class="row" style="margin-top:8px; justify-content:space-between">
      <button class="smallbtn" id="detailNoteSend">Opslaan</button>
      <span class="hint" id="detailNoteHint"></span>
    </div>
    <div id="detailNotes" class="list" style="margin-top:8px"></div>

    <div class="sep"></div>
    <div style="font-weight:800;margin-bottom:6px">Foto</div>
    <div class="hint" style="margin-bottom:8px">Voeg een foto toe aan deze taak.</div>
    <input id="detailPhotoFile" type="file" accept="image/*" capture="environment" />
    <div class="row" style="margin-top:8px; justify-content:space-between">
      <button class="smallbtn" id="detailPhotoUpload">Upload</button>
      <span class="hint" id="detailPhotoHint"></span>
    </div>
    <div id="detailPhotoPreview" style="margin-top:8px"></div>

    ${state.role === "admin" ? `
      <div class="sep"></div>
      <div style="font-weight:800;margin-bottom:6px">Admin</div>
      <div class="row">
        <label style="min-width:120px">Opleggen aan:</label>
        <select id="teamSel">${teamOptionsHTML(state.team)}</select>
      </div>
      <div class="row">
        <label style="min-width:120px">Reden:</label>
        <input id="reason" placeholder="bv. stormschade" />
      </div>
      <div class="row">
        <label style="min-width:120px">Override:</label>
        <select id="override">
          <option value="false">nee</option>
          <option value="true">ja (vervang actieve taak)</option>
        </select>
      </div>
      <div class="btnRow">
        <button class="smallbtn" id="btnImpose" ${canImpose ? "" : "disabled"}>Opleggen</button>
        <button class="smallbtn" id="btnDelete">Verwijderen</button>
        ${t.status === "DONE" ? `<button class="smallbtn" id="btnReopen">Heropenen</button>` : ""}
      </div>
    ` : ""}
  `;

  if (state.role === "admin") {
    try { localStorage.setItem("sc_forceAdmin", "1"); } catch {}
    $("prioSel").value = (t.priority || "GREEN").toString().toUpperCase();
    $("savePrio").onclick = () => setPriority(t.id, $("prioSel").value);
  }

  $("btnFocus").onclick = () => focusOnMap(t);
  $("btnClaim").onclick = () => claimTask(t.id);
  $("btnDone").onclick = () => doneTask(t.id);
  $("btnUnassign").onclick = () => unassignTask(t.id);

  // Notes
  const noteSend = $("detailNoteSend");
  if (noteSend) noteSend.onclick = () => sendDetailNote(t.id);
  loadDetailNotes(t.id).catch(() => {});

  // Photo
  const photoFile = $("detailPhotoFile");
  const photoUp = $("detailPhotoUpload");
  const photoHint = $("detailPhotoHint");
  const photoPreview = $("detailPhotoPreview");
  if (photoPreview) {
    if (t.photoPath) {
      photoPreview.innerHTML = `<img src="${t.photoPath}" alt="Taak foto" style="width:100%; border-radius:14px; border:1px solid var(--line)" />`;
    } else {
      photoPreview.innerHTML = `<div class="hint">Nog geen foto.</div>`;
    }
  }
  if (photoFile && photoPreview) {
    photoFile.onchange = () => {
      const f = photoFile.files && photoFile.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      photoPreview.innerHTML = `<img src="${url}" alt="Voorbeeld" style="width:100%; border-radius:14px; border:1px solid var(--line)" />`;
    };
  }
  if (photoUp) {
    photoUp.onclick = async () => {
      const f = photoFile && photoFile.files ? photoFile.files[0] : null;
      if (!f) { if (photoHint) photoHint.textContent = "Kies eerst een foto."; return; }
      if (photoHint) photoHint.textContent = "Uploaden...";
      try {
        await uploadTaskPhoto(t.id, f);
        if (photoHint) photoHint.textContent = "Opgeslagen ✅";
        await load();
      } catch (e) {
        if (e && e.status === 413) {
          if (photoHint) photoHint.textContent = "Foto te groot. Neem een kleinere/duidelijkere foto.";
        } else {
          if (photoHint) photoHint.textContent = "Upload mislukt.";
        }
      }
    };
  }

  if (state.role === "admin") {
    $("teamSel").value = state.team;
    $("btnImpose").onclick = () => imposeTask(t.id, $("override").value === "true");
    $("btnDelete").onclick = () => deleteTask(t.id);
    const reopen = $("btnReopen");
    if (reopen) reopen.onclick = () => reopenTask(t.id);
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
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
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
  // Keep it under the backend JSON limit by compressing aggressively when needed.
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
      // fallback to original
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

async function loadDetailNotes(taskId){
  const box = $("detailNotes");
  if (!box) return;
  box.innerHTML = `<div class="hint">Laden...</div>`;
  try {
    const r = await api(`/api/tasks/${taskId}/notes?limit=30`);
    const rows = (r && r.rows) ? r.rows : [];
    if (!rows.length) {
      box.innerHTML = `<div class="hint">Nog geen opmerkingen.</div>`;
      return;
    }
    box.innerHTML = "";
    for (const n of rows.slice(0, 10)) {
      const div = document.createElement("div");
      div.className = "item";
      div.innerHTML = `
        <div class="itemMain">
          <div>
            <div class="desc">${fmtTime(n.at)} • ${(n.by || "").toString()}</div>
            <div style="white-space:pre-wrap">${(n.note || "").toString()}</div>
          </div>
        </div>
      `;
      box.appendChild(div);
    }
  } catch {
    box.innerHTML = `<div class="hint">Opmerkingen laden lukt niet.</div>`;
  }
}

async function sendDetailNote(taskId){
  const ta = $("detailNoteTxt");
  const hint = $("detailNoteHint");
  if (!ta) return;
  const note = (ta.value || "").trim();
  if (!note) {
    if (hint) hint.textContent = "(leeg)";
    return;
  }
  if (hint) hint.textContent = "Opslaan...";
  try {
    await api(`/api/tasks/${taskId}/notes`, {
      method: "POST",
      body: JSON.stringify({ note })
    });
    ta.value = "";
    if (hint) hint.textContent = "Opgeslagen ✅";
    await loadDetailNotes(taskId);
  } catch (e) {
    if (hint) hint.textContent = "Niet gelukt.";
  }
}


async function ensureCoords(t) {
  // If coords exist, use them
  if (t.lat && t.lng) return { lat: t.lat, lng: t.lng };

  // Best-effort geocode via Nominatim (client-side) + persist via backend for caching
  const q = encodeURIComponent(`${t.street}, Schelle, Belgium`);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${q}`, {
      headers: { "Accept-Language": "nl" }
    });
    const results = await r.json();
    if (!results || !results.length) return null;

    const r0 = results[0];
    const lat = parseFloat(r0.lat);
    const lng = parseFloat(r0.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    // Persist to backend (MVP cache)
    try {
      await api(`/api/tasks/${t.id}/location`, {
        method: "POST",
        body: JSON.stringify({ lat, lng })
      });
    } catch { /* ignore */ }

    // Also update local copy to avoid another geocode this session
    t.lat = lat; t.lng = lng;

    return { lat, lng };
  } catch {
    return null;
  }
}

function clearTeamMarkers() {
  if (!map) return;
  for (const k of Object.keys(state.teamMarkers)) {
    try { state.teamMarkers[k].remove(); } catch {}
  }
  state.teamMarkers = {};
}

function renderLegend(activeByTeam) {
  const el = $("mapLegend");
  if (!el) return;
  const teams = teamCodesList();
  el.innerHTML = "";
  for (const tm of teams) {
    const a = activeByTeam[tm];
    const item = document.createElement("div");
    item.className = "legendItem";
    const dot = document.createElement("div");
    dot.className = "legendDot";
    dot.style.background = teamColor(tm);
    const label = document.createElement("div");
    const members = (teamMembers(tm) || []).join(", ");
    const memTxt = members ? ` <span class="mut">(${members})</span>` : "";
    label.innerHTML = `<strong>${teamLabel(tm)}</strong>${memTxt} — ${a ? a.street : "—"}`;
    item.appendChild(dot);
    item.appendChild(label);
    item.style.cursor = 'pointer';
    item.onclick = () => jumpToTeam(tm);
    el.appendChild(item);
  }
}

async function updateTeamMarkers() {
  if (!map) return;

  // Only active tasks (claimed/imposed) per team
  const activeByTeam = {};
  for (const t of state.tasks) {
    if (t.team && (t.status === "CLAIMED" || t.status === "IMPOSED")) {
      activeByTeam[t.team] = t; // max 1 by rule
    }
  }

  renderLegend(activeByTeam);
  clearTeamMarkers();

  for (const [team, task] of Object.entries(activeByTeam)) {
    const coords = await ensureCoords(task);
    if (!coords) continue;

    const color = teamColor(team);
    const circle = L.circleMarker([coords.lat, coords.lng], {
      radius: 10,
      weight: 3,
      color: color,
      fillOpacity: 0.35
    }).addTo(map);

    const label = `${teamLabel(team)}: ${task.street}`;
    circle.bindPopup(label);
    circle.bindTooltip(label, { permanent: false, direction: "top", offset: [0, -8] });
    state.teamMarkers[team] = circle;
  }
}

// Jump map to the active task of a given team (via legend)
async function jumpToTeam(team) {
  if (!map) return;

  const task = state.tasks.find(t => t.team === team && (t.status === "CLAIMED" || t.status === "IMPOSED"));
  if (!task) {
    alert(`${teamLabel(team)} heeft geen actieve taak.`);
    return;
  }

  const coords = await ensureCoords(task);
  if (!coords) {
    alert("Straat niet gevonden op kaart.");
    return;
  }

  map.setView([coords.lat, coords.lng], Math.max(map.getZoom(), 16));

  // Prefer the colored circle marker if it exists
  const m = state.teamMarkers[team];
  if (m) {
    try { m.openPopup(); } catch {}
  } else {
    panMarker(coords.lat, coords.lng, `${teamLabel(team)}: ${task.street}`);
  }

  // Also show the task in the detail panel (without re-moving the map)
  selectTask(task.id, false);
}



function showPlanningError(msg){
  const a = $("attendanceList");
  const t = $("teams");
  if (a) a.innerHTML = `<div class="hint">${msg}</div>`;
  if (t) t.innerHTML = "";
}

async function loadPlanning() {
  try {
    const data = await api(`/api/planning?date=${encodeURIComponent(state.dueDate)}`);
    state.planning = data;
    rebuildTeamSelect();
    renderTeamAdminTools();
    renderAttendance();
    renderTeams();
    renderVehicleAdmin();
  } catch (e) {
    showPlanningError(`Dagplanning kan niet laden: ${e.message}`);
  }
}

async function addTeam(){
  try {
    await api("/api/planning/teams", { method: "POST", body: JSON.stringify({}) });
    await loadPlanning();
  } catch (e) {
    alert(`Ploeg toevoegen: ${e.message}`);
  }
}

async function deleteTeamSoft(team){
  const label = teamLabel(team);
  const ok = window.confirm(`${label} verwijderen?`);
  if (!ok) return;
  try {
    await api(`/api/planning/teams/${encodeURIComponent(team)}/delete`, { method: "POST" });
    if ((state.team || "").toUpperCase() === (team || "").toUpperCase()) {
      const codes = teamCodesList().filter(c => c !== team);
      state.team = codes[0] || "";
    }
    await loadPlanning();
    if (state.selectedId) {
      const cur = (state.tasks || []).find(t => String(t.id) === String(state.selectedId));
      if (cur) selectTask(cur.id, false);
    }
  } catch (e) {
    alert(`Ploeg verwijderen: ${e.message}`);
  }
}

async function undoLastAction(){
  try {
    const data = await api(`/api/planning/undo`, { method: "POST" });
    if (data && data.teamCodes) {
      const activeCodes = ((data.teamCodes || []).map(v => String(v).toUpperCase()));
      if (!activeCodes.includes(String(state.team || '').toUpperCase())) {
        state.team = activeCodes[0] || '';
      }
      if (data.undone && data.undone.entityType === 'team' && data.undone.entityId) {
        const undoneCode = String(data.undone.entityId || '').toUpperCase();
        if (activeCodes.includes(undoneCode)) state.team = undoneCode;
      }
    }
    await load();
  } catch (e) {
    alert(`Undo: ${e.message}`);
  }
}

function renderTeamAdminTools(){
  const bar = $("teamAdminTools");
  if (!bar) return;
  bar.innerHTML = "";
  if (state.role !== "admin") { bar.style.display = "none"; return; }
  bar.style.display = "flex";

  const btn = document.createElement("button");
  btn.className = "smallbtn";
  btn.textContent = "+ Ploeg";
  btn.onclick = () => addTeam();
  bar.appendChild(btn);




  const hint = document.createElement("div");
  hint.className = "mut";
  hint.style.marginLeft = "6px";
  hint.textContent = "Voegt automatisch Ploeg 5, 6, ... toe.";
  bar.appendChild(hint);
}


async function downloadHistoryExcel(){
  try{
    if (state.role !== "admin") { alert("Alleen admin."); return; }
    const date = state.dueDate;
    const url = `/api/history.xls?date=${encodeURIComponent(date)}`;
    const r = await fetch(url, { headers: headers() });
    if (!r.ok) { alert(`Historiek mislukt (${r.status}).`); return; }
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `historiek-${String(date).slice(0,4)}.xls`;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
    a.remove();
  }catch(e){
    alert(`Historiek: ${e.message}`);
  }
}



async function randomizeTeams() {
  try {
    const r = await api("/api/planning/randomize", {
      method: "POST",
      body: JSON.stringify({ date: state.dueDate })
    });
    if (r.warning) alert(r.warning);
    await loadPlanning();
  } catch (e) {
    if (e.data && e.data.error === "not_enough_people") {
      alert("Te weinig aanwezigen om random ploegen te maken (min 2).");
    } else {
      alert(`Random ploegen: ${e.message}`);
    }
  }
}


async function loadEmployeesAll() {
  try {
    const data = await api("/api/planning/employees/all");
    state.employeesAll = data;
    renderEmployeeAdmin();
  } catch {}
}

async function loadForemenAll(){
  try{
    state.foremenAll = await api("/api/foremen", { method:"GET" });
  }catch{
    state.foremenAll = { foremen: [] };
  }
}

async function addForeman(){
  const nameEl = $("newForemanName");
  const codeEl = $("newForemanCode");
  const name = nameEl ? nameEl.value.trim() : "";
  const code = codeEl ? codeEl.value.trim() : "";
  if (!name || !code) return alert("Naam + code invullen.");
  try{
    await api("/api/foremen", { method:"POST", body: JSON.stringify({ name, code }) });
    if (nameEl) nameEl.value = "";
    if (codeEl) codeEl.value = "";
    await loadForemenAll();
    renderForemenAdmin();
  }catch(e){
    alert(`Ploegbaas: ${e.message}`);
  }
}

async function deleteForeman(id){
  if (!confirm("Ploegbaas verwijderen? Code werkt dan niet meer.")) return;
  try{
    await api(`/api/foremen/${id}/delete`, { method:"POST" });
    await loadForemenAll();
    renderForemenAdmin();
  }catch(e){
    alert(`Ploegbaas delete: ${e.message}`);
  }
}

function renderForemenAdmin(){
  const card = $("foremanAdminCard");
  if (card) {
    if (state.role === "admin") card.classList.remove("hidden"); else card.classList.add("hidden");
  }

  const wrap = $("foremanList");
  const addBtn = $("addForeman");
  if (addBtn) addBtn.onclick = () => addForeman();

  if (!wrap) return;
  // Only show list if admin; otherwise keep it empty (but button still gives a clear error)
  if (state.role !== "admin") {
    wrap.innerHTML = "";
    return;
  }

  const rows = (state.foremenAll && state.foremenAll.foremen) ? state.foremenAll.foremen : [];
  wrap.innerHTML = "";
  for (const f of rows){
    if (f.deletedAt) continue;
    const item = document.createElement("div");
    item.className = "vehicleItem";
    const left = document.createElement("div");
    left.textContent = f.name;

    const del = document.createElement("button");
    del.className = "smallbtn";
    del.textContent = "Verwijder";
    del.onclick = () => deleteForeman(f.id);

    item.appendChild(left);
    item.appendChild(del);
    wrap.appendChild(item);
  }
}


async function loadLibrary() {
  try {
    const data = await api("/api/library");
    state.library = data;
    renderLibraryAdmin();
  } catch {}
}

async function addEmployee() {
  const name = $("newEmployee") ? $("newEmployee").value.trim() : "";
  if (!name) return;
  try {
    await api("/api/planning/employees", { method:"POST", body: JSON.stringify({ name }) });
    $("newEmployee").value = "";
    await loadEmployeesAll();
    await loadPlanning();
  } catch (e) {
    alert(`Werknemer: ${e.message}`);
  }
}

async function deleteEmployee(id) {
  if (!confirm("Werknemer verwijderen?")) return;
  try {
    await api(`/api/planning/employees/${id}/delete`, { method:"POST" });
    await loadEmployeesAll();
    await loadPlanning();
  } catch (e) {
    alert(`Werknemer delete: ${e.message}`);
  }
}

function renderEmployeeAdmin() {
  const card = $("employeeMiniWrap") || $("employeeAdminCard");
  if (!card) return;
  if (state.role === "admin") card.classList.remove("hidden"); else card.classList.add("hidden");

  const list = $("employeeList");
  if (!list) return;
  list.innerHTML = "";

  const rows = (state.employeesAll && state.employeesAll.employees) ? state.employeesAll.employees : [];
  for (const e of rows) {
    const item = document.createElement("div");
    item.className = "vehicleItem";
    const left = document.createElement("div");
    left.textContent = e.name;

    const btn = document.createElement("button");
    btn.className = "smallbtn";
    if (e.deletedAt) {
      btn.textContent = "Heractiveer";
      btn.onclick = () => { $("newEmployee").value = e.name; addEmployee(); };
    } else {
      btn.textContent = "Verwijder";
      btn.onclick = () => deleteEmployee(e.id);
    }

    item.appendChild(left);
    item.appendChild(btn);
    list.appendChild(item);
  }

  const addBtn = $("addEmployee");
  if (addBtn) addBtn.onclick = () => addEmployee();
}

async function releaseFromLibrary(id) {
  try {
    await api(`/api/library/${id}/release`, { method:"POST", body: JSON.stringify({ date: state.dueDate }) });
    await load();
  } catch (e) {
    alert(`Vrijgeven: ${e.message}`);
  }
}

async function deleteFromLibrary(id) {
  if (!confirm("Opdracht uit de lijst verwijderen?")) return;
  try {
    await api(`/api/library/${id}/delete`, { method:"POST" });
    await loadLibrary();
  await loadForemenAll();
  renderForemenAdmin();
  } catch (e) {
    alert(`Opdracht delete: ${e.message}`);
  }
}

function renderLibraryAdmin() {
  const card = $("libraryAdminCard");
  if (!card) return;
  if (state.role === "admin") card.classList.remove("hidden"); else card.classList.add("hidden");

  const list = $("libraryList");
  if (!list) return;
  list.innerHTML = "";

  const items = (state.library && state.library.items) ? state.library.items : [];
  for (const it of items) {
    const item = document.createElement("div");
    item.className = "vehicleItem";

    const left = document.createElement("div");
    left.innerHTML = `<strong>${it.street}</strong>${it.description ? " — " + it.description : ""}`;

    const right = document.createElement("div");
    right.className = "row";
    right.style.gap = "8px";

    const rel = document.createElement("button");
    rel.className = "smallbtn";
    rel.textContent = "Vrijgeven";
    rel.disabled = !!it.deletedAt || !it.active;
    rel.onclick = () => releaseFromLibrary(it.id);

    const del = document.createElement("button");
    del.className = "smallbtn";
    del.textContent = "Verwijder";
    del.onclick = () => deleteFromLibrary(it.id);

    right.appendChild(rel);
    right.appendChild(del);

    item.appendChild(left);
    item.appendChild(right);
    list.appendChild(item);
  }

  const reloadBtn = $("reloadLibrary");
  if (reloadBtn) reloadBtn.onclick = () => loadLibrary();
}


function renderAttendance() {
  const el = $("attendanceList");
  if (!el) return;
  el.innerHTML = "";
  const employees = state.planning.employees || [];
  const attendance = state.planning.attendance || {};

  for (const e of employees) {
    const row = document.createElement("div");
    row.className = "attRow";

    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!attendance[e.name];
    cb.onchange = () => setAttendance(e.name, cb.checked);

    const name = document.createElement("span");
    name.textContent = e.name;

    lab.appendChild(cb);
    lab.appendChild(name);

    const status = document.createElement("div");
    status.className = "mut";
    status.textContent = cb.checked ? "aanwezig" : "afwezig";

    // Admin-only: generate one-time pairing code for crew phone
    if (state.role === "admin") {
    try { localStorage.setItem("sc_forceAdmin", "1"); } catch {}
      const btn = document.createElement("button");
      btn.className = "smallbtn";
      btn.textContent = "Koppel gsm";
      btn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        createPairCode(e.id, e.name);
      };
      status.appendChild(document.createElement("div"));
      status.appendChild(btn);
    }

    row.appendChild(lab);
    row.appendChild(status);
    el.appendChild(row);
  }
}

function presentNames() {
  const att = state.planning.attendance || {};
  return Object.keys(att).filter(n => att[n]);
}

function teamMembers(team) {
  const teams = state.planning.teams || {};
  return Array.isArray(teams[team]) ? teams[team] : [];
}

// Draft teams: allow building a team in 2 steps (0 -> 1 -> 2) without violating 0 or 2..4 rule on the backend.
function getDraftMembers(team) {
  return (state._draftTeams && Array.isArray(state._draftTeams[team])) ? state._draftTeams[team] : [];
}

function setDraftMembers(team, members) {
  state._draftTeams = state._draftTeams || {};
  if (!members || members.length === 0) {
    delete state._draftTeams[team];
  } else {
    state._draftTeams[team] = members;
  }
}

function clientTeamMembers(team) {
  const saved = teamMembers(team);
  if (saved.length > 0) return saved;
  const draft = getDraftMembers(team);
  return draft.length > 0 ? draft : saved;
}

function teamVehicles(team) {
  const tv = state.planning.teamVehicles || {};
  return Array.isArray(tv[team]) ? tv[team] : [];
}

async function setAttendance(name, present) {
  try {
    await api("/api/planning/attendance", {
      method: "POST",
      body: JSON.stringify({ date: state.dueDate, name, present })
    });
    await loadPlanning();
  } catch (e) {
    alert(`Fout aanwezig: ${e.message}`);
  }
}

async function saveTeamMembers(team, members) {
  try {
    await api("/api/planning/team-members", {
      method: "POST",
      body: JSON.stringify({ date: state.dueDate, team, members })
    });
    await loadPlanning();
  } catch (e) {
    if (e.data && e.data.error === "team_size_invalid") {
      alert(state.role === "admin" ? "Ploeg moet 0–4 personen hebben." : "Ploeg moet leeg zijn óf 2–4 personen hebben.");
    } else {
      alert(`Fout ploeg: ${e.message}`);
    }
  }
}

async function saveTeamVehicles(team, assignments) {
  try {
    await api("/api/planning/team-vehicles", {
      method: "POST",
      body: JSON.stringify({ date: state.dueDate, team, assignments })
    });
    await loadPlanning();
  } catch (e) {
    if (e.data && e.data.error === "max_2_vehicles") {
      alert("Max 2 voertuigen per ploeg.");
    } else if (e.data && e.data.error === "vehicle_already_assigned") {
      const name = e.data.vehicleName || "Dit voertuig";
      const assigned = e.data.assignedTeam || "een andere ploeg";
      alert(`${name} is al toegewezen aan ${assigned}. Eén voertuig mag maar bij één ploeg tegelijk zitten.`);
      await loadPlanning();
    } else if (e.data && e.data.error === "driver_not_in_team") {
      alert(`Chauffeur ${e.data.driverName || ''} zit niet in deze ploeg.`);
      await loadPlanning();
    } else {
      alert(`Fout voertuigen: ${e.message}`);
    }
  }
}

function renderTeams() {
  const el = $("teams");
  if (!el) return;
  el.innerHTML = "";

  const teams = teamCodesList();
  const present = presentNames();
  const vehicles = state.planning.vehicles || [];
  const vehicleAssignments = state.planning.teamVehicles || {};
  const vehicleTeamMap = {};
  for (const [teamCode, assignedList] of Object.entries(vehicleAssignments)) {
    for (const assigned of (assignedList || [])) {
      if (assigned && assigned.id) vehicleTeamMap[assigned.id] = teamCode;
    }
  }

  // Helpers
  const membersFor = (team) => clientTeamMembers(team);
  const isDraftTeam = (team) => teamMembers(team).length === 0 && getDraftMembers(team).length > 0;

  const inAnyTeam = new Set();
  for (const tm of teams) for (const n of membersFor(tm)) inAnyTeam.add(n);

  const applyTeamMembers = async (team, members) => {
    const cleaned = Array.from(new Set((members || []).map(x => (x || "").toString().trim()).filter(Boolean)));
    const isAdmin = state.role === "admin";

    // Saved team (backend already has members)
    if (teamMembers(team).length > 0) {
      if (!isAdmin && cleaned.length === 1) cleaned.length = 0;
      const n = cleaned.length;
      const okSize = isAdmin ? (n >= 0 && n <= 4) : (n === 0 || (n >= 2 && n <= 4));
      if (!okSize) {
        alert(isAdmin ? "Ploeg moet 0–4 personen hebben." : "Ploeg moet leeg zijn óf 2–4 personen hebben.");
        return;
      }
      await saveTeamMembers(team, cleaned);
      return;
    }

    // Empty team on backend:
    if (cleaned.length === 0) {
      setDraftMembers(team, []);
      renderTeams();
      return;
    }
    if (cleaned.length === 1) {
      if (isAdmin) {
        setDraftMembers(team, []);
        await saveTeamMembers(team, cleaned);
        return;
      } else {
        setDraftMembers(team, cleaned);
        renderTeams();
        return;
      }
    }
    if (cleaned.length > 4) {
      alert("Max 4 personen per ploeg.");
      return;
    }

    // 2..4 => save + clear draft
    setDraftMembers(team, []);
    await saveTeamMembers(team, cleaned);
  };

  const moveToTeam = async (name, targetTeam) => {
    name = (name || "").toString().trim();
    if (!name) return;

    // Remove from any other team (saved or draft)
    for (const tm of teams) {
      if (tm === targetTeam) continue;
      const cur = membersFor(tm);
      if (!cur.includes(name)) continue;
      const next = cur.filter(x => x !== name);
      if (state.role !== "admin" && next.length === 1) next.length = 0; // crew: auto-clear lonely team
      await applyTeamMembers(tm, next);
    }

    const curT = membersFor(targetTeam);
    if (curT.includes(name)) return;
    if (curT.length >= 4) {
      alert("Max 4 personen per ploeg.");
      return;
    }
    const nextT = [...curT, name];
    if (state.role !== "admin" && teamMembers(targetTeam).length === 0 && curT.length === 0 && nextT.length === 1) {
      alert("Nog 1 medewerker nodig om deze ploeg te bewaren (minimum 2).");
    }
    await applyTeamMembers(targetTeam, nextT);
  };

  const removeFromTeam = async (team, name) => {
    const cur = membersFor(team);
    if (!cur.includes(name)) return;
    const next = cur.filter(x => x !== name);
    if (state.role !== "admin" && next.length === 1) {
      if (!confirm("Ploeg mag niet 1 persoon zijn. Ploeg leegmaken?")) return;
      await applyTeamMembers(team, []);
      return;
    }
    await applyTeamMembers(team, next);
  };

  for (const team of teams) {
    const box = document.createElement("div");
    box.className = "teamBox";

    const members = membersFor(team);
    const draft = isDraftTeam(team);
    const vAssigned = teamVehicles(team);

    const header = document.createElement("div");
    header.className = "teamHeader";

    const left = document.createElement("div");
    left.innerHTML = `<strong>${teamLabel(team)}</strong>`;

    const meta = document.createElement("div");
    meta.className = "meta";
    if (members.length === 0) meta.textContent = "leeg";
    else if (draft && members.length === 1) meta.textContent = "1/4 (nog 1)";
    else meta.textContent = `${members.length}/4`;

    const headerRight = document.createElement("div");
    headerRight.className = "teamHeaderRight";
    headerRight.appendChild(meta);

    const teamMeta = Array.isArray(state.planning.teamsMeta) ? state.planning.teamsMeta.find(x => (x.code || "").toUpperCase() === team) : null;
    const sortOrder = teamMeta && Number.isFinite(Number(teamMeta.sortOrder)) ? Number(teamMeta.sortOrder) : 0;
    const canDeleteTeam = state.role === "admin" && sortOrder > 4;
    if (canDeleteTeam) {
      const delTeamBtn = document.createElement("button");
      delTeamBtn.className = "iconGhostBtn";
      delTeamBtn.type = "button";
      delTeamBtn.title = `${teamLabel(team)} verwijderen`;
      delTeamBtn.setAttribute("aria-label", `${teamLabel(team)} verwijderen`);
      delTeamBtn.textContent = "×";
      delTeamBtn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        deleteTeamSoft(team);
      };
      headerRight.appendChild(delTeamBtn);
    }

    header.appendChild(left);
    header.appendChild(headerRight);

    const body = document.createElement("div");
    body.className = "teamBody";

    // Member pills
    const pills = document.createElement("div");
    pills.className = "pills";

    // Allow drag & drop of names between teams (works best on PC)
    pills.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    pills.addEventListener("drop", (e) => {
      e.preventDefault();
      const name = (e.dataTransfer.getData("text/plain") || "").trim();
      if (!name) return;
      moveToTeam(name, team);
    });

    if (draft && members.length === 1) {
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.style.margin = "6px 0 0 0";
      hint.textContent = "Nog 1 naam nodig (minimum 2) om deze ploeg te bewaren.";
      body.appendChild(hint);
    }
    for (const m of members) {
      const pill = document.createElement("button");
      pill.className = "pillBtn";
      pill.innerHTML = `${m} <span class="x">×</span>`;
      pill.draggable = true;
      pill.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", m);
      });
      pill.onclick = () => removeFromTeam(team, m);
      pills.appendChild(pill);
    }
    body.appendChild(pills);

    // Add member control
    const ctrl = document.createElement("div");
    ctrl.className = "teamControls";

    const sel = document.createElement("select");
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "Voeg medewerker toe…";
    sel.appendChild(opt0);

    for (const n of present) {
      if (members.includes(n)) continue;
      // allow moving between teams by selecting; we will remove from other team client-side first
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n + (inAnyTeam.has(n) ? " (verplaatsen)" : "");
      sel.appendChild(opt);
    }

    const addBtn = document.createElement("button");
    addBtn.className = "smallbtn";
    addBtn.textContent = "Toevoegen";
    addBtn.onclick = () => {
      const name = sel.value;
      if (!name) return;
      moveToTeam(name, team);
    };

    ctrl.appendChild(sel);
    ctrl.appendChild(addBtn);
    body.appendChild(ctrl);

    // Vehicles for team (max 2) + optional chauffeur per voertuig
    const vehWrap = document.createElement("div");
    vehWrap.className = "vehiclePick";

    const mkVehicleSlot = (slot) => {
      const row = document.createElement("div");
      row.className = "vehicleDriverRow";
      const vSel = document.createElement("select");
      const dSel = document.createElement("select");

      const blankV = document.createElement("option");
      blankV.value = "";
      blankV.textContent = `Voertuig ${slot} (optioneel)`;
      vSel.appendChild(blankV);

      for (const v of vehicles) {
        const usedBy = vehicleTeamMap[v.id];
        const ownTeamKeepsIt = usedBy === team;
        const label = usedBy && !ownTeamKeepsIt ? `${v.name} — bezet door ${usedBy}` : v.name;
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = label;
        opt.disabled = !!usedBy && !ownTeamKeepsIt;
        vSel.appendChild(opt);
      }

      const blankD = document.createElement("option");
      blankD.value = "";
      blankD.textContent = "Chauffeur kiezen (optioneel)";
      dSel.appendChild(blankD);
      for (const m of members) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        dSel.appendChild(opt);
      }

      const assigned = vAssigned[slot-1] || null;
      vSel.value = assigned ? assigned.id : "";
      dSel.value = assigned && assigned.driverName ? assigned.driverName : "";
      row.appendChild(vSel);
      row.appendChild(dSel);
      return { row, vSel, dSel };
    };

    const s1 = mkVehicleSlot(1);
    const s2 = mkVehicleSlot(2);

    const saveVeh = () => {
      const assignments = [
        { vehicleId: s1.vSel.value, driverName: s1.dSel.value || '' },
        { vehicleId: s2.vSel.value, driverName: s2.dSel.value || '' }
      ].filter(x => x.vehicleId);
      if (assignments.length === 2 && assignments[0].vehicleId === assignments[1].vehicleId) {
        alert("Kies 2 verschillende voertuigen (of laat één leeg).");
        return;
      }
      saveTeamVehicles(team, assignments);
    };

    s1.vSel.onchange = saveVeh;
    s1.dSel.onchange = saveVeh;
    s2.vSel.onchange = saveVeh;
    s2.dSel.onchange = saveVeh;

    vehWrap.appendChild(s1.row);
    vehWrap.appendChild(s2.row);
    if (!vAssigned.length && members.length) {
      const warnVehicle = document.createElement("div");
      warnVehicle.className = "hint warn-yellow";
      warnVehicle.textContent = "Geen voertuig gekozen";
      vehWrap.appendChild(warnVehicle);
    }
    if (vAssigned.some(v => v && v.id && !v.driverName)) {
      const warn = document.createElement("div");
      warn.className = "hint warn-yellow";
      warn.textContent = "Chauffeur ontbreekt voor minstens 1 voertuig. Kies hem hier op de PC.";
      vehWrap.appendChild(warn);
    }
    body.appendChild(vehWrap);

    box.appendChild(header);
    box.appendChild(body);
    el.appendChild(box);
  }
}

async function addVehicle() {
  const name = ($("newVehicle") && $("newVehicle").value) ? $("newVehicle").value.trim() : "";
  if (!name) return;
  try {
    await api("/api/planning/vehicles", { method: "POST", body: JSON.stringify({ name }) });
    $("newVehicle").value = "";
    await load();
  } catch (e) {
    alert(`Voertuig: ${e.message}`);
  }
}

async function deleteVehicle(id) {
  if (!confirm("Voertuig verwijderen?")) return;
  try {
    await api(`/api/planning/vehicles/${id}/delete`, { method: "POST" });
    await load();
  } catch (e) {
    alert(`Voertuig delete: ${e.message}`);
  }
}

function renderVehicleAdmin() {
  const card = $("vehicleAdminCard");
  if (!card) return;
  if (state.role === "admin") card.classList.remove("hidden"); else card.classList.add("hidden");

  const list = $("vehicleList");
  if (!list) return;
  list.innerHTML = "";

  const vehicles = state.planning.vehicles || [];
  for (const v of vehicles) {
    const item = document.createElement("div");
    item.className = "vehicleItem";
    const left = document.createElement("div");
    left.textContent = v.name;

    const del = document.createElement("button");
    del.className = "iconBtn subtleDelete";
    del.textContent = "×";
    del.title = "Verwijder voertuig";
    del.onclick = () => deleteVehicle(v.id);

    item.appendChild(left);
    item.appendChild(del);
    list.appendChild(item);
  }

  const addBtn = $("addVehicle");
  if (addBtn) addBtn.onclick = () => addVehicle();
}



async function loadHistoryDay() {
  try {
    if (state.role !== "admin") { state.historyDay = null; renderHistoryDay(); return; }
    state.historyDay = await api(`/api/history/day?date=${encodeURIComponent(state.dueDate)}`);
  } catch {
    state.historyDay = null;
  }
  renderHistoryDay();
}

function renderHistoryDay() {
  const card = $("historyCard");
  const box = $("historyView");
  const btn = $("reloadHistory");
  const xbtn = $("historyExcel");
  if (btn) btn.onclick = () => loadHistoryDay();
  if (xbtn) xbtn.onclick = () => downloadHistoryExcel();
  if (!card || !box) return;
  if (state.role === "admin") card.classList.remove("hidden"); else card.classList.add("hidden");
  const h = state.historyDay;
  if (!h) {
    box.innerHTML = `<div class="hint">Geen historiek geladen.</div>`;
    return;
  }
  const taskRows = (h.tasks || []).map(t => `
    <tr>
      <td>${t.street || ""}</td>
      <td>${t.description || ""}</td>
      <td>${prioNl(t.priority)}</td>
      <td>${statusLabel(t.status)}</td>
      <td>${teamLabel(t.team || "")}</td>
      <td>${(t.members || []).join(", ") || "—"}</td>
      <td>${(t.vehicles || []).join(", ") || "—"}</td>
      <td>${t.startedAt ? fmtDateTime(t.startedAt) : "—"}</td>
      <td>${t.doneAt ? fmtDateTime(t.doneAt) : "—"}</td>
      <td>${t.durationMin != null ? `${t.durationMin} min` : "—"}</td>
    </tr>
  `).join("");
  box.innerHTML = `
    <div class="historySection">
      <div class="subTitle">Taken van de dag</div>
      <div class="tableWrap">
        <table class="historyTable">
          <thead><tr><th>Straat</th><th>Beschrijving</th><th>Prio</th><th>Status</th><th>Ploeg</th><th>Mensen</th><th>Wagens</th><th>Start</th><th>Einde</th><th>Duur</th></tr></thead>
          <tbody>${taskRows || `<tr><td colspan="10" class="mut">Geen taken.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}

async function refreshWhoAmI(){
  const el = $("whoami");
  if (!el) return;
  try {
    const me = await api('/api/whoami');
    state._serverRole = me.role;
    el.textContent = `Server: ${me.role}`;
    const warn = $("adminMismatch");
    if (warn){
      if (state.role === 'admin' && me.role !== 'admin') { warn.classList.remove('hidden'); }
      else warn.classList.add('hidden');
    }
  } catch {
    el.textContent = 'Server: ?';
  }
}

async function load() {
  await refreshWhoAmI();
  await loadDeviceLinks();
  await loadPlanning();
  await loadHistoryDay();
  await loadEmployeesAll();
  await loadLibrary();
  await loadForemenAll();
  renderForemenAdmin();
  const data = await api(`/api/tasks?date=${encodeURIComponent(state.dueDate)}&status=${encodeURIComponent(state.status)}`);
  state.tasks = data.rows;

  const activeForTeam = state.tasks.find(t => t.team === state.team && (t.status === "CLAIMED" || t.status === "IMPOSED"));
  const activeByTeam = {};
  for (const t of state.tasks) {
    if (t.team && (t.status === "CLAIMED" || t.status === "IMPOSED")) activeByTeam[t.team] = t;
  }
  renderActiveTasks(activeByTeam);
  renderList(activeForTeam);

  const selected = state.selectedId ? state.tasks.find(t => t.id === state.selectedId) : null;
  renderDetail(selected, activeForTeam);
  await updateTeamMarkers();
}

async function claimTask(id) {
  try {
    await api(`/api/tasks/${id}/claim`, {
      method: "POST",
      body: JSON.stringify({ team: state.team, dueDate: state.dueDate })
    });
    state.selectedId = id;
    await load();
  } catch (e) {
    if (e.data && e.data.error === "team_already_has_active_task") {
      alert(`Anti-chaos: je ploeg heeft al 1 actieve taak: ${e.data.activeTask.street}`);
    } else if (e.data && e.data.error === "priority_blocked") {
      alert(`Volgorde: eerst ${prioNl(e.data.requiredPriority)} taken.`);
    } else {
      alert(`Fout: ${e.message}`);
    }
  }
}

async function imposeTask(id, override) {
  const reason = ($("reason") && $("reason").value) ? $("reason").value : "";
  const teamSel = ($("teamSel") && $("teamSel").value) ? $("teamSel").value : state.team;
  try {
    await api(`/api/tasks/${id}/impose`, {
      method: "POST",
      body: JSON.stringify({ team: teamSel, reason, override, dueDate: state.dueDate })
    });
    state.selectedId = id;
    await load();
  } catch (e) {
    if (e.data && e.data.error === "team_already_has_active_task") {
      alert(`Ploeg heeft al 1 actieve taak: ${e.data.activeTask.street}\nKies override = ja als je wil vervangen.`);
    } else {
      alert(`Fout: ${e.message}`);
    }
  }
}

async function unassignTask(id) {
  try {
    await api(`/api/tasks/${id}/unassign`, { method: "POST" });
    await load();
  } catch (e) {
    alert(`Fout: ${e.message}`);
  }
}

async function doneTask(id) {
  try {
    await api(`/api/tasks/${id}/done`, { method: "POST" });
    await load();
  } catch (e) {
    alert(`Fout: ${e.message}`);
  }
}

async function reopenTask(id) {
  try {
    await api(`/api/tasks/${id}/reopen`, { method: "POST", body: JSON.stringify({ priority: "YELLOW" }) });
    await load();
  } catch (e) {
    alert(`Fout: ${e.message}`);
  }
}

async function deleteTask(id) {
  if (!confirm("Zeker verwijderen? (soft delete)")) return;
  try {
    await api(`/api/tasks/${id}/delete`, { method: "POST" });
    state.selectedId = null;
    await load();
  } catch (e) {
    alert(`Fout: ${e.message}`);
  }
}

async function setPriority(id, priority) {
  try {
    await api(`/api/tasks/${id}/priority`, { method: "POST", body: JSON.stringify({ priority }) });
    await load();
  } catch (e) {
    alert(`Fout: ${e.message}`);
  }
}

async function addTask() {
  const street = $("newStreet").value.trim();
  const description = $("newDesc").value.trim();
  const priority = $("newPrio").value;

  if (!street) {
    alert("Straat is verplicht.");
    return;
  }

  try {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ street, description, priority, dueDate: state.dueDate })
    });
    $("newStreet").value = "";
    $("newDesc").value = "";
    await load();
  } catch (e) {
    alert(`Fout: ${e.message}`);
  }
}

function selectTask(id, focus = false) {
  state.selectedId = id;
  const t = state.tasks.find(x => x.id === id);
  const activeForTeam = state.tasks.find(x => x.team === state.team && (x.status === "CLAIMED" || x.status === "IMPOSED"));
  renderDetail(t, activeForTeam);
  if (focus && t) focusOnMap(t);
}

let map;

function initMap() {
  // Approx Schelle bounds (MVP). Adjust later if needed.
  const bounds = L.latLngBounds(
    L.latLng(51.105, 4.305),
    L.latLng(51.150, 4.385)
  );

  map = L.map("map", {
    center: [51.1258, 4.3399],
    zoom: 14,
    minZoom: 13,
    maxZoom: 19,
    maxBounds: bounds,
    maxBoundsViscosity: 0.9
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // Optional boundary + mask (placeholder geojson)
  fetch("assets/schelle-boundary.geojson")
    .then(r => r.json())
    .then(geo => {
      const boundary = L.geoJSON(geo, { style: { weight: 2, opacity: 0.9 } });
      boundary.addTo(map);

      // Create mask (world rectangle with hole)
      const world = [
        [-90, -180],
        [-90, 180],
        [90, 180],
        [90, -180]
      ];

      // Grab first polygon coords (rough MVP)
      let hole = null;
      try {
        const coords = geo.features[0].geometry.coordinates[0]; // [ [lng,lat], ... ]
        hole = coords.map(([lng, lat]) => [lat, lng]);
      } catch { /* ignore */ }

      if (hole) {
        const mask = L.polygon([world, hole], {
          stroke: false,
          fillOpacity: 0.35
        });
        mask.addTo(map);
      }
    })
    .catch(() => {});
}

function focusOnMap(t) {
  if (!map) return;
  const lat = t.lat, lng = t.lng;

  if (lat && lng) {
    panMarker(lat, lng, t.street);
    return;
  }

  // If no coords yet: best-effort geocode via Nominatim (client-side)
  // NOTE: In a production app you’d do this server-side + cache.
  const q = encodeURIComponent(`${t.street}, Schelle, Belgium`);
  fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${q}`, {
    headers: { "Accept-Language": "nl" }
  })
    .then(r => r.json())
    .then(results => {
      if (!results || !results.length) return;
      const r0 = results[0];
      const lat2 = parseFloat(r0.lat);
      const lng2 = parseFloat(r0.lon);
      panMarker(lat2, lng2, t.street);
    })
    .catch(() => {});
}

function panMarker(lat, lng, label) {
  map.setView([lat, lng], Math.max(map.getZoom(), 16));
  if (state.marker) state.marker.remove();
  state.marker = L.marker([lat, lng]).addTo(map).bindPopup(label).openPopup();
}

// UI bindings

function applyRoleUi() {
  const newCard = $("newTaskCard");
  const toggleBtn = $("newTaskToggle");
  const adminWrap = $("adminKeyWrap");
  if (adminWrap) adminWrap.classList.remove("hidden");
  if (!newCard || !toggleBtn) return;

  if (state.role === "admin") {
    try { localStorage.setItem("sc_forceAdmin", "1"); } catch {}
    if (adminWrap) adminWrap.classList.remove("hidden");
    toggleBtn.disabled = false;
    toggleBtn.classList.remove("hidden");
    // Start visible by default for admin
    newCard.classList.remove("hidden");
  } else {
    try { localStorage.removeItem("sc_forceAdmin"); } catch {}
    // Crew cannot create tasks
    newCard.classList.add("hidden");
    toggleBtn.classList.add("hidden");
  }
}



function saveWidgetLayout(){
  const cols = ["col1","col2","col3"];
  const layout = {};
  for (const cid of cols){
    const el = document.getElementById(cid);
    if (!el) continue;
    layout[cid] = Array.from(el.querySelectorAll(".widget"))
      .map(w => w.getAttribute("data-wid"));
  }
  localStorage.setItem("scw_widget_layout", JSON.stringify(layout));
}

function loadWidgetSizes(){
  try { return JSON.parse(localStorage.getItem("scw_widget_sizes") || "{}"); } catch { return {}; }
}

function saveWidgetSizes(sizes){
  try { localStorage.setItem("scw_widget_sizes", JSON.stringify(sizes || {})); } catch {}
}

function applyWidgetSizes(){
  const sizes = loadWidgetSizes();
  for (const w of document.querySelectorAll(".widget")){
    const id = w.getAttribute("data-wid");
    const s = id ? sizes[id] : null;
    if (s && s.h) { w.style.minHeight = `${Math.max(120, parseInt(s.h, 10) || 0)}px`; w.style.height = "auto"; }
  }
}

function applyWidgetLayout(){
  const raw = localStorage.getItem("scw_widget_layout");
  if (!raw) return;
  let layout = null;
  try { layout = JSON.parse(raw); } catch { return; }
  if (!layout) return;

  const byId = {};
  for (const w of document.querySelectorAll(".widget")){
    byId[w.getAttribute("data-wid")] = w;
  }
  for (const [cid, list] of Object.entries(layout)){
    const col = document.getElementById(cid);
    if (!col) continue;
    for (const wid of list){
      const node = byId[wid];
      if (node) col.appendChild(node);
    }
  }
}

function initWidgetBoard(){
  applyWidgetLayout();
  applyWidgetSizes();

  let dragged = null;
  let pDrag = null;   // { w, pid }
  let pResize = null; // { w, pid, startY, startH }

  for (const w of document.querySelectorAll(".widget")){
    w.draggable = true;
    w.addEventListener("dragstart", (e) => {
      // If a draggable child (e.g. a name pill) started the drag, don't hijack it.
      const childDraggable = e.target.closest('[draggable="true"]');
      if (childDraggable && childDraggable !== w) return;

      // Widget dragging: via handle or header
      const handle = e.target.closest(".dragHandle") || e.target.closest(".cardTitle");
      if (!handle) { e.preventDefault(); return; }
      dragged = w;
      w.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", w.getAttribute("data-wid"));
    });
    w.addEventListener("dragend", () => {
      if (dragged) dragged.classList.remove("dragging");
      dragged = null;
      saveWidgetLayout();
    });

    // Pointer-based drag fallback (works on PCs where HTML5 DnD can be flaky)
    const dh = w.querySelector(".dragHandle");
    if (dh) {
      dh.addEventListener("pointerdown", (ev) => {
        if (ev.button !== undefined && ev.button !== 0) return;
        // Don't start widget drag while resizing
        if (ev.target && ev.target.closest(".resizeHandle")) return;
        pDrag = { w, pid: ev.pointerId };
        w.classList.add("dragging");
        try { dh.setPointerCapture(ev.pointerId); } catch {}
        ev.preventDefault();
      });
    }

    // Resize handle (vertical)
    let rh = w.querySelector(".resizeHandle");
    if (!rh) {
      rh = document.createElement("div");
      rh.className = "resizeHandle";
      rh.title = "Grootte aanpassen";
      w.appendChild(rh);
    }
    rh.addEventListener("pointerdown", (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      const rect = w.getBoundingClientRect();
      pResize = { w, pid: ev.pointerId, startY: ev.clientY, startH: rect.height };
      w.classList.add("resizing");
      try { rh.setPointerCapture(ev.pointerId); } catch {}
      ev.preventDefault();
      ev.stopPropagation();
    });
  }

  const getDropBefore = (container, y) => {
    const els = [...container.querySelectorAll(".widget:not(.dragging)")];
    return els.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - (box.top + box.height / 2);
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      } else return closest;
    }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
  };

  for (const c of document.querySelectorAll(".column")){
    c.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (!dragged) return;
      const before = getDropBefore(c, e.clientY);
      if (before) c.insertBefore(dragged, before);
      else c.appendChild(dragged);
    });
    c.addEventListener("drop", (e) => {
      e.preventDefault();
      saveWidgetLayout();
    });
  }

  // Global pointer move/up for drag+resize
  const onPtrMove = (e) => {
    if (pResize && e.pointerId === pResize.pid) {
      const dy = e.clientY - pResize.startY;
      const nextH = Math.max(140, Math.min(1200, pResize.startH + dy));
      pResize.w.style.minHeight = `${Math.round(nextH)}px`;
      pResize.w.style.height = "auto";
      return;
    }
    if (pDrag && e.pointerId === pDrag.pid) {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const col = under ? under.closest(".column") : null;
      if (!col) return;
      const before = getDropBefore(col, e.clientY);
      if (before) col.insertBefore(pDrag.w, before);
      else col.appendChild(pDrag.w);
    }
  };

  const onPtrUp = (e) => {
    if (pResize && e.pointerId === pResize.pid) {
      const wid = pResize.w.getAttribute("data-wid");
      const sizes = loadWidgetSizes();
      sizes[wid] = sizes[wid] || {};
      sizes[wid].h = parseInt(pResize.w.style.minHeight || "", 10) || Math.round(pResize.w.getBoundingClientRect().height);
      pResize.w.style.height = "auto";
      saveWidgetSizes(sizes);
      pResize.w.classList.remove("resizing");
      pResize = null;
    }
    if (pDrag && e.pointerId === pDrag.pid) {
      pDrag.w.classList.remove("dragging");
      pDrag = null;
      saveWidgetLayout();
    }
  };

  window.addEventListener("pointermove", onPtrMove);
  window.addEventListener("pointerup", onPtrUp);
  window.addEventListener("pointercancel", onPtrUp);

  const reset = $("resetWidgets");
  if (reset) reset.onclick = () => {
    localStorage.removeItem("scw_widget_layout");
    localStorage.removeItem("scw_widget_sizes");
    location.reload();
  };
}


let liveRefreshTimer = null;

function armLiveRefresh(){
  if (liveRefreshTimer) clearInterval(liveRefreshTimer);
  liveRefreshTimer = null;
  if (state.role !== "admin") return;
  liveRefreshTimer = setInterval(() => {
    if (document.hidden) return;
    load().catch(() => {});
  }, 60000);
}

function initUI() {
  initWidgetBoard();
  state.dueDate = today();
  $("date").value = state.dueDate;

  $("date").onchange = () => { state.dueDate = $("date").value; load(); };
  $("status").onchange = () => { state.status = $("status").value; load(); };
  $("role").onchange = () => { state.role = $("role").value; applyRoleUi(); armLiveRefresh(); load(); };
  $("team").onchange = () => { state.team = $("team").value; load(); };
  $("userId").onchange = () => { state.userId = $("userId").value.trim() || "anon"; load(); };
  if ($("adminKey")) $("adminKey").oninput = () => { state.adminKey = $("adminKey").value.trim(); };
  // Admin: show/hide create panel via button
  const toggleBtn = $("newTaskToggle");
  const newCard = $("newTaskCard");
  if (toggleBtn && newCard) {
    toggleBtn.onclick = () => {
      newCard.classList.toggle("hidden");
    };
  }

  const mapBtn = $("toggleMap");
  const mapCard = $("mapCard");
  const syncMapToggle = () => {
    if (!mapBtn || !mapCard) return;
    const collapsed = mapCard.classList.contains("mapCollapsed");
    mapBtn.textContent = collapsed ? "Kaart uitklappen" : "Kaart inklappen";
    try { localStorage.setItem("scw_map_collapsed", collapsed ? "1" : "0"); } catch {}
    if (map) setTimeout(() => map.invalidateSize(), collapsed ? 220 : 120);
  };
  if (mapCard) {
    try {
      if (localStorage.getItem("scw_map_collapsed") === "1") mapCard.classList.add("mapCollapsed");
    } catch {}
  }
  syncMapToggle();
  if (mapBtn && mapCard){
    mapBtn.onclick = () => {
      mapCard.classList.toggle("mapCollapsed");
      syncMapToggle();
    };
  }

  if ($("randomTeams")) $("randomTeams").onclick = () => randomizeTeams();
  if ($("undoTeams")) $("undoTeams").onclick = () => undoLastAction();
  $("refresh").onclick = () => load();
  $("addTask").onclick = () => addTask();
  // Foremen button wiring
  renderForemenAdmin();
}

initUI();
initMap();
armLiveRefresh();
load().then(() => hideSplash()).catch(() => hideSplash());
setTimeout(() => hideSplash(), 2500);

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function applyStoredLayout(){
  const wLeft = parseInt(localStorage.getItem("scw_left") || "", 10);
  const wMap  = parseInt(localStorage.getItem("scw_map") || "", 10);
  if (Number.isFinite(wLeft)) document.documentElement.style.setProperty("--w-left", wLeft + "px");
  if (Number.isFinite(wMap))  document.documentElement.style.setProperty("--w-map", wMap + "px");
}

function resetLayout(){
  localStorage.removeItem("scw_left");
  localStorage.removeItem("scw_map");
  document.documentElement.style.setProperty("--w-left", "420px");
  document.documentElement.style.setProperty("--w-map", "520px");
  if (map) setTimeout(() => map.invalidateSize(), 80);
}

function initSplitLayout(){
  applyStoredLayout();

  const splitLeft = $("splitLeft");
  const splitMap  = $("splitMap");

  const startDrag = (which, ev) => {
    ev.preventDefault();
    const root = document.documentElement;
    const startX = ev.clientX;
    const rectLeft = $("leftPane").getBoundingClientRect();
    const rectMap  = $("mapPane").getBoundingClientRect();

    const startLeft = rectLeft.width;
    const startMap  = rectMap.width;

    const onMove = (e) => {
      const dx = e.clientX - startX;
      if (which === "left"){
        const next = clamp(startLeft + dx, 300, 720);
        root.style.setProperty("--w-left", next + "px");
        localStorage.setItem("scw_left", String(Math.round(next)));
      } else {
        // map width changes; keep some room for detail
        const next = clamp(startMap + dx, 320, 900);
        root.style.setProperty("--w-map", next + "px");
        localStorage.setItem("scw_map", String(Math.round(next)));
      }
      if (map) map.invalidateSize();
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (splitLeft) splitLeft.classList.remove("dragging");
      if (splitMap) splitMap.classList.remove("dragging");
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  if (splitLeft) splitLeft.onmousedown = (e) => { splitLeft.classList.add("dragging"); startDrag("left", e); };
  if (splitMap)  splitMap.onmousedown  = (e) => { splitMap.classList.add("dragging");  startDrag("map", e);  };

  const resetBtn = $("resetLayout");
  if (resetBtn) resetBtn.onclick = () => resetLayout();
}



