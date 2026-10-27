// Hands-off mode verification against localhost:8899: auto-queue at prep time, forfeits, worker claim/report, guards, sweep, release.
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()];}));
const B='http://localhost:8899/.netlify/functions';
const KEY={'x-key':env.PIPELINE_KEY,'content-type':'application/json'}, SEC={'x-secret':env.RESEARCH_SECRET,'content-type':'application/json'};
const j=async(r)=>({status:r.status, body:await r.json().catch(()=>null)});
const get=(fn,h)=>fetch(`${B}/${fn}`,{headers:h}).then(j);
const post=(fn,h,b)=>fetch(`${B}/${fn}`,{method:'POST',headers:h,body:JSON.stringify(b)}).then(j);
let pass=0, fail=0; const ok=(name,c,extra='')=>{ if(c){pass++;console.log('PASS',name);} else {fail++;console.log('FAIL',name,extra);} };
const state=async()=>(await get('state',KEY)).body.state;
const roleOf=(st,name)=>{const c=st.companies.find(x=>x.name===name);return c&&st.roles.find(r=>r.companyId===c.id);};
const editState=async(fn)=>{const full=(await get('state',KEY)).body; fn(full.state); return post('state',KEY,{baseRev:full.rev,state:full.state});};

// seed
const cur=await get('state',KEY);
const seed={ updatedAt:'', channels:cur.body.state.channels, people:[], tasks:[], companies:[
  {id:'c-old',name:'Oldco',what:'',stage:'',ceo:'',fit:'',links:'https://oldco.com',notes:'',peopleIds:[],tier:'practice',research:{status:'done',fit:{grade:5}}},
], roles:[] };
ok('seed state',(await post('state',KEY,{baseRev:cur.body.rev,state:seed})).status===200);
let s=await post('hunt',KEY,{action:'settings',killSwitch:false,autoQueue:true,caps:{found:10,prepared:8,perDay:3},denyExtra:'dreamco.ai'});
ok('settings: autoQueue + perDay accepted',s.body.hunt.autoQueue===true&&s.body.hunt.caps.perDay===3,JSON.stringify(s.body.hunt));
ok('settings: perDay above 20 ignored',(await post('hunt',KEY,{action:'settings',caps:{perDay:25}})).body.hunt.caps.perDay===3);
const sum=await get('hunt',SEC); ok('GET summary has autoQueue + worker',sum.body.autoQueue===true&&typeof sum.body.worker==='object');

// finder: 8 candidates
const cand=(name,site,title,ats='lever',location='Tel Aviv, Israel',url)=>({name,site,domain:site,source:ats,title,url:url||`https://jobs.lever.co/${name.toLowerCase()}/x`,ats,location});
const f1=await post('hunt',SEC,{runId:'hunt-w1',funnel:{found:20},candidates:[
  cand('W1','https://w1.co','AI Engineer'), cand('W2','https://w2.co','Product Manager','greenhouse'), cand('W3','https://w3.co','AI Engineer','workday'),
  cand('W4','https://w4.co','Solutions Engineer','comeet'), cand('W5','https://w5.co','AI Engineer','drushim','Tel Aviv','https://www.drushim.co.il/job/123/'), cand('W6','https://w6.co','Technical Product Manager','alljobs','Tel Aviv','https://www.alljobs.co.il/x?JobID=5'),
  cand('W7','https://w7.co','AI Engineer','linkedin','Tel Aviv','https://www.linkedin.com/jobs/view/1'), cand('W8','https://w8.co','GenAI Engineer'),
]});
ok('finder created 8',f1.body.created===8,JSON.stringify(f1.body));
let st=await state();
const research=(g)=>({summary:'does things',stage:'Seed',headcount:20,location:'Tel Aviv',fit:{grade:g,reasons:['x']}});
for (const n of ['W1','W2','W3','W4','W5','W6','W7','W8']) { const g=await post('hunt',SEC,{kind:'grade',roleId:roleOf(st,n).id,research:research(n==='W8'?7:4),sentence:'s'}); if(!g.body||!['graded','real'].includes(g.body.placed)) console.log('grade',n,JSON.stringify(g.body)); }
st=await state();
const pkg=(extra={})=>({url:'https://jobs.lever.co/p/x/apply',ats:'lever',title:'AI Engineer',cv:'engineer-big',sentence:'one line',fields:[{name:'name',label:'Name',type:'text',required:true}],screeners:[{q:'Are you located in Israel?',type:'yesno',options:['Yes','No']}],answers:{'Are you located in Israel?':'Yes'},flags:{},...extra});

