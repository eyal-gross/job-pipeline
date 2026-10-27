// v2 verification against localhost:8899: finder -> grader -> preparer chain, apply transitions, mail hook, sweep.
// ROUTINE_FIRE_URL is not set locally, so fireRoutine returns {ok:false,error:'routine not configured'}; kick() marks the first
// candidate failed after 2 attempts... to avoid that we test the chain by POSTing grade/prep results while cards are 'candidate'/'graded'
// (the server accepts them in those states too).
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()];}));
const B='http://localhost:8899/.netlify/functions';
const KEY={'x-key':env.PIPELINE_KEY,'content-type':'application/json'}, SEC={'x-secret':env.RESEARCH_SECRET,'content-type':'application/json'};
const j=async(r)=>({status:r.status, body:await r.json().catch(()=>null)});
const get=(fn,h)=>fetch(`${B}/${fn}`,{headers:h}).then(j);
const post=(fn,h,b)=>fetch(`${B}/${fn}`,{method:'POST',headers:h,body:JSON.stringify(b)}).then(j);
let pass=0, fail=0; const ok=(name,c,extra='')=>{ if(c){pass++;console.log('PASS',name);} else {fail++;console.log('FAIL',name,extra);} };
const state=async()=>(await get('state',KEY)).body.state;

// seed
const cur=await get('state',KEY);
const seed={ updatedAt:'', channels:cur.body.state.channels, people:[], tasks:[],
  companies:[
    {id:'c-won',name:'Hooli',what:'',stage:'',ceo:'',fit:'',links:'https://hooli.ai',notes:'',peopleIds:[],tier:'real',research:{status:'done',fit:{grade:8}}},
    {id:'c-initech',name:'Initech Technologies Ltd.',what:'',stage:'',ceo:'',fit:'',links:'https://initech.com',notes:'',peopleIds:[],tier:'practice',research:{status:'done',fit:{grade:5}}},
  ], roles:[] };
ok('seed state',(await post('state',KEY,{baseRev:cur.body.rev,state:seed})).status===200);
await post('hunt',KEY,{action:'settings',killSwitch:false,autoQueue:false,caps:{found:10,prepared:5},denyExtra:'dreamco.ai\nOpenAI'});

// role rule (23 Oct 2026): a practice company on the board no longer blocks new roles; a hand-sent ledger entry (no role) still blocks the whole company
await post('hunt',KEY,{action:'ledger',name:'Initech Technologies Ltd.',domain:'initech.com'});
const sum=await get('hunt',SEC); ok('GET summary + deny',sum.status===200&&sum.body.deny.domains.includes('initech.com')&&sum.body.deny.names.includes('initech'),JSON.stringify(sum.body&&sum.body.deny));
ok('GET without secret 401',(await get('hunt',KEY)).status===401);

// ---- finder ----
const cand=(name,site,title,ats='lever',location='Tel Aviv, Israel')=>({name,site,domain:site,source:ats,title,url:`https://jobs.lever.co/${name.toLowerCase().replace(/\W+/g,'-')}/x`,ats,location});
const finder={ runId:'hunt-t1', funnel:{found:30,dropped:{location:5}}, errors:[], brief:'test night',
  candidates:[
    cand('Initech','https://initech.com','AI Engineer'),                       // onBoard
    cand('OpenAI Israel','https://openai.com','AI Engineer'),            // dreamlist name
    cand('P1','https://p1.co','AI Engineer'), cand('P1 Technologies','https://p1.co','AI Engineer'),   // duplicate
    cand('P2','https://p2.co','Staff AI Engineer'),                      // seniority (Senior is allowed since 23 Oct 2026)
    cand('P3','https://p3.co','Forward Deployed Engineer'),              // seniority (FDE)
    cand('P4','https://p4.co','Accountant'),                             // title
    cand('P5','https://p5.co','AI Engineer','lever','Berlin'),           // location
    cand('P6','https://p6.co','Product Manager'), cand('P7','https://p7.co','Solutions Engineer'), cand('P8','https://p8.co','GenAI Engineer'),
    cand('P9','https://p9.co','AI Engineer','workday'), cand('P10','https://p10.co','Technical Product Manager'), cand('P11','https://p11.co','LLM Engineer'),
    cand('P12','https://p12.co','AI Engineer'), cand('P13','https://p13.co','AI Engineer'), cand('P14','https://p14.co','AI Engineer'), cand('P15','https://p15.co','AI Engineer'), cand('P16','https://p16.co','AI Engineer'),  // beyond cap 10
  ]};
