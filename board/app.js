(() => {
  const API = '/.netlify/functions/state';
  const RESEARCH_API = '/.netlify/functions/research';
  const STAGES = ['lead','in-conversation','applied','interviewing','offer','closed'];
  const ODDS = ['unknown','low','medium','high'];
  const TIERS = ['real','practice'];
  const SPRINT_DAYS = 21, SPRINT_GOALS = {screens: 5, finished: 2};
  const RECORD_API = '/.netlify/functions/record';   // application records (record.mjs): what each run put on the form
  const LESSONS_API = '/.netlify/functions/lessons', MAIL_API = '/.netlify/functions/mail', HUNT_API = '/.netlify/functions/hunt';
  // apply loop statuses (separate maps: 'real' collides with the tier label)
  const AL = {candidate:'In the hunt', prepared:'Prepared', approved:'Queued', submitting:'Submitting', submitted:'Submitted', confirmed:'Confirmed', unverified:'Unverified', blocked:'Blocked', failed:'Failed', skipped:'Forfeited', manual:'By hand', real:'Real lead'};
  const ACLS = {candidate:'c-accent-line', prepared:'c-warn', approved:'c-accent', submitting:'c-accent-line', submitted:'c-ok', confirmed:'c-ok', unverified:'c-hot', blocked:'c-hot', failed:'c-hot', skipped:'c-mute', manual:'c-mute', real:'c-practice'};
  const ATITLE = {candidate:'Found by the finder; the grader and preparer have not finished with it yet.', prepared:'Prepared by the nightly hunt but not queued (an answer was missing, or hands-off mode is off). Approve it here to queue it.', approved:'Queued. The PC worker submits it the next time the computer is on.', submitting:'The PC worker is on it right now.', submitted:'Form submitted, waiting for the receipt email.', confirmed:'Receipt email filed by the mail clerk. Proven.', unverified:'No receipt after 3 days, or the worker was interrupted after the click. Check by hand, never retried.', blocked:'The worker hit a captcha, login wall or bot check.', failed:'The worker failed before anything was sent. See the reason.', skipped:'Forfeited by the board (no recipe for the form, an unanswered screener, a flag) or skipped by Eyal. Back to prepared revives it.', manual:'Not an ATS the runner handles. Apply by hand or skip.', real:'Graded above 6 or could not be graded. Never applied to by the system.'};
  const APPLY_ORDER = ['candidate','prepared','approved','submitting','submitted','confirmed','unverified','blocked','failed','manual','real','skipped'];
  const ROUNDS = ['HR screen','Hiring manager','Case interview','Home assignment','Technical interview','Final','Other'];
  const LTYPES = ['do','dont','general'], LSTATUS = ['new','practicing','nailed'], IMPS = ['10','9','8','7','6','5','4','3','2','1'];
  const LHINT = {do: 'Behaviours to repeat.', dont: 'Behaviours to stop.', general: 'How companies decide and what rounds really test.'};
  const KIND_ORDER = ['people','platforms','sources'];
  const KINDS = {
    people:    {one:'Person',   many:'People',    ph:'Untitled person',   whoL:'Who',  whoPh:'Who this is, how I know them', whyPh:'What they can open for me, what to ask', empty:'No one here yet. Add a person.', status:['to-ask','asked','replied','done'], cos:'Companies', cosEmpty:'No companies yet. Add one or link an existing one.'},
    platforms: {one:'Platform', many:'Platforms', ph:'Untitled platform', whoL:'What', whoPh:'Which board or site, the filters I use, how often I check', whyPh:'What kind of companies show up here', empty:'No platforms yet. Add a job board or site.', status:['to-check','checked','paused'], cos:'Companies found here', cosEmpty:'No companies yet. Add one you found here or link an existing one.'},
    sources:   {one:'Source',   many:'Sources',   ph:'Untitled source',   whoL:'What', whoPh:'Where this lead came from', whyPh:'Why it matters', empty:'No sources yet. Add where a lead came from.', status:['to-ask','asked','replied','done'], cos:'Companies', cosEmpty:'No companies yet. Add one or link an existing one.'},
  };
  const L = {lead:'Lead','in-conversation':'In conversation',applied:'Applied',interviewing:'Interviewing',offer:'Offer',closed:'Closed',
    unknown:'Odds ?',low:'Low odds',medium:'Medium odds',high:'High odds',
    'to-ask':'To ask',asked:'Asked',replied:'Replied',done:'Done','to-check':'To check',checked:'Checked',paused:'Paused',
    people:'People',platforms:'Platforms',sources:'Sources', strong:'Top option', maybe:'Mid option', no:'Lower rated',
    real:'Real', practice:'Practice', do:'Do', dont:"Don't", general:'Good to know', new:'To review', practicing:'Requires work', nailed:'Nailed', reply:'Reply needed', rejected:'Rejected', update:'Heads-up', ack:'Application received', auto:'Auto-added'};
  const CLS = {lead:'','in-conversation':'c-accent',applied:'c-warn',interviewing:'c-hot',offer:'c-ok',closed:'c-mute',
    unknown:'',low:'c-mute',medium:'c-warn',high:'c-ok',
    'to-ask':'',asked:'c-accent-line',replied:'c-accent',done:'c-mute','to-check':'',checked:'c-ok',paused:'c-mute',
    people:'c-accent-line',platforms:'c-accent-line',sources:'c-accent-line', strong:'c-ok', maybe:'c-warn', no:'c-mute',
    real:'c-mute', practice:'c-practice', do:'c-do', dont:'c-dont', general:'c-know', new:'c-warn', practicing:'c-hot', nailed:'c-ok', reply:'c-hot', rejected:'c-mute', update:'c-accent-line', ack:'c-ok', auto:'c-warn'};
  const COLL = {channel:'channels', person:'people', company:'companies', role:'roles', task:'tasks', lesson:'lessons'};
  const CYCLE = {stage:STAGES, odds:ODDS, kind:KIND_ORDER, tier:TIERS, ltype:LTYPES, lstatus:LSTATUS, round:ROUNDS, imp:IMPS};
  const FIELD_OF = {ltype:'type', lstatus:'status', imp:'importance'};   // chip key -> stored field, where they differ
  const PH = {company:'Untitled company', role:'Untitled role', channel:'Untitled channel'};
  const KEY_LS = 'pipeline.key', RT_KEY = 'pipeline.route', FILTER_KEY = 'pipeline.filter', LF_KEY = 'pipeline.lfilter', HOME_KEY = 'pipeline.home';
  let roleFilter = 'all'; try { roleFilter = sessionStorage.getItem(FILTER_KEY) || 'all'; } catch (e) {}
  let lessonFilter = 'all'; try { lessonFilter = sessionStorage.getItem(LF_KEY) || 'all'; } catch (e) {}
  // Home is split in two: the real search and the practice tier + automation never share a screen
  let homeTier = 'real'; try { homeTier = sessionStorage.getItem(HOME_KEY) === 'practice' ? 'practice' : 'real'; } catch (e) {}
  const CE = (() => { const d = document.createElement('div'); try { d.contentEditable = 'plaintext-only'; } catch (e) {} return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; })();

  // ---- state + sync ----
  let features = {};
  let state = null, rev = -1, dirty = false, saving = false, saveTimer = null, pendingFocus = null, keepScroll = false;
  let key = ''; try { key = localStorage.getItem(KEY_LS) || ''; } catch (e) {}

  const $ = s => document.querySelector(s);
  const page = $('#page');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const fmt = d => new Date(d).toLocaleDateString('en-GB', {day:'numeric', month:'short'});
  const fmtT = d => new Date(d).toLocaleString('en-GB', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
  function getDebrief(id) { for (const r of state.roles) { const d = (r.debriefs || []).find(x => x.id === id); if (d) return d; } for (const c of state.companies) { const d = (c.debriefs || []).find(x => x.id === id); if (d) return d; } return null; }
  const get = (t, id) => t === 'debrief' ? getDebrief(id) : (state[COLL[t]] || []).find(x => x.id === id);
  const href = (t, x) => `#/${t}/${x.id}`;
  const editing = () => !!document.activeElement?.closest?.('[data-f]');

  const hdr = () => ({'Content-Type': 'application/json', 'x-key': key});
  async function load() {
    let r;
    try { r = await fetch(API + (rev >= 0 ? `?rev=${rev}` : ''), {headers: hdr()}); } catch (e) { setSave('ro', 'Offline'); return false; }
    if (r.status === 401) { gate(true); return false; }
    const d = await r.json();
    if (d.unchanged) return true;
    if (d.rev === rev) return true;
    if (dirty) return true; // our unsaved edits win; the save will reconcile
    state = d.state; rev = d.rev; if (d.features) features = d.features;
    if (!editing()) { keepScroll = true; render(); }
    setSave('', 'Saved');
    return true;
  }
  function touch() { state.updatedAt = new Date().toISOString(); dirty = true; setSave('busy', 'Saving…'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 700); }
  async function save() {
    if (!dirty || saving) return;
    saving = true;
    try {
      const r = await fetch(API, {method: 'POST', headers: hdr(), body: JSON.stringify({baseRev: rev, state})});
      if (r.status === 401) { gate(true); return; }
      const d = await r.json();
      if (r.status === 409) { // someone else saved first: adopt theirs, keep our text if we are mid-edit
        toast('Updated from another device.'); state = d.state; rev = d.rev; dirty = false; if (!editing()) { keepScroll = true; render(); } setSave('', 'Saved'); return;
      }
      if (!r.ok) { setSave('busy', 'Will retry'); setTimeout(() => { saving = false; save(); }, 4000); return; }
      rev = d.rev; dirty = false; setSave('', 'Saved');
    } catch (e) { setSave('busy', 'Will retry'); setTimeout(() => { saving = false; save(); }, 4000); return; }
    finally { saving = false; }
    if (dirty) save();
  }
  function commit() { touch(); keepScroll = true; render(); clearTimeout(saveTimer); save(); }
  setInterval(() => { if (!document.hidden && !dirty && !saving && state) load(); }, 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state) load(); });

  // ---- access key gate ----
  function gate(on) { $('#gate').hidden = !on; if (on) { setSave('ro', 'Locked'); setTimeout(() => $('#gateKey').focus(), 0); } }
  $('#gateForm').addEventListener('submit', async e => {
    e.preventDefault(); key = $('#gateKey').value.trim();
    try { localStorage.setItem(KEY_LS, key); } catch (x) {}
    $('#gateErr').textContent = '';
    const r = await fetch(API, {headers: hdr()});
    if (r.status === 401) { $('#gateErr').textContent = 'That key did not work.'; return; }
    gate(false); rev = -1; await load();
  });

  // ---- kinds + derived ----
  const guessKind = ch => { const n = (ch && ch.name || '').toLowerCase(); return /platform|board|site|online|web/.test(n) ? 'platforms' : /relation|people|network|friend|contact/.test(n) ? 'people' : 'sources'; };
  const kindOf = ch => KINDS[ch && ch.kind] || KINDS[guessKind(ch)];
  const kindOfP = p => kindOf(get('channel', p.channelId));
  const isPerson = p => kindOfP(p) === KINDS.people;
  const nm = (x, fb) => x && x.name && x.name.trim() ? x.name.trim() : fb;
  const label = (t, x) => nm(x, t === 'person' ? kindOfP(x).ph : PH[t]);
  const roleLabel = r => r.title && r.title.trim() ? r.title.trim() : PH.role;
  const peopleOf = c => state.people.filter(p => c.peopleIds.includes(p.id));
  const companiesOf = p => state.companies.filter(c => c.peopleIds.includes(p.id));
  const rolesOf = c => state.roles.filter(r => r.companyId === c.id);
  const secondDeg = p => state.people.filter(x => x.viaId === p.id);
  const tasksOf = (type, id) => state.tasks.filter(t => (type ? (t.owner && t.owner.type === type && t.owner.id === id) : !t.owner));
  const rolesViaChannel = ch => { const ids = new Set(state.people.filter(p => p.channelId === ch.id).map(p => p.id));
    return state.roles.filter(r => r.viaId ? ids.has(r.viaId) : (get('company', r.companyId) || {peopleIds: []}).peopleIds.some(i => ids.has(i))); };
  const ownerOf = t => t.owner ? get(t.owner.type, t.owner.id) : null;
  const typeName = (type, o) => type === 'person' && o ? kindOfP(o).one.toLowerCase() : type;
  // practice tier: roles I run only for interview reps; they never mix into the real numbers
  const tierOf = x => x && x.tier === 'practice' ? 'practice' : 'real';
  const isPractice = x => tierOf(x) === 'practice';
  const practiceRoles = () => state.roles.filter(isPractice);
  const visibleRoles = () => roleFilter === 'all' ? state.roles : state.roles.filter(r => tierOf(r) === roleFilter);
  const visibleCompanies = () => roleFilter === 'all' ? state.companies : state.companies.filter(c => tierOf(c) === roleFilter);
  // which home a task belongs to: company/role tasks follow their tier, everything else (people, channels, general) is the real search
  const tierOfTask = t => t.owner && (t.owner.type === 'company' || t.owner.type === 'role') ? tierOf(get(t.owner.type, t.owner.id)) : 'real';
  const stageAtLeast = (r, s) => STAGES.indexOf(r.stage) >= STAGES.indexOf(s);
  const lessons = () => state.lessons || [];
  const lstatus = l => l.status || 'new';
  const limp = l => { const n = Number(l.importance); return n >= 1 && n <= 10 ? Math.round(n) : 5; };
  const debriefsOfCompany = c => [...(c.debriefs || []), ...rolesOf(c).flatMap(r => r.debriefs || [])];
  const pendingDebriefs = c => debriefsOfCompany(c).filter(d => (d.text || '').trim() && !d.distilledAt);
  const ownerOfDebrief = id => state.roles.find(r => (r.debriefs || []).some(d => d.id === id)) || state.companies.find(c => (c.debriefs || []).some(d => d.id === id)) || null;
  const DAY = 86400000;
  const daysLeft = sp => Math.ceil((new Date(sp.endsAt).getTime() - Date.now()) / DAY);
  const sprintStats = () => { const pr = practiceRoles(); return {
    marked: pr.length,
    applied: pr.filter(r => stageAtLeast(r, 'applied')).length,
    screens: pr.filter(r => r.screened).length,
    finished: pr.filter(r => r.screened && (r.stage === 'offer' || r.stage === 'closed')).length,
  }; };

  // ---- apply loop (practice tier hunt + runner) ----
  const hunt = () => { state.hunt = state.hunt || {}; const h = state.hunt; h.caps = Object.assign({found: 10, prepared: 5}, h.caps || {}); h.denyExtra = h.denyExtra || ''; h.applied = h.applied || []; h.runs = h.runs || []; return h; };
  const applyOf = r => r && r.apply && r.apply.status ? r.apply : null;
  const applyChip = r => { const a = applyOf(r); return a ? `<span class="chip ${ACLS[a.status] || ''}" title="${esc(ATITLE[a.status] || '')}">${AL[a.status] || esc(a.status)}</span>` : ''; };
  const applyRoles = () => state.roles.filter(r => applyOf(r));
  const HSTAGE = {candidate:'waiting for the grader', grading:'grading', graded:'waiting for the preparer', preparing:'preparing', failed:'failed', done:'done', dropped:'dropped'};
  const huntStage = r => { const c = get('company', r.companyId); return c && c.hunt ? (HSTAGE[c.hunt.status] || c.hunt.status) : ''; };
  const tonight = () => applyRoles().filter(r => r.apply.status === 'candidate');
  const applyQueue = () => { const q = {}; APPLY_ORDER.forEach(k => q[k] = 0); applyRoles().forEach(r => { q[r.apply.status] = (q[r.apply.status] || 0) + 1; }); return q; };
  const huntStale = () => { const lr = hunt().lastRun; if (!lr) return 'The hunt has never run.'; if (!lr.ok) return 'The last hunt failed.'; const age = Date.now() - new Date(lr.at).getTime(); return age > DAY ? `No hunt in ${Math.floor(age / DAY)} day${age >= 2 * DAY ? 's' : ''} - check the scheduled finder on Netlify (Functions > hunt-find).` : ''; };
  const funnelLine = f => { if (!f) return ''; const d = f.dropped || {}; const drops = Object.keys(d).filter(k => d[k]).map(k => `${k} ${d[k]}`).join(', '); return `<span class="funnel"><b class="mono">${f.found || 0}</b> found<i>·</i><b class="mono">${f.graded || 0}</b> graded<i>·</i><b class="mono">${f.prepared || 0}</b> prepared<i>·</i><b class="mono">${f.realLeads || 0}</b> real leads${drops ? `<i>·</i><span class="dim">dropped: ${esc(drops)}</span>` : ''}</span>`; };
  const applyRow = r => { const c = get('company', r.companyId); const a = r.apply; const g = c && c.research && c.research.fit && c.research.fit.grade; return `<div class="row arow"><span class="nc"><a class="n clip" href="${href('role', r)}">${esc(roleLabel(r))}</a></span><span class="clip"><a href="${c ? href('company', c) : '#/'}">${esc(c ? label('company', c) : '?')}</a>${Number.isInteger(g) ? ` <span class="dim mono">${g}</span>` : ''}</span><span>${applyChip(r)}</span><span class="dim clip">${esc(a.cv || '')}</span><span class="dim clip" title="${esc(a.reason || '')}">${a.status === 'candidate' ? `<span class="dim">${esc(huntStage(r))}</span>` : a.needsHuman && a.needsHuman.length ? `<span class="chip c-warn">${a.needsHuman.length} need you</span>` : esc(a.reason || a.sentence || '')}${a.fitNotes ? ` <span class="dim" title="${esc(a.fitNotes)}">· fit notes</span>` : ''}</span><span class="acts">${applyButtons(r, true)}</span></div>`; };
  function applyButtons(r, compact) {
    const a = applyOf(r); if (!a) return '';
    const b = (st, txt, cls = 'quiet', extra = '') => `<button class="btn ${cls}" data-apply="${st}" data-id="${r.id}" ${extra}>${txt}</button>`;
    const open = a.needsHuman && a.needsHuman.length;
    if (a.status === 'prepared') return (open ? `<span class="dim small">${a.needsHuman.length} screener${a.needsHuman.length === 1 ? '' : 's'} need an answer</span>` : b('approved', 'Approve', '')) + b('skipped', 'Skip');
    if (a.status === 'approved') return b('prepared', 'Un-queue') + b('skipped', 'Skip');
    const co = get('company', r.companyId); const fromHunt = co && co.hunt;
    if (['failed', 'skipped'].includes(a.status) && fromHunt && !a.cv) return b('candidate', 'Re-queue for the hunt', 'quiet', 'data-arm="1"');
    if (['blocked', 'failed', 'unverified', 'skipped'].includes(a.status)) return b('prepared', 'Back to prepared', 'quiet', 'data-arm="1"') + (fromHunt ? b('candidate', 'Re-queue', 'quiet', 'data-arm="1"') : '');
    if (a.status === 'manual') return b('submitted', 'Mark applied by hand', 'quiet', 'data-arm="1"') + (compact ? '' : b('prepared', 'Let the runner try', 'quiet', 'data-arm="1"'));
    if (a.status === 'real' && !compact) return `<span class="dim small">Real lead. Decide by hand on the role page.</span>`;
    return '';
  }
  function applyLoopBlock() {
    const h = hunt(); const lr = h.lastRun; const run = state.huntRun || {}; const q = applyQueue(); const stale = huntStale();
    const pend = tonight().length;
    const acts = (run.status === 'running' ? `<span class="running"><span class="spin"></span>Hunting… ${esc(run.step || '')}</span>` : `<button class="btn quiet" data-huntnow="1" title="Run tonight's finder now: Drushim, AllJobs, LinkedIn, the job boards on the list. About a minute.">Hunt now</button>`) + (pend ? `<button class="btn quiet" data-kick="1" title="Nudge the chain: re-fires a stuck grader or preparer">Kick (${pend} in the hunt)</button>` : '') + `<button class="btn ${h.killSwitch ? 'danger kill on' : 'quiet kill'}" data-kill="1" title="${h.killSwitch ? 'The hunt writes nothing, nothing is queued, the PC worker gets no cards. Click to switch back on.' : 'Stop everything: the hunt writes nothing, nothing is queued, the PC worker gets no cards.'}">${h.killSwitch ? 'Kill switch ON' : 'Kill switch'}</button>`;
    const warn = (stale ? `<div class="rbox err">${esc(stale)}</div>` : '') + (run.status === 'error' ? `<div class="rbox err">Could not start the hunt: ${esc(run.error || 'unknown error')}.</div>` : '') + (h.killSwitch ? `<div class="rbox err">Kill switch is on. The nightly hunt logs a no-op, nothing is queued and the PC worker gets no cards until you switch it off.</div>` : '');
    const stats = `<div class="stats apply">${APPLY_ORDER.filter(k => k !== 'skipped').map(k => `<a class="stat ${q[k] ? '' : 'dim'}" href="#/apply?s=${k}" title="${esc(ATITLE[k])}"><b class="mono">${q[k]}</b><span>${AL[k]}</span></a>`).join('')}</div>`;
    const last = lr ? `<div class="mail-line"><span class="mail-when">Last hunt ${esc(fmtT(lr.at))}${lr.noop ? ' <span class="chip c-mute">no-op</span>' : ''}</span>${funnelLine(lr.funnel)}${lr.pending ? `<span class="chip c-accent-line" title="Candidates still being graded or prepared">${lr.pending} in progress</span>` : ''}</div>${(lr.errors || []).length ? `<div class="rbox err small">${lr.errors.map(esc).join('<br>')}</div>` : ''}` : `<div class="dim">The nightly hunt has not run yet. Once it is set up on claude.ai it finds practice-tier roles every night, grades the companies, preps the application and leaves the cards here for the morning brief.</div>`;
    const prepared = applyRoles().filter(r => r.apply.status === 'prepared');
    const queued = applyRoles().filter(r => r.apply.status === 'approved' || r.apply.status === 'submitting');
    const forfeited = applyRoles().filter(r => r.apply.status === 'skipped' && /^forfeited/.test(r.apply.reason || '') && r.apply.preparedAt && Date.now() - new Date(r.apply.preparedAt).getTime() < 7 * DAY);
    const w = h.worker || {}; const wt = w.today && w.today.date === new Date().toISOString().slice(0, 10) ? w.today : null;
    const wAge = w.lastAt ? Date.now() - new Date(w.lastAt).getTime() : null;
    const workerLine = `<div class="mail-line"><span class="mail-when">${w.lastAt ? `PC worker ran ${esc(fmtT(w.lastAt))}` : 'PC worker has not reported yet'}</span>${wt ? `<span class="funnel">today: <b class="mono">${wt.submitted || 0}</b> submitted<i>·</i><b class="mono">${wt.failed || 0}</b> failed<i>·</i><b class="mono">${wt.blocked || 0}</b> blocked<i>·</i><b class="mono">${wt.unverified || 0}</b> unverified<i>·</i><b class="mono">${wt.runs || 0}</b> runs</span>` : ''}${w.lastError ? `<span class="chip c-hot" title="The one thing the worker cannot fix by itself">${esc(w.lastError)}</span>` : ''}</div>`;
    const workerWarn = queued.length && (wAge === null || wAge > DAY) ? `<div class="rbox err">${queued.length} card${queued.length === 1 ? '' : 's'} in the queue but the PC worker ${wAge === null ? 'has never run' : `has not run in ${Math.floor(wAge / DAY)} day${wAge >= 2 * DAY ? 's' : ''}`}. Is the computer on and the scheduled task JobApplyWorker enabled?</div>` : '';
    const attention = applyRoles().filter(r => ['blocked', 'failed', 'unverified'].includes(r.apply.status));
    const real = applyRoles().filter(r => r.apply.status === 'real' && r.stage === 'lead');
    const list = (rs, title2) => rs.length ? `<h3 class="sub-h">${esc(title2)}</h3><div class="rows apply">${rs.map(applyRow).join('')}</div>` : '';
    const inHunt = tonight();
    const settings = `<div class="hunt-settings"><label class="caps">Cap per night <input type="number" min="0" max="50" data-cap="prepared" value="${h.caps.prepared}"> prepared, <input type="number" min="0" max="50" data-cap="found" value="${h.caps.found}"> candidates, <input type="number" min="0" max="50" data-cap="offered" value="${h.caps.offered ?? 40}"> offered to the sorter, <input type="number" min="1" max="5" data-cap="concurrency" value="${h.concurrency || 1}"> agent${(h.concurrency || 1) === 1 ? '' : 's'} at a time</label><label class="caps">PC worker: <input type="number" min="0" max="20" data-cap="perDay" value="${h.caps.perDay ?? 8}"> submissions per day · <input type="checkbox" data-autoq="1" ${h.autoQueue === false ? '' : 'checked'}> hands-off (prepared cards are queued without a morning approval; the rest is forfeited)</label><label>Dreamlist - never touched, one company or domain per line<textarea data-hunt="denyExtra" rows="2" placeholder="e.g. Hooli&#10;openai.com">${esc(h.denyExtra)}</textarea></label><label>Job boards to check first - one per line, ats + slug<textarea data-hunt="seeds" rows="2" placeholder="greenhouse acme&#10;lever globex&#10;comeet initech/A0.002">${esc(h.seeds || '')}</textarea></label></div>`;
    const runs = h.runs.length > 1 ? `<details class="runs"><summary>${h.runs.length} runs</summary>${h.runs.map(x => `<div class="run-line"><span class="mail-when">${esc(fmtT(x.at))}</span>${x.noop ? '<span class="chip c-mute">no-op</span>' : funnelLine(x.funnel)}</div>`).join('')}</details>` : '';
    return sec('Apply loop', acts, `${warn}${workerWarn}<div class="mailbox">${last}${workerLine}</div>${stats}${list(inHunt, 'Tonight, still in the hunt')}${list(queued, 'Queue for the PC worker')}${list(prepared, h.autoQueue === false ? 'Waiting for the morning brief' : 'Prepared, not queued - approve or skip')}${list(forfeited, 'Forfeited this week - revive by hand if you want one')}${list(attention, 'Needs a look')}${list(real, 'Real leads the hunt found - yours to decide')}${settings}${runs}`, 'applysec');
  }
  function applySection(r) {
    const a = applyOf(r); if (!a) return '';
    const c = get('company', r.companyId);
    const row = (k, v) => v ? `<div class="afield"><span class="ak">${esc(k)}</span><span class="av">${v}</span></div>` : '';
    const fields = (a.fields || []).length ? `<div class="afield"><span class="ak">Form fields</span><span class="av dim">${a.fields.map(f => `${esc(f.label || f.name)}${f.required ? '*' : ''}`).join(', ')}</span></div>` : '';
    const scr = (a.screeners || []).length ? `<div class="afield col"><span class="ak">Screeners</span>${a.screeners.map(sq => { const ans = (a.answers || {})[sq.q] || ''; return `<div class="screener ${ans ? '' : 'needs'}"><div class="sq">${esc(sq.q)}${sq.options && sq.options.length ? ` <span class="dim">(${esc(sq.options.join(' / '))})</span>` : ''}</div><div class="f sa" contenteditable="${CE}" data-ans="${esc(sq.q)}" data-id="${r.id}" data-ph="${ans ? '' : 'Needs you - type the answer'}">${esc(ans)}</div></div>`; }).join('')}</div>` : '';
    const when = [a.preparedAt && `prepared ${fmtT(a.preparedAt)}`, a.approvedAt && `approved ${fmtT(a.approvedAt)}`, a.submittedAt && `submitted ${fmtT(a.submittedAt)}`, a.confirmedAt && `confirmed ${fmtT(a.confirmedAt)}`, a.unverifiedAt && `unverified ${fmtT(a.unverifiedAt)}`, a.blockedAt && `blocked ${fmtT(a.blockedAt)}`, a.failedAt && `failed ${fmtT(a.failedAt)}`].filter(Boolean).join(' · ');
    const body = `<div class="abox">${row('Status', `${applyChip(r)} <span class="dim small">${esc(ATITLE[a.status] || '')}</span>`)}${row('Apply', `${link(a.url, a.ats ? `${a.ats} form` : 'form')}${a.location ? ` <span class="dim">· ${esc(a.location)}</span>` : ''}`)}${row('CV', a.cv ? `<span class="mono">${esc(a.cv)}</span>${a.title ? ` with title "${esc(a.title)}"` : ''}${a.pdf ? ` · <span class="dim">${esc(a.pdf)}</span>` : ''}` : '')}${fields}${scr}${row('For the brief', esc(a.sentence))}${row('Fit notes', esc(a.fitNotes))}${(a.errors || []).length ? row('Preparer notes', a.errors.map(esc).join('<br>')) : ''}${row('Reason', esc(a.reason))}${row('Proof', a.screenshot ? `<span class="mono">${esc(a.screenshot)}</span>` : '')}${a.log ? `<details class="alog"><summary>Runner log</summary><pre>${esc(a.log)}</pre></details>` : ''}${row('Timeline', esc(when))}</div>`;
    return sec('Application', applyButtons(r, false), body, 'applysec');
  }

  // ---- components ----
  const bc = items => `<div class="bc">${items.map((it, i) => i < items.length - 1 ? `<a href="${it[1]}">${esc(it[0])}</a><span class="sep">/</span>` : `<span>${esc(it[0])}</span>`).join('')}</div>`;
  const field = (t, id, f, ph, cls = '') => `<div class="f ${cls}" contenteditable="${CE}" data-t="${t}" data-id="${id}" data-f="${f}" data-ph="${esc(ph)}">${esc(get(t, id)[f])}</div>`;
  const title = (t, id, ph, f = 'name') => `<h1 class="title f" contenteditable="${CE}" data-t="${t}" data-id="${id}" data-f="${f}" data-ph="${esc(ph)}">${esc(get(t, id)[f])}</h1>`;
  const chip = (k, t, x) => `<button class="chip ${CLS[x[k]] || ''}" data-cycle="${k}" data-t="${t}" data-id="${x.id}" title="Click to change">${L[x[k]] || esc(x[k])}</button>`;
  const chipRO = v => `<span class="chip ${CLS[v] || ''}">${L[v] || esc(v)}</span>`;
  const sec = (h, acts, body, cls = '') => `<section class="sec ${cls}"><div class="sec-h"><h2>${esc(h)}</h2><div class="acts">${acts || ''}</div></div>${body}</section>`;
  const empty = t => `<div class="empty">${esc(t)}</div>`;
  const pick = (k, id, opts, ph) => opts.length ? `<select class="pick" data-pick="${k}" data-id="${id}"><option value="">${esc(ph)}</option>${opts.map(o => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}</select>` : '';
  const card = (h, n, ph, d, m, cls = '', logo = '') => { const s = (n || '').trim(); return `<a class="card ${cls}" href="${h}">${logo ? `<img class="logo" src="${esc(logo)}" alt="" loading="lazy">` : ''}<div class="n ${s ? '' : 'ph'}">${esc(s || ph)}</div>${d ? `<div class="d">${esc(d)}</div>` : ''}<div class="m">${m || ''}</div></a>`; };
  const opt = (t, list) => list.map(x => ({id: x.id, label: label(t, x)}));
  const link = (u, t) => u ? `<a class="ext" href="${esc(u)}" target="_blank" rel="noopener">${esc(t || u.replace(/^https?:\/\//, '').slice(0, 40))}</a>` : '';

  function taskRow(t) {
    return `<div class="task ${t.done ? 'done' : ''}"><button class="cb" data-toggle="${t.id}" title="Done">${t.done ? '✓' : ''}</button>
      <div class="f" contenteditable="${CE}" data-t="task" data-id="${t.id}" data-f="text" data-ph="What needs doing">${esc(t.text)}</div>
      <button class="rm" data-deltask="${t.id}" title="Remove task">×</button></div>`;
  }
  function tasksBlock(type, id, h = 'Tasks') {
    const ts = tasksOf(type, id);
    return sec(h, '', `<div class="tasks">${ts.filter(t => !t.done).concat(ts.filter(t => t.done)).map(taskRow).join('')}<button class="tadd" data-add="task" data-otype="${type || ''}" data-oid="${id || ''}">+ Add task</button></div>`);
  }
  const personCard = p => { const n = companiesOf(p).length; return card(href('person', p), p.name, kindOfP(p).ph, p.who, `${chipRO(p.status)}${p.viaId ? `<span>via ${esc(label('person', get('person', p.viaId)))}</span>` : ''}<span class="sp"></span><span>${n} compan${n === 1 ? 'y' : 'ies'}</span>`); };
  const companyCard = c => { const rs = rolesOf(c); const v = c.research && c.research.status === 'done' ? gradeChip(c.research) : ''; return card(href('company', c), c.name, PH.company, c.what, `${rs.slice(0, 2).map(r => chipRO(r.stage)).join('')}${v}${rs.slice(0, 2).map(applyChip).join('')}${isPractice(c) ? chipRO('practice') : ''}<span class="sp"></span><span>${rs.length} role${rs.length === 1 ? '' : 's'}</span>`, isPractice(c) ? 'practice' : '', c.logo); };
  const roleCard = r => card(href('role', r), r.title, PH.role, r.nextAction ? 'Next: ' + r.nextAction : '', `${chipRO(r.stage)}${chipRO(r.odds)}${isPractice(r) ? chipRO('practice') : ''}`, isPractice(r) ? 'practice' : '');
  const removeBtn = (t, id, word) => `<div class="foot-acts"><button class="btn danger" data-del="${t}" data-id="${id}">Remove ${esc(word)}</button></div>`;
  const filterBar = (list = state.roles) => { const n = practiceRoles().length + state.companies.filter(isPractice).length; if (!n && roleFilter === 'all') return ''; const cnt = k => k === 'all' ? list.length : list.filter(x => tierOf(x) === k).length; return `<div class="filter" role="group" aria-label="Show">${[['all', 'All'], ['real', 'Real'], ['practice', 'Practice']].map(([k, t]) => `<button class="fbtn ${roleFilter === k ? 'on' : ''}" data-filter="${k}">${t}<span class="mono">${cnt(k)}</span></button>`).join('')}</div>`; };
  const homeBar = () => `<div class="filter home" role="group" aria-label="Home">${[['real', 'Real'], ['practice', 'Practice']].map(([k, t]) => `<button class="fbtn ${homeTier === k ? 'on' : ''}" data-home="${k}">${t}</button>`).join('')}</div>`;

  // ---- practice sprint (home) ----
  function sprintBlock() {
    const sp = state.practice; const st = sprintStats();
    const rule = `<p class="rule">Stop at ${SPRINT_GOALS.finished} finished processes or when the time is up, whichever comes first. Under 3 screens by the end means the CV is the problem, not the market.</p>`;
    if (!sp) return sec('Practice tier', `<button class="btn quiet" data-sprint="start">Start ${SPRINT_DAYS / 7}-week sprint</button>`,
      `<div class="rbox dim">Interview reps at companies I do not care about. Mark a company or role as <b>Practice</b>, then start the sprint to track it here.${st.marked ? ` <b>${st.marked}</b> role${st.marked === 1 ? '' : 's'} already marked.` : ''}</div>`, 'practice');
    const left = daysLeft(sp); const over = left <= 0 || st.finished >= SPRINT_GOALS.finished;
    const when = left <= 0 ? `Ended ${fmt(sp.endsAt)}` : `Ends ${fmt(sp.endsAt)} · ${left} day${left === 1 ? '' : 's'} left`;
    const verdict = over ? (st.finished >= SPRINT_GOALS.finished ? 'Goal reached. Time to stop the practice tier.' : st.screens < 3 ? 'Time is up with under 3 screens. Fix the CV before applying more.' : 'Time is up. Stop here, carry the lessons into the real targets.') : '';
    const lessons = practiceRoles().filter(r => (r.lesson || '').trim()).map(r => { const c = get('company', r.companyId); return `<div class="task"><div class="lsn"><a href="${href('role', r)}">${esc(roleLabel(r))}</a><span class="dim"> · ${esc(c ? label('company', c) : '')}</span><div>${esc(r.lesson)}</div></div></div>`; }).join('');
    const stat = (n, goal, l, dim) => `<div class="stat ${dim ? 'dim' : ''}"><b class="mono">${n}${goal ? `<small>/${goal}</small>` : ''}</b><span>${l}</span></div>`;
    return sec('Practice tier', `<span class="dim small">${esc(when)}</span><button class="btn quiet" data-sprint="extend">+1 week</button><button class="btn danger" data-sprint="end">End sprint</button>`,
      `<div class="stats practice">${stat(st.marked, 0, 'Practice roles', !st.marked)}${stat(st.applied, 0, 'Applied', !st.applied)}${stat(st.screens, SPRINT_GOALS.screens, 'Screens', !st.screens)}${stat(st.finished, SPRINT_GOALS.finished, 'Finished', !st.finished)}<div class="stat wide"><b>${esc(over ? verdict : `Started ${fmt(sp.startedAt)}`)}</b><span>${over ? 'Verdict' : 'Screen = reached Interviewing'}</span></div></div>
      ${rule}
      <div class="tasks lessons">${lessons || `<div class="empty">Lessons land here. After each meeting, write the one thing to fix on the role page.</div>`}</div>`, 'practice');
  }

  // ---- research block (company page) ----
  const ctxDraft = {};           // context text typed per company, survives re-renders
  const simpleOn = {};           // "Simplify" toggle per company
  const val = v => (v == null || v === 'unknown' || v === 'null') ? '' : String(v);
  const gradeOf = r => { if (!r) return null; const g = r.fit && Number(r.fit.grade); if (g >= 1 && g <= 10) return Math.round(g); const m = {strong: 9, maybe: 6, no: 2}; return r.verdict && m[r.verdict.score] || null; };
  const gradeCls = g => g == null ? 'c-mute' : g >= 8 ? 'c-ok' : g >= 5 ? 'c-warn' : 'c-mute';
  const gradeChip = r => { const g = gradeOf(r); return g == null ? '' : `<span class="chip ${gradeCls(g)}">Fit ${g}/10</span>`; };
  const initial = n => esc((val(n) || '?').slice(0, 1));
  function researchBlock(c) {
    const r = c.research || {};
    const st = r.status || 'idle';
    const acts = st === 'running'
      ? `<span class="running"><span class="spin"></span>Researching… usually 3 to 10 min</span>`
      : `<button class="btn" data-research="${c.id}" data-depth="standard">${st === 'done' ? 'Run again' : 'Run research'}</button><button class="btn quiet" data-research="${c.id}" data-depth="deep">Deep dive</button>`;
    const ctxVal = ctxDraft[c.id] != null ? ctxDraft[c.id] : '';
    const ctxBox = st === 'running'
      ? (r.context ? `<div class="rctx-sent"><span class="rl">Context sent</span>${esc(r.context)}</div>` : '')
      : `<textarea class="rctx" data-rctx="${c.id}" rows="2" placeholder="Anything the researcher should know before it starts? e.g. 'I hear they like ex-founders', 'check if the TLV deployment seat is real'">${esc(ctxVal)}</textarea>`;
    let body = '';
    if (st === 'idle') body = empty('Not researched yet. One click, and Claude fills this in: what they do, stage, team size, founders, open roles, ways in, and a fit grade against my filter.');
    else if (st === 'running') body = `<div class="rbox dim">Started ${esc(fmtT(r.requestedAt))}. This page refreshes by itself when the result lands. You can leave.</div>`;
    else if (st === 'error') body = `<div class="rbox err">Could not start the research: ${esc(r.error || 'unknown error')}. Check the routine setup, then try again.</div>`;
    else {
      const g = gradeOf(r);
      const fit = r.fit || {}; const reasons = fit.reasons || (r.verdict && r.verdict.reasons) || [];
      const simple = !!simpleOn[c.id];
      const deep = val(r.summaryDeep), plain = val(r.summarySimple);
      const explain = simple ? (plain || deep) : (deep || plain);
      const founders = (r.founders || []).map(f => { const ph = val(f.photo); return `<div class="fcard">${ph ? `<img src="${esc(ph)}" alt="" loading="lazy" data-initial="${initial(f.name)}">` : `<span class="avatar">${initial(f.name)}</span>`}<div class="fc-n">${esc(val(f.name))}</div><div class="fc-r">${esc(val(f.role))}</div><div class="fc-b">${esc(val(f.background))}</div><div class="links">${link(val(f.linkedin), 'LinkedIn')}${link(val(f.mutualSearch), 'Mutual connections')}</div></div>`; }).join('');
      const roles = (r.openRoles || []).map(o => `<div class="orow"><div><b>${esc(val(o.title))}</b><div class="dim small">${esc(val(o.fit))}</div></div>${link(val(o.url), 'Open')}</div>`).join('');
      const list = a => (a || []).length ? `<ul class="rlist">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="dim small">None found.</div>';
      // headcount should be a number; if the routine sends a sentence, keep the number big and move the rest to the note
      const hcRaw = typeof r.headcount === 'number' ? String(r.headcount) : val(r.headcount).replace(/^~/, '').trim();
      const hcM = hcRaw.match(/^[\d,.]+\s*[kK+]?(?:\s*-\s*[\d,.]+\s*[kK+]?)?/);
      const hc = hcM ? hcM[0].trim() : '';
      const hcNote = [hcM ? hcRaw.slice(hcM[0].length).replace(/^[\s,;:-]+/, '').replace(/^(people|employees)\b[\s,;:-]*/i, '') : hcRaw, val(r.headcountNote)].filter(Boolean).join(' - ');
      body = `<div class="rgrid">
        <div class="rbox span2 fitbox"><div class="fitnum ${gradeCls(g)}"><b>${g == null ? '–' : g}</b><span>/10</span></div><div><div class="rl">Option grade</div>${list(reasons)}</div></div>
        <div class="rbox span2"><div class="rl-row"><div class="rl">What they do</div>${(deep && plain) ? `<button class="btn quiet mini" data-simplify="${c.id}">${simple ? 'Technical' : 'Simplify'}</button>` : ''}</div><p class="lead">${esc(val(r.summary) || '–')}</p>${explain ? `<p class="explain ${simple ? 'simple' : ''}">${esc(explain)}</p>` : ''}</div>
        <div class="rbox"><div class="rl">Stage & funding</div>${esc(val(r.stage) || '–')}${val(r.totalRaised) ? `<div class="dim small">Total raised ${esc(r.totalRaised)}</div>` : ''}</div>
        <div class="rbox"><div class="rl">Team size</div><div class="bignum">${esc(hc || '?')}<span> people</span></div><div class="dim small">${esc(hcNote || val(r.location))}</div>${hcNote && val(r.location) ? `<div class="dim small">${esc(r.location)}</div>` : ''}</div>
        <div class="rbox span2"><div class="rl">In Israel</div>${esc(val(r.israelPresence) || '–')}<div class="dim small">CEO technical: ${r.ceoTechnical === true ? 'yes' : r.ceoTechnical === false ? 'no' : 'unknown'}</div></div>
        <div class="rbox span2 fbox"><div class="rl">Founders & C-level</div>${founders ? `<div class="fcards">${founders}</div>` : '<div class="dim small">None found.</div>'}</div>
        <div class="rbox span2"><div class="rl">Open roles that could fit</div>${roles || '<div class="dim small">Nothing open that fits right now.</div>'}</div>
        <div class="rbox"><div class="rl">Ways in</div>${list(r.waysIn)}</div>
        <div class="rbox"><div class="rl">Recent signals</div>${list(r.signals)}</div>
        ${(r.outreachAngles || []).length ? `<div class="rbox span2"><div class="rl">Outreach angles</div>${list(r.outreachAngles)}</div>` : ''}
        <div class="rbox span2 srcs"><div class="rl">Sources</div>${(r.sources || []).map(s => link(val(s.url), val(s.title))).join(' · ') || '–'}</div>
      </div><div class="dim small rstamp">Researched ${esc(fmtT(r.updatedAt))}${r.depth === 'deep' ? ' · deep dive' : ''}${r.context ? ` · with context: "${esc(r.context)}"` : ''}</div>`;
    }
    return sec('Research', acts, ctxBox + body, 'research');
  }

  // ---- learning pipeline: raw debrief notes -> Claude -> lessons ----
  function debriefsBlock(t, o) {
    const c = t === 'company' ? o : get('company', o.companyId);
    const list = t === 'company' ? (o.debriefs || []).map(d => ({d, k: 'company'})) : [...(o.debriefs || []).map(d => ({d, k: 'role'})), ...((c && c.debriefs) || []).map(d => ({d, k: 'company'}))];
    const run = state.lessonsRun || {};
    const mine = c && run.companyId === c.id;
    const running = mine && run.status === 'running';
    const pend = c ? pendingDebriefs(c).length : 0;
    const noteBtn = c ? `<button class="btn quiet" data-add="debrief" data-otype="company" data-oid="${c.id}" title="Something about the company as a whole, not one round. Shows on every role at this company.">+ Company note</button>` : '';
    const addBtn = t === 'company' ? noteBtn : `<button class="btn quiet" data-add="debrief" data-otype="role" data-oid="${o.id}">+ Round</button>` + noteBtn;
    const goBtn = running
      ? `<span class="running"><span class="spin"></span>Extracting lessons… 2 to 5 min</span>`
      : `<button class="btn" data-distill="${c ? c.id : ''}" ${pend ? '' : 'disabled'} title="${pend ? `Sends ${pend} new note${pend === 1 ? '' : 's'} from this company to Claude` : 'Write a note first'}">Extract lessons${pend ? ` <span class="n">${pend}</span>` : ''}</button>`;
    const err = mine && run.status === 'error' ? `<div class="rbox err">Could not start: ${esc(run.error || 'unknown error')}. Check the routine setup, then try again.</div>` : '';
    const hint = t === 'company'
      ? 'Things about the company itself, not one round: how they decide, who was in the room, what they value. Claude turns it into lessons.'
      : 'Right after each round: what happened, what they said, what you felt, what you would do differently. A company note is for things about the company as a whole, like how they decide. Messy is fine. Claude turns it all into lessons.';
    const body = list.length ? `<div class="debriefs">${list.map(({d, k}) => debriefRow(d, k)).join('')}</div>` : empty(hint);
    return sec(t === 'company' ? 'Company notes' : 'Interview debrief', addBtn + goBtn, err + body, 'dbsec');
  }
  function debriefRow(d, t) {
    const done = !!d.distilledAt;
    const round = t === 'company' ? chipRO('Company note') : chip('round', 'debrief', d);
    const state_ = done ? `<span class="chip c-mute" title="Claude read this note on ${esc(fmtT(d.distilledAt))}">Lessons extracted</span>` : `<span class="chip c-warn">Not extracted yet</span>`;
    const head = `<div class="db-h">${round}<span class="f db-date" contenteditable="${CE}" data-t="debrief" data-id="${d.id}" data-f="date" data-ph="date">${esc(d.date)}</span>${state_}<span class="sp"></span><button class="rm" data-deldb="${d.id}" title="Remove this note">×</button></div>`;
    const text = `<div class="f db-text" contenteditable="${CE}" data-t="debrief" data-id="${d.id}" data-f="text" data-ph="${t === 'company' ? 'What did I learn about how this company works and decides?' : 'What happened, what they said, what I felt, what I would do differently'}">${esc(d.text)}</div>`;
    if (!done) return `<div class="debrief">${head}${text}</div>`;
    return `<div class="debrief done">${head}<div class="takeaway"><span class="rl">${t === 'company' ? 'What to carry' : 'What this round tested'}</span>${esc(d.takeaway || 'Nothing to carry from this one.')}</div><details class="raw"><summary>My notes</summary>${text}</details></div>`;
  }
  function lessonRow(l) {
    const groups = new Map();   // company label -> {href, rounds: [{label, href}]}
    (l.sources || []).forEach(sr => {
      const r = sr.roleId ? get('role', sr.roleId) : null; const c = get('company', sr.companyId); const d = sr.debriefId ? getDebrief(sr.debriefId) : null;
      const co = c ? label('company', c) : r ? roleLabel(r) : ''; if (!co) return;
      if (!groups.has(co)) groups.set(co, {href: c ? href('company', c) : href('role', r), rounds: []});
      const g = groups.get(co); const rd = d ? d.round : (r ? roleLabel(r) : 'Company note');
      if (!g.rounds.some(x => x.label === rd)) g.rounds.push({label: rd, href: r ? href('role', r) : (c ? href('company', c) : '#/')});
    });
    const srcs = [...groups].map(([co, g]) => `<span class="srcg"><a class="co" href="${g.href}">${esc(co)}</a>${g.rounds.length ? `<span class="rds">${g.rounds.map(x => `<a href="${x.href}">${esc(x.label)}</a>`).join('<i>,</i> ')}</span>` : ''}</span>`).join('');
    const n = l.count || 1;
    const cnt = n > 1 ? `<span class="count" title="Came up in ${n} debriefs">Seen ${n}×</span>` : '';
    return `<div class="lrow ${lstatus(l)}"><div class="ltop"><div class="lbody"><div class="f ltitle" contenteditable="${CE}" data-t="lesson" data-id="${l.id}" data-f="title" data-ph="Headline, a few words">${esc(l.title)}</div><div class="f ltext" contenteditable="${CE}" data-t="lesson" data-id="${l.id}" data-f="text" data-ph="One sentence: what to do and why">${esc(l.text)}</div></div><button class="imp" data-cycle="imp" data-t="lesson" data-id="${l.id}" title="Importance ${limp(l)} of 10. Click to change">${limp(l)}<span>/10</span></button>${chip('lstatus', 'lesson', {id: l.id, lstatus: lstatus(l)})}<button class="rm" data-dellesson="${l.id}" title="Remove">×</button></div><div class="lmeta">${cnt}${srcs || '<span class="dim">Added by hand</span>'}<span class="sp"></span>${chip('ltype', 'lesson', {id: l.id, ltype: l.type})}</div></div>`;
  }
  const lessonFilterBar = () => { const ls = lessons(); if (!ls.length) return ''; const n = k => k === 'all' ? ls.length : ls.filter(l => lstatus(l) === k).length; return `<div class="filter" role="group" aria-label="Show">${[['all', 'All'], ['practicing', 'Requires work'], ['new', 'To review'], ['nailed', 'Nailed']].map(([k, t]) => `<button class="fbtn ${lessonFilter === k ? 'on' : ''}" data-lfilter="${k}">${t} <span class="mono">${n(k)}</span></button>`).join('')}</div>`; };

  // ---- mail clerk: Gmail -> board ----
  const ROBOT = `<img class="robot" src="robot.png" alt="Added by the mail clerk" title="Added by the mail clerk from an email. Open the role to check it and clear the tag.">`;
  const autoChip = (t, x) => x.autoAdded ? `<span class="chip c-warn auto" title="Created by the mail clerk from an email. Check the name and role, then click x.">Auto-added<button class="x" data-clearauto="${t}" data-id="${x.id}" title="Got it, remove the tag">×</button></span>` : '';
  function mailBlock(tier = 'real') {
    const m = state.mail || {}; const run = state.mailRun || {}; const lr = m.lastRun;
    const acts = run.status === 'running' ? `<span class="running"><span class="spin"></span>Checking mail…</span>` : (features.mailCheck ? `<button class="btn quiet" data-mailcheck="1">Check now</button>` : '');
    const err = run.status === 'error' ? `<div class="rbox err">Could not start the check: ${esc(run.error || 'unknown error')}.</div>` : '';
    if (!lr) return sec('Mail', acts, err + `<div class="mailbox dim">The mail clerk has not run yet. Once it is set up on claude.ai it reads your Gmail twice a day and files job mail here: replies to answer, rejections, heads-ups and application receipts.</div>`, 'mailsec');
    const c = lr.counts || {};
    const part = (n, one, many) => `<span class="${n ? '' : 'dim'}"><b class="mono">${n || 0}</b> ${n === 1 ? one : many}</span>`;
    const line = [part(c.reply, 'reply needed', 'replies needed'), part(c.rejected, 'rejected', 'rejected'), part(c.update, 'heads-up', 'heads-ups'), part(c.ack, 'application received', 'applications received'), part(c.noise, 'noise', 'noise')].join('<i>·</i>');
    const replies = state.roles.filter(r => tierOf(r) === tier && (r.mail || [])[0] && r.mail[0].kind === 'reply' && /^Reply to /.test(r.nextAction || '')).map(r => { const co = get('company', r.companyId); return `<a class="mail-reply" href="${href('role', r)}"><span class="chip c-hot">Reply needed</span><b>${esc(co ? label('company', co) : '')}</b><span>${esc(r.nextAction)}</span></a>`; }).join('');
    return sec('Mail', acts, err + `<div class="mailbox"><div class="mail-line"><span class="mail-when">Checked ${esc(fmtT(lr.at))}</span>${line}</div>${replies}</div>`, 'mailsec');
  }
  // "What we sent": the worker's record of each run (every question, the exact answer, the CV, the outcome). Loaded on open, cached a minute.
  const recCache = {};
  function sentSection(r) {
    const a = r.apply; if (!a || !(a.submittedAt || a.failedAt || a.blockedAt || a.unverifiedAt || a.confirmedAt)) return '';
    return `<div id="sentrec" data-role="${esc(r.id)}">${sec('What we sent', '', `<div class="abox dim small">${recCache[r.id] ? recordsHtml(recCache[r.id].records) : 'Loading the record…'}</div>`)}</div>`;
  }
  function recordsHtml(recs) {
    if (!recs || !recs.length) return '<span class="dim">No record for this card yet (records start 25 Oct 2026; older sends are backfilled from the PC).</span>';
    return recs.map(x => {
      const head = `<div class="rhead"><b>${esc(fmtT(x.at))}</b> · ${esc(x.outcome)}${x.ats ? ` · ${esc(x.ats)}` : ''}${x.backfilled ? ' · <span class="dim">backfilled</span>' : ''}</div>`;
      const cv = x.cv && x.cv.version ? `<div class="afield"><span class="ak">CV</span><span class="av"><span class="mono">${esc(x.cv.version)}</span>${x.cv.title ? ` with title "${esc(x.cv.title)}"` : ''}${x.cv.file ? ` <span class="dim mono">${esc(x.cv.file)}</span>` : ''}</span></div>` : '';
      const pages = new Set(x.fields.map(f => f.page).filter(Boolean)).size > 1;
      const rows = x.fields.map(f => `<div class="rrow"><span class="rq">${pages && f.page ? `<span class="dim">p${f.page}</span> ` : ''}${esc(f.label)}${f.required && !/\*\s*$/.test(f.label) ? '*' : ''}</span><span class="ra ${f.final ? '' : 'dim'}">${esc(f.final || '(empty)')}</span><span class="rs">${esc(f.source || '')}</span></div>`).join('');
      const why = x.reason ? `<div class="afield"><span class="ak">Reason</span><span class="av">${esc(x.reason)}</span></div>` : '';
      const conf = x.confirmText ? `<div class="afield"><span class="ak">Confirmation</span><span class="av dim">${esc(x.confirmText)}</span></div>` : '';
      const shots = x.screenshots && x.screenshots.length ? `<div class="afield"><span class="ak">On the PC</span><span class="av dim mono small">${x.screenshots.map(esc).join('<br>')}</span></div>` : '';
      return `<div class="rec">${head}${cv}${why}<div class="rtab">${rows || '<span class="dim">no fields recorded</span>'}</div>${conf}${shots}</div>`;
    }).join('');
  }
  async function loadRecords() {
    const el = page.querySelector('#sentrec'); if (!el) return;
    const id = el.dataset.role, hit = recCache[id];
    if (hit && Date.now() - hit.at < 60000) return;
    try {
      const res = await fetch(`${RECORD_API}?roleId=${encodeURIComponent(id)}`, {headers: hdr()});
      const d = await res.json(); recCache[id] = {at: Date.now(), records: res.ok ? d.records || [] : []};
    } catch (e) { recCache[id] = {at: Date.now(), records: []}; }
    const box = page.querySelector(`#sentrec[data-role="${CSS.escape(id)}"] .abox`); if (box) { box.classList.remove('dim', 'small'); box.innerHTML = recordsHtml(recCache[id].records); }
  }
  function mailSection(r) {
    const rows = (r.mail || []).map(m => `<div class="mrow"><span class="mdate mono">${esc(fmt(m.date))}</span>${chipRO(m.kind)}<div class="mbody"><div class="mfrom">${esc(m.from)}${m.subject ? `<span class="dim"> · ${esc(m.subject)}</span>` : ''}</div><div class="msum">${esc(m.summary)}</div></div>${m.link ? link(m.link, 'Open in Gmail') : ''}</div>`).join('');
    return sec('Mail', '', rows ? `<div class="mrows">${rows}</div>` : empty('Nothing yet. The mail clerk files job mail about this role here.'), 'mailsec');
  }

  // ---- pages ----
  const PAGES = {};
  PAGES.home = () => homeTier === 'practice' ? homePractice() : homeReal();
  const taskGroups = tier => { const groups = new Map(); state.tasks.filter(t => !t.done && t.owner && t.text.trim() && tierOfTask(t) === tier).forEach(t => { const k = t.owner.type + ':' + t.owner.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }); return groups; };
  const groupsBlock = (groups, emptyMsg) => sec('Open tasks elsewhere', '', groups.size ? [...groups.values()].map(ts => { const ty = ts[0].owner.type; const o = ownerOf(ts[0]); return `<div class="tgroup"><h3><a href="${o ? href(ty, o) : '#/'}">${esc(o ? (ty === 'role' ? roleLabel(o) : label(ty, o)) : 'Unknown')}</a><small>${esc(typeName(ty, o))}</small></h3><div class="tasks">${ts.map(taskRow).join('')}</div></div>`; }).join('') : empty(emptyMsg));
  // Real home: my own search. Nothing from the practice tier or the automation shows here.
  function homeReal() {
    const cnt = s => state.roles.filter(r => r.stage === s && !isPractice(r)).length;
    const openN = state.tasks.filter(t => !t.done && t.text.trim() && tierOfTask(t) === 'real').length;
    const practN = lessons().filter(l => lstatus(l) === 'practicing').length;
    return `<div class="head"><h1 class="title">Home</h1><span class="dim small">The real search</span>${homeBar()}</div>
      <div class="stats">${['lead','in-conversation','applied','interviewing','offer'].map(s => `<a class="stat ${cnt(s) ? '' : 'dim'}" href="#/pipeline"><b class="mono">${cnt(s)}</b><span>${L[s]}</span></a>`).join('')}<div class="stat ${openN ? '' : 'dim'}"><b class="mono">${openN}</b><span>Open tasks</span></div><a class="stat ${practN ? '' : 'dim'}" href="#/lessons" title="Lessons I am working on"><b class="mono">${practN}</b><span>Open lessons</span></a></div>
      ${mailBlock('real')}
      ${sec('Channels', `<button class="btn quiet" data-add="channel">+ Channel</button>`, `<div class="grid">${state.channels.map(ch => { const ps = state.people.filter(p => p.channelId === ch.id); const rs = rolesViaChannel(ch).filter(r => !isPractice(r)); return card(href('channel', ch), ch.name, PH.channel, ch.snapshot, `<span>${ps.length} ${kindOf(ch).many.toLowerCase()}</span><span class="sp"></span><span>${rs.length} role${rs.length === 1 ? '' : 's'}</span>`, 'ch'); }).join('')}</div>`)}
      ${tasksBlock(null, null, 'General tasks')}
      ${groupsBlock(taskGroups('real'), 'Nothing open on any person, company or role.')}`;
  }
  // ---- System section (practice home): is the machine alive, is it producing, is it delivering, do we know the outcomes. ----
  // Everything here is computed from the board state on every render. Signals are about the system, never about one role:
  // per-role items live in the apply loop section below.
  const ago = iso => { const ms = Date.now() - new Date(iso).getTime(); if (!(ms >= 0)) return ''; const h = ms / 3600000; return h < 1 ? `${Math.max(1, Math.round(ms / 60000))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`; };
  const within = (iso, days) => !!iso && Date.now() - new Date(iso).getTime() < days * DAY;
  const errClass = s => (s || '').split(/[:(]/)[0].replace(/\s+-\s.*$/, '').trim().slice(0, 40) || 'unknown';
  const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '–';
  const GARBLED = /[Ã×][\u0080-¿]|×[ -¿]/;
  const SOURCES = ['drushim', 'alljobs', 'linkedin', 'boards'];
  const sourcesOf = run => { const o = {}; const re = /(drushim|alljobs|linkedin|boards)[^:;]*:\s*(\d+) roles seen/g; let m; while ((m = re.exec(run.brief || ''))) o[m[1]] = Number(m[2]); return o; };
  function systemData(D = 7) {
    const h = hunt(); const rs = applyRoles(); const pr = practiceRoles();
    const runs = h.runs.filter(x => within(x.at, D)); const lr = h.lastRun;
    const nights = runs.map(x => ({ at: x.at, noop: !!x.noop, ok: x.ok !== false, src: sourcesOf(x), found: (x.funnel && x.funnel.found) || 0, cands: (x.funnel && x.funnel.candidates) || x.candidates || 0, prepared: rs.filter(r => { const t = r.apply.preparedAt ? new Date(r.apply.preparedAt).getTime() : 0; const t0 = new Date(x.at).getTime(); return t >= t0 && t < t0 + DAY; }).length, real: rs.filter(r => r.apply.status === 'real' && r.apply.foundAt && Math.abs(new Date(r.apply.foundAt) - new Date(x.at)) < DAY).length, errors: (x.errors || []).length, offered: Number((((x.brief || '').match(/(\d+) offered to the sorter/) || [])[1]) || 0) }));
    const srcAvg = {}; SOURCES.forEach(s => { const v = nights.filter(n => !n.noop).map(n => n.src[s] || 0); srcAvg[s] = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; });
    const drops = {}; runs.forEach(x => Object.entries((x.funnel && x.funnel.dropped) || {}).forEach(([k, n]) => { drops[k] = (drops[k] || 0) + n; }));
    const topDrops = Object.entries(drops).filter(([k]) => !/^cap|^forfeited|^cannotGrade/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const capCut = runs.reduce((n, x) => n + (((x.funnel && x.funnel.dropped) || {}).capPrepared || 0), 0);
    const sentAt = a => a.submittedAt || a.confirmedAt || a.unverifiedAt;
    const prepared = rs.filter(r => within(r.apply.preparedAt, D));
    const forfeited = prepared.filter(r => r.apply.status === 'skipped' && /^forfeited/.test(r.apply.reason || ''));
    const forfeitWhy = {}; forfeited.forEach(r => { const k = errClass((r.apply.reason || '').replace(/^forfeited:\s*/, '')); forfeitWhy[k] = (forfeitWhy[k] || 0) + 1; });
    const manual = prepared.filter(r => r.apply.status === 'manual'); const manualBy = {}; manual.forEach(r => { const k = r.apply.ats || 'other'; manualBy[k] = (manualBy[k] || 0) + 1; });
    const queued = rs.filter(r => ['approved', 'submitting'].includes(r.apply.status));
    const sent = rs.filter(r => within(sentAt(r.apply), D) && ['submitted', 'confirmed', 'unverified'].includes(r.apply.status));
    const confirmed = rs.filter(r => within(r.apply.confirmedAt, D));
    const failed = rs.filter(r => within(r.apply.failedAt, D) && r.apply.status === 'failed');
    const blocked = rs.filter(r => within(r.apply.blockedAt, D) && r.apply.status === 'blocked');
    const misread = failed.filter(r => /SENT in fact|sent in fact/i.test(r.apply.reason || ''));
    const unverified = rs.filter(r => r.apply.status === 'unverified');
    const retried = rs.filter(r => (r.apply.attempts || 0) >= 2 && within(r.apply.preparedAt, D));
    const recipes = {}; const touch2 = (r, k) => { const a = r.apply.ats || 'other'; recipes[a] = recipes[a] || {ats: a, tried: 0, sent: 0, failed: 0, blocked: 0, manual: 0, classes: {}, last3: {tried: 0, sent: 0}}; const o = recipes[a]; o[k]++; if (k !== 'manual') o.tried++; if (k === 'failed' || k === 'blocked') { const c = errClass(r.apply.reason); o.classes[c] = (o.classes[c] || 0) + 1; } const t = k === 'sent' ? sentAt(r.apply) : k === 'failed' ? r.apply.failedAt : r.apply.blockedAt; if (k !== 'manual' && within(t, 3)) { o.last3.tried++; if (k === 'sent') o.last3.sent++; } };
    sent.forEach(r => touch2(r, 'sent')); failed.forEach(r => touch2(r, 'failed')); blocked.forEach(r => touch2(r, 'blocked')); manual.forEach(r => touch2(r, 'manual'));
    const recipeRows = Object.values(recipes).map(o => ({ ...o, rate: o.tried ? Math.round(100 * o.sent / o.tried) : null, topClass: Object.entries(o.classes).sort((a, b) => b[1] - a[1])[0] })).sort((a, b) => (b.tried + b.manual) - (a.tried + a.manual));
    const lagH = confirmed.map(r => (new Date(r.apply.confirmedAt) - new Date(sentAt(r.apply) || r.apply.confirmedAt)) / 3600000).filter(x => x >= 0).sort((a, b) => a - b);
    const medLag = lagH.length ? lagH[Math.floor(lagH.length / 2)] : null;
    const mail7 = {reply: 0, rejected: 0, ack: 0, update: 0}; pr.forEach(r => (r.mail || []).forEach(m => { if (within(m.date, D) && mail7[m.kind] !== undefined) mail7[m.kind]++; }));
    const screens = pr.filter(r => r.screened || ['interviewing', 'offer'].includes(r.stage)).length;
    const lessonsN = pr.filter(r => (r.lesson || '').trim()).length;
    const garbled = rs.filter(r => GARBLED.test(r.apply.reason || '') || GARBLED.test(r.title || '')).length;
    // agents last night
    const lrId = lr && lr.runId; const lrCos = lrId ? state.companies.filter(c => c.hunt && c.hunt.runId === lrId) : [];
    const agents = { fired: lrCos.length, done: lrCos.filter(c => ['done', 'dropped'].includes(c.hunt.status)).length, failed: lrCos.filter(c => c.hunt.status === 'failed').length, stuck: state.companies.filter(c => c.hunt && ['candidate', 'grading', 'graded', 'preparing'].includes(c.hunt.status) && !within(c.hunt.firedAt || c.hunt.foundAt, 1 / 12)).length, retried: lrCos.filter(c => (c.hunt.attempts || 0) > 1).length };
    const w = h.worker || {}; const wt = w.today && w.today.date === new Date().toISOString().slice(0, 10) ? w.today : null;
    const now = new Date(); const expected = Math.max(1, Math.floor((now.getHours() * 60 + now.getMinutes()) / 15));
    const wAge = w.lastAt ? Date.now() - new Date(w.lastAt).getTime() : null;
    const rv = w.reviewer || null; const rvAge = rv && rv.lastRunAt ? Date.now() - new Date(rv.lastRunAt).getTime() : null;   // scheduled reviewer heartbeat, relayed by the worker
    const ml = state.mail && state.mail.lastRun; const mAge = ml ? Date.now() - new Date(ml.at).getTime() : null;
    const stuck = { submitting: rs.filter(r => r.apply.status === 'submitting' && !within(r.apply.startedAt || r.apply.approvedAt, 1 / 24)).length, submitted: rs.filter(r => r.apply.status === 'submitted' && !within(r.apply.submittedAt, 3)).length, candidates: agents.stuck };
    const missedNights = lr ? Math.max(0, Math.floor((Date.now() - new Date(lr.at).getTime() - 3 * 3600000) / DAY)) : null;
    return { D, h, lr, runs, nights, srcAvg, topDrops, capCut, prepared, forfeited, forfeitWhy, manual, manualBy, queued, sent, confirmed, failed, blocked, misread, unverified, retried, recipeRows, medLag, mail7, screens, lessonsN, garbled, agents, w, wt, expected, wAge, rv, rvAge, ml, mAge, stuck, missedNights, real: nights.reduce((n, x) => n + x.real, 0) };
  }
  function systemSignals(d) {
    const S = []; const add = (sev, text, href2) => S.push({sev, text, href: href2 || ''});
    const { h, lr, nights, srcAvg, d7 = d } = d; const n0 = nights[0];
    // alive
    if (h.killSwitch) add('needs', 'Kill switch is on: no hunt, no queue, no worker until you switch it off.');
    if (d.missedNights === null) add('needs', 'The hunt has never run.'); else if (d.missedNights >= 1) add('needs', `Hunt missed ${d.missedNights} night${d.missedNights === 1 ? '' : 's'}: check the scheduled function on Netlify.`);
    else if (lr && lr.ok === false) add('unusual', 'Last night\'s hunt failed before finishing.');
    if (d.queued.length && (d.wAge === null || d.wAge > 3600000)) add('needs', `${d.queued.length} card${d.queued.length === 1 ? '' : 's'} queued but the PC worker is silent (${d.wAge === null ? 'never reported' : `last seen ${ago(d.w.lastAt)} ago`}).`, '#/apply?s=approved');
    else if (d.wAge !== null && d.wAge > DAY) add('unusual', `PC worker silent for ${ago(d.w.lastAt)}: the scheduled task may be off.`);
    if (d.w.lastError) add('unusual', `PC worker reported an error on its last tick: ${d.w.lastError}`);
    if (d.wAge !== null && d.wAge < DAY && (!d.rv || d.rvAge === null)) add('unusual', 'Scheduled reviewer has never reported: JobApplyReviewer may not be registered.');
    else if (d.rvAge !== null && d.rvAge > 13 * 3600000) add('needs', `Scheduled reviewer silent for ${ago(d.rv.lastRunAt)}: check Task Scheduler (JobApplyReviewer) and that the laptop is plugged in.`);
    if (d.rv && d.rv.lastExit) add('unusual', `The last reviewer run exited with code ${d.rv.lastExit}: see worker/logs/reviewer.out.`);
    if (!d.ml) add('improve', 'Mail clerk has never run: nothing can be confirmed until it does.'); else if (d.mAge > DAY) add('needs', `Mail clerk silent for ${ago(d.ml.at)}: receipts are not being read, sent cards cannot confirm.`);
    if (d.agents.failed || d.agents.stuck) add('unusual', `Agents did not finish for ${d.agents.failed + d.agents.stuck} of ${d.agents.fired} candidates last night${d.agents.stuck ? ` (${d.agents.stuck} still stuck, use Kick)` : ''}.`, '#/apply?s=candidate');
    if (lr && (lr.errors || []).length >= 2) add('unusual', `Last hunt logged ${lr.errors.length} errors: ${lr.errors.map(e => e.slice(0, 60)).join(' · ')}`);
    // producing
    SOURCES.forEach(s => { const zero = nights.filter(n => !n.noop).slice(0, 3).filter(n => !(n.src[s] > 0)).length; const seen = nights.filter(n => !n.noop).length; if (seen >= 2 && zero >= 2 && srcAvg[s] === 0) add('unusual', `${s === 'boards' ? 'ATS boards' : s[0].toUpperCase() + s.slice(1)} returned 0 roles for ${zero} nights in a row.`); else if (n0 && !n0.noop && seen >= 3 && srcAvg[s] >= 20 && (n0.src[s] || 0) < 0.4 * srcAvg[s]) add('unusual', `${s[0].toUpperCase() + s.slice(1)} returned ${n0.src[s] || 0} roles last night against a ${Math.round(srcAvg[s])} average: the source may be blocking or the query broke.`); });
    if (n0 && !n0.noop && n0.offered >= 10 && n0.cands / n0.offered < 0.1) add('unusual', `Sorter kept ${n0.cands} of ${n0.offered} offered last night. Top drops this week: ${d.topDrops.map(([k, n]) => `${k} ${n}`).join(', ')}.`);
    if (nights.length >= 2 && nights.every(n => n.noop || !n.cands)) add('unusual', 'No candidates in any run this week: deny list or title filters may be too tight.');
    if (d.capCut >= 3) add('improve', `${d.capCut} good candidates cut by the ${h.caps.prepared}-per-night cap this week. Raise it if the worker keeps up.`);
    if (d.prepared.length >= 3 && d.forfeited.length * 2 >= d.prepared.length) add('unusual', `${pct(d.forfeited.length, d.prepared.length)} of prepared cards forfeited this week: ${Object.entries(d.forfeitWhy).map(([k, n]) => `${k} ${n}`).join(', ')}. Feed the answer bank.`, '#/apply?s=skipped');
    if (d.prepared.length >= 3 && d.manual.length * 2.5 >= d.prepared.length) add('improve', `${pct(d.manual.length, d.prepared.length)} of prepared cards have no recipe: ${Object.entries(d.manualBy).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}. Build the biggest one next.`, '#/apply?s=manual');
    // delivering
    d.recipeRows.forEach(o => { if (o.last3.tried >= 2 && o.last3.sent === 0) add('needs', `${o.ats}: 0 of ${o.last3.tried} sent in the last 3 days${o.topClass ? ` (${o.topClass[0]})` : ''}. The recipe or the login is broken.`, '#/apply?s=failed'); else if (o.tried >= 3 && o.rate !== null && o.rate < 50) add('unusual', `${o.ats}: only ${o.rate}% of ${o.tried} attempts sent this week${o.topClass ? `, mostly ${o.topClass[0]}` : ''}.`, '#/apply?s=failed'); });
    const cap7 = (h.caps.perDay ?? 5) * 7; if (d.sent.length < 3 && (d.prepared.length >= 3 || d.queued.length) && d.wAge !== null) add('unusual', `Only ${d.sent.length} sent in 7 days, the cap allows ${cap7}. Supply is there, delivery is not.`, '#/apply');
    if (d.misread.length) add('improve', `${d.misread.length} recipe misread${d.misread.length === 1 ? '' : 's'}: sent in fact but recorded as failed. The success check is wrong.`, '#/apply?s=failed');
    if (d.retried.length >= 2) add('improve', `${d.retried.length} cards needed 2 or more attempts this week: flaky steps in the recipes.`);
    // outcomes
    const unvOld = d.unverified.filter(r => !within(r.apply.unverifiedAt, 1)).length; if (unvOld) add('needs', `${unvOld} sent card${unvOld === 1 ? '' : 's'} unverified for over a day: no receipt came. Check the inbox or the ATS.`, '#/apply?s=unverified');
    if (d.sent.length >= 3 && d.confirmed.length / d.sent.length < 0.5 && d.sent.filter(r => !within(r.apply.submittedAt || r.apply.unverifiedAt, 1)).length >= 2) add('unusual', `Only ${d.confirmed.length} of ${d.sent.length} sent got a receipt this week. Either the ATS does not mail receipts or the clerk misses them.`);
    if (d.stuck.submitting) add('unusual', `${d.stuck.submitting} card${d.stuck.submitting === 1 ? '' : 's'} stuck in submitting for over an hour: the worker died mid-form.`, '#/apply?s=submitting');
    if (d.stuck.submitted) add('unusual', `${d.stuck.submitted} submitted card${d.stuck.submitted === 1 ? '' : 's'} older than 3 days: the sweep is not running.`, '#/apply?s=submitted');
    if (d.garbled) add('improve', `${d.garbled} card${d.garbled === 1 ? '' : 's'} carry garbled Hebrew written by the worker: fix the encoding in the recipes.`);
    if (d.real >= 1) add('info', `The hunt surfaced ${d.real} real lead${d.real === 1 ? '' : 's'} this week (grade above 6). Decide on them by hand.`, '#/apply?s=real');
    if (h.autoQueue === false) add('info', 'Auto-queue is off: prepared cards wait for you every morning.');
    return S;
  }
  function systemBlock() {
    const d = systemData(7); const S = systemSignals(d);
    const ORDER = ['needs', 'unusual', 'improve', 'info']; const SL = {needs: 'Needs you', unusual: 'Unusual', improve: 'Improve', info: 'FYI'}; const SC = {needs: 'c-hot', unusual: 'c-warn', improve: 'c-accent-line', info: 'c-mute'};
    const all = ORDER.flatMap(s => S.filter(i => i.sev === s)); const MAX = 6; const more = all.length - MAX;
    const light = (cls, k, v, sub) => `<div class="light ${cls}"><span class="dot"></span><div><b>${esc(k)}</b><span>${v}</span>${sub ? `<small>${sub}</small>` : ''}</div></div>`;
    const n0 = d.nights[0]; const lr = d.lr;
    const huntL = !lr ? light('bad', 'Hunt', 'never ran') : d.missedNights >= 1 ? light('bad', 'Hunt', `missed ${d.missedNights} night${d.missedNights === 1 ? '' : 's'}`, `last ${esc(fmtT(lr.at))}`) : light(lr.ok === false || (lr.errors || []).length >= 2 ? 'warn' : 'ok', 'Hunt', lr.noop ? 'ran, no-op' : `ran, ${n0 ? n0.found : 0} seen → ${n0 ? n0.cands : 0} cand. → ${n0 ? n0.prepared : 0} prep.`, `${esc(fmtT(lr.at))}${(lr.errors || []).length ? ` · ${lr.errors.length} error${lr.errors.length === 1 ? '' : 's'}` : ''}`);
    const agL = light(d.agents.fired === 0 ? 'off' : d.agents.failed || d.agents.stuck ? 'warn' : 'ok', 'Agents', d.agents.fired ? `${d.agents.done} of ${d.agents.fired} came back` : 'nothing fired last night', d.agents.retried ? `${d.agents.retried} needed a retry` : '');
    const up = d.wt ? Math.min(100, Math.round(100 * (d.wt.runs || 0) / d.expected)) : null;
    const wL = light(d.wAge === null ? 'bad' : d.wAge > DAY ? 'bad' : d.wAge > 3600000 ? 'warn' : 'ok', 'PC worker', d.wAge === null ? 'never reported' : `seen ${ago(d.w.lastAt)} ago`, d.wt ? `${d.wt.runs || 0} of ${d.expected} ticks today (${up}%) · ${d.wt.submitted || 0} sent · ${d.wt.failed || 0} failed` : 'no ticks today');
    const mL = light(!d.ml ? 'off' : d.mAge > DAY ? 'bad' : d.mAge > 14 * 3600000 ? 'warn' : 'ok', 'Mail clerk', !d.ml ? 'never ran' : `checked ${ago(d.ml.at)} ago`, d.ml && d.ml.counts ? `${d.ml.counts.ack || 0} receipts · ${d.ml.counts.reply || 0} replies · ${d.ml.counts.rejected || 0} rejected` : '');
    const switches = `<div class="dim small switches">${d.h.killSwitch ? '<span class="chip c-hot">Kill switch ON</span>' : ''}${d.h.autoQueue === false ? '<span class="chip c-warn">auto-queue off</span>' : ''}caps: ${d.h.caps.perDay ?? 5}/day · ${d.h.caps.perHour ?? 5}/hour · ${d.h.caps.prepared} prepared · ${d.h.caps.found} candidates · ${d.h.caps.offered ?? 40} offered per night</div>`;
    const cr = (d.w || {}).credits;   // Netlify credit budget relayed by the worker (25 Oct 2026)
    const crL = cr && cr.budget ? light(cr.projected >= 0.85 * cr.budget ? 'bad' : cr.projected >= 0.7 * cr.budget ? 'warn' : 'ok', 'Credits', `${cr.used} of ${cr.budget} used`, `projected ${cr.projected} at the reset ${String(cr.resetAt || '').slice(0, 10)} · ${cr.deploysLeft} deploys fit · next deploy from ${cr.nextDeployAllowedAt ? new Date(cr.nextDeployAllowedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'now'}`) : '';
    const rvL = light(!d.rv || d.rvAge === null ? 'bad' : d.rv.lastExit ? 'warn' : d.rvAge > 13 * 3600000 ? 'bad' : d.rvAge > 7 * 3600000 ? 'warn' : 'ok', 'Reviewer', !d.rv || d.rvAge === null ? 'never reported' : `ran ${ago(d.rv.lastRunAt)} ago`, d.rv ? `${d.rv.open ?? 0} open · ${d.rv.proven ?? 0} proven${d.rv.lastExit ? ` · last exit ${d.rv.lastExit}` : ''}${d.rv.digest ? ` · ${esc(d.rv.digest)}` : ''}` : 'every 6 h, hidden Claude on the PC');
    const lights = `<div class="lights">${huntL}${agL}${wL}${rvL}${mL}${crL}</div>${switches}`;
    const sig = all.length ? `<div class="attns">${all.slice(0, MAX).map(i => `<div class="attn ${i.sev}"><span class="chip ${SC[i.sev]}">${SL[i.sev]}</span><div class="attn-b">${i.href ? `<a href="${i.href}">${esc(i.text)}</a>` : esc(i.text)}</div></div>`).join('')}</div>${more > 0 ? `<div class="dim small attn-more">${more} more: clear the ones above and they move up.</div>` : ''}` : `<div class="rbox dim">All quiet: the hunt ran, the agents came back, the worker is ticking, receipts arrive.</div>`;
    // numbers
    const nn = d.nights.filter(n => !n.noop); const avg = f => nn.length ? Math.round(nn.reduce((a, n) => a + f(n), 0) / nn.length) : 0;
    const srcRows = SOURCES.map(s => { const last = n0 && !n0.noop ? (n0.src[s] || 0) : 0; const a = Math.round(d.srcAvg[s]); const cls = !nn.length ? '' : last === 0 && a > 0 ? 'bad' : a && last < 0.6 * a ? 'warn' : ''; return `<div class="row"><span class="n">${s === 'boards' ? 'ATS boards' : s}</span><span class="mono ${cls}">${last}</span><span class="mono">${a}</span></div>`; }).join('');
    const huntT = `<div class="rows sys"><div class="row h"><span>Hunt, per night</span><span>Last</span><span>7d avg</span></div>${srcRows}<div class="row"><span class="n">Offered to the sorter</span><span class="mono">${n0 ? n0.offered : 0}</span><span class="mono">${avg(n => n.offered)}</span></div><div class="row"><span class="n">Candidates kept</span><span class="mono">${n0 ? n0.cands : 0}</span><span class="mono">${avg(n => n.cands)}</span></div><div class="row"><span class="n">Prepared (cap ${d.h.caps.prepared})</span><span class="mono">${n0 ? n0.prepared : 0}</span><span class="mono">${avg(n => n.prepared)}</span></div><div class="row"><span class="n">Real leads</span><span class="mono">${n0 ? n0.real : 0}</span><span class="mono">${d.real} total</span></div></div>
      <div class="dim small kv">Top drops this week: ${d.topDrops.length ? d.topDrops.map(([k, n]) => `${esc(k)} ${n}`).join(', ') : '–'}${d.capCut ? ` · cut by cap ${d.capCut}` : ''} · forfeited ${d.forfeited.length} of ${d.prepared.length} prepared${Object.keys(d.forfeitWhy).length ? ` (${Object.entries(d.forfeitWhy).map(([k, n]) => `${esc(k)} ${n}`).join(', ')})` : ''} · no recipe ${d.manual.length}${Object.keys(d.manualBy).length ? ` (${Object.entries(d.manualBy).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)} ${n}`).join(', ')})` : ''}</div>`;
    const recT = `<div class="rows sys rec"><div class="row h"><span>Recipe, 7 days</span><span>Tried</span><span>Sent</span><span>Failed</span><span>Blocked</span><span>Success</span><span>Last 3d</span><span>Top failure</span></div>${d.recipeRows.length ? d.recipeRows.map(o => `<div class="row"><span class="n">${esc(o.ats)}${o.manual ? `<small class="dim"> +${o.manual} by hand</small>` : ''}</span><span class="mono">${o.tried}</span><span class="mono">${o.sent}</span><span class="mono ${o.failed ? 'bad' : ''}">${o.failed}</span><span class="mono ${o.blocked ? 'bad' : ''}">${o.blocked}</span><span class="mono ${o.rate === null ? 'dim' : o.rate < 50 ? 'bad' : 'good'}">${o.rate === null ? '–' : o.rate + '%'}</span><span class="mono ${o.last3.tried && !o.last3.sent ? 'bad' : ''}">${o.last3.tried ? `${o.last3.sent}/${o.last3.tried}` : '–'}</span><span class="dim clip">${o.topClass ? esc(o.topClass[0]) : '–'}</span></div>`).join('') : '<div class="row"><span class="dim">nothing tried this week</span></div>'}</div>`;
    const cap7 = (d.h.caps.perDay ?? 5) * 7;
    const outT = `<div class="stats analytics"><div class="stat"><b class="mono">${d.sent.length}</b><span>Sent, 7d</span><small>cap ${cap7} · ${d.queued.length} queued now</small></div><div class="stat"><b class="mono">${d.confirmed.length}</b><span>Confirmed</span><small>${pct(d.confirmed.length, d.sent.length)} of sent${d.medLag !== null ? ` · receipt in ~${d.medLag < 1 ? '<1 h' : d.medLag < 48 ? Math.round(d.medLag) + ' h' : Math.round(d.medLag / 24) + ' d'}` : ''}</small></div><div class="stat"><b class="mono">${d.unverified.length}</b><span>Unverified</span><small>${d.unverified.length ? `oldest ${ago(d.unverified.map(r => r.apply.unverifiedAt).sort()[0])}` : 'none open'}</small></div><div class="stat"><b class="mono">${d.mail7.reply}</b><span>Replies, 7d</span><small>${d.mail7.rejected} rejected · ${d.mail7.ack} receipts</small></div><div class="stat"><b class="mono">${d.screens}</b><span>Screens</span><small>sprint goal ${SPRINT_GOALS.screens}</small></div><div class="stat"><b class="mono">${d.lessonsN}</b><span>Lessons</span><small>${(d.h.applied || []).length} companies in the ledger</small></div></div>`;
    return sec('System', `<a class="btn quiet" href="#/analytics">Analytics</a><span class="dim small">${all.length ? all.filter(i => i.sev === 'needs').length + ' need you · ' + all.filter(i => i.sev === 'unusual').length + ' unusual · ' + all.filter(i => i.sev === 'improve').length + ' to improve' : 'all quiet'}</span>`, `${lights}${sig}<h3 class="sub-h">Numbers, last 7 days</h3>${outT}${huntT}${recT}`, 'syssec');
  }
  // Practice home: the practice tier and the hands-off apply loop. Counts here never touch the real numbers.
  function homePractice() {
    const stat = (n, goal, l, dim) => `<div class="stat ${dim ? 'dim' : ''}"><b class="mono">${n}</b><span>${l}</span></div>`;
    const pr = practiceRoles();
    const cnt = s => pr.filter(r => r.stage === s).length;
    const confirmed = pr.filter(r => applyOf(r) && applyOf(r).status === 'confirmed').length;
    const cos = state.companies.filter(isPractice).length;
    const openN = state.tasks.filter(t => !t.done && t.text.trim() && tierOfTask(t) === 'practice').length;
    const replies = pr.filter(r => (r.mail || [])[0] && r.mail[0].kind === 'reply' && /^Reply to /.test(r.nextAction || '')).map(r => { const co = get('company', r.companyId); return `<a class="mail-reply" href="${href('role', r)}"><span class="chip c-hot">Reply needed</span><b>${esc(co ? label('company', co) : '')}</b><span>${esc(r.nextAction)}</span></a>`; }).join('');
    return `<div class="head"><h1 class="title">Home</h1><span class="dim small">Practice tier + automation</span><a class="btn" href="#/analytics">Analytics</a>${homeBar()}</div>
      <div class="stats practice">${stat(cos, 0, 'Companies', !cos)}${stat(pr.length, 0, 'Roles', !pr.length)}${['applied','interviewing','offer'].map(s => stat(cnt(s), 0, L[s], !cnt(s))).join('')}${stat(confirmed, 0, 'Confirmed', !confirmed)}${stat(openN, 0, 'Open tasks', !openN)}</div>
      ${systemBlock()}
      ${replies ? sec('Mail', '', `<div class="mailbox">${replies}</div>`, 'mailsec') : ''}
      ${applyLoopBlock()}
      ${sprintBlock()}
      ${groupsBlock(taskGroups('practice'), 'Nothing open on any practice company or role.')}`;
  }
  // ---- Analytics page: the practice loop as a funnel, per day, so every day's work shows up as a rate moving (Eyal, 21 Oct 2026). ----
  // Four stages, each with an owner of the fix: kept -> queued (finder, answer bank, briefs) · queued -> sent (recipes, worker) ·
  // sent -> receipt (mail clerk; Drushim and AllJobs never mail one) · sent -> reply / interview (CV, targeting, grade).
  // Cohorts: a card is counted on the day it ENTERED a stage (found / queued / sent), so a day's rate does not drift when a later
  // day happens, and outcomes that lag show as "still open" instead of a false 0%. Counts are context; rates are what we move.
  const dayOf = iso => { const d = new Date(iso); if (isNaN(d)) return ''; return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const ATTACK = [
    [/manualOnly - linkedin|own form not found|own careers portal|own portal|no recipe/i, 'form finder (find-form.mjs) or a new recipe'],
    [/needsAnswer|needs-human|open screeners|answer bank/i, 'answer bank (answer-bank.md)'],
    [/cannotGrade/i, 'grader brief: grade from the posting when the company is unknown'],
    [/capPrepared|cap reached/i, 'raise caps.prepared if the worker keeps up'],
    [/stale|closed|no longer/i, 'finder freshness filter'],
    [/click never landed|intercept/i, 'overlay handling before submit'],
    [/changed-form|not found|missing|did not (render|appear|register)/i, 'recipe selectors'],
    [/timeout|no confirmation/i, 'recipe confirmation check'],
    [/release|logged out/i, 'runner Chrome login'],
    [/captcha|bot/i, 'blocked by design: wait, never bypass'],
    [/upload/i, 'CV upload step'],
    [/never-twice|duplicate/i, 'dedupe before prep'],
    [/dialog/i, 'browser dialog handling'],
  ];
  const attackFor = k => { const m = ATTACK.find(([re]) => re.test(k)); return m ? m[1] : 'open the card'; };
  const reasonKey = s => String(s || '').replace(/^forfeited:\s*/i, '').split(/[;(]/)[0].replace(/\s+-\s+linkedin.*$/i, ' - linkedin').replace(/:\s.*$/, '').trim().slice(0, 48) || 'unknown';
  function analyticsData(days = 14) {
    const now = Date.now(); const since = now - days * DAY;
    const pr = practiceRoles().filter(r => applyOf(r)); const a = r => r.apply;
    const queuedAt = r => a(r).approvedAt || a(r).startedAt || (['submitted', 'confirmed', 'failed', 'blocked'].includes(a(r).status) ? (a(r).submittedAt || a(r).failedAt || a(r).blockedAt) : '');
    const sentAt = r => a(r).submittedAt || (a(r).status === 'confirmed' ? a(r).confirmedAt : '');
    const isReal = r => a(r).status === 'real' || /gradeAbove6/i.test(a(r).reason || '');
    const kept = pr.filter(r => a(r).foundAt && !isReal(r));
    const real = state.roles.filter(r => applyOf(r) && r.apply.foundAt && isReal(r));   // graded above 6: moved to the real tier, so not in practiceRoles()
    const queued = pr.filter(r => queuedAt(r)); const sent = pr.filter(r => sentAt(r));
    const unknown = pr.filter(r => a(r).status === 'unverified' && !sentAt(r));   // clicked, outcome never seen
    const failed = pr.filter(r => ['failed', 'blocked'].includes(a(r).status));
    const replied = r => (r.mail || []).some(m => m.kind === 'reply');
    const rejected = r => (r.mail || []).some(m => m.kind === 'rejected') || r.stage === 'closed';
    const interview = r => !!r.screened || ['interviewing', 'offer'].includes(r.stage);
    const rows = {}; const row = d => rows[d] = rows[d] || { d, seen: null, kept: 0, real: 0, queued: 0, sent: 0, unknown: 0, failed: 0, confirmed: 0, replies: 0, interviews: 0 };
    for (let i = 0; i < days; i++) row(dayOf(now - i * DAY));
    (hunt().runs || []).forEach(x => { const d = dayOf(x.at); if (rows[d]) rows[d].seen = (rows[d].seen || 0) + ((x.funnel && x.funnel.found) || 0); });
    const bump = (list, at, k) => list.forEach(r => { const d = dayOf(at(r)); if (rows[d]) rows[d][k]++; });
    bump(kept, r => a(r).foundAt, 'kept'); bump(real, r => a(r).foundAt, 'real'); bump(queued, queuedAt, 'queued'); bump(sent, sentAt, 'sent');
    bump(sent.filter(r => a(r).confirmedAt), sentAt, 'confirmed'); bump(sent.filter(replied), sentAt, 'replies'); bump(sent.filter(interview), sentAt, 'interviews');
    bump(unknown, r => a(r).unverifiedAt || a(r).startedAt, 'unknown'); bump(failed, r => a(r).failedAt || a(r).blockedAt, 'failed');
    const win = (from, to) => {
      const inW = t => t && new Date(t).getTime() >= from && new Date(t).getTime() < to;
      const k = kept.filter(r => inW(a(r).foundAt)); const q = queued.filter(r => inW(queuedAt(r))); const s = sent.filter(r => inW(sentAt(r)));
      return { kept: k.length, keptQueued: k.filter(r => queuedAt(r)).length, keptSent: k.filter(r => sentAt(r)).length, keptOpen: k.filter(r => !queuedAt(r) && ['candidate', 'prepared'].includes(a(r).status)).length,
        queued: q.length, queuedSent: q.filter(r => sentAt(r)).length, queuedUnknown: q.filter(r => a(r).status === 'unverified' && !sentAt(r)).length, queuedOpen: q.filter(r => ['approved', 'submitting'].includes(a(r).status)).length,
        sent: s.length, confirmed: s.filter(r => a(r).confirmedAt).length, replied: s.filter(replied).length, interviews: s.filter(interview).length, rejected: s.filter(rejected).length, open: s.filter(r => !replied(r) && !rejected(r) && !interview(r)).length };
    };
    const w7 = win(now - 7 * DAY, now + DAY), p7 = win(now - 14 * DAY, now - 7 * DAY), all = win(0, now + DAY);
    const count = (list, f) => { const m = {}; list.forEach(r => { const k = f(r); if (k) m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((x, y) => y[1] - x[1]); };
    const inRange = t => t && new Date(t).getTime() >= since;
    const notQueued = kept.filter(r => inRange(a(r).foundAt) && !queuedAt(r) && !['candidate', 'prepared'].includes(a(r).status));
    const whyNotQueued = count(notQueued, r => a(r).status === 'manual' ? `no recipe for ${a(r).ats || 'this form'}` : reasonKey(a(r).reason || a(r).status));
    const notSent = pr.filter(r => queuedAt(r) && inRange(queuedAt(r)) && !sentAt(r) && !['approved', 'submitting'].includes(a(r).status));
    const whyNotSent = count(notSent, r => `${a(r).ats || '?'}: ${a(r).status === 'unverified' ? 'clicked, outcome unknown' : reasonKey(a(r).reason || a(r).status)}`);
    const byAts = {}; pr.filter(r => queuedAt(r) && inRange(queuedAt(r))).forEach(r => { const k = a(r).ats || '?'; const o = byAts[k] = byAts[k] || { ats: k, queued: 0, sent: 0, unknown: 0, failed: 0, open: 0 }; o.queued++; if (sentAt(r)) o.sent++; else if (a(r).status === 'unverified') o.unknown++; else if (['failed', 'blocked'].includes(a(r).status)) o.failed++; else o.open++; });
    // LinkedIn: of the practice cards that came in through LinkedIn, how many got a form outside LinkedIn (sorter or PC finder) and how many were sent
    const companyOf = r => get('company', r.companyId) || {}; const liOf = list => { const f = list.filter(r => (companyOf(r).hunt || {}).source === 'linkedin'); const form = f.filter(r => a(r).ats && a(r).ats !== 'linkedin'); return { found: f.length, form: form.length, sent: f.filter(r => sentAt(r)).length, noForm: f.filter(r => a(r).ats === 'linkedin').map(r => companyOf(r).name) }; };
    const linkedin = { range: liOf(kept.filter(r => inRange(a(r).foundAt))), all: liOf(kept) };
    // What gets answers (25 Oct 2026): every sent practice card grouped by what we sent and where, with what came back. Only the mail
    // clerk's piles count as answers; days = submit to the first reply or rejection.
    const family = r => { const t = String(r.title || a(r).title || '').toLowerCase(); return /product|מוצר|\btpm\b|\bpm\b/.test(t) ? 'Product' : /solution|implementation|integration|customer|פתרונות|presales|pre-sales/.test(t) ? 'Solutions / customer engineer' : /\bai\b|llm|genai|gen ai|machine learning|\bml\b|agent/.test(t) ? 'AI engineer' : 'Other'; };
    const firstAnswer = r => { const t0 = new Date(sentAt(r)).getTime(); const m = (r.mail || []).filter(x => ['reply', 'rejected'].includes(x.kind) && new Date(x.date).getTime() >= t0).map(x => new Date(x.date).getTime()).sort((x, y) => x - y)[0]; return m ? (m - t0) / DAY : null; };
    const median = xs => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
    const groupBy = (list, f) => { const m = {}; list.forEach(r => { const k = f(r) || '?'; (m[k] = m[k] || []).push(r); }); return Object.entries(m).map(([k, rs]) => ({ k, sent: rs.length, receipt: rs.filter(r => a(r).confirmedAt).length, rejected: rs.filter(rejected).length, replied: rs.filter(replied).length, interviews: rs.filter(interview).length, days: median(rs.map(firstAnswer).filter(x => x !== null)) })).sort((x, y) => y.sent - x.sent); };
    const answersOf = list => ({ cv: groupBy(list, r => a(r).cv), family: groupBy(list, family), source: groupBy(list, r => (companyOf(r).hunt || {}).source || 'boards'), ats: groupBy(list, r => a(r).ats), grade: groupBy(list, r => a(r).grade != null ? `grade ${a(r).grade}` : ''), senior: groupBy(list, r => /senior|\bsr\b|סניור|בכיר/i.test(r.title || '') ? 'Senior in the title' : 'No seniority word') });
    const answers = { all: answersOf(sent), range: answersOf(sent.filter(r => inRange(sentAt(r)))) };
    return { days, win, linkedin, answers, rows: Object.values(rows).sort((x, y) => y.d.localeCompare(x.d)), w7, p7, all, whyNotQueued, whyNotSent, byAts: Object.values(byAts).sort((x, y) => y.queued - x.queued), totals: { kept: kept.length, real: real.length, queued: queued.length, sent: sent.length, unknown: unknown.length, confirmed: sent.filter(r => a(r).confirmedAt).length, replied: sent.filter(replied).length, interviews: sent.filter(interview).length, rejected: sent.filter(rejected).length, open: sent.filter(r => !replied(r) && !rejected(r) && !interview(r)).length } };
  }
  function analyticsPage() {
    const q = new URLSearchParams(location.hash.split('?')[1] || ''); const days = [7, 14, 30].includes(Number(q.get('d'))) ? Number(q.get('d')) : 14;
    const d = analyticsData(days); const w = d.w7, p = d.p7, t = d.totals;
    const rate = (n, m) => m ? Math.round(100 * n / m) : null;
    // the one number: of the jobs the hunt kept, how many were sent (end to end), these 7 days against the 7 before
    const cur = rate(w.keptSent, w.kept), prev = rate(p.keptSent, p.kept);
    const dpts = cur !== null && prev !== null ? cur - prev : null;
    const sent3 = d.rows.slice(0, 3).reduce((n, r) => n + r.sent, 0);
    let mood = 'flat', head = 'Flat', why = '';
    if (cur === null) { mood = 'none'; head = 'Nothing to judge yet'; why = 'No kept jobs in the last 7 days.'; }
    else if (w.queuedUnknown >= 2 || (sent3 === 0 && w.kept >= 3)) { mood = 'bad'; head = 'Needs attention'; why = sent3 === 0 ? `Nothing sent in 3 days while ${w.kept} jobs were kept this week.` : `${w.queuedUnknown} cards clicked with an unknown outcome this week.`; }
    else if (dpts === null) { mood = cur >= 60 ? 'good' : cur >= 35 ? 'flat' : 'bad'; head = cur >= 60 ? 'Running well' : cur >= 35 ? 'Half way' : 'Needs attention'; why = `${w.keptSent} of ${w.kept} kept jobs were sent this week (${cur}%). No earlier week to compare yet.`; }
    else if (dpts >= 5) { mood = 'good'; head = 'Moving forward'; why = `${cur}% of kept jobs were sent this week, up from ${prev}% the week before.`; }
    else if (dpts <= -5) { mood = 'bad'; head = 'Slipping'; why = `${cur}% of kept jobs were sent this week, down from ${prev}% the week before.`; }
    else { mood = 'flat'; head = 'Flat'; why = `${cur}% this week, ${prev}% the week before. No real change.`; }
    const verdict = `<div class="verdict ${mood}"><span class="vdot"></span><div><b>${esc(head)}</b><span>${esc(why)}</span></div></div>`;
    const arrow = (c, pr, unit = ' pts') => c === null || pr === null ? '<span class="dim">no week before</span>' : c === pr ? '<span class="dim">same as last week</span>' : `<span class="${c > pr ? 'up' : 'down'}">${c > pr ? '▲' : '▼'} ${Math.abs(c - pr)}${unit} vs last week</span>`;
    const tile = (big, label, sub, foot) => `<div class="tile"><span class="t-l">${esc(label)}</span><b class="mono">${big}</b><span class="t-s mono">${sub}</span><span class="t-f">${foot}</span></div>`;
    const tiles = `<div class="tiles">
      ${tile(cur === null ? '–' : cur + '%', 'Submission rate, this week', `${w.keptSent} of ${w.kept} kept jobs sent`, arrow(cur, prev))}
      ${tile(w.sent, 'Sent, this week', `${p.sent} the week before`, arrow(w.sent, p.sent, ''))}
      ${tile(pct(t.interviews, t.sent), 'Interviews, all time', `${t.interviews} of ${t.sent} sent · ${t.replied} replied`, t.sent ? `${t.open} still waiting for an answer` : 'nothing sent yet')}
    </div>`;
    // 14-day strip: kept (light) and the sent share of it (dark) per day, oldest on the left
    const strip = [...d.rows].reverse().slice(-14); const mx = Math.max(1, ...strip.map(r => r.kept));
    const bars = strip.map(r => { const k = r.kept, s = Math.min(r.sent, k); const hk = Math.round(100 * k / mx); const hs = k ? Math.round(100 * s / k) : 0; return `<div class="sbar" title="${r.d}: kept ${k}, sent ${r.sent}${r.failed ? `, failed ${r.failed}` : ''}${r.unknown ? `, unknown ${r.unknown}` : ''}"><div class="bk" style="height:${hk}%"><div class="bs" style="height:${hs}%"></div></div><span class="bl">${r.d.slice(8)}</span></div>`; }).join('');
    const stripH = `<div class="strip">${bars}</div><div class="dim small kv">Each day: the light bar is the jobs kept that night, the dark part is how many of them got sent. A bar that is all dark is a perfect night. Hover a bar for the numbers.</div>`;
    // by week: four 7-day blocks ending today
    const now = Date.now();
    const wk = [0, 1, 2, 3].map(i => ({ i, ...d.win(now - (i + 1) * 7 * DAY, i === 0 ? now + DAY : now - i * 7 * DAY) }));
    const wkRows = wk.map(x => { const r = rate(x.keptSent, x.kept); const lost = x.queued - x.queuedSent - x.queuedOpen; return `<div class="row ${x.kept || x.sent ? '' : 'dim'}"><span class="n">${x.i === 0 ? 'This week' : x.i === 1 ? 'Last week' : `${x.i} weeks ago`}</span><span class="mono">${x.kept}</span><span class="mono">${x.sent}</span><span class="mono ${r === null ? '' : r >= 60 ? 'good' : r >= 35 ? 'warn' : 'bad'}">${r === null ? '–' : r + '%'}</span><span class="mono ${lost ? 'bad' : ''}">${lost}</span><span class="mono ${x.interviews ? 'good' : ''}">${x.interviews}</span></div>`; }).join('');
    const weekT = `<div class="rows wk"><div class="row h"><span>Week</span><span>Kept</span><span>Sent</span><span>Rate</span><span>Failed or unknown</span><span>Interviews</span></div>${wkRows}</div>`;
    // the top leaks right now
    const leaks = [...d.whyNotQueued.map(([k, n]) => ({ k, n, stage: 'never reached the queue' })), ...d.whyNotSent.map(([k, n]) => ({ k, n, stage: 'queued but not sent' }))].sort((a, b) => b.n - a.n).slice(0, 3);
    const leakH = leaks.length ? `<div class="leaks">${leaks.map(l => `<div class="leak"><b class="mono">${l.n}</b><div><span>${esc(l.k)}</span><small class="dim">${esc(l.stage)} · attack: ${esc(attackFor(l.k))}</small></div></div>`).join('')}</div>` : '<div class="dim small">No leaks in this window: every kept job was sent.</div>';
    // LinkedIn: form-found share under 70% means the LinkedIn situation needs a decision (Eyal, 21 Oct)
    const li = d.linkedin.range, liA = d.linkedin.all; const liForm = rate(li.form, li.found), liSent = rate(li.sent, li.found);
    const liMood = li.found < 3 ? 'none' : liForm >= 70 ? 'good' : 'bad';
    const liH = `<div class="tiles li">
      ${tile(li.found, 'LinkedIn jobs found', `${liA.found} all time`, li.found ? '' : '<span class="dim">none in this window</span>')}
      ${tile(liForm === null ? '–' : liForm + '%', 'Form found outside LinkedIn', `${li.form} of ${li.found} · ${pct(liA.form, liA.found)} all time`, liMood === 'bad' ? '<span class="down">under 70%: time to sort the LinkedIn situation</span>' : liMood === 'good' ? '<span class="up">above the 70% line</span>' : '<span class="dim">under 3 jobs, too few to judge</span>')}
      ${tile(liSent === null ? '–' : liSent + '%', 'Sent', `${li.sent} of ${li.found} · ${pct(liA.sent, liA.found)} all time`, li.noForm.length ? `<span class="dim">still LinkedIn-only: ${esc(li.noForm.slice(0, 3).join(', '))}${li.noForm.length > 3 ? ` +${li.noForm.length - 3}` : ''}</span>` : '<span class="dim">no LinkedIn-only cards left</span>')}
    </div><div class="dim small kv">Jobs the hunt picked up on LinkedIn. We never submit on LinkedIn itself: the sorter or the PC finder has to find the company's own form (Comeet, Greenhouse, SmartRecruiters...). Under 70% found means too many jobs die on LinkedIn.</div>`;
    // What gets answers: one table per way of slicing the sent cards; rows under 5 sent are too few to read
    const ansScope = q.get('a') === 'range' ? 'range' : 'all'; const A = d.answers[ansScope];
    const ansT = (title, rows) => `<div class="rows ans"><div class="row h"><span>${esc(title)}</span><span>Sent</span><span>Receipt</span><span>Rejected</span><span>Replied</span><span>Interview</span><span>Days to answer</span></div>${rows.length ? rows.map(x => `<div class="row ${x.sent < 5 ? 'dim' : ''}" ${x.sent < 5 ? 'title="under 5 sent: too few to read"' : ''}><span class="n">${esc(x.k)}</span><span class="mono">${x.sent}</span><span class="mono">${pct(x.receipt, x.sent)}</span><span class="mono">${x.rejected}</span><span class="mono ${x.replied ? 'good' : ''}">${x.replied}</span><span class="mono ${x.interviews ? 'good' : ''}">${x.interviews}</span><span class="mono">${x.days === null ? '–' : x.days.toFixed(1)}</span></div>`).join('') : '<div class="row dim"><span>nothing sent</span></div>'}</div>`;
    const ansScopeBtn = `<div class="filter" role="group" aria-label="Scope">${[['all', 'All time'], ['range', `${days} days`]].map(([k, l]) => `<a class="fbtn ${k === ansScope ? 'on' : ''}" href="#/analytics?d=${days}${k === 'range' ? '&a=range' : ''}">${l}</a>`).join('')}</div>`;
    const ansH = `${ansT('Role family', A.family)}${ansT('CV version', A.cv)}${ansT('Seniority', A.senior)}${ansT('Found on', A.source)}${ansT('Form (ATS)', A.ats)}${ansT('Grade', A.grade)}
      <div class="dim small kv">Every sent practice application, sliced six ways. Answers are what the mail clerk filed: a rejection or a human reply (an interview counts once the stage moves). Grey rows have under 5 sent: too few to read. Each card's exact form answers are under "What we sent" on its role page.</div>`;
    // details: the full view, folded away
    const card = (title, n, m, pn, pm, owner, note, href2) => { const r = rate(n, m); return `<div class="ana-card"><div class="ana-t">${esc(title)}</div><b class="mono">${r === null ? '–' : r + '%'}</b><div class="ana-n mono">${n} of ${m} <span class="dim">· last 7 days</span></div><div class="ana-d">${m ? arrow(r, rate(pn, pm)) : '<span class="dim">nothing entered this stage in 7 days</span>'}</div><div class="ana-o"><span class="chip c-mute">owner</span> ${esc(owner)}</div>${note ? `<small class="dim">${note}</small>` : ''}${href2 ? `<a class="small" href="${href2}">cards</a>` : ''}</div>`; };
    const cards = `<div class="ana-cards">
      ${card('Kept → queued', w.keptQueued, w.kept, p.keptQueued, p.kept, 'finder, answer bank, briefs', `counted on the night the card was found${w.keptOpen ? ` · ${w.keptOpen} still being prepared` : ''}`, '#/apply?s=skipped')}
      ${card('Queued → sent', w.queuedSent, w.queued, p.queuedSent, p.queued, 'recipes, worker', `${w.queuedUnknown ? `${w.queuedUnknown} clicked with unknown outcome, not counted as sent · ` : ''}${w.queuedOpen ? `${w.queuedOpen} in the queue now` : 'queue empty'}`, '#/apply?s=failed')}
      ${card('Sent → receipt', w.confirmed, w.sent, p.confirmed, p.sent, 'mail clerk', 'Drushim and AllJobs never mail a receipt: this stays low until more sends go through Greenhouse, Comeet, Lever, Ashby or SmartRecruiters', '#/apply?s=submitted')}
      ${card('Sent → interview', w.interviews, w.sent, p.interviews, p.sent, 'CV, targeting, grade', `${w.replied} replied · ${w.rejected} rejected · ${w.open} still open (outcomes lag by days or weeks)`, '#/apply?s=confirmed')}
    </div>`;
    const dayRows = d.rows.map(r => `<div class="row ${r.seen === null && !r.kept && !r.queued && !r.sent && !r.failed ? 'dim' : ''}"><span class="n mono">${r.d.slice(5)}</span><span class="mono">${r.seen === null ? '–' : r.seen}</span><span class="mono">${r.kept}${r.real ? `<small class="dim"> +${r.real} real</small>` : ''}</span><span class="mono">${r.queued}</span><span class="mono ${r.sent ? 'good' : ''}">${r.sent}</span><span class="mono ${r.unknown ? 'warn' : ''}">${r.unknown}</span><span class="mono ${r.failed ? 'bad' : ''}">${r.failed}</span><span class="mono">${r.confirmed}</span><span class="mono">${r.replies}</span><span class="mono ${r.interviews ? 'good' : ''}">${r.interviews}</span></div>`).join('');
    const dayT = `<div class="rows ana"><div class="row h"><span>Day</span><span>Seen</span><span>Kept</span><span>Queued</span><span>Sent</span><span>Unknown</span><span>Failed</span><span>Receipts</span><span>Replies</span><span>Interviews</span></div>${dayRows}</div>
      <div class="dim small kv">Seen = postings the finder looked at that night. Kept = cards the sorter kept for the practice tier (real leads counted apart). Each card sits on the day it entered that column. Unknown = the worker clicked submit and never saw a confirmation. Receipts, replies and interviews sit on the day the card was SENT, so a row keeps filling in for weeks.</div>`;
    const whyT = (title, list, empty) => `<div class="rows why"><div class="row h"><span>${esc(title)}</span><span>Cards</span><span>What to attack</span></div>${list.length ? list.slice(0, 8).map(([k, n]) => `<div class="row"><span class="n">${esc(k)}</span><span class="mono">${n}</span><span class="dim">${esc(attackFor(k))}</span></div>`).join('') : `<div class="row dim"><span>${esc(empty)}</span><span></span><span></span></div>`}</div>`;
    const rec = `<div class="rows rec2"><div class="row h"><span>Recipe</span><span>Queued</span><span>Sent</span><span>Unknown</span><span>Failed</span><span>Success</span></div>${d.byAts.length ? d.byAts.map(o => { const r = rate(o.sent, o.queued - o.open); return `<div class="row"><span class="n">${esc(o.ats)}</span><span class="mono">${o.queued}</span><span class="mono">${o.sent}</span><span class="mono">${o.unknown}</span><span class="mono ${o.failed ? 'bad' : ''}">${o.failed}</span><span class="mono ${r !== null && r < 50 ? 'bad' : r !== null && r < 80 ? 'warn' : ''}">${r === null ? '–' : r + '%'}</span></div>`; }).join('') : '<div class="row dim"><span>nothing queued in this window</span><span></span><span></span><span></span><span></span><span></span></div>'}</div>`;
    const totals = `<div class="stats analytics"><div class="stat"><b class="mono">${t.sent}</b><span>Sent, all time</span><small>${t.unknown ? `+${t.unknown} unknown outcome` : 'every click seen through'}</small></div><div class="stat"><b class="mono">${pct(t.confirmed, t.sent)}</b><span>Receipts</span><small>${t.confirmed} of ${t.sent}</small></div><div class="stat"><b class="mono">${pct(t.replied, t.sent)}</b><span>Replies</span><small>${t.replied} of ${t.sent} · ${t.rejected} rejected</small></div><div class="stat"><b class="mono">${pct(t.interviews, t.sent)}</b><span>Interviews</span><small>${t.interviews} of ${t.sent}</small></div><div class="stat"><b class="mono">${t.real}</b><span>Real leads surfaced</span><small>grade above 6, by hand</small></div></div>`;
    const range = `<div class="filter" role="group" aria-label="Range">${[7, 14, 30].map(n => `<a class="fbtn ${n === days ? 'on' : ''}" href="#/analytics?d=${n}">${n} days</a>`).join('')}</div>`;
    return bc([['Practice home', '#/']]) + `<div class="head"><h1 class="title">Analytics</h1><span class="dim small">Practice tier · are we getting better at submitting?</span>${range}</div>
      ${verdict}
      ${tiles}
      ${sec('Last 14 days, night by night', '', stripH)}
      ${sec('By week', '', weekT)}
      ${sec(`Where we lose jobs now, ${days} days`, '', leakH)}
      ${sec(`LinkedIn, ${days} days`, '', liH)}
      ${sec('What gets answers', ansScopeBtn, ansH)}
      <details class="ana-details"><summary>Details: stages, per day, reasons, recipes, all time</summary>
      ${cards}
      ${sec('All time', '', totals)}
      ${sec(`Per day, last ${days}`, '', dayT)}
      ${sec(`Why kept cards never reached the queue, ${days} days`, `<a class="small" href="#/apply?s=skipped">forfeited cards</a>`, whyT('Reason', d.whyNotQueued, 'every kept card reached the queue'))}
      ${sec(`Why queued cards were not sent, ${days} days`, `<a class="small" href="#/apply?s=failed">failed cards</a>`, whyT('Recipe: reason', d.whyNotSent, 'every queued card was sent'))}
      ${sec(`By recipe, ${days} days`, '', rec)}
      </details>`;
  }
  PAGES.analytics = () => analyticsPage();
  PAGES.channel = ({id}) => {
    const ch = get('channel', id); if (!ch) return notFound();
    const k = kindOf(ch); const ps = state.people.filter(p => p.channelId === ch.id);
    return bc([['Home', '#/'], [label('channel', ch)]]) + `<div class="head">${title('channel', id, PH.channel)}<div class="chips"><span class="chip c-mute" style="border:0">Holds</span>${chip('kind', 'channel', {id, kind: ch.kind || guessKind(ch)})}</div></div>
      <div class="fields"><label>Snapshot</label>${field('channel', id, 'snapshot', 'One line on where this channel stands')}</div>
      ${sec(k.many, `<button class="btn" data-add="person" data-channel="${id}">+ ${k.one}</button>`, ps.length ? `<div class="grid">${ps.map(personCard).join('')}</div>` : empty(k.empty))}
      ${tasksBlock('channel', id)}
      ${removeBtn('channel', id, 'channel')}`;
  };
  PAGES.person = ({id}) => {
    const p = get('person', id); if (!p) return notFound();
    const k = kindOfP(p); const human = isPerson(p);
    const ch = get('channel', p.channelId); const via = p.viaId ? get('person', p.viaId) : null;
    const cos = companiesOf(p); const sd = secondDeg(p);
    const crumbs = [['Home', '#/']]; if (ch) crumbs.push([label('channel', ch), href('channel', ch)]); if (via) crumbs.push([label('person', via), href('person', via)]); crumbs.push([label('person', p)]);
    return bc(crumbs) + `<div class="head">${title('person', id, k.ph)}<div class="chips">${chip('status', 'person', p)}${p.statusAt ? `<span class="chip c-mute" title="Status since">since ${esc(p.statusAt)}</span>` : ''}</div></div>
      ${human ? `<p class="sub">${via ? `2nd degree, via <a href="${href('person', via)}">${esc(label('person', via))}</a> · ` : ''}${pick('via', id, opt('person', state.people.filter(x => x.id !== id && isPerson(x))), via ? 'Change who intros…' : 'Reached via… (optional)')}${via ? ` <button class="btn quiet" data-clearvia="${id}">clear</button>` : ''}</p>` : ''}
      <div class="fields"><label>${esc(k.whoL)}</label>${field('person', id, 'who', k.whoPh)}<label>Why relevant</label>${field('person', id, 'why', k.whyPh)}</div>
      ${sec(k.cos, `${pick('linkCompany', id, opt('company', state.companies.filter(c => !c.peopleIds.includes(id))), 'Link existing…')}<button class="btn" data-add="company" data-person="${id}">+ New company</button>`, cos.length ? `<div class="grid">${cos.map(companyCard).join('')}</div>` : empty(k.cosEmpty))}
      ${human ? sec('2nd degree', `<button class="btn" data-add="person" data-channel="${p.channelId}" data-via="${id}">+ Person</button>`, sd.length ? `<div class="grid">${sd.map(personCard).join('')}</div>` : empty('People this person can intro me to.')) : ''}
      ${tasksBlock('person', id)}
      <div class="notes">${sec('Notes', '', field('person', id, 'notes', 'Anything else'))}</div>
      ${removeBtn('person', id, k.one.toLowerCase())}`;
  };
  PAGES.company = ({id}) => {
    const c = get('company', id); if (!c) return notFound();
    const ps = peopleOf(c); const rs = rolesOf(c);
    return bc([['Home', '#/'], ['Companies', '#/companies'], [label('company', c)]]) + `<div class="head">${c.logo ? `<img class="logo big" src="${esc(c.logo)}" alt="">` : ''}${title('company', id, PH.company)}<div class="chips">${rs.map(r => chipRO(r.stage)).join('')}${chip('tier', 'company', {id, tier: tierOf(c)})}${autoChip('company', c)}</div></div>
      <div class="fields"><label>What they do</label>${field('company', id, 'what', 'Product, market, one line')}<label>Stage & size</label>${field('company', id, 'stage', 'Round, headcount, location')}<label>CEO</label>${field('company', id, 'ceo', 'Who runs it, technical or not, where they sit')}<label>Why it fits</label>${field('company', id, 'fit', 'Would I learn here, team strength, real hole to fill')}<label>Links</label>${field('company', id, 'links', 'Site, LinkedIn, notes file')}</div>
      ${researchBlock(c)}
      ${debriefsBlock('company', c)}
      ${sec('Way in', pick('linkPerson', id, opt('person', state.people.filter(p => !c.peopleIds.includes(p.id))), 'Link a person or platform…'), ps.length ? `<div class="pills">${ps.map(p => `<span class="pill"><a href="${href('person', p)}">${esc(label('person', p))}</a><button class="x" data-unlink="${p.id}" data-company="${id}" title="Unlink">×</button></span>`).join('')}</div>` : empty('Nothing linked. Who or what gets me in here?'))}
      ${sec('Roles', `<button class="btn" data-add="role" data-company="${id}">+ Role</button>`, rs.length ? `<div class="grid">${rs.map(roleCard).join('')}</div>` : empty('No roles yet. Add the seat I am going for.'))}
      ${tasksBlock('company', id)}
      <div class="notes">${sec('Notes', '', field('company', id, 'notes', 'Research, conversations, anything'))}</div>
      ${removeBtn('company', id, 'company')}`;
  };
  PAGES.role = ({id}) => {
    const r = get('role', id); if (!r) return notFound();
    const c = get('company', r.companyId); const via = r.viaId ? get('person', r.viaId) : null;
    return bc([['Home', '#/'], ['Companies', '#/companies'], [c ? label('company', c) : '?', c ? href('company', c) : '#/companies'], [roleLabel(r)]]) +
      `<div class="head">${title('role', id, PH.role, 'title')}<div class="chips">${chip('stage', 'role', r)}${chip('odds', 'role', r)}${chip('tier', 'role', {id, tier: tierOf(r)})}${r.stageAt ? `<span class="chip c-mute" title="In this stage since">since ${esc(r.stageAt)}</span>` : ''}${autoChip('role', r)}</div></div>
      <p class="sub">at <a href="${c ? href('company', c) : '#/companies'}">${esc(c ? label('company', c) : '?')}</a>${via ? ` · via <a href="${href('person', via)}">${esc(label('person', via))}</a>` : ''} · ${pick('viaRole', id, opt('person', state.people.filter(x => x.id !== r.viaId)), via ? 'Change the way in…' : 'Way in…')}</p>
      <div class="next"><label>Next action</label>${field('role', id, 'nextAction', 'The one thing to do next')}</div>
      ${applySection(r)}
      ${sentSection(r)}
      ${isPractice(r) ? `<div class="next lesson"><label>Quick lesson${r.screened ? '' : ' (fills in after the first screen)'}</label>${field('role', id, 'lesson', 'The one thing to fix before the next meeting')}</div>` : ''}
      ${tasksBlock('role', id, 'Prep & to-do')}
      ${mailSection(r)}
      ${debriefsBlock('role', r)}
      <div class="notes">${sec('Notes', '', field('role', id, 'notes', 'Interview shape, comp, questions, what I learned'))}</div>
      ${removeBtn('role', id, 'role')}`;
  };
  PAGES.people = () => `<div class="head"><h1 class="title">People & sources</h1></div>` + (state.people.length ? state.channels.map(ch => { const ps = state.people.filter(p => p.channelId === ch.id); if (!ps.length) return ''; return `<div class="group-h"><a href="${href('channel', ch)}">${esc(label('channel', ch))}</a></div><div class="rows people"><div class="row h"><span>Name</span><span>Via</span><span>Status</span><span>Companies</span></div>${ps.map(p => `<div class="row"><a class="n clip" href="${href('person', p)}">${esc(label('person', p))}</a><span class="dim clip">${p.viaId ? esc(label('person', get('person', p.viaId))) : '–'}</span><span>${chipRO(p.status)}</span><span class="dim mono">${companiesOf(p).length}</span></div>`).join('')}</div>`; }).join('') : empty('Nothing yet. Add people and platforms from a channel page.'));
  PAGES.companies = () => { const cs = visibleCompanies(); return `<div class="head"><h1 class="title">Companies</h1><div class="chips"><button class="btn" data-add="company">+ Company</button></div>${filterBar(state.companies)}</div>` + (cs.length ? `<div class="rows companies"><div class="row h"><span>Name</span><span>Stage & size</span><span>Way in</span><span>Research</span><span>Roles</span></div>${cs.map(c => { const r = c.research || {}; return `<div class="row ${isPractice(c) ? 'practice' : ''}"><span class="nc"><a class="n clip" href="${href('company', c)}">${esc(label('company', c))}</a>${isPractice(c) ? chipRO('practice') : ''}${c.autoAdded ? chipRO('auto') : ''}</span><span class="dim clip">${esc(c.stage || '–')}</span><span class="dim clip">${esc(peopleOf(c).map(p => label('person', p)).join(', ') || '–')}</span><span>${r.status === 'done' ? (gradeChip(r) || '<span class="dim">done</span>') : r.status === 'running' ? '<span class="chip c-accent-line">Running</span>' : '<span class="dim">–</span>'}</span><span class="dim mono">${rolesOf(c).length}</span></div>`; }).join('')}</div>` : empty(state.companies.length ? 'Nothing in this view.' : 'No companies yet.')); };
  PAGES.roles = () => { const rs = visibleRoles(); return `<div class="head"><h1 class="title">Roles</h1>${filterBar()}</div>` + (rs.length ? `<div class="rows roles"><div class="row h"><span>Role</span><span>Company</span><span>Way in</span><span>Stage</span><span>Odds</span><span>Next action</span></div>${rs.map(r => { const c = get('company', r.companyId); const v = r.viaId ? get('person', r.viaId) : null; return `<div class="row ${isPractice(r) ? 'practice' : ''}"><span class="nc"><a class="n clip" href="${href('role', r)}">${esc(roleLabel(r))}</a>${isPractice(r) ? chipRO('practice') : ''}${r.autoAdded ? chipRO('auto') : ''}</span><span class="dim clip">${c ? `<a href="${href('company', c)}">${esc(label('company', c))}</a>` : '–'}</span><span class="dim clip">${v ? esc(label('person', v)) : '–'}</span><span>${chip('stage', 'role', r)}${applyChip(r)}</span><span>${chip('odds', 'role', r)}</span><span class="dim clip">${esc(r.nextAction || '–')}</span></div>`; }).join('')}</div>` : empty(state.roles.length ? 'Nothing in this view.' : 'No roles yet. Add one from a company page.')); };
  PAGES.pipeline = () => { const all = visibleRoles(); return `<div class="head"><h1 class="title">Board</h1>${filterBar()}</div><div class="board">${STAGES.map(s => { const rs = all.filter(r => r.stage === s); return `<div class="col"><h3>${L[s]}<span class="mono">${rs.length}</span></h3><div class="stack">${rs.map(r => { const c = get('company', r.companyId); return `<div class="bcard ${isPractice(r) ? 'practice' : ''}"><a class="n" href="${href('role', r)}">${esc(roleLabel(r))}</a><div class="co">${esc(c ? label('company', c) : '')}</div><div class="na">${esc(r.nextAction)}</div><div class="m">${chip('stage', 'role', r)}${chip('odds', 'role', r)}${isPractice(r) ? chipRO('practice') : ''}${applyChip(r)}</div>${r.autoAdded ? ROBOT : ''}</div>`; }).join('')}</div></div>`; }).join('')}</div>`; };
  PAGES.apply = () => {
    let want = ''; try { want = new URLSearchParams((location.hash.split('?')[1] || '')).get('s') || ''; } catch (e) {}
    const rs = applyRoles(); const q = applyQueue();
    const bar = `<div class="filter">${['', ...APPLY_ORDER].map(k => `<button class="fbtn ${want === k ? 'on' : ''}" data-afilter="${k}">${k ? AL[k] : 'All'}<span class="mono">${k ? q[k] : rs.length}</span></button>`).join('')}</div>`;
    const groups = APPLY_ORDER.filter(k => !want || k === want).map(k => { const g = rs.filter(r => r.apply.status === k); return g.length ? `<h3 class="sub-h">${esc(AL[k])} <span class="dim small">${esc(ATITLE[k])}</span></h3><div class="rows apply"><div class="row h arow"><span>Role</span><span>Company · grade</span><span>Status</span><span>CV</span><span>Note</span><span></span></div>${g.map(applyRow).join('')}</div>` : ''; }).join('');
    const h = hunt(); const led = h.applied.length ? `<details class="runs"><summary>Never-twice ledger · ${h.applied.length} compan${h.applied.length === 1 ? 'y' : 'ies'}</summary>${h.applied.slice().reverse().map(x => `<div class="run-line"><span class="mail-when">${esc(fmt(x.at))}</span><b>${esc(x.name)}</b><span class="dim">${esc(x.domain || '')}</span></div>`).join('')}</details>` : '';
    return `<div class="head"><h1 class="title">Apply loop</h1>${bar}</div>` + (groups || empty(rs.length ? 'Nothing in this view.' : 'No prepared applications yet. The nightly hunt fills this page.')) + led;
  };
  PAGES.lessons = () => {
    const ls = lessons();
    const order = {practicing: 0, new: 1, nailed: 2};
    const vis = (lessonFilter === 'all' ? ls : ls.filter(l => lstatus(l) === lessonFilter)).slice().sort((a, b) => (limp(b) - limp(a)) || (order[lstatus(a)] - order[lstatus(b)]) || ((b.count || 1) - (a.count || 1)));
    const block = type => { const rows = vis.filter(l => l.type === type); return sec(L[type], `${rows.length ? `<span class="scount">${rows.length}</span>` : ''}<button class="btn quiet" data-add="lesson" data-ltype="${type}">+ Add by hand</button>`, rows.length ? `<div class="lrows">${rows.map(lessonRow).join('')}</div>` : empty(ls.length ? 'Nothing here in this view.' : LHINT[type]), `lsec ${type}`); };
    const intro = ls.length
      ? `<p class="intro">What I take from every interview. Claude writes these from my debrief notes and counts how often a point comes back. Status is mine: <b>Requires work</b> is the list I carry into the next interview, <b>To review</b> is what I have not sorted yet. Claude grades importance 1 to 10 and sorts by it; click the number to change it.</p>`
      : `<p class="intro">Nothing yet. Write a debrief note on a role page right after an interview, then click <b>Extract lessons</b>. Claude files the points worth keeping here as Do, Don't and Good to know.</p>`;
    return `<div class="head"><h1 class="title">Lessons</h1>${lessonFilterBar()}</div>${intro}${LTYPES.map(block).join('')}`;
  };
  const notFound = () => `<div class="head"><h1 class="title">Not here</h1></div><p class="sub">That item was removed. <a href="#/">Back home</a>.</p>`;

  // ---- routing + render ----
  function route() {
    const h = (location.hash || '#/').replace(/^#\/?/, '').split('?')[0];
    const [p, id] = h.split('/');
    return PAGES[p] ? {page: p, id} : {page: 'home'};
  }
  const NAV_FOR = {channel: 'home', person: 'people', company: 'companies', role: 'roles', apply: 'apply'};
  // "Needs you" banner (25 Oct 2026): the day hunt could not start its agents for half a day and the only trace was a log line.
  // Every page now opens with what only Eyal can unblock: the PC's alerts (worker/alerts.mjs, relayed by the worker; the same list
  // is emailed to him) plus the checks the board can make by itself, which still show when the PC is off and cannot email.
  function needsBanner() {
    const h = state.hunt || {}; const w = h.worker || {}; const lr = h.lastRun; const items = [];
    const add = (id, sev, text) => { if (!items.some(x => x.id === id)) items.push({ id, sev, text }); };
    if (features.huntWorker === false || (lr && (lr.errors || []).some(e => /routine not configured/i.test(e)))) add('agents-off', 'needs', 'The board cannot start its agents (ROUTINE_TOKEN missing on the live deploy): new roles sit ungraded.');
    const wAge = w.lastAt ? Date.now() - new Date(w.lastAt).getTime() : null;
    if (wAge === null || wAge > 2 * 3600000) add('pc-silent', 'needs', `The PC worker has been silent ${wAge === null ? 'forever' : 'for ' + ago(w.lastAt)}: nothing is sent and no alert emails go out. Is the laptop on, awake and plugged in?`);
    for (const x of (Array.isArray(w.alerts) ? w.alerts : [])) add(x.id, x.sev, x.text);
    const shown = items.filter(x => x.sev !== 'info'); if (!shown.length) return '';
    const needs = shown.filter(x => x.sev === 'needs');
    return `<div class="needsbar${needs.length ? '' : ' good'}"><b>${needs.length ? `Needs you (${needs.length})` : 'News'}</b><ul>${shown.map(x => `<li class="${x.sev}">${esc(x.text)}</li>`).join('')}</ul></div>`;
  }
  function render() {
    if (!state) return;
    const r = route();
    closeMenu();
    page.innerHTML = needsBanner() + PAGES[r.page](r);
    page.classList.toggle('wide', r.page === 'pipeline'); document.body.classList.toggle('wide', r.page === 'pipeline');
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === r.page || a.dataset.r === NAV_FOR[r.page]));
    if (!keepScroll) window.scrollTo(0, 0); keepScroll = false;
    try { sessionStorage.setItem(RT_KEY, location.hash || '#/'); } catch (e) {}
    loadRecords();
    if (pendingFocus) { const el = page.querySelector(`.title[data-t="${pendingFocus.t}"][data-id="${pendingFocus.id}"]`); pendingFocus = null; if (el) el.focus(); }
  }
  page.addEventListener('error', e => { const im = e.target; if (im && im.tagName === 'IMG' && im.dataset.initial) { const sp = document.createElement('span'); sp.className = 'avatar'; sp.textContent = im.dataset.initial; im.replaceWith(sp); } }, true);
  window.addEventListener('hashchange', render);
  const nav = h => { if (location.hash === h) render(); else location.hash = h; };
  const goNew = (t, x) => { pendingFocus = {t, id: x.id}; nav(href(t, x)); };

  // ---- edits ----
  page.addEventListener('input', e => {
    const ta = e.target.closest('[data-rctx]'); if (ta) { ctxDraft[ta.dataset.rctx] = ta.value; return; }
    const hx = e.target.closest('[data-hunt]'); if (hx) { hunt()[hx.dataset.hunt] = hx.value; touch(); return; }
    const an = e.target.closest('[data-ans]'); if (an) { const r = get('role', an.dataset.id); if (!r || !r.apply) return; r.apply.answers = r.apply.answers || {}; const v = an.innerText.replace(/\n$/, '').trim(); if (v) r.apply.answers[an.dataset.ans] = v; else delete r.apply.answers[an.dataset.ans]; r.apply.needsHuman = (r.apply.screeners || []).map(x => x.q).filter(q => !r.apply.answers[q]); an.parentElement.classList.toggle('needs', !v); touch(); return; }
    const el = e.target.closest('[data-f]'); if (!el) return;
    const x = get(el.dataset.t, el.dataset.id); if (!x) return;
    x[el.dataset.f] = el.innerText.replace(/\n$/, '');
    touch();
  });
  page.addEventListener('keydown', e => {
    const el = e.target.closest('[data-f]'); if (!el) return;
    if (e.key === 'Escape') { el.blur(); return; }
    if (e.key !== 'Enter') return;
    if (el.classList.contains('title') || el.dataset.t === 'task' || el.dataset.t === 'lesson' || el.dataset.f === 'nextAction' || el.dataset.f === 'date') {
      e.preventDefault();
      if (el.dataset.t === 'task' && el.innerText.trim()) { const t = get('task', el.dataset.id); addTask(t.owner ? t.owner.type : null, t.owner ? t.owner.id : null); return; }
      const all = [...page.querySelectorAll('[data-f]')]; const n = all[all.indexOf(el) + 1]; if (n) n.focus(); else el.blur();
    }
  });
  page.addEventListener('focusout', e => {
    const el = e.target.closest && e.target.closest('.f[data-t="task"]'); if (!el) return;
    const t = get('task', el.dataset.id); if (!t || t.text.trim()) return;
    setTimeout(() => { if (!get('task', el.dataset.id) || get('task', el.dataset.id).text.trim()) return;
      const act = document.activeElement && document.activeElement.closest ? document.activeElement.closest('[data-f]') : null; const keep = act ? {t: act.dataset.t, id: act.dataset.id, f: act.dataset.f} : null;
      state.tasks = state.tasks.filter(x => x.id !== t.id); commit();
      if (keep) { const el2 = page.querySelector(`[data-f="${keep.f}"][data-t="${keep.t}"][data-id="${keep.id}"]`); if (el2) el2.focus(); } }, 150);
  });
  page.addEventListener('focusout', e => {
    const el = e.target.closest && e.target.closest('.f[data-t="lesson"]'); if (!el) return;
    const l = get('lesson', el.dataset.id); if (!l || (l.text || '').trim() || (l.title || '').trim()) return;
    setTimeout(() => { const x = get('lesson', el.dataset.id); if (!x || (x.text || '').trim() || (x.title || '').trim()) return; state.lessons = lessons().filter(y => y.id !== x.id); commit(); }, 150);
  });
  function addTask(type, id) {
    const t = {id: uid(), text: '', done: false, owner: type ? {type, id} : null, createdAt: Date.now()};
    state.tasks.push(t); touch(); render();
    const el = page.querySelector(`.f[data-t="task"][data-id="${t.id}"]`); if (el) el.focus();
  }

  page.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if (d.add === 'task') { addTask(d.otype || null, d.oid || null); return; }
    if (d.add === 'channel') { const ch = {id: uid(), name: '', kind: 'sources', snapshot: ''}; state.channels.push(ch); touch(); goNew('channel', ch); return; }
    if (d.add === 'person') { const ch = get('channel', d.channel); const p = {id: uid(), name: '', channelId: d.channel, viaId: d.via || null, who: '', why: '', status: kindOf(ch).status[0], statusAt: '', notes: ''}; state.people.push(p); touch(); goNew('person', p); return; }
    if (d.add === 'company') { const c = {id: uid(), name: '', what: '', stage: '', ceo: '', fit: '', links: '', notes: '', peopleIds: d.person ? [d.person] : []}; state.companies.push(c); touch(); goNew('company', c); return; }
    if (d.add === 'role') { const c = get('company', d.company); const r = {id: uid(), companyId: d.company, title: '', viaId: c && c.peopleIds.length === 1 ? c.peopleIds[0] : null, stage: 'lead', stageAt: '', odds: 'unknown', nextAction: '', notes: '', tier: tierOf(c)}; state.roles.push(r); touch(); goNew('role', r); return; }
    if (d.add === 'debrief') {
      const o = get(d.otype, d.oid); if (!o) return;
      const used = new Set((o.debriefs || []).map(x => x.round));
      const round = d.otype === 'company' ? 'Company note' : (ROUNDS.find(x => x !== 'Other' && !used.has(x)) || 'Other');
      const db = {id: uid(), round, date: fmt(Date.now()), text: '', takeaway: '', distilledAt: ''};
      (o.debriefs = o.debriefs || []).push(db); touch(); keepScroll = true; render();
      const el = page.querySelector(`.db-text[data-id="${db.id}"]`); if (el) el.focus(); return;
    }
    if (d.distill !== undefined) { if (d.distill) runDistill(d.distill); return; }
    if (d.add === 'lesson') {
      const l = {id: uid(), type: d.ltype || 'general', title: '', text: '', count: 1, sources: [], status: 'new', importance: 5, importanceBy: 'human', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()};
      (state.lessons = state.lessons || []).push(l); touch(); keepScroll = true; render();
      const el = page.querySelector(`.ltitle[data-id="${l.id}"]`); if (el) el.focus(); return;
    }
    if (d.lfilter) { lessonFilter = d.lfilter; try { sessionStorage.setItem(LF_KEY, lessonFilter); } catch (x) {} keepScroll = true; render(); return; }
    if (d.deldb || d.dellesson) {
      if (!b.classList.contains('arm')) { b.classList.add('arm'); b.title = 'Click again to remove'; clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('arm'); }, 3000); return; }
      if (d.deldb) { const o = ownerOfDebrief(d.deldb); if (o) o.debriefs = o.debriefs.filter(x => x.id !== d.deldb); }
      else state.lessons = lessons().filter(x => x.id !== d.dellesson);
      commit(); return;
    }
    if (d.clearauto) { const x = get(d.clearauto, d.id); if (x) delete x.autoAdded; commit(); return; }
    if (d.mailcheck) { runMailCheck(); return; }
    if (d.huntnow) { runHuntCheck(); return; }
    if (d.kick) { runKick(); return; }
    if (d.kill) { hunt().killSwitch = !hunt().killSwitch; commit(); toast(hunt().killSwitch ? 'Kill switch on. Nothing runs until you switch it off.' : 'Kill switch off.'); return; }
    if (d.afilter !== undefined) { nav(d.afilter ? `#/apply?s=${d.afilter}` : '#/apply'); return; }
    if (d.apply) {
      if (d.arm && !b.classList.contains('arm')) { b.dataset.txt = b.textContent; b.classList.add('arm'); b.textContent = 'Click again to confirm'; clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('arm'); b.textContent = b.dataset.txt; }, 3000); return; }
      setApply(d.id, d.apply); return;
    }
    if (d.research) { runResearch(d.research, d.depth); return; }
    if (d.simplify) { simpleOn[d.simplify] = !simpleOn[d.simplify]; keepScroll = true; render(); return; }
    if (d.filter) { roleFilter = d.filter; try { sessionStorage.setItem(FILTER_KEY, roleFilter); } catch (x) {} keepScroll = true; render(); return; }
    if (d.home) { homeTier = d.home; try { sessionStorage.setItem(HOME_KEY, homeTier); } catch (x) {} render(); return; }
    if (d.sprint) {
      if (d.sprint === 'start') { const now = Date.now(); state.practice = {startedAt: new Date(now).toISOString(), endsAt: new Date(now + SPRINT_DAYS * DAY).toISOString()}; commit(); return; }
      if (d.sprint === 'extend') { state.practice.endsAt = new Date(Math.max(Date.now(), new Date(state.practice.endsAt).getTime()) + 7 * DAY).toISOString(); commit(); return; }
      if (d.sprint === 'end') {
        if (!b.classList.contains('arm')) { b.dataset.txt = b.textContent; b.classList.add('arm'); b.textContent = 'Click again to end'; clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('arm'); b.textContent = b.dataset.txt; }, 3000); return; }
        delete state.practice; commit(); return;
      }
    }
    if (d.cycle) {
      const x = get(d.t, d.id); const list = d.cycle === 'status' ? kindOfP(x).status : CYCLE[d.cycle];
      const cur = d.cycle === 'tier' ? tierOf(x) : d.cycle === 'kind' ? (x.kind || guessKind(x)) : d.cycle === 'ltype' ? x.type : d.cycle === 'lstatus' ? lstatus(x) : d.cycle === 'imp' ? String(limp(x)) : x[d.cycle];
      if (list.length > 2) { openMenu(b, list, cur, v => setField(d.cycle, d.t, d.id, v)); return; }
      setField(d.cycle, d.t, d.id, list[(list.indexOf(cur) + 1) % list.length]); return;
    }
    if (d.toggle) { const t = get('task', d.toggle); t.done = !t.done; commit(); return; }
    if (d.deltask) { state.tasks = state.tasks.filter(t => t.id !== d.deltask); commit(); return; }
    if (d.unlink) { const c = get('company', d.company); c.peopleIds = c.peopleIds.filter(i => i !== d.unlink); commit(); return; }
    if (d.clearvia) { get('person', d.clearvia).viaId = null; commit(); return; }
    if (d.del) {
      if (!b.classList.contains('arm')) { b.dataset.txt = b.textContent; b.classList.add('arm'); b.textContent = 'Click again to remove'; clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('arm'); b.textContent = b.dataset.txt; }, 3000); return; }
      remove(d.del, d.id);
    }
  });
  function setField(k, t, id, v) {
    const x = get(t, id); if (!x) return;
    const list = k === 'status' ? kindOfP(x).status : CYCLE[k];
    x[FIELD_OF[k] || k] = k === 'imp' ? Number(v) : v;
    if (k === 'lstatus' || k === 'ltype' || k === 'imp') x.updatedAt = new Date().toISOString();
    if (k === 'imp') x.importanceBy = 'human';
    if (k === 'status') x.statusAt = list.indexOf(v) === 0 ? '' : fmt(Date.now());
    if (k === 'stage') { x.stageAt = fmt(Date.now()); if (v === 'interviewing' || v === 'offer') x.screened = true; }
    if (k === 'tier' && t === 'company') { const rs = rolesOf(x); rs.forEach(r => { r.tier = v; }); if (rs.length) toast(`${L[v]} tier set on ${rs.length} role${rs.length === 1 ? '' : 's'} too.`); }
    commit();
  }
  // ---- chip menu ----
  const menu = document.createElement('div'); menu.className = 'menu'; menu.hidden = true; document.body.appendChild(menu);
  let menuPick = null;
  function openMenu(anchor, list, cur, onPick) {
    menuPick = onPick; menu.classList.toggle('num', list === IMPS);
    menu.innerHTML = list.map(v => `<button class="mi ${v === cur ? 'on' : ''}" data-v="${esc(v)}"><span class="chip ${CLS[v] || ''}">${L[v] || esc(v)}</span></button>`).join('');
    menu.hidden = false;
    const r = anchor.getBoundingClientRect(); const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = r.left, top = r.bottom + 6;
    if (left + mw > innerWidth - 8) left = Math.max(8, innerWidth - 8 - mw);
    if (top + mh > innerHeight - 8) top = Math.max(8, r.top - 6 - mh);
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
    const on = menu.querySelector('.mi.on'); if (on) on.focus();
  }
  function closeMenu() { menu.hidden = true; menuPick = null; }
  menu.addEventListener('click', e => { const b = e.target.closest('.mi'); if (!b) return; const f = menuPick; closeMenu(); if (f) f(b.dataset.v); });
  document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-cycle]')) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });
  window.addEventListener('scroll', () => { if (!menu.hidden) closeMenu(); }, {passive: true});

  page.addEventListener('change', e => {
    const aq = e.target.closest('input[data-autoq]'); if (aq) { hunt().autoQueue = !!aq.checked; commit(); return; }
    const cap = e.target.closest('input[data-cap]'); if (cap) { const v = Math.max(0, Math.min(50, parseInt(cap.value, 10) || 0)); if (cap.dataset.cap === 'concurrency') hunt().concurrency = Math.max(1, Math.min(5, v)); else if (cap.dataset.cap === 'perDay') hunt().caps.perDay = Math.min(20, v); else hunt().caps[cap.dataset.cap] = v; commit(); return; }
    const s = e.target.closest('select[data-pick]'); if (!s || !s.value) return;
    const v = s.value, id = s.dataset.id;
    if (s.dataset.pick === 'linkCompany') get('company', v).peopleIds.push(id);
    if (s.dataset.pick === 'linkPerson') get('company', id).peopleIds.push(v);
    if (s.dataset.pick === 'via') get('person', id).viaId = v;
    if (s.dataset.pick === 'viaRole') get('role', id).viaId = v;
    commit();
  });
  function remove(t, id) {
    const dropTasks = (ty, i) => { state.tasks = state.tasks.filter(x => !(x.owner && x.owner.type === ty && x.owner.id === i)); };
    if (t === 'channel') {
      if (state.people.some(p => p.channelId === id)) { toast('Move or remove what is inside it first.'); render(); return; }
      state.channels = state.channels.filter(x => x.id !== id); dropTasks('channel', id); commit(); nav('#/'); return;
    }
    if (t === 'person') {
      const p = get('person', id);
      state.people = state.people.filter(x => x.id !== id); state.people.forEach(x => { if (x.viaId === id) x.viaId = null; });
      state.roles.forEach(r => { if (r.viaId === id) r.viaId = null; }); state.companies.forEach(c => { c.peopleIds = c.peopleIds.filter(i => i !== id); });
      dropTasks('person', id); commit(); nav(href('channel', {id: p.channelId})); return;
    }
    if (t === 'company') {
      rolesOf({id}).forEach(r => dropTasks('role', r.id)); state.roles = state.roles.filter(r => r.companyId !== id);
      state.companies = state.companies.filter(x => x.id !== id); dropTasks('company', id); commit(); nav('#/companies'); return;
    }
    if (t === 'role') { const r = get('role', id); state.roles = state.roles.filter(x => x.id !== id); dropTasks('role', id); commit(); nav(href('company', {id: r.companyId})); }
  }

  // ---- research ----
  async function runResearch(companyId, depth) {
    const c = get('company', companyId); if (!c) return;
    if (!nm(c, '')) { toast('Give the company a name first.'); return; }
    if (dirty) { clearTimeout(saveTimer); await save(); }
    const context = (ctxDraft[companyId] || '').trim(); delete ctxDraft[companyId];
    c.research = {...(c.research || {}), status: 'running', error: undefined, requestedAt: new Date().toISOString(), depth, context};
    keepScroll = true; render();
    try {
      const r = await fetch(RESEARCH_API, {method: 'POST', headers: hdr(), body: JSON.stringify({companyId, depth, context})});
      const d = await r.json();
      if (d.state) { state = d.state; rev = d.rev; dirty = false; }
      if (!r.ok) toast(d.fire && d.fire.error ? d.fire.error : 'Research could not start.');
      keepScroll = true; render();
    } catch (e) { toast('Network error, try again.'); c.research.status = 'error'; c.research.error = 'network'; keepScroll = true; render(); }
  }

  async function runDistill(companyId) {
    const c = get('company', companyId); if (!c) return;
    if (!pendingDebriefs(c).length) { toast('Write a note first.'); return; }
    if (dirty) { clearTimeout(saveTimer); await save(); }
    state.lessonsRun = {status: 'running', companyId, requestedAt: new Date().toISOString()};
    keepScroll = true; render();
    try {
      const r = await fetch(LESSONS_API, {method: 'POST', headers: hdr(), body: JSON.stringify({companyId})});
      const d = await r.json();
      if (d.state) { state = d.state; rev = d.rev; dirty = false; }
      else if (!r.ok) { state.lessonsRun = {status: 'error', companyId, error: d.error || 'could not start'}; }
      if (!r.ok) toast(d.fire && d.fire.error ? d.fire.error : (d.error || 'Could not start.'));
      keepScroll = true; render();
    } catch (e) { toast('Network error, try again.'); state.lessonsRun = {status: 'error', companyId, error: 'network'}; keepScroll = true; render(); }
  }

  // apply transitions go through the hunt function so the server re-checks tier, grade, kill switch and never-twice
  async function setApply(roleId, status) {
    const r = get('role', roleId); if (!r || !r.apply) return;
    if (dirty) { clearTimeout(saveTimer); await save(); }
    try {
      const res = await fetch(HUNT_API, {method: 'POST', headers: hdr(), body: JSON.stringify({action: 'apply', roleId, byHuman: true, patch: {status}})});
      const d = await res.json();
      if (!res.ok) { toast(d.error === 'never-twice' ? `Not approved: ${d.detail || 'this company was already applied to'}.` : (d.error || 'Could not change it.')); return; }
      rev = -1; await load(); toast(`${AL[status] || status}.`);
    } catch (e) { toast('Network error, try again.'); }
  }
  async function runKick() {
    if (dirty) { clearTimeout(saveTimer); await save(); }
    try {
      const r = await fetch(HUNT_API, {method: 'POST', headers: hdr(), body: JSON.stringify({action: 'kick'})});
      const d = await r.json();
      if (!r.ok) { toast(d.error || 'Could not kick.'); return; }
      const k = d.kicked || {}; toast((k.fired || []).length ? `Fired: ${k.fired.join(', ')}` : ((k.events || [])[0] || 'Nothing to fire.'));
      rev = -1; await load();
    } catch (e) { toast('Network error, try again.'); }
  }
  async function runHuntCheck() {
    if (dirty) { clearTimeout(saveTimer); await save(); }
    state.huntRun = {status: 'running', requestedAt: new Date().toISOString(), step: 'starting'};
    keepScroll = true; render();
    try {
      for (let i = 0; i < 40; i++) {   // one finder step per call, until done
        const r = await fetch(HUNT_API, {method: 'POST', headers: hdr(), body: JSON.stringify({action: 'find'})});
        const d = await r.json();
        if (!r.ok) { state.huntRun = {status: 'error', error: d.error || 'could not run'}; toast(d.error || 'Could not run the hunt.'); break; }
        if (d.find && d.find.done) { toast(d.find.next === 'sorting' || d.find.step === 'sorting' ? 'Finder done - the sorter agent is picking (up to 30 min).' : d.lastRun && d.lastRun.funnel ? `Hunt done: ${d.lastRun.funnel.found || 0} roles seen, ${d.lastRun.candidates || 0} candidates` : 'Hunt done.'); break; }
        state.huntRun = {status: 'running', requestedAt: state.huntRun.requestedAt, step: d.find ? d.find.next : ''};
        keepScroll = true; render();
      }
      rev = -1; await load();
    } catch (e) { toast('Network error, try again.'); state.huntRun = {status: 'error', error: 'network'}; keepScroll = true; render(); }
  }
  async function runMailCheck() {
    if (dirty) { clearTimeout(saveTimer); await save(); }
    state.mailRun = {status: 'running', requestedAt: new Date().toISOString()};
    keepScroll = true; render();
    try {
      const r = await fetch(MAIL_API, {method: 'POST', headers: hdr(), body: '{}'});
      const d = await r.json();
      if (d.state) { state = d.state; rev = d.rev; dirty = false; }
      else if (!r.ok) state.mailRun = {status: 'error', error: d.error || 'could not start'};
      if (!r.ok) toast(d.error || 'Could not start the mail check.');
      keepScroll = true; render();
    } catch (e) { toast('Network error, try again.'); state.mailRun = {status: 'error', error: 'network'}; keepScroll = true; render(); }
  }

  function setSave(cls, txt) { const s = $('#save'); s.className = 'save ' + cls; s.textContent = txt; }
  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2600); }

  // ---- boot ----
  (async () => {
    // ?key=... in the link unlocks once and is then removed from the address bar
    try { const q = new URLSearchParams(location.search); if (q.get('key')) { key = q.get('key'); localStorage.setItem(KEY_LS, key); history.replaceState(null, '', location.pathname + location.hash); } } catch (e) {}
    let rt = ''; try { rt = sessionStorage.getItem(RT_KEY) || ''; } catch (e) {}
    if (rt && (!location.hash || location.hash === '#/')) { try { history.replaceState(null, '', rt); } catch (e) {} }
    const ok = await load();
    if (ok && state) render();
  })();
})();