// ---- prep in hands-off mode ----
const LQ='Do you now or in the future require visa sponsorship to continue working in your country of residence?';
let p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'W1').id,apply:pkg({fields:[{name:'name',label:'Name',type:'text',required:true},{name:'q_1',label:LQ,type:'text',required:true},{name:'q_2',label:'Sponsorship',type:'text',required:true}],screeners:[{q:'Are you located in Israel?',type:'yesno',options:['Yes','No']},{q:LQ,type:'yesno',options:['Yes','No']}],answers:{'Are you located in Israel?':'Yes',[LQ]:'No'}})}); ok('clean prep -> queued (approved); a required field clipped at 80 chars matches its answered screener (24 Oct Piedpiper / Woodgrove), and so does a short summary label (27 Oct Proseware)',p.body.placed==='queued',JSON.stringify(p.body));
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'W2').id,apply:pkg({ats:'greenhouse',cv:'tpm',url:'https://job-boards.greenhouse.io/w2/jobs/1',answers:{}})}); ok('open screener -> forfeited needsAnswer',p.body.placed==='forfeited'&&p.body.why==='needsAnswer',JSON.stringify(p.body));
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'W3').id,apply:pkg({ats:'workday'})}); ok('workday -> forfeited manualOnly',p.body.placed==='forfeited'&&p.body.why==='manualOnly');
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'W4').id,apply:pkg({ats:'comeet',url:'https://www.comeet.com/jobs/w4/1/x/2',flags:{coverLetterRequired:true}})}); ok('cover letter -> forfeited',p.body.why==='coverLetter');
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'W5').id,apply:pkg({ats:'drushim',url:'https://www.drushim.co.il/job/123/',flags:{formUnread:true}})}); ok('drushim -> queued',p.body.placed==='queued',JSON.stringify(p.body));
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'W6').id,apply:pkg({ats:'alljobs',cv:'tpm',url:'https://www.alljobs.co.il/x?JobID=5',flags:{formUnread:true}})}); ok('alljobs -> queued',p.body.placed==='queued');
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'W7').id,apply:pkg({ats:'linkedin',url:'https://www.linkedin.com/jobs/view/1'})}); ok('linkedin -> forfeited manualOnly',p.body.why==='manualOnly');
st=await state();
ok('W1 approved, approvedAt set, nextAction queued',roleOf(st,'W1').apply.status==='approved'&&!!roleOf(st,'W1').apply.approvedAt&&/Queued/.test(roleOf(st,'W1').nextAction));
ok('W2 skipped with reason forfeited: needsAnswer',roleOf(st,'W2').apply.status==='skipped'&&/^forfeited: needsAnswer/.test(roleOf(st,'W2').apply.reason),roleOf(st,'W2').apply.reason);
ok('W8 (grade 7) is a real lead, untouched',roleOf(st,'W8').apply.status==='real');
ok('lastRun: queued 3, forfeited 4',st.hunt.lastRun.queued.length===3&&st.hunt.lastRun.forfeited.length===4,JSON.stringify({q:st.hunt.lastRun.queued.length,f:st.hunt.lastRun.forfeited.length}));
ok('lastRun refused buckets forfeited:needsAnswer 1, forfeited:manualOnly 2',st.hunt.lastRun.refused['forfeited:needsAnswer']===1&&st.hunt.lastRun.refused['forfeited:manualOnly']===2,JSON.stringify(st.hunt.lastRun.refused));

// ---- revive a forfeited card by hand: back to prepared + answer -> approve ----
let a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'W2').id,patch:{status:'prepared'},byHuman:true}); ok('forfeited -> prepared by Eyal',a.status===200,JSON.stringify(a.body));
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'W2').id,patch:{status:'approved'},byHuman:true}); ok('approve with open screener refused even by Eyal',a.status===409,JSON.stringify(a.body));
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'W2').id,patch:{answers:{'Are you located in Israel?':'Yes'}}}); ok('answer clears needsHuman',a.body.role.apply.needsHuman.length===0);
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'W2').id,patch:{status:'approved'},byHuman:true}); ok('then approve works',a.status===200&&a.body.role.apply.status==='approved');