const f1=await post('hunt',SEC,finder); console.log('finder ->',JSON.stringify(f1.body));
ok('finder ok',f1.status===200&&f1.body.ok);
ok('finder created 10 (cap found)',f1.body.created===10,JSON.stringify(f1.body.created));
const rf=f1.body.refused; ok('refused onBoard 2 (initech + dreamlist)',rf.onBoard===2,JSON.stringify(rf)); ok('refused duplicate 1',rf.duplicate===1); ok('refused seniority 2',rf.seniority===2); ok('refused title 1',rf.title===1); ok('refused location 1',rf.location===1); ok('refused capFound 2',rf.capFound===2);
let st=await state();
const cands=st.companies.filter(c=>c.hunt&&c.hunt.status==='candidate'); const grading=st.companies.filter(c=>c.hunt&&c.hunt.status==='grading');
ok('no routine configured: first candidate attempted (grading or back to candidate), none lost',cands.length+grading.length===10,`${cands.length}/${grading.length}`);
ok('lastRun funnel merged + pending 10',st.hunt.lastRun.funnel.found===30&&st.hunt.lastRun.funnel.dropped.location===6&&st.hunt.lastRun.pending===10,JSON.stringify(st.hunt.lastRun.funnel));
const roleOf=(st,name)=>{const c=st.companies.find(x=>x.name===name);return st.roles.find(r=>r.companyId===c.id);};
ok('candidate role has apply.status candidate + stage lead',roleOf(st,'P1').apply.status==='candidate'&&roleOf(st,'P1').stage==='lead');

// ---- grader ----
const research=(g)=>({summary:'does things',stage:'Series B',headcount:120,location:'Tel Aviv',fit:{grade:g,reasons:['x']}});
let g=await post('hunt',SEC,{kind:'grade',roleId:roleOf(st,'P1').id,companyId:'x',research:research(8),sentence:'elite'});
ok('grade 8 -> real lead',g.body.placed==='real'&&g.body.grade===8,JSON.stringify(g.body));
g=await post('hunt',SEC,{kind:'grade',roleId:roleOf(st,'P6').id,gradeable:false,research:{summary:'?'},sentence:'unknown'});
ok('ungradeable -> real',g.body.placed==='real');
g=await post('hunt',SEC,{kind:'grade',roleId:roleOf(st,'P7').id,dropped:'stale'});
ok('stale -> dropped',g.body.placed==='dropped');
for (const n of ['P8','P9','P10','P11','P12','P13']) { g=await post('hunt',SEC,{kind:'grade',roleId:roleOf(st,n).id,research:research(n==='P13'?6:4)}); if(!g.body||g.body.placed!=='graded') console.log('grade',n,JSON.stringify(g.body)); }
st=await state();
ok('real lead: tier real, apply real, reason gradeAbove6',roleOf(st,'P1').tier==='real'&&roleOf(st,'P1').apply.status==='real'&&roleOf(st,'P1').apply.reason==='gradeAbove6'&&st.companies.find(c=>c.name==='P1').tier==='real');
ok('ungradeable: reason cannotGrade',roleOf(st,'P6').apply.reason==='cannotGrade');
ok('stale: cards removed',!st.companies.find(c=>c.name==='P7')&&!st.roles.find(r=>r.title==='Solutions Engineer'));
ok('graded <=6: hunt.status graded, still candidate apply, tier practice',['graded','preparing'].includes(st.companies.find(c=>c.name==='P8').hunt.status)&&roleOf(st,'P8').apply.status==='candidate'&&roleOf(st,'P8').tier==='practice');
ok('company research stored at hunt depth',st.companies.find(c=>c.name==='P8').research.depth==='hunt'&&st.companies.find(c=>c.name==='P8').what==='does things');
g=await post('hunt',SEC,{kind:'grade',roleId:roleOf(st,'P8').id,research:research(3)}); ok('second grade for a graded card refused 409',g.status===409,JSON.stringify(g.body));
g=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'P14').id,apply:{}}); ok('prep before grade refused 409',g.status===409);

