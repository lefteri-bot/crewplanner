(function(){
  if (typeof window === 'undefined' || !window.state || !window.api) return;

  const POOLS = window.SC_POOLS || ["GRND","POLY","WGNW","TRNSPRT","KRKHF"];
  const label = window.scPoolLabel || ((x)=>x);
  const norm = window.scNormalizePool || ((x)=>x || 'GRND');

  function poolOptions(selected){
    const cur = norm(selected);
    return POOLS.map(code => `<option value="${code}" ${code===cur?'selected':''}>${label(code)}</option>`).join('');
  }

  function ensureNewTaskPool(){
    const row = document.querySelector('#newTaskCard .newTaskRow');
    if (!row || document.getElementById('newPool')) return;
    const sel = document.createElement('select');
    sel.id = 'newPool';
    sel.className = 'poolInlineSelect';
    sel.innerHTML = poolOptions('GRND');
    const addBtn = document.getElementById('addTask');
    if (addBtn && addBtn.parentNode === row) row.insertBefore(sel, addBtn);
    else row.appendChild(sel);
  }

  async function saveTaskPool(taskId, pool){
    await api(`/api/tasks/${taskId}/pool`, {
      method: 'POST',
      body: JSON.stringify({ pool })
    });
  }

  function applyPoolBadgesToList(){
    const list = document.getElementById('list');
    if (!list || !Array.isArray(state.tasks)) return;
    const items = Array.from(list.children || []);
    items.forEach((item, idx) => {
      const t = state.tasks[idx];
      if (!t) return;
      const badges = item.querySelector('.badges');
      if (!badges || badges.querySelector('.poolTag')) return;
      const span = document.createElement('span');
      span.className = 'badge poolTag';
      span.textContent = label(t.pool);
      badges.appendChild(span);
    });
  }

  function applyPoolBadgesToActive(activeByTeam){
    const box = document.getElementById('activeTask');
    if (!box || !activeByTeam) return;
    for (const code of Object.keys(activeByTeam)){
      const t = activeByTeam[code];
      if (!t) continue;
      const teamTitle = Array.from(box.querySelectorAll('strong')).find(el => (el.textContent || '').trim().startsWith((window.teamLabel ? window.teamLabel(code) : code)));
      if (!teamTitle) continue;
      const card = teamTitle.closest('.item');
      const badges = card && card.querySelector('.badges');
      if (!badges || badges.querySelector('.poolTag')) continue;
      const span = document.createElement('span');
      span.className = 'badge poolTag compact';
      span.textContent = label(t.pool);
      badges.appendChild(span);
    }
  }

  function patchTeamSelect(task){
    const teamSel = document.getElementById('teamSel');
    if (!teamSel) return;
    const codes = (window.teamCodesList ? window.teamCodesList() : []).slice();
    if (!codes.length) return;
    const prev = task && task.team ? String(task.team).toUpperCase() : (state.team || codes[0]);
    teamSel.innerHTML = codes.map(code => `<option value="${code}">${window.teamLabel ? window.teamLabel(code) : code}</option>`).join('');
    teamSel.value = codes.includes(prev) ? prev : codes[0];
  }

  function enhanceDetail(task){
    const el = document.getElementById('detail');
    if (!el || !task) return;

    const pillRow = el.querySelector('.row');
    if (pillRow && !pillRow.querySelector('.poolPill')){
      const span = document.createElement('span');
      span.className = 'pill poolPill';
      span.textContent = label(task.pool);
      pillRow.appendChild(span);
    }

    patchTeamSelect(task);

    if (state.role !== 'admin' || document.getElementById('poolSel')) return;
    const adminHeader = Array.from(el.querySelectorAll('div')).find(node => (node.textContent || '').trim() === 'Admin');
    if (!adminHeader) return;
    const row = document.createElement('div');
    row.className = 'row';
    row.id = 'taskPoolRow';
    row.innerHTML = `
      <label style="min-width:120px">Pool:</label>
      <select id="poolSel" class="poolInlineSelect">${poolOptions(task.pool)}</select>
      <button class="smallbtn" id="poolSaveBtn">Opslaan</button>
    `;
    adminHeader.insertAdjacentElement('afterend', row);
    document.getElementById('poolSaveBtn').onclick = async () => {
      try {
        await saveTaskPool(task.id, document.getElementById('poolSel').value);
        await window.load();
      } catch (e) {
        alert(`Pool aanpassen lukt niet: ${e.message}`);
      }
    };
  }

  const baseAddTask = window.addTask;
  window.addTask = async function(){
    const street = (document.getElementById('newStreet')?.value || '').trim();
    const description = (document.getElementById('newDesc')?.value || '').trim();
    const priority = document.getElementById('newPrio')?.value || 'GREEN';
    const pool = norm(document.getElementById('newPool')?.value || 'GRND');
    if (!street) return alert('Straat is verplicht.');
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ street, description, priority, pool, dueDate: state.dueDate })
      });
      document.getElementById('newStreet').value = '';
      document.getElementById('newDesc').value = '';
      document.getElementById('newPool').value = pool;
      await window.load();
    } catch (e) {
      alert(`Fout: ${e.message}`);
    }
  };

  const baseRenderList = window.renderList;
  window.renderList = function(activeForTeam){
    baseRenderList(activeForTeam);
    applyPoolBadgesToList();
  };

  const baseRenderActiveTasks = window.renderActiveTasks;
  window.renderActiveTasks = function(activeByTeam){
    baseRenderActiveTasks(activeByTeam);
    applyPoolBadgesToActive(activeByTeam);
  };

  const baseRenderDetail = window.renderDetail;
  window.renderDetail = function(task, activeForTeam){
    baseRenderDetail(task, activeForTeam);
    enhanceDetail(task);
  };

  const baseRenderLibraryAdmin = window.renderLibraryAdmin;
  if (baseRenderLibraryAdmin) {
    window.renderLibraryAdmin = function(){
      baseRenderLibraryAdmin();
      const list = document.getElementById('libraryList');
      if (!list || !state.library || !Array.isArray(state.library.items)) return;
      Array.from(list.children).forEach((item, idx) => {
        const lib = state.library.items[idx];
        if (!lib) return;
        const left = item.firstElementChild;
        if (!left || left.querySelector('.poolMiniLine')) return;
        const div = document.createElement('div');
        div.className = 'poolMiniLine';
        div.textContent = `Pool: ${label(lib.pool)}`;
        left.appendChild(div);
      });
    };
  }

  window.loadDeviceLinks = async function(){
    const card = document.getElementById('deviceLinksCard');
    if (card) {
      if (state.role === 'admin') card.classList.remove('hidden'); else card.classList.add('hidden');
    }
    const list = document.getElementById('deviceLinksList');
    const btn = document.getElementById('reloadLinks');
    if (btn) btn.onclick = () => window.loadDeviceLinks();
    if (!list) return;
    if (state._serverRole !== 'admin') {
      list.innerHTML = `<div class="hint">Alleen admin.</div>`;
      return;
    }
    list.innerHTML = `<div class="hint">Laden…</div>`;
    try {
      const r = await api('/api/pairing/links');
      const rows = Array.isArray(r.rows) ? r.rows : [];
      if (!rows.length) {
        list.innerHTML = `<div class="hint">Geen gekoppelde gsm's.</div>`;
        return;
      }
      rows.sort((a,b) => (String(b.lastSeenAt||'')).localeCompare(String(a.lastSeenAt||'')));
      list.innerHTML = '';
      for (const it of rows) {
        const wrap = document.createElement('div');
        wrap.className = 'vehicleItem';
        const who = (it.employeeName || it.employeeId || '—').toString();
        const dev = (it.deviceId || '').toString();
        const seen = it.lastSeenAt ? (window.fmtTime ? window.fmtTime(it.lastSeenAt) : '') : '';
        const pools = Array.isArray(it.pools) && it.pools.length ? it.pools : ['GRND'];
        const left = document.createElement('div');
        left.innerHTML = `
          <strong>${who}</strong>
          <div class='mut'>Toestel: ${dev.length > 10 ? `${dev.slice(0,4)}…${dev.slice(-4)}` : dev}${seen ? ` • ${seen}` : ''}</div>
          <div class='poolCheckRow'></div>
        `;
        const row = left.querySelector('.poolCheckRow');
        for (const code of POOLS) {
          const id = `pool_${dev}_${code}`.replace(/[^a-zA-Z0-9_:-]/g, '_');
          const lab = document.createElement('label');
          lab.innerHTML = `<input type="checkbox" id="${id}" value="${code}" ${pools.includes(code) ? 'checked' : ''}/> ${label(code)}`;
          row.appendChild(lab);
        }
        row.addEventListener('change', async () => {
          const checked = Array.from(row.querySelectorAll('input:checked')).map(el => el.value);
          try {
            await api('/api/pairing/device-pools', { method: 'POST', body: JSON.stringify({ deviceId: dev, pools: checked }) });
          } catch (e) {
            alert(`Pools opslaan lukt niet: ${e.message}`);
            window.loadDeviceLinks();
          }
        });
        const right = document.createElement('div');
        right.className = 'row';
        right.style.gap = '8px';
        const ubtn = document.createElement('button');
        ubtn.className = 'smallbtn';
        ubtn.textContent = 'Ontkoppel';
        ubtn.onclick = () => window.unlinkDevice(dev, who);
        right.appendChild(ubtn);
        wrap.appendChild(left);
        wrap.appendChild(right);
        list.appendChild(wrap);
      }
    } catch (e) {
      list.innerHTML = `<div class="hint">Links laden lukt niet.</div>`;
    }
  };

  function init(){
    ensureNewTaskPool();
    const addBtn = document.getElementById('addTask');
    if (addBtn) addBtn.onclick = () => window.addTask();
    if (typeof window.load === 'function') {
      setTimeout(() => { try { window.load(); } catch {} }, 120);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
