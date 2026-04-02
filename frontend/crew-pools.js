(function(){
  if (typeof window === 'undefined' || !window.state || !window.api) return;
  const POOLS = window.SC_POOLS || ["GRND","POLY","WGNW","TRNSPRT","KRKHF"];
  const label = window.scPoolLabel || ((x)=>x);
  const norm = window.scNormalizePool || ((x)=>x || 'GRND');

  const baseHeaders = window.headers;
  window.headers = function(){
    const h = baseHeaders ? baseHeaders() : { 'Content-Type': 'application/json' };
    h['x-device-id'] = state.deviceId || '';
    return h;
  };

  function ensureForemanPoolField(){
    const row = document.querySelector('#foremanNewTask .crewRow:last-of-type');
    if (!row || document.getElementById('fmPool')) return;
    const sel = document.createElement('select');
    sel.id = 'fmPool';
    sel.style.flex = '1';
    sel.innerHTML = POOLS.map(code => `<option value="${code}">${label(code)}</option>`).join('');
    row.insertBefore(sel, row.querySelector('button'));
  }

  function updatePoolInfo(){
    const sub = document.getElementById('crewSub');
    if (!sub || !state.employee) return;
    const pools = Array.isArray(state.allowedPools) && state.allowedPools.length ? state.allowedPools : ['GRND'];
    sub.textContent = `Toestel: gekoppeld aan ${state.employee.name} • pools: ${pools.map(label).join(', ')}`;
  }

  async function refreshPools(){
    if (!state.deviceId) return;
    try {
      const me = await api(`/api/pairing/me?deviceId=${encodeURIComponent(state.deviceId)}`);
      state.allowedPools = Array.isArray(me.pools) && me.pools.length ? me.pools.map(norm) : ['GRND'];
      updatePoolInfo();
    } catch {}
  }

  function filterTasksForPools(rows){
    const allowed = Array.isArray(state.allowedPools) && state.allowedPools.length ? state.allowedPools : ['GRND'];
    return (rows || []).filter(t => t && (t.status !== 'FREE' || allowed.includes(norm(t.pool))));
  }

  function decorateTaskList(filteredRows){
    const list = document.getElementById('crewTasks');
    if (!list) return;
    Array.from(list.children).forEach((item, idx) => {
      const t = filteredRows[idx];
      if (!t) return;
      const badges = item.querySelector('.badges');
      if (!badges || badges.querySelector('.poolTag')) return;
      const span = document.createElement('span');
      span.className = 'badge poolTag compact';
      span.textContent = label(t.pool);
      badges.appendChild(span);
    });
  }

  const baseCheckMe = window.checkMe;
  window.checkMe = async function(){
    const out = await baseCheckMe();
    await refreshPools();
    return out;
  };

  const baseLoadTasks = window.loadTasks;
  window.loadTasks = async function(){
    const out = await baseLoadTasks();
    updatePoolInfo();
    return out;
  };

  const baseRenderTasks = window.renderTasks;
  window.renderTasks = function(){
    const original = Array.isArray(state.tasks) ? state.tasks.slice() : [];
    const originalReq = state.requiredPriority;
    const filtered = filterTasksForPools(original);
    state.tasks = filtered;
    state.requiredPriority = (typeof window.requiredPriorityForClaim === 'function') ? window.requiredPriorityForClaim(filtered) : originalReq;
    try {
      baseRenderTasks();
      decorateTaskList(filtered);
    } finally {
      state.tasks = original;
      state.requiredPriority = originalReq;
    }
  };

  const baseSetActiveUI = window.setActiveUI;
  window.setActiveUI = function(active){
    baseSetActiveUI(active);
    const box = document.getElementById('activeBox');
    if (!box || !active || box.querySelector('.poolMiniLine')) return;
    const div = document.createElement('div');
    div.className = 'poolMiniLine';
    div.textContent = `Pool: ${label(active.pool)}`;
    box.appendChild(div);
  };

  const baseAddForemanTask = window.addForemanTask;
  window.addForemanTask = async function(){
    if (!state.foreman) return alert('Activeer eerst je ploegbaas code.');
    const streetEl = document.getElementById('fmStreet');
    const descEl = document.getElementById('fmDesc');
    const prioEl = document.getElementById('fmPrio');
    const impEl = document.getElementById('fmImposeTeam');
    const poolEl = document.getElementById('fmPool');
    const street = streetEl ? streetEl.value.trim() : '';
    const description = descEl ? descEl.value.trim() : '';
    const priority = prioEl ? prioEl.value : 'GREEN';
    const imposeTeam = impEl ? impEl.value : '';
    const pool = norm(poolEl ? poolEl.value : 'GRND');
    if (!street) return alert('Straat invullen.');
    try{
      await apiAsForeman('/api/tasks', {
        method:'POST',
        body: JSON.stringify({ street, description, priority, pool, dueDate: state.dueDate, imposeTeam: imposeTeam || null })
      });
      if (streetEl) streetEl.value = '';
      if (descEl) descEl.value = '';
      await loadTasks();
      await loadActiveTasks();
      alert(imposeTeam ? 'Taak opgelegd.' : 'Taak toegevoegd.');
    }catch(e){
      alert(`Nieuwe taak: ${e.message}`);
    }
  };

  function init(){
    ensureForemanPoolField();
    const addBtn = document.getElementById('fmAdd');
    if (addBtn) addBtn.onclick = () => window.addForemanTask();
    setTimeout(() => { refreshPools().then(() => { try { window.loadTasks(); } catch {} }); }, 300);
    setInterval(() => { refreshPools().catch(() => {}); }, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