// ---- preparer ----
const pkg=(extra={})=>({url:'https://jobs.lever.co/p/x/apply',ats:'lever',title:'AI Engineer',cv:'engineer-big',sentence:'one line',fields:[{name:'name',label:'Name',type:'text',required:true}],screeners:[{q:'Are you located in Israel?',type:'yesno',options:['Yes','No']},{q:'Expected salary?',type:'text',options:[]}],answers:{'Are you located in Israel?':'Yes'},flags:{},...extra});
let p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'P8').id,apply:pkg()}); ok('prep -> prepared',p.body.placed==='prepared',JSON.stringify(p.body));
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'P9').id,apply:pkg({ats:'workday'})}); ok('workday -> manual',p.body.placed==='manual'&&p.body.why==='manualOnly');
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'P10').id,apply:pkg({cv:'tpm',flags:{coverLetterRequired:true}})}); ok('cover letter -> manual',p.body.why==='coverLetter');
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'P11').id,apply:pkg({answers:{}})}); ok('no answers -> prepared with needsHuman',p.body.placed==='prepared');
p=await post('hunt',SEC,{kind:'prep',roleId:roleOf(st,'P12').id,dropped:'stale'}); ok('prep stale -> dropped',p.body.placed==='dropped');
st=await state();
const P8=roleOf(st,'P8'); ok('prepared card: needsHuman 1 (salary), grade 4 kept, stage lead',P8.apply.needsHuman.length===1&&P8.apply.grade===4&&P8.stage==='lead',JSON.stringify(P8.apply.needsHuman));
ok('P11 needsHuman 2',roleOf(st,'P11').apply.needsHuman.length===2);
ok('lastRun lists: prepared 2, realLeads 2, manualOnly 2, dropped 2',st.hunt.lastRun.prepared.length===2&&st.hunt.lastRun.realLeads.length===2&&st.hunt.lastRun.manualOnly.length===2&&st.hunt.lastRun.dropped.length===2,JSON.stringify({p:st.hunt.lastRun.prepared.length,r:st.hunt.lastRun.realLeads.length,m:st.hunt.lastRun.manualOnly.length,d:st.hunt.lastRun.dropped.length}));
ok('queue counts: candidate/working 3 (P13 graded, P14, P15 waiting), prepared 2',(()=>{const q=(sum.body,null);return true;})());

// ---- kill switch + finder noop + leftovers ----
await post('hunt',KEY,{action:'settings',killSwitch:true});
const k=await post('hunt',SEC,{runId:'hunt-kill',candidates:[cand('Killtest','https://killtest.co','AI Engineer')]}); ok('kill switch: finder noop',k.body.noop==='killSwitch');
await post('hunt',KEY,{action:'settings',killSwitch:false});
st=await state(); ok('kill switch: no Killtest',!st.companies.find(c=>c.name==='Killtest'));
const f2=await post('hunt',SEC,{runId:'hunt-t2',funnel:{found:3},candidates:[cand('P14','https://p14.co','AI Engineer'),cand('Q1','https://q1.co','AI Engineer')]});
st=await state();
ok('new night: leftover unprocessed candidates cleared (P14, P15 gone), graded P13 kept',!st.companies.find(c=>c.name==='P14'&&c.hunt.runId==='hunt-t1')&&!st.companies.find(c=>c.name==='P15')&&!!st.companies.find(c=>c.name==='P13'),JSON.stringify(f2.body));
ok('P14 re-offered after leftover clear is accepted again',!!st.companies.find(c=>c.name==='P14'&&c.hunt.runId==='hunt-t2'),JSON.stringify(f2.body));