// ---- worker claim ----
let c=await post('hunt',KEY,{action:'worker',claim:true,max:2,workerId:'pc-1',machine:'TEST-PC',runId:'run-x'});
ok('claim 2: oldest first (W1, W5)',c.status===200&&c.body.claimed.length===2&&c.body.claimed[0].company==='W1'&&c.body.claimed[1].company==='W5',JSON.stringify(c.body.claimed&&c.body.claimed.map(x=>x.company)));
ok('claimed card carries the package',c.body.claimed[0].apply.url&&c.body.claimed[0].apply.cv==='engineer-big'&&c.body.claimed[0].apply.answers['Are you located in Israel?']==='Yes'&&c.body.claimed[0].domain==='w1.co');
st=await state(); ok('claimed cards are submitting with workerId + runId',roleOf(st,'W1').apply.status==='submitting'&&roleOf(st,'W1').apply.workerId==='pc-1'&&roleOf(st,'W1').apply.runId==='run-x');
c=await post('hunt',KEY,{action:'worker',claim:true,max:5,workerId:'pc-1'}); ok('second claim: perDay 3 -> room 1 -> W6 only',c.body.claimed.length===1&&c.body.claimed[0].company==='W6'&&c.body.room===1,JSON.stringify({n:c.body.claimed.length,room:c.body.room}));
c=await post('hunt',KEY,{action:'worker',claim:true,max:5,workerId:'pc-1'}); ok('third claim: daily cap reached, nothing',c.body.claimed.length===0&&c.body.note==='daily cap reached',JSON.stringify(c.body));
// release W6 (worker could not start)
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'W6').id,patch:{status:'approved'},release:true,workerId:'pc-1'}); ok('release submitting -> approved by the same worker',a.status===200&&a.body.role.apply.status==='approved',JSON.stringify(a.body));
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'W1').id,patch:{status:'approved'},release:true,workerId:'pc-2'}); ok('release by another worker refused',a.status===409);
// outcomes
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'W1').id,patch:{status:'submitted',screenshot:'applications/w1/x.png'}}); ok('submitting -> submitted: ledger',a.body.role.stage==='applied');
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'W5').id,patch:{status:'unverified',reason:'worker interrupted'}}); ok('submitting -> unverified allowed',a.status===200&&a.body.role.apply.status==='unverified');
// role rule (23 Oct 2026): the same role at W5 (unverified) is refused; a different fitting role at W5 joins the W5 card and skips the grader
// (same role family since the company rule of 25 Oct 2026: a PM next to an open AI Engineer application is refused as roleFamily)
const fw=await post('hunt',SEC,{runId:'hunt-w2',candidates:[cand('W5 Ltd','https://w5.co','AI Engineer'),cand('W5 Ltd','https://w5.co','LLM Engineer','greenhouse','Tel Aviv, Israel','https://job-boards.greenhouse.io/w5/jobs/9')]});
ok('role rule: same role at W5 refused as sameRole, other role accepted',fw.body.refused.sameRole===1&&fw.body.created===1,JSON.stringify(fw.body));
st=await state(); { const w5s=st.companies.filter(x=>x.name==='W5'||x.name==='W5 Ltd'); const pm=st.roles.find(r=>r.title==='LLM Engineer'&&r.apply&&r.apply.url==='https://job-boards.greenhouse.io/w5/jobs/9');
ok('role rule: the new role joins the existing W5 card (no second company), company graded or preparing',w5s.length===1&&pm&&pm.companyId===w5s[0].id&&['graded','preparing'].includes(w5s[0].hunt.status)&&st.roles.filter(r=>r.companyId===w5s[0].id).length===2,JSON.stringify({cos:w5s.length,status:w5s[0]&&w5s[0].hunt.status})); }
// a dropped candidate at a company with history removes only that candidate role, never the company or its earlier application
await editState(stt=>{stt.companies.push({id:'c-ng',name:'Nograde',what:'',stage:'',ceo:'',fit:'',links:'https://nograde.co',notes:'',peopleIds:[],tier:'practice',hunt:{status:'done',runId:'old',foundAt:'2026-10-01T00:00:00Z'}}); stt.roles.push({id:'r-ng1',companyId:'c-ng',title:'AI Engineer',stage:'applied',stageAt:'x',odds:'unknown',nextAction:'',notes:'',tier:'practice',apply:{status:'submitted',url:'https://jobs.lever.co/ng/1',ats:'lever',submittedAt:'2026-10-01T00:00:00Z'}});});
const fn1=await post('hunt',SEC,{runId:'hunt-ng1',candidates:[cand('Nograde','https://nograde.co','LLM Engineer')]});
st=await state(); ok('role rule: new role at an ungraded practice company is a candidate for the grader',fn1.body.created===1&&st.companies.find(x=>x.id==='c-ng').hunt.status==='candidate',JSON.stringify(fn1.body));
await post('hunt',SEC,{runId:'hunt-ng2',candidates:[]}); st=await state();
ok('role rule: leftover drop keeps the company and its submitted role',!!st.companies.find(x=>x.id==='c-ng')&&!!st.roles.find(r=>r.id==='r-ng1')&&!st.roles.some(r=>r.companyId==='c-ng'&&r.title==='LLM Engineer')&&st.companies.find(x=>x.id==='c-ng').hunt.status==='done',JSON.stringify(st.companies.find(x=>x.id==='c-ng')&&st.companies.find(x=>x.id==='c-ng').hunt));
// a real-tier company and the dreamlist still block every role
await editState(stt=>{stt.companies.push({id:'c-real',name:'Realco',what:'',stage:'',ceo:'',fit:'',links:'https://realco.com',notes:'',peopleIds:[],tier:'real'});});
const fr=await post('hunt',SEC,{runId:'hunt-real',candidates:[cand('Realco','https://realco.com','Product Owner'),cand('Dreamco','https://dreamco.ai','Product Manager')]});
ok('role rule: real-tier company and dreamlist company refused',fr.body.created===0&&fr.body.refused.onBoard===2,JSON.stringify(fr.body.refused));
// kill switch blocks claim
await post('hunt',KEY,{action:'settings',killSwitch:true});
c=await post('hunt',KEY,{action:'worker',claim:true,max:5,workerId:'pc-1'}); ok('kill switch: claim returns nothing',c.body.claimed.length===0&&/kill/.test(c.body.note));
await post('hunt',KEY,{action:'settings',killSwitch:false});
// daily cap counts today's submitted (W1) + submitting; W5 unverified today has no submittedAt -> room = 3-1 = 2
c=await post('hunt',KEY,{action:'worker',claim:true,max:5,workerId:'pc-1'}); ok('after outcomes: room 2, W6 (released) + W2 claimed',c.body.claimed.length===2&&c.body.claimed.map(x=>x.company).sort().join()==='W2,W6',JSON.stringify(c.body.claimed&&c.body.claimed.map(x=>x.company)));
// never-twice at claim, per role: the same W1 role queued again ("Senior AI Engineer - Tel Aviv" = "AI Engineer") is refused; a different W1 role is claimed
await editState(stt=>{const c1=stt.companies.find(x=>x.name==='W1'); const mk=(id,title,url)=>({id,companyId:c1.id,title,stage:'lead',stageAt:'x',odds:'unknown',nextAction:'',notes:'',tier:'practice',autoAdded:true,apply:{status:'approved',url,ats:'lever',cv:'engineer-big',approvedAt:new Date().toISOString(),needsHuman:[],answers:{}}}); stt.roles.push(mk('r-w1b','Senior AI Engineer - Tel Aviv','https://jobs.lever.co/w1/y'), mk('r-w1c','Product Manager','https://jobs.lever.co/w1/z'));});
await post('hunt',KEY,{action:'settings',caps:{perDay:10,perHour:5}});
c=await post('hunt',KEY,{action:'worker',claim:true,max:5,workerId:'pc-1'});
ok('never-twice at claim: same W1 role refused, other W1 role claimed',c.body.refused.some(x=>x.roleId==='r-w1b'&&x.why==='never-twice')&&c.body.claimed.some(x=>x.roleId==='r-w1c'),JSON.stringify({refused:c.body.refused,claimed:c.body.claimed&&c.body.claimed.map(x=>x.roleId)}));
// hourly pacing (23 Oct 2026)
ok('settings: perHour above 20 ignored',(await post('hunt',KEY,{action:'settings',caps:{perHour:25}})).body.hunt.caps.perHour===5);
await post('hunt',KEY,{action:'settings',caps:{perHour:1}});
c=await post('hunt',KEY,{action:'worker',claim:true,max:5,workerId:'pc-1'}); ok('hourly cap: 1 per hour with sends in the last hour -> nothing, note says hourly',c.body.claimed.length===0&&/hourly cap/.test(c.body.note||''),JSON.stringify(c.body));
await editState(stt=>{for(const r of stt.roles) if(r.apply&&r.apply.submittedAt) r.apply.submittedAt=new Date(Date.now()-2*3600000).toISOString(); for(const r of stt.roles) if(r.apply&&r.apply.status==='submitting'){r.apply.status='unverified';r.apply.unverifiedAt=new Date().toISOString();}});
await editState(stt=>{const c1=stt.companies.find(x=>x.name==='W1'); stt.roles.push({id:'r-w1d',companyId:c1.id,title:'Solutions Engineer',stage:'lead',stageAt:'x',odds:'unknown',nextAction:'',notes:'',tier:'practice',autoAdded:true,apply:{status:'approved',url:'https://jobs.lever.co/w1/s',ats:'lever',cv:'engineer-big',approvedAt:new Date().toISOString(),needsHuman:[],answers:{}}});});
c=await post('hunt',KEY,{action:'worker',claim:true,max:5,workerId:'pc-1'}); ok('hourly cap: an hour later room 1 again',c.body.claimed.length===1&&c.body.claimed[0].roleId==='r-w1d',JSON.stringify(c.body));
await post('hunt',KEY,{action:'settings',caps:{perHour:5}});
// report
const rep=await post('hunt',KEY,{action:'worker',workerId:'pc-1',machine:'TEST-PC',report:{runId:'run-x',chrome:'started',submitted:[{company:'W1',title:'AI Engineer'}],failed:[],blocked:[],unverified:[{company:'W5',why:'worker interrupted'}],ms:1234}});
ok('report stored: lastAt, machine, today counts',rep.body.worker&&rep.body.worker.machine==='TEST-PC'&&rep.body.worker.today.submitted===1&&rep.body.worker.today.unverified===1&&rep.body.worker.today.runs===1,JSON.stringify(rep.body.worker));
const rep2=await post('hunt',KEY,{action:'worker',workerId:'pc-1',report:{runId:'run-y',chrome:'attached',submitted:[],error:'Google logged out'}});
ok('second report: runs 2, lastError kept',rep2.body.worker.today.runs===2&&rep2.body.worker.lastError==='Google logged out');
// reviewer heartbeat relayed by the worker (22 Oct 2026)
const rep3=await post('hunt',KEY,{action:'worker',workerId:'pc-1',report:{runId:'run-z',chrome:'attached',submitted:[],reviewer:{lastRunAt:'2026-10-22T08:38:00.000Z',startedAt:'2026-10-22T08:09:00.000Z',open:4,proven:'1',digest:'Reviewer digest - 22 Oct',lastExit:0}}});
ok('reviewer heartbeat stored',rep3.body.worker.reviewer&&rep3.body.worker.reviewer.lastRunAt==='2026-10-22T08:38:00.000Z'&&rep3.body.worker.reviewer.open===4&&rep3.body.worker.reviewer.proven===1&&rep3.body.worker.reviewer.lastExit===0&&rep3.body.worker.reviewer.digest==='Reviewer digest - 22 Oct',JSON.stringify(rep3.body.worker.reviewer));
const rep4=await post('hunt',KEY,{action:'worker',workerId:'pc-1',report:{runId:'run-z2',chrome:'attached',submitted:[]}});
ok('report without reviewer keeps the last heartbeat',rep4.body.worker.reviewer&&rep4.body.worker.reviewer.open===4&&rep4.body.worker.today.runs===4,JSON.stringify(rep4.body.worker.reviewer));
const rep5=await post('hunt',KEY,{action:'worker',workerId:'pc-1',report:{runId:'run-z3',chrome:'attached',submitted:[],reviewer:{lastRunAt:'not a date',open:'x',lastExit:'1'}}});
ok('reviewer heartbeat: bad values become null, numeric strings parse',rep5.body.worker.reviewer.lastRunAt===null&&rep5.body.worker.reviewer.open===null&&rep5.body.worker.reviewer.lastExit===1,JSON.stringify(rep5.body.worker.reviewer));
st=await state(); ok('GET state carries the reviewer heartbeat',st.hunt.worker.reviewer&&st.hunt.worker.reviewer.lastExit===1);
// alerts relayed by the worker (25 Oct 2026): stored for the "Needs you" banner, bad severities become needs, empty ones dropped, max 10
const rep6=await post('hunt',KEY,{action:'worker',workerId:'pc-1',report:{runId:'run-z4',chrome:'attached',submitted:[],alerts:[{id:'agents-off',sev:'needs',text:'cannot start agents',since:'2026-10-25T15:00:00.000Z'},{id:'x',sev:'weird',text:'odd sev'},{id:'',text:'no id'},...Array.from({length:12},(_, i)=>({id:'a'+i,text:'t'}))]}});
const al=rep6.body.worker.alerts||[]; ok('alerts stored, cleaned and capped',al.length===10&&al[0].id==='agents-off'&&al[1].sev==='needs'&&!al.some(x=>!x.id),JSON.stringify(al.slice(0,3)));
const rep7=await post('hunt',KEY,{action:'worker',workerId:'pc-1',report:{runId:'run-z5',chrome:'attached',submitted:[],alerts:[]}});
ok('an empty alerts list clears the banner',Array.isArray(rep7.body.worker.alerts)&&rep7.body.worker.alerts.length===0);
// credit budget relayed by the worker (25 Oct 2026): numbers rounded, dates normalised, junk dropped
const rep8=await post('hunt',KEY,{action:'worker',workerId:'pc-1',report:{runId:'run-z6',chrome:'attached',submitted:[],credits:{at:'2026-10-25T16:00:00Z',used:26.7,projected:'62',budget:300,resetAt:'2026-11-12T08:00:00.000Z',deploysLeft:11,nextDeployAllowedAt:'nope',lastBoardDeploy:null}}});
const cr=rep8.body.worker.credits||{}; ok('credits stored and cleaned',cr.used===27&&cr.projected===62&&cr.budget===300&&cr.resetAt==='2026-11-12T08:00:00.000Z'&&cr.nextDeployAllowedAt===null,JSON.stringify(cr));
// seed boards: a smartrecruiters line survives the settings round trip (hunt-find.mjs BOARD_LINE accepts it since 22 Oct 2026)
const sd=await post('hunt',KEY,{action:'settings',by:'claude-code',seeds:'greenhouse examplesec\nsmartrecruiters Fabrikam2\nworkday nope'});
st=await state(); ok('seeds saved through settings',sd.status===200&&st.hunt.seeds==='greenhouse examplesec\nsmartrecruiters Fabrikam2\nworkday nope',JSON.stringify(st.hunt.seeds));
await post('hunt',KEY,{action:'settings',seeds:''});
// sweep: submitting + 3h -> unverified (not failed)
await editState(stt=>{const r=stt.roles.find(x=>x.id!=='r-w1b'&&x.apply&&x.apply.status==='submitting'); r.apply.startedAt=new Date(Date.now()-3*3600000).toISOString();});
await post('hunt',KEY,{action:'sweep'}); st=await state();
ok('sweep: submitting + 3h -> unverified/timeout',st.roles.some(r=>r.apply&&r.apply.status==='unverified'&&r.apply.reason==='timeout'));
// manual mode still works
await post('hunt',KEY,{action:'settings',autoQueue:false});
const f3=await post('hunt',SEC,{runId:'hunt-w3',candidates:[cand('M1','https://m1.co','AI Engineer')]}); st=await state();
await post('hunt',SEC,{kind:'grade',roleId:roleOf(st,'M1').id,research:research(4),sentence:'s'});
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'M1').id,apply:pkg()}); ok('manual mode: prep -> prepared (not queued)',p.body.placed==='prepared',JSON.stringify(p.body));
await post('hunt',KEY,{action:'settings',autoQueue:true});
// Hebrew title forms (reviewer, 22 Oct 2026): Drushim writes "מנהל.ת מוצר" (dot) as often as "מנהל/ת מוצר"; both are PM titles, "מנהל.ת צוות" is still seniority
const fh=await post('hunt',SEC,{runId:'hunt-heb',candidates:[
  cand('H1','https://h1.co.il','מנהל.ת מוצר דיגיטל','drushim','רמת גן, Israel','https://www.drushim.co.il/job/h1/'),
  cand('H2','https://h2.co.il','מנהל/ת תחום מוצר ודיגיטל','drushim','בני ברק, Israel','https://www.drushim.co.il/job/h2/'),
  cand('H3','https://h3.co.il','מנהלת מוצר','drushim','תל אביב, Israel','https://www.drushim.co.il/job/h3/'),
  cand('H4','https://h4.co.il','מנהל.ת צוות פיתוח','drushim','חיפה, Israel','https://www.drushim.co.il/job/h4/'),
]}); st=await state();
ok('hebrew titles: dot / slash / feminine PM forms ingested, dot-form team lead dropped',fh.body.created===3&&!!roleOf(st,'H1')&&!!roleOf(st,'H2')&&!!roleOf(st,'H3')&&!roleOf(st,'H4'),JSON.stringify(fh.body));
// Drushim external apply (reviewer, 23 Oct 2026): the finder follows the posting's externalApplyUrl and maps the landing host to an ATS;
// a recipe ATS is offered on its real URL, Workday / other is dropped as "external" (Contoso via stats.the-network.com -> Workday failed in the worker)
try {
  const { externalAts } = await import('../netlify/functions/hunt-find.mjs');
  ok('externalAts: landing hosts map to recipe ATS / workday / other',
    externalAts('https://job-boards.greenhouse.io/umbrella/jobs/1')==='greenhouse' && externalAts('https://jobs.lever.co/x/1')==='lever' && externalAts('https://jobs.ashbyhq.com/x/1')==='ashby'
    && externalAts('https://www.comeet.com/jobs/x/1')==='comeet' && externalAts('https://jobs.smartrecruiters.com/Fabrikam2/1')==='smartrecruiters'
    && externalAts('https://contoso.wd3.myworkdayjobs.com/Contoso_Careers/job/x')==='workday' && externalAts('https://stats.the-network.com/redirect/abc')==='other' && externalAts('')==='other');
} catch (e) { ok('externalAts importable from hunt-find.mjs', false, e.message); }
// resolve per company with a 7-day miss cache (reviewer, 24 Oct 2026: the night run looped in resolve, one row per lookup)
try {
  const { resolvePlan } = await import('../netlify/functions/hunt-find.mjs');
  const now = Date.parse('2026-10-24T00:30:00Z');
  const f = { raw: [{ name: 'Vandelay', title: 'PM', ats: 'drushim' }, { name: 'Vandelay', title: 'PO', ats: 'drushim' }, { name: 'Vandelay', title: 'AI PM', ats: 'alljobs' },
    { name: 'Megacorp', title: 'PM', ats: 'drushim' }, { name: 'Umbrella', title: 'PM', ats: 'greenhouse' }, { name: 'קבוצה', title: 'PM', ats: 'drushim' }, { name: 'Old Miss', title: 'PM', ats: 'drushim' }] };
  const h = { resolveMiss: { megacorp: '2026-10-22T00:00:00Z', oldmiss: '2026-10-01T00:00:00Z' } };
  const p = resolvePlan(f, h, now, 10);
  const keys = p.batch.map(b => b.key);
  ok('resolve: one lookup per company, recent miss skipped, stale miss expired, own-ATS / Hebrew-only rows untouched',
    p.done && keys.length === 2 && p.batch.find(b => b.rows.length === 3) && f.raw[3].resolved === true && !h.resolveMiss.oldmiss && !f.raw[4].resolved && !f.raw[5].resolved, JSON.stringify({ keys, miss: h.resolveMiss }));
  const p2 = resolvePlan({ raw: Array.from({ length: 25 }, (_, i) => ({ name: `Co ${i}`, title: 'PM', ats: 'drushim' })) }, {}, now, 10);
  ok('resolve: 10 companies a tick, not done while more wait', p2.batch.length === 10 && !p2.done);
} catch (e) { ok('resolvePlan importable from hunt-find.mjs', false, e.message); }
// application records (record.mjs, 25 Oct 2026): what each run put on the form, kept outside the board state
{
  const rid='rec'+Date.now().toString(36).slice(-6);
  const base={roleId:rid,company:'Recco',title:'Product Manager',ats:'greenhouse',outcome:'submitted',clicked:true,cv:{version:'tpm',title:'Product Manager',sha256:'ab'},fields:[{label:'Country*',final:'Israel',required:true,source:'profile'},{label:'Password',final:'secret',type:'password'}]};
  const p1=await post('record',KEY,{...base,runId:'worker-2026-10-25-100000',at:'2026-10-25T10:00:00Z'});
  ok('record: POST accepted',p1.status===200&&p1.body.ok===true,JSON.stringify(p1));
  await post('record',KEY,{...base,runId:'worker-2026-10-25-110000',at:'2026-10-25T11:00:00Z',outcome:'failed'});
  ok('record: same run again replaces it',(await post('record',KEY,{...base,runId:'worker-2026-10-25-100000',at:'2026-10-25T10:00:00Z'})).status===200);
  const g=await get(`record?roleId=${rid}`,KEY);
  ok('record: GET newest first, one per run',g.status===200&&g.body.records.length===2&&g.body.records[0].outcome==='failed',JSON.stringify(g.body).slice(0,300));
  ok('record: a password field is never stored',g.body.records.every(r=>r.fields.every(f=>f.final!=='secret')));
  ok('record: no key refused',(await post('record',{'content-type':'application/json'},{...base,runId:'worker-x-1'})).status===401);
  ok('record: no runId refused',(await post('record',KEY,{...base,runId:''})).status===422);
  ok('record: oversized refused',(await post('record',KEY,{...base,runId:'worker-2026-10-25-120000',fields:Array.from({length:60},(_,i)=>({label:'q'+i+'x'.repeat(150),final:'y'.repeat(200)}))})).status===413);
}
// title filters loosened by Eyal (23 Oct 2026): yes / no table
try {
  const { TITLE_INCLUDE, TITLE_EXCLUDE, titleKey } = await import('../netlify/functions/hunt.mjs');
  const pass1 = t => TITLE_INCLUDE.test(t) && !TITLE_EXCLUDE.test(t);
  const yes = ['Senior Product Manager', 'Sr. Solutions Engineer', 'Product Owner', 'Product Lead', 'Lead Product Manager', 'Implementation Engineer', 'Integration Engineer', 'Customer Engineer', 'מנהל/ת מוצר בכיר', 'מנהל.ת מוצר סניור', 'מנהל /ת מוצר טכנולוגי /ת - Platforms Digital Products', 'דרוש /ה מנהל /ת מוצר', 'AI Engineer', 'Head of AI Engineering', 'Head AI Engineer'];
  const no = ['Team Lead', 'Tech Lead - AI', 'Director of Product', 'Staff Engineer', 'Principal Product Manager', 'Group Product Manager', 'VP Product', 'Product Intern', 'ראש צוות פיתוח', 'מנהל /ת צוות פיתוח', 'Forward Deployed Engineer', 'Sales Manager'];
  ok('filters: every yes title passes', yes.every(pass1), JSON.stringify(yes.filter(t => !pass1(t))));
  ok('filters: every no title is dropped', no.every(t => !pass1(t)), JSON.stringify(no.filter(pass1)));
  ok('titleKey: seniority, gender marks and a trailing location do not make a new role', titleKey('Senior Product Manager - Tel Aviv') === titleKey('Product Manager') && titleKey('מנהל/ת מוצר בכיר') === titleKey('מנהל מוצר') && titleKey('Product Owner') !== titleKey('Product Manager'));
} catch (e) { ok('hunt.mjs filters importable', false, e.message); }
console.log(`\n${pass} passed, ${fail} failed`);
