import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()];}));
const B='http://localhost:8899/.netlify/functions';
const KEY={'x-key':env.PIPELINE_KEY,'content-type':'application/json'}, SEC={'x-secret':env.RESEARCH_SECRET,'content-type':'application/json'};
const j=async(r)=>({status:r.status, body:await r.json().catch(()=>null)});
const get=(fn,h)=>fetch(`${B}/${fn}`,{headers:h}).then(j);
const post=(fn,h,b)=>fetch(`${B}/${fn}`,{method:'POST',headers:h,body:JSON.stringify(b)}).then(j);
let pass=0, fail=0; const ok=(name,c,extra='')=>{ if(c){pass++;console.log('PASS',name);} else {fail++;console.log('FAIL',name,extra);} };
const state=async()=>(await get('state',KEY)).body;
const PAYLOADS=process.env.PAYLOADS||new URL('./payloads.jsonl', import.meta.url);   // written by tests/fire-catcher.mjs next to itself
const lastPayload=()=>{ const lines=fs.readFileSync(PAYLOADS,'utf8').trim().split('\n'); return JSON.parse(lines[lines.length-1]); };
const payloadOf=(p)=>p.payload||p;

// clean board
const cur=await state(); await post('state',KEY,{baseRev:cur.rev,state:{updatedAt:'',channels:cur.state.channels,people:[],tasks:[],companies:[],roles:[]}});
await post('hunt',KEY,{action:'settings',killSwitch:false,caps:{found:3,prepared:2,offered:8},denyExtra:''});

// (a) Hunt now -> sorting
let last; for (let i=0;i<40;i++){ const r=await post('hunt',KEY,{action:'find'}); last=r.body.find; if(!r.body.ok||last.done) break; }
let d=await state(); let f=d.state.hunt.find;
ok('finder ends in sorting', f.status==='sorting' && last.next==='sorting', JSON.stringify({status:f.status,last}));
ok('offered <= cap 8 and > 0', f.offered.length>0 && f.offered.length<=8, String(f.offered.length));
ok('huntRun shows sorting', d.state.huntRun && /sorting/.test(d.state.huntRun.step), JSON.stringify(d.state.huntRun));
const fired=payloadOf(lastPayload()); ok('sorter payload fired (kind hunt-sort, offered list, brief url)', fired.kind==='hunt-sort' && Array.isArray(fired.offered) && fired.offered.length===f.offered.length && /hunt-sort-brief/.test(fired.brief) && fired.deny, JSON.stringify(fired).slice(0,200));
ok('no cards yet', d.state.companies.length===0);

// (b) scheduled tick while sorting = wait
const tick=await post('hunt',KEY,{action:'find'}); ok('tick while sorting waits', tick.body.find.step==='sorting' && tick.body.find.done, JSON.stringify(tick.body.find));
d=await state(); ok('still sorting after tick', d.state.hunt.find.status==='sorting');

// (c) sorter posts
const bad=await post('hunt',SEC,{kind:'sort',runId:'hunt-wrong',candidates:[]}); ok('wrong runId -> 409', bad.status===409, JSON.stringify(bad.body));
const picks=[{name:'Globex Security',site:'https://www.globex.io',domain:'globex.io',source:'linkedin',title:'Product Manager',url:'https://job-boards.greenhouse.io/globex/jobs/1',ats:'greenhouse',location:'Ramat Gan, Israel',why:'plain PM seat, Greenhouse form'},
             {name:'Massive Dynamic',site:'https://massivedynamic.io',domain:'massivedynamic.io',source:'linkedin',title:'AI Engineer',url:'https://il.linkedin.com/jobs/view/x',ats:'linkedin',location:'Tel Aviv, Israel',why:'by hand'}];
const s1=await post('hunt',SEC,{kind:'sort',runId:f.runId,candidates:picks,dropped:{sales:3,language:1},errors:['x'],brief:'kept 2 of 8'});
ok('sort accepted, 2 cards created', s1.status===200 && s1.body.created===2, JSON.stringify(s1.body).slice(0,200));
d=await state(); const lr=d.state.hunt.lastRun;
ok('find done, huntRun cleared', d.state.hunt.find.status==='done' && !d.state.huntRun);
ok('lastRun brief has finder + sorter lines', /Finder:/.test(lr.brief) && /Sorter: kept 2 of 8/.test(lr.brief), lr.brief);
ok('funnel merged sorter drops', lr.funnel.dropped['sorter:sales']===3 && lr.funnel.found>0, JSON.stringify(lr.funnel));
const up=d.state.roles.find(r=>r.title==='Product Manager'); ok('role note carries the sorter why', up && /Sorter: plain PM seat/.test(up.notes), up&&up.notes);
const g=payloadOf(lastPayload()); ok('first grader fired after sort', g.kind==='hunt-grade', JSON.stringify(g).slice(0,120));
const s2=await post('hunt',SEC,{kind:'sort',runId:f.runId,candidates:picks}); ok('second sort -> 409', s2.status===409);

// (d) fallback after 30 min
for (let i=0;i<40;i++){ const r=await post('hunt',KEY,{action:'find'}); if(!r.body.ok||r.body.find.done) break; }
d=await state(); ok('second manual run is sorting again', d.state.hunt.find.status==='sorting');
d.state.hunt.find.firedAt=new Date(Date.now()-31*60000).toISOString();
const sv=await post('state',KEY,{baseRev:d.rev,state:d.state}); ok('aged firedAt saved', sv.status===200);
const kk=await post('hunt',KEY,{action:'kick'}); ok('kick used the fallback', /finder's pick used/.test((kk.body.kicked.events||[]).join(' ')), JSON.stringify(kk.body.kicked));
d=await state(); const lr2=d.state.hunt.lastRun;
ok('fallback created cards (cap 3) and noted the error', d.state.hunt.find.status==='done' && lr2.candidates>0 && lr2.candidates<=3 && lr2.errors.some(e=>/did not answer/.test(e)), JSON.stringify({c:lr2.candidates,e:lr2.errors}));
ok('fallback brief says so', /finder's own pick/.test(lr2.brief), lr2.brief);
console.log(`\n${pass} passed, ${fail} failed`);