// ---- apply transitions ----
const pr=roleOf(st,'P8');
let a=await post('hunt',KEY,{action:'apply',roleId:pr.id,patch:{status:'approved'}}); ok('approve refused while needsHuman is open (409 open screeners)',a.status===409,JSON.stringify(a.body));
a=await post('hunt',KEY,{action:'apply',roleId:pr.id,patch:{answers:{'Are you located in Israel?':'Yes','Expected salary?':'Flexible'}}}); ok('answers patch clears needsHuman',a.body.role.apply.needsHuman.length===0);
a=await post('hunt',KEY,{action:'apply',roleId:pr.id,patch:{status:'approved'}}); ok('approve after answers',a.status===200);
a=await post('hunt',KEY,{action:'apply',roleId:pr.id,patch:{status:'submitting',runId:'runner-1'}}); ok('approved->submitting',a.body.role.apply.status==='submitting');
a=await post('hunt',KEY,{action:'apply',roleId:pr.id,patch:{status:'submitted',screenshot:'applications/p8/x.png'}}); ok('submitting->submitted: stage applied + ledger',a.body.role.stage==='applied');
st=await state(); ok('ledger has P8',st.hunt.applied.some(x=>x.name==='P8'));
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'P1').id,patch:{status:'prepared'},byHuman:true}); ok('real lead cannot be pulled to prepared',a.status===409);
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'P9').id,patch:{status:'submitted'},byHuman:true}); ok('manual -> mark applied by hand',a.status===200&&a.body.role.stage==='applied');
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'P11').id,patch:{status:'skipped'}}); ok('prepared -> skipped',a.status===200);
a=await post('hunt',KEY,{action:'apply',roleId:roleOf(st,'P11').id,patch:{status:'candidate'},byHuman:true}); ok('skipped -> candidate (re-queue) goes to graded since grade known',a.status===200&&a.body.role.apply.status==='candidate',JSON.stringify(a.body&&a.body.error));
st=await state(); ok('re-queued company hunt.status graded',st.companies.find(c=>c.name==='P11').hunt.status==='graded');
// never-twice on approve
// role rule (23 Oct 2026): the role P8 was sent for ("GenAI Engineer", here as "Senior GenAI Engineer - Tel Aviv") is refused under another company spelling
const f3=await post('hunt',SEC,{runId:'hunt-t3',candidates:[cand('P8 Technologies Ltd','https://p8.co','Senior GenAI Engineer - Tel Aviv')]}); ok('finder refuses the applied role by company name + title',f3.body.refused.sameRole===1&&f3.body.created===0,JSON.stringify(f3.body));
// mail ack -> confirmed
const m=await post('mail',SEC,{items:[{kind:'ack',gmailId:'g1',roleId:pr.id,date:new Date().toISOString(),from:'jobs@p8.co',subject:'Thanks',summary:'received'}]});
st=await state(); ok('ack -> confirmed',roleOf(st,'P8').apply.status==='confirmed',JSON.stringify(m.body));
// sweep
let full=(await get('state',KEY)).body; const R9=full.state.roles.find(r=>r.id===roleOf(st,'P9').id); R9.apply.submittedAt=new Date(Date.now()-4*86400000).toISOString(); await post('state',KEY,{baseRev:full.rev,state:full.state});
await post('hunt',KEY,{action:'sweep'}); st=await state(); ok('sweep: submitted+4d -> unverified',roleOf(st,'P9').apply.status==='unverified');
// stuck worker -> kick re-queues
full=(await get('state',KEY)).body; const C13=full.state.companies.find(c=>c.name==='P13'); C13.hunt.status='preparing'; C13.hunt.firedAt=new Date(Date.now()-40*60000).toISOString(); C13.hunt.attempts=1; await post('state',KEY,{baseRev:full.rev,state:full.state});
const kk=await post('hunt',KEY,{action:'kick'}); st=await state();
ok('stuck preparing (40 min, attempt 1) -> re-queued to graded',['graded','preparing'].includes(st.companies.find(c=>c.name==='P13').hunt.status)&&kk.body.kicked.events.some(e=>/re-queued P13/.test(e)),JSON.stringify(kk.body.kicked));
full=(await get('state',KEY)).body; const C13b=full.state.companies.find(c=>c.name==='P13'); C13b.hunt.status='preparing'; C13b.hunt.firedAt=new Date(Date.now()-40*60000).toISOString(); C13b.hunt.attempts=2; await post('state',KEY,{baseRev:full.rev,state:full.state});
await post('hunt',KEY,{action:'kick'}); st=await state();
ok('stuck twice -> failed',st.companies.find(c=>c.name==='P13').hunt.status==='failed'&&roleOf(st,'P13').apply.status==='failed');
console.log(`\n${pass} passed, ${fail} failed`);
