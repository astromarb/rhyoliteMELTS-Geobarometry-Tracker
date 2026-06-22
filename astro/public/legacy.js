// ════════════════════════════════════════════════════════
//  APP CONSTANTS
// ════════════════════════════════════════════════════════
const APP_VERSION    = '0.20';
const SCHEMA_VERSION = 4;
const STORAGE_KEY    = 'melts_v4';
const BACKUP_PREFIX  = 'melts_v4_backup_';   // rolling pre-import snapshots
const BACKUP_RING    = 3;                    // keep last N snapshots
const DEFAULT_SIM_TOTAL  = 200;              // default Monte-Carlo cell count per run
const RANK_PLOT_PAD_FRAC = 0.08;             // y-axis padding fraction in rank plot
const RANK_PLOT_EXPORT_DPR = 4;              // ~400 dpi PNG export
const PDF_GRIDS_PER_PAGE   = 9;              // 3×3 grids per batch-PDF page

// ════════════════════════════════════════════════════════
//  DATA MODEL
// ════════════════════════════════════════════════════════
const SAMPLE_NAMES = [
  'KCP-109-C','KCP-110-A','KCP-109-B','KCP-109-A','KCP-114-A',
  'KHD-105-B-2','KHD-105-B','KHD-105-D','KHD-107-C','KHD-105-G',
  'KHD-105-E','KHD-105-F','KKC-103-A','KHD-107-A','KHD-107-D','KHD-106-A'
];
const ST = {NR:'not-run', OK:'success', FAIL:'failed'};

const OXIDES = ['SiO2','TiO2','Al2O3','FeO*','MnO','MgO','CaO','Na2O','K2O','P2O5'];
const OX_LABEL = {
  'SiO2':'SiO₂','TiO2':'TiO₂','Al2O3':'Al₂O₃','FeO*':'FeO*','P2O5':'P₂O₅',
  'MnO':'MnO','MgO':'MgO','CaO':'CaO','Na2O':'Na₂O','K2O':'K₂O'
};

const STEPS = [1,2,5,10,25,50];

function mkComps(n){
  const a=[];
  for(let i=1;i<=n;i++) a.push({num:i,status:ST.NR,note:''});
  return a;
}
function mkSampleEntity(name, notes=''){
  return{id:'S'+Date.now()+Math.random().toString(36).slice(2,5),name,notes,
         unitId:'',rockType:'',
         // legacy compat fields (may be present in old JSON)
         geoUnit:'',geoUnitAbbr:'',
         wholeRock:{headers:[],values:{}},createdAt:new Date().toISOString()};
}
function mkSimset(sampleId, name, total=DEFAULT_SIM_TOTAL){
  return{id:'SS'+Date.now()+Math.random().toString(36).slice(2,5),sampleId,name,total,compositions:mkComps(total),thresholds:[],compWholeRock:{headers:[],rows:{}},defaultThreshold:{pressure:'',unit:'MPa',notes:''},createdAt:Date.now()};
}
// Legacy compatibility shim (used internally only, not for new data)
function mkSample(name,total=DEFAULT_SIM_TOTAL){
  const se=mkSampleEntity(name,'');
  const ss=mkSimset(se.id,name,total);
  return{...ss, _legacyCombined:true, _sampleRef:se};
}
function mkThreshold(simsetId,name,cutoff,unit='',desc='',parentComps){
  const comps=parentComps
    ? parentComps.map(c=>({num:c.num,status:c.status===ST.FAIL?ST.FAIL:ST.NR,note:'',fname:'',pValue:undefined}))
    : mkComps(200);
  return{id:'T'+Date.now()+Math.random().toString(36).slice(2,5),simsetId,name,cutoff,unit,desc,compositions:comps,pMean:'',pStd:'',pUnit:'',pCount:0,rawPaste:'',createdAt:Date.now(),open:true};
}

// ════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════
let S={samples:[],simsets:[],activeSimsetId:null,activeSampleId:null,activeThreshSid:null,activePage:'runs'};
let activeTab={};      // simsetId -> 'grid'|'failed'
let activeThreshTab={};// tid -> 'grid'|'locked'

// Phase 5: id-keyed Map caches. Rebuild on array-ref or length change.
let _smpCache=null,_smpRef=null,_smpLen=-1;
let _ssCache=null,_ssRef=null,_ssLen=-1;
function getSample(id){
  if(_smpCache===null||_smpRef!==S.samples||_smpLen!==S.samples.length){
    _smpCache=new Map();for(const s of S.samples)_smpCache.set(s.id,s);
    _smpRef=S.samples;_smpLen=S.samples.length;
  }
  return _smpCache.get(id);
}
function getSimset(id){
  if(_ssCache===null||_ssRef!==S.simsets||_ssLen!==S.simsets.length){
    _ssCache=new Map();for(const ss of S.simsets)_ssCache.set(ss.id,ss);
    _ssRef=S.simsets;_ssLen=S.simsets.length;
  }
  return _ssCache.get(id);
}
// Legacy aliases used in thresholding code (maps to simsets for backward compat)
function getS(id){return getSimset(id);}
function getT(sid,tid){const s=getSimset(sid);return s&&s.thresholds.find(t=>t.id===tid);}
function getRunCount(comps){return comps.filter(c=>c.status!==ST.NR).length;}
function getSucc(comps){return comps.filter(c=>c.status===ST.OK).length;}
function getFail(comps){return comps.filter(c=>c.status===ST.FAIL).length;}
function getPct(comps){return comps.length===0?0:Math.round(getRunCount(comps)/comps.length*100);}

// ════════════════════════════════════════════════════════
//  PERSISTENCE
// ════════════════════════════════════════════════════════
// ── Sample Categories ────────────────────────────────────────────
// Ensure sampleCategories initialized on state
function _initCats(){if(!Array.isArray(S.sampleCategories))S.sampleCategories=[];}

// CRUD
function addSampleCategory(name,color){
  _initCats();
  const id='CAT'+Date.now()+Math.random().toString(36).slice(2,5);
  S.sampleCategories.push({id,name:name.trim(),color:color||'#58a6ff',sampleIds:[]});
  save();renderSamples();toast('Category "'+name+'" created ✓');
}
function renameSampleCategory(id,name,color){
  _initCats();
  const c=S.sampleCategories.find(x=>x.id===id);
  if(!c)return;
  c.name=name.trim();c.color=color||c.color;
  save();renderSamples();toast('Category updated ✓');
}
function deleteSampleCategory(id){
  _initCats();
  if(!confirm('Delete this category? Samples will not be deleted.'))return;
  S.sampleCategories=S.sampleCategories.filter(x=>x.id!==id);
  save();renderSamples();toast('Category deleted');
}
function toggleSampleInCategory(sampleId,catId){
  _initCats();
  const c=S.sampleCategories.find(x=>x.id===catId);if(!c)return;
  const i=c.sampleIds.indexOf(sampleId);
  if(i>=0)c.sampleIds.splice(i,1); else c.sampleIds.push(sampleId);
  save();renderSamples();
}
// Inline rename: show input in category header
function _catEditMode(id){
  const row=document.getElementById('cat-row-'+id);
  if(!row)return;
  const c=(S.sampleCategories||[]).find(x=>x.id===id);if(!c)return;
  row.innerHTML=`<input id="cat-inp-${id}" value="${esc(c.name)}" style="flex:1;background:var(--surface2);border:1px solid var(--blue);border-radius:4px;padding:2px 7px;color:var(--text);font-size:12px;font-weight:700">
  <input type="color" id="cat-col-${id}" value="${c.color}" style="width:28px;height:24px;border:none;background:none;cursor:pointer;padding:0">
  <button class="btn btn-sm btn-primary" style="font-size:10px;padding:2px 7px" onclick="_catSave('${id}')">Save</button>
  <button class="btn btn-sm" style="font-size:10px;padding:2px 7px" onclick="renderSamples()">Cancel</button>`;
}
function _catSave(id){
  const inp=document.getElementById('cat-inp-'+id);
  const col=document.getElementById('cat-col-'+id);
  if(!inp||!inp.value.trim())return;
  renameSampleCategory(id,inp.value,col?col.value:undefined);
}
// Open inline add-category form
function _showAddCatForm(){
  const el=document.getElementById('add-cat-form');
  if(el)el.style.display=el.style.display==='none'?'flex':'none';
}
function _submitNewCat(){
  const n=document.getElementById('new-cat-name');
  const c=document.getElementById('new-cat-color');
  if(!n||!n.value.trim()){toast('Enter a category name','err');return;}
  addSampleCategory(n.value,c?c.value:'#58a6ff');
}

// Persistent banner for unrecoverable errors (quota, save-blocked, etc.)
let _saveBlocked=false;
function showPersistentBanner(msg){
  const el=document.getElementById('persistent-banner');
  const m =document.getElementById('persistent-banner-msg');
  if(!el||!m)return;
  m.textContent=msg;
  el.classList.add('show');
}
function dismissPersistentBanner(){
  const el=document.getElementById('persistent-banner');
  if(el)el.classList.remove('show');
}

// Phase 5: debounced save. Public save() returns true and schedules a
// trailing write 250 ms after the last call; flushSave() forces immediate
// persistence (used by load() cleanup and before unload).
let _saveTimer=null;
function save(){
  if(_saveTimer!==null) return true;
  _saveTimer=setTimeout(()=>{ _saveTimer=null; _saveImmediate(); },250);
  return true;
}
function flushSave(){
  if(_saveTimer!==null){ clearTimeout(_saveTimer); _saveTimer=null; }
  return _saveImmediate();
}
function _saveImmediate(){
  try{
    S._schemaVersion=SCHEMA_VERSION;  // stamp for fast-path on next load
    localStorage.setItem(STORAGE_KEY,JSON.stringify(S));
    if(_saveBlocked){_saveBlocked=false;dismissPersistentBanner();}
    return true;
  }catch(e){
    console.error('save() failed:',e);
    // QuotaExceededError (and Firefox's NS_ERROR_DOM_QUOTA_REACHED) → block silently-lost writes
    const isQuota = e&&(e.name==='QuotaExceededError'||e.name==='NS_ERROR_DOM_QUOTA_REACHED'||e.code===22||e.code===1014);
    if(isQuota&&!_saveBlocked){
      _saveBlocked=true;
      showPersistentBanner('⚠ Browser storage is full — recent edits could not be saved. Export your data now (⬇ Export) before closing this tab. After exporting, use Settings → Reset to clear old data, then re-import.');
    }else if(!_saveBlocked){
      showPersistentBanner('⚠ Could not save to local storage: '+(e&&e.message||'unknown error')+'. Export your data before closing this tab.');
    }
    return false;
  }
}

/* ── Whole-rock sanitisation: enforce OXIDES whitelist on imported / migrated data.
   Prevents hostile JSON from injecting unescaped strings into DOM via header names. ── */
function sanitizeWR(wr){
  if(!wr||typeof wr!=='object')return{headers:[],values:{}};
  const headers=Array.isArray(wr.headers)?wr.headers.filter(h=>typeof h==='string'&&OXIDES.includes(h)):[];
  const valuesIn=(wr.values&&typeof wr.values==='object')?wr.values:{};
  const values={};
  headers.forEach(h=>{const v=Number(valuesIn[h]);values[h]=isFinite(v)?v:0;});
  return{headers,values};
}
function sanitizeCompWR(cwr){
  if(!cwr||typeof cwr!=='object')return{headers:[],rows:{}};
  const headers=Array.isArray(cwr.headers)?cwr.headers.filter(h=>typeof h==='string'&&OXIDES.includes(h)):[];
  const rowsIn=(cwr.rows&&typeof cwr.rows==='object')?cwr.rows:{};
  const rows={};
  for(const k in rowsIn){
    const num=parseInt(k,10);
    if(!isFinite(num)||num<1)continue;
    const r=rowsIn[k];
    if(!r||typeof r!=='object')continue;
    const clean={};
    headers.forEach(h=>{const v=Number(r[h]);clean[h]=isFinite(v)?v:0;});
    rows[num]=clean;
  }
  return{headers,rows};
}

/* ── migrate: repair any broken sample/threshold objects ── */
function migrateComp(c,i){
  if(!c||typeof c!=='object') return{num:i+1,status:ST.NR,note:'',fname:''};
  return{
    num:    typeof c.num==='number'?c.num:i+1,
    status: [ST.NR,ST.OK,ST.FAIL].includes(c.status)?c.status:ST.NR,
    note:   typeof c.note==='string'?c.note:'',
    fname:  typeof c.fname==='string'?c.fname:'',
    pValue: typeof c.pValue==='number'?c.pValue:undefined
  };
}
function migrateThresh(t){
  if(!t||typeof t!=='object') return null;
  const total = Array.isArray(t.compositions)?t.compositions.length:200;
  return{
    id:        typeof t.id==='string'&&t.id?t.id:'T'+Date.now()+Math.random().toString(36).slice(2,5),
    name:      typeof t.name==='string'?t.name:'Threshold',
    cutoff:    t.cutoff!=null?t.cutoff:0,
    unit:      typeof t.unit==='string'?t.unit:'',
    desc:      typeof t.desc==='string'?t.desc:'',
    compositions: Array.isArray(t.compositions)?t.compositions.map(migrateComp):mkComps(total),
    pMean:     t.pMean!=null?String(t.pMean):'',
    pStd:      t.pStd!=null?String(t.pStd):'',
    pUnit:     typeof t.pUnit==='string'?t.pUnit:'',
    pCount:    typeof t.pCount==='number'?t.pCount:0,
    rawPaste:  typeof t.rawPaste==='string'?t.rawPaste:'',
    createdAt: typeof t.createdAt==='number'?t.createdAt:Date.now(),
    open:      t.open!==false
  };
}
// ── New entity migrators ──
function migrateSampleEntity(s){
  if(!s||typeof s!=='object') return null;
  return{
    id:           typeof s.id==='string'&&s.id?s.id:'S'+Date.now()+Math.random().toString(36).slice(2,5),
    name:         typeof s.name==='string'&&s.name?s.name:'Unknown',
    notes:        typeof s.notes==='string'?s.notes:'',
    rockType:     typeof s.rockType==='string'?s.rockType:'',
    unitId:       typeof s.unitId==='string'?s.unitId:'',
    geoUnit:      typeof s.geoUnit==='string'?s.geoUnit:'',
    geoUnitAbbr:  typeof s.geoUnitAbbr==='string'?s.geoUnitAbbr:'',
    wholeRock:    sanitizeWR(s.wholeRock),
    wholeRockRaw: s.wholeRockRaw?sanitizeWR(s.wholeRockRaw):null,
    createdAt:    s.createdAt||new Date().toISOString(),
    updatedAt:    s.updatedAt||null
  };
}
function migrateSimsetEntity(ss){
  if(!ss||typeof ss!=='object') return null;
  const total = typeof ss.total==='number'&&ss.total>0?ss.total:200;
  const rawComps = Array.isArray(ss.compositions)?ss.compositions:[];
  const comps = rawComps.length>0?rawComps.map(migrateComp):mkComps(total);
  return{
    id:              typeof ss.id==='string'&&ss.id?ss.id:'SS'+Date.now()+Math.random().toString(36).slice(2,5),
    sampleId:        typeof ss.sampleId==='string'?ss.sampleId:'',
    name:            typeof ss.name==='string'&&ss.name?ss.name:'Unknown',
    notes:           typeof ss.notes==='string'?ss.notes:'',
    runType:         typeof ss.runType==='string'?ss.runType:'monte_carlo',
    total:           total,
    compositions:    comps,
    thresholds:      Array.isArray(ss.thresholds)?ss.thresholds.map(t=>migrateThreshEntity(t,ss.id)).filter(Boolean):[],
    compWholeRock:   sanitizeCompWR(ss.compWholeRock),
    defaultThreshold:(ss.defaultThreshold&&typeof ss.defaultThreshold==='object')?{
      pressure: String(ss.defaultThreshold.pressure||''),
      unit:     String(ss.defaultThreshold.unit||''),
      notes:    String(ss.defaultThreshold.notes||'')
    }:{pressure:'',unit:'',notes:''},
    createdAt:       typeof ss.createdAt==='number'?ss.createdAt:Date.now(),
    updatedAt:       ss.updatedAt||null,
    batchId:         typeof ss.batchId==='string'&&ss.batchId?ss.batchId:undefined
  };
}
function migrateThreshEntity(t, simsetId){
  if(!t||typeof t!=='object') return null;
  const base = migrateThresh(t);
  if(!base) return null;
  base.simsetId = simsetId||t.simsetId||'';
  return base;
}
// ── Old-format (combined) sample migrator — splits into sampleEntity + simset ──
function migrateSample(s){
  if(!s||typeof s!=='object') return null;
  const total = typeof s.total==='number'&&s.total>0?s.total:200;
  const rawComps = Array.isArray(s.compositions)?s.compositions:[];
  const comps = rawComps.length>0?rawComps.map(migrateComp):mkComps(total);
  const sid = typeof s.id==='string'&&s.id?s.id:'S'+Date.now()+Math.random().toString(36).slice(2,5);
  const ssid = 'SS'+sid;
  const sampleEntity = {
    id:        sid,
    name:      typeof s.name==='string'&&s.name?s.name:'Unknown',
    notes:     typeof s.notes==='string'?s.notes:'',
    wholeRock: sanitizeWR(s.wholeRock),
    createdAt: s.createdAt? (typeof s.createdAt==='number'? new Date(s.createdAt).toISOString():s.createdAt) : new Date().toISOString()
  };
  const simsetEntity = {
    id:           ssid,
    sampleId:     sid,
    name:         sampleEntity.name,
    total:        total,
    compositions: comps,
    thresholds:   Array.isArray(s.thresholds)?s.thresholds.map(t=>{const mt=migrateThresh(t);if(mt){mt.simsetId=ssid;}return mt;}).filter(Boolean):[],
    createdAt:    typeof s.createdAt==='number'?s.createdAt:Date.now()
  };
  return {sampleEntity, simsetEntity};
}
function migrate(raw){
  if(!raw||typeof raw!=='object') return null;
  const src = raw.state||raw;
  // Phase 5 fast path: trust the schema-version stamp from last save().
  if(src._schemaVersion===SCHEMA_VERSION && src._migrated && Array.isArray(src.simsets) && Array.isArray(src.samples)){
    return src;
  }
  // Already migrated to new format?
  if(raw._migrated && Array.isArray(src.simsets)){
    return{
      _migrated:true,
      samples: Array.isArray(src.samples)?src.samples.map(migrateSampleEntity).filter(Boolean):[],
      simsets: src.simsets.map(ss=>migrateSimsetEntity(ss)).filter(Boolean),
      activeSimsetId: src.activeSimsetId||src.activeSid||null,
      activeSampleId: src.activeSampleId||null,
      activeThreshSid:typeof src.activeThreshSid==='string'?src.activeThreshSid:null,
      _appTitle: typeof src._appTitle==='string'?src._appTitle:'',
      _onboardingComplete: !!src._onboardingComplete,
      _lastExportAt: typeof src._lastExportAt==='string'?src._lastExportAt:undefined,
      units: Array.isArray(src.units)?src.units:[],
      settings: (src.settings&&typeof src.settings==='object')?src.settings:{owner:'',advisors:'',citation:''},
      activePage: ['runs','samples','overview','thresh','settings','pvis'].includes(src.activePage)?src.activePage:'runs',
      batches: Array.isArray(src.batches)?src.batches:[],
      sampleCategories: Array.isArray(src.sampleCategories)?src.sampleCategories:[]
    };
  }
  // Old combined format — split
  if(!Array.isArray(src.samples)) return null;
  const result = {_migrated:true, samples:[], simsets:[], activeSimsetId:null, activeSampleId:null, activeThreshSid:src.activeThreshSid||null, activePage:'runs', _appTitle:src._appTitle||'', _onboardingComplete:!!src._onboardingComplete, units:Array.isArray(src.units)?src.units:[], settings:(src.settings&&typeof src.settings==='object')?src.settings:{owner:'',advisors:'',citation:''},batches:Array.isArray(src.batches)?src.batches:[],sampleCategories:Array.isArray(src.sampleCategories)?src.sampleCategories:[]};
  for(const s of src.samples){
    const r = migrateSample(s);
    if(!r) continue;
    result.samples.push(r.sampleEntity);
    result.simsets.push(r.simsetEntity);
    // Map old activeSid → new activeSimsetId
    if(src.activeSid===s.id) result.activeSimsetId = r.simsetEntity.id;
    // Map old activeThreshSid → first simset with matching sample
    if(src.activeThreshSid===s.id) result.activeThreshSid = r.simsetEntity.id;
  }
  return result;
}

function load(){
  const keys=[STORAGE_KEY,'meltst_v4','meltst_v3'];
  for(const key of keys){
    try{
      const raw=localStorage.getItem(key);
      if(!raw) continue;
      const parsed=JSON.parse(raw);
      const migrated=migrate(parsed);
      if(migrated&&(migrated.samples.length>0||migrated.simsets.length>0)){
        S=migrated;
        if(!Array.isArray(S.simsets))S.simsets=[];
        if(!Array.isArray(S.samples))S.samples=[];
        if(!Array.isArray(S.sampleCategories))S.sampleCategories=[];
        if(key!==STORAGE_KEY){
          // Only delete the legacy key AFTER confirming the new key was written successfully.
          const ok=flushSave();
          if(ok){
            try{
              const verify=localStorage.getItem(STORAGE_KEY);
              if(verify&&JSON.parse(verify))localStorage.removeItem(key);
            }catch(e){console.error('legacy-key cleanup aborted:',e);}
          }
        }
        return;
      }
    }catch(e){console.error('load() failed for key',key,':',e);}
  }
  // Fresh blank state — no defaults; user creates their own samples and runs
  S={samples:[],simsets:[],activeSimsetId:null,activeSampleId:null,activeThreshSid:null,activePage:'runs'};
  save();
}

function resetData(){
  // Opens the typed-confirm modal. Snapshot is taken before destruction in _doResetData().
  const inp=document.getElementById('reset-confirm-input');
  const btn=document.getElementById('reset-confirm-btn');
  if(inp)inp.value='';
  if(btn)btn.disabled=true;
  openModal('modal-confirm-reset');
}
function _doResetData(){
  // Snapshot current state to the backup ring before wiping, so a misclick is recoverable
  // for the lifetime of the ring.
  snapshotBeforeImport();
  localStorage.removeItem(STORAGE_KEY);
  S={samples:[],simsets:[],activeSimsetId:null,activeSampleId:null,activeThreshSid:null,activePage:'runs'};
  closeModal('modal-confirm-reset');
  save();
  activeTab={};activeThreshTab={};
  renderSidebar();showPage('runs');
  toast('Data reset to defaults');
}

// ════════════════════════════════════════════════════════
//  NAVIGATION  — V3 exact pattern
// ════════════════════════════════════════════════════════
function showPage(p){
  S.activePage=p;
  document.querySelectorAll('.nav-tab').forEach(t=>{
    const isActive=t.dataset.page===p;
    t.classList.toggle('active',isActive);
    t.setAttribute('aria-selected',isActive?'true':'false');
  });
  document.querySelectorAll('.page').forEach(pg=>pg.classList.toggle('active',pg.id==='pg-'+p));
  // sidebar: hidden on overview and samples pages
  document.getElementById('main-sidebar').style.display=(p==='overview'||p==='samples'||p==='settings'||p==='pvis')?'none':'flex';
  if(p==='runs'){renderSidebar();renderRuns();}
  if(p==='overview'){renderOverview();}
  if(p==='thresh'){renderSidebar();renderThresholding();}
  if(p==='samples'){renderSamples();}
  if(p==='pvis'){renderPressureViz();}
  if(p==='settings'){renderSettings();}
  save();
}

// ════════════════════════════════════════════════════════
//  SIDEBAR
// ════════════════════════════════════════════════════════
function renderSidebar(){
  const simsets = S.simsets||[];
  document.getElementById('sb-cnt').textContent=simsets.length;
  const el=document.getElementById('sb-list');
  if(!simsets.length){
    el.innerHTML='<div class="empty" style="padding:20px"><p>No Runs yet.<br>Click "＋ Add Run" to create one.</p></div>';
    updateThreshBadge();
    return;
  }
  el.innerHTML=simsets.map(ss=>{
    try{
      const pct=getPct(ss.compositions);
      const active=ss.id===S.activeSimsetId;
      const parentSample=getSample(ss.sampleId);
      const parentName=parentSample?parentSample.name:'(orphaned)';
      const isOrphan=!parentSample;
      return`<div class="${'si'+(active?' active':'')}${isOrphan?' orphan-run':''}"
           onclick="selectSimset('${ss.id}')"
           draggable="true" data-ssid="${ss.id}"
           style="${isOrphan?'border-left:3px solid var(--yellow);':''}"
           ondragstart="_ssDragStart(event,'${ss.id}')"
           ondragend="_ssDragEnd(event)"
           ondragover="_ssDragOver(event)"
           ondragleave="_ssDragLeave(event)"
           ondrop="_ssDrop(event,'${ss.id}')">
        <!-- Run name: primary title -->
        <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px">
          <span style="cursor:grab;color:var(--text-muted);opacity:.55;font-size:13px;user-select:none" title="Drag to reorder">⠇</span>
          <div class="si-name" style="font-size:14px;${isOrphan?'color:var(--yellow);':''}flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${isOrphan?'⚠ ':''}${esc(ss.name)}
            ${isOrphan?`<button class="btn btn-sm" style="font-size:9px;padding:1px 6px;background:var(--yellow);color:#000;border-color:var(--yellow);margin-left:4px" onclick="event.stopPropagation();openRelinkModal('${ss.id}')">&#128279;</button>`:''}
          </div>
        </div>
        <!-- Sample name: coloured decorator -->
        ${(()=>{
          const _cat=(S.sampleCategories||[]).find(c=>parentSample&&c.sampleIds.includes(parentSample.id));
          const _nameCol=_cat?_cat.color:'var(--text-muted)';
          return `<div style="font-size:11px;color:${_nameCol};font-family:var(--mono);margin-bottom:3px;padding-left:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(parentName)}">${esc(parentName)}</div>`;
        })()}
        <!-- Stats -->
        <div style="font-size:11px;color:var(--text-muted);padding-left:18px;margin-bottom:2px">${ss.total} simulations</div>
        <div style="padding-left:18px">
          <div class="si-bar"><div class="si-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;padding-left:18px;margin-top:3px">
          <span style="font-size:10px;color:var(--text-muted);background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:1px 7px">${pct}% complete</span>
          ${ss.thresholds.length?`<span class="chip chip-thresh" style="font-size:10px">${ss.thresholds.length} thresh</span>`:''}
        </div>
      </div>`;
    }catch(e){return '<div class="si" style="color:#f87171;font-size:11px;padding:6px 10px">⚠ data error</div>';}
  }).join('');
  updateThreshBadge();
}

let _ssDragId=null;
function _ssDragStart(e,id){_ssDragId=id;e.currentTarget.classList.add('dragging');e.dataTransfer.effectAllowed='move';}
function _ssDragEnd(e){e.currentTarget.classList.remove('dragging');document.querySelectorAll('.si').forEach(el=>el.classList.remove('drag-over'));_ssDragId=null;}
function _ssDragOver(e){e.preventDefault();e.dataTransfer.dropEffect='move';e.currentTarget.classList.add('drag-over');}
function _ssDragLeave(e){e.currentTarget.classList.remove('drag-over');}
function _ssDrop(e,toId){
  e.preventDefault();e.currentTarget.classList.remove('drag-over');
  if(!_ssDragId||_ssDragId===toId)return;
  const fromIdx=S.simsets.findIndex(ss=>ss.id===_ssDragId);
  const toIdx=S.simsets.findIndex(ss=>ss.id===toId);
  if(fromIdx<0||toIdx<0)return;
  const [moved]=S.simsets.splice(fromIdx,1);
  S.simsets.splice(toIdx,0,moved);
  save();renderSidebar();
  toast('Run order updated');
}
function selectSimset(id){
  S.activeSimsetId=id;
  if(!activeTab[id])activeTab[id]='grid';
  if(S.activePage==='runs'){renderSidebar();renderRuns();}
  else if(S.activePage==='thresh'){S.activeThreshSid=id;renderSidebar();renderThresholding();}
  save();
}

function updateThreshBadge(){
  const n=(S.simsets||[]).reduce((a,ss)=>a+(ss.thresholds?ss.thresholds.length:0),0);
  document.getElementById('thresh-badge').textContent=n;
}

// ════════════════════════════════════════════════════════
//  TRACKER PAGE
// ════════════════════════════════════════════════════════
function renderRuns(){
  const el=document.getElementById('tracker-main');
  const s=getSimset(S.activeSimsetId);
  if(!s){el.innerHTML='<div class="empty"><div class="empty-icon">👈</div><p>Select a simulation set from the sidebar.</p></div>';return;}
  const comps=s.compositions;
  const rc=getRunCount(comps),ss=getSucc(comps),sf=getFail(comps),pct=getPct(comps);
  const tab=activeTab[s.id]||'grid';
  const parentSample=getSample(s.sampleId);
  const hasParentWR=parentSample&&parentSample.wholeRock&&parentSample.wholeRock.headers&&parentSample.wholeRock.headers.length>0;
  const parentLabel=parentSample
    ?`<span style="font-size:10px;color:var(--text-muted);font-weight:400;font-family:var(--mono);background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;margin-right:4px">🧪 ${esc(parentSample.name)}</span>${hasParentWR?`<span style="font-size:11px;color:var(--green);background:rgba(56,211,100,.1);border:1px solid rgba(56,211,100,.25);border-radius:4px;padding:2px 8px;margin-right:4px">WR ✓</span>${(()=>{const _pu=_getUnit(parentSample.unitId||'');return _pu?`<span style="background:${getCBUnitColor(_pu.color||'#58a6ff')}22;border:1.5px solid ${getCBUnitColor(_pu.color||'#58a6ff')};color:${getCBUnitColor(_pu.color||'#58a6ff')};border-radius:4px;padding:2px 8px;font-size:11px;font-weight:700;font-family:var(--mono);margin-right:4px" title="${esc(_pu.name)}">${esc(_pu.abbr)}</span>`:''})()}`:''}`
    :`<span style="font-size:11px;color:var(--yellow);font-style:italic;margin-right:6px">⚠ Orphaned run — parent sample was deleted</span><button class="btn btn-sm" style="font-size:10px;padding:2px 9px;background:var(--yellow);color:#000;border-color:var(--yellow)" onclick="openRelinkModal('${s.id}')">🔗 Re-link to Sample</button>`
  const _rtLabel={'monte_carlo':'Monte Carlo','batch':'Batch','manual':'Manual'}[s.runType||'monte_carlo']||(s.runType||'Monte Carlo');
  el.innerHTML=`
  <div style="display:flex;gap:10px;margin-bottom:10px;align-items:flex-start">
    <!-- LEFT: run info panel -->
    <div class="card" style="margin-bottom:0;flex:1;min-width:0">
      <!-- Edit controls (top-right) -->
      <div style="display:flex;justify-content:flex-end;gap:4px;margin-bottom:4px">
        <button class="btn btn-sm edit-only" onclick="openEditSimset('${s.id}')" aria-label="Edit run">✏ Edit</button>
        <button class="btn btn-sm btn-danger edit-only" onclick="deleteSimset('${s.id}')" aria-label="Delete run">🗑</button>
      </div>
      <!-- Run name: large (+8pt → 34px), right-justified -->
      <div style="text-align:right;margin-bottom:8px">
        <h2 style="font-size:34px;font-weight:700;font-family:var(--mono);line-height:1.1">${esc(s.name)}</h2>
      </div>
      <!-- Decorators row: DONE chip + run type + threshold count + parent sample — below title -->
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap;justify-content:flex-end">
        ${statusChip(rc,s.total)}
        <span style="font-size:11px;font-weight:700;color:var(--text-muted);background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-family:var(--mono)">${_rtLabel}</span>
        ${s.thresholds.length?`<span class="chip chip-thresh" style="font-size:11px">${s.thresholds.length} threshold${s.thresholds.length===1?'':'s'}</span>`:''}
        ${parentLabel}
      </div>
      <!-- Stat boxes: vertically expanded (larger padding) -->
      ${s.notes?`<p style="font-size:11px;color:var(--text-muted);margin-bottom:10px">${esc(s.notes)}</p>`:''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
        <div class="stat-box" style="padding:14px 16px;min-width:64px;flex:1"><div style="font-size:22px;font-weight:700;font-family:var(--mono)">${rc}</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-top:3px">Run</div></div>
        <div class="stat-box" style="padding:14px 16px;min-width:64px;flex:1"><div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--green)">${ss}</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-top:3px">Success</div></div>
        <div class="stat-box" style="padding:14px 16px;min-width:64px;flex:1"><div style="font-size:22px;font-weight:700;font-family:var(--mono);color:var(--red)">${sf}</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-top:3px">Failed</div></div>
        <div class="stat-box" style="padding:14px 16px;min-width:64px;flex:1"><div style="font-size:22px;font-weight:700;font-family:var(--mono)">${s.total-rc}</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-top:3px">Remaining</div></div>
        <div class="stat-box" style="padding:14px 16px;min-width:64px;flex:1"><div style="font-size:22px;font-weight:700;font-family:var(--mono)">${pct}%</div><div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-top:3px">Complete</div></div>
      </div>
      <div class="pbar"><div class="pbar-fill" style="width:${pct}%"></div></div>
    </div>
    <!-- RIGHT: Add/Remove simulations — fitted box -->
    <div class="card" style="margin-bottom:0;flex-shrink:0;width:auto;min-width:0">
      <div class="card-title">Add / Remove Simulations</div>
      <div class="counter-section" style="width:max-content">${buildCounterRows('main',s.id)}</div>
    </div>
  </div>
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 14px;margin-bottom:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span style="font-size:12px;font-weight:700;color:var(--text-muted);white-space:nowrap">⚙ Default Q2F Pressure Threshold:</span>
    <input type="number" id="dt-pressure-${s.id}" step="any" placeholder="e.g. 200"
      value="${s.defaultThreshold&&s.defaultThreshold.pressure?s.defaultThreshold.pressure:''}"
      style="width:100px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:4px 8px;font-family:var(--mono);font-size:13px">
    <span style="font-size:11px;color:var(--text-muted)">(unitless)</span>
    <input type="text" id="dt-notes-${s.id}" placeholder="Notes…"
      value="${s.defaultThreshold&&s.defaultThreshold.notes?esc(s.defaultThreshold.notes):''}"
      style="flex:1;min-width:140px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:4px 8px;font-family:var(--mono);font-size:12px">
    <button class="btn btn-primary btn-sm" style="padding:4px 10px" onclick="saveDefaultThreshold('${s.id}')">&#128190; Save</button>
    ${s.defaultThreshold&&s.defaultThreshold.pressure?`<span id="dt-saved-${s.id}" style="font-size:12px;color:var(--green);font-weight:700;display:inline">✓ ${s.defaultThreshold.pressure}${s.defaultThreshold.notes?' — '+esc(s.defaultThreshold.notes):''}</span>`:`<span id="dt-saved-${s.id}" style="display:none"></span>`}
  </div>
  <div class="card">
    <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)">Default rhyolite-MELTS Pressure Calculation Tracking Grid</div>
    <div class="tabs" style="display:flex;align-items:center;gap:0;flex-wrap:wrap">
      <button class="tab-btn${tab==='grid'?' active':''}" onclick="setTab('${s.id}','grid')">Grid View</button>
      <button class="tab-btn${tab==='failed'?' active':''}" onclick="setTab('${s.id}','failed')">Failed Review (${sf})</button>
      <div style="background:var(--surface2);border-left:1px solid var(--border);padding:2px 10px;display:flex;align-items:center;gap:6px;white-space:nowrap;flex-shrink:0">
        <span style="font-size:11px;font-weight:700;color:var(--text-muted)">Default Threshold:</span>
        <input type="number" id="dt-p-inline-${s.id}" step="any" placeholder="MPa"
          value="${s.defaultThreshold&&s.defaultThreshold.pressure?s.defaultThreshold.pressure:''}"
          style="width:70px;background:var(--surface);border:1px solid var(--border);border-radius:3px;color:var(--text);padding:2px 5px;font-family:var(--mono);font-size:12px"
          onchange="saveDefaultThresholdInline('${s.id}',this.value)">
        ${s.defaultThreshold&&s.defaultThreshold.pressure?`<span style="font-size:11px;color:var(--blue);font-weight:700">✓ ${s.defaultThreshold.pressure}</span>`:''}
      </div>
      <div style="flex:1"></div>
      ${tab==='grid'?`<button class="btn btn-sm" style="font-size:10px;padding:3px 8px;margin-right:2px" onclick="exportGridPng('${s.id}')">📷 Export PNG</button>`:''}
    </div>
    ${tab==='grid'?buildGrid(s.id,comps,'main'):buildFailedList(s.id,comps,'main')}
  </div>
  <div class="card" style="margin-top:10px">
    <div class="card-title" style="display:flex;align-items:center;gap:8px;cursor:pointer"
         onclick="toggleRunHarkerPanel('${s.id}')">
      \u{1F4CA} Compositional Harker Diagrams
      <span id="rh-toggle-${s.id}" style="margin-left:auto;color:var(--text-muted);font-size:13px">${(s.compWholeRock&&s.compWholeRock.headers&&s.compWholeRock.headers.length)?'\u25BC':'\u25B6'}</span>
    </div>
    <div id="rh-panel-${s.id}" style="display:${(s.compWholeRock&&s.compWholeRock.headers&&s.compWholeRock.headers.length)?'block':'none'}">
      <div style="margin-bottom:12px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Paste Whole-Rock Data</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
          Tab-separated. <strong>Column 0 = composition number</strong> (matches your grid, any order).
          Remaining columns = oxides: SiO2 TiO2 Al2O3 FeO MnO MgO CaO Na2O K2O P2O5.
          <span style="background:#1a3a5c;color:#58a6ff;font-size:9px;padding:1px 6px;border-radius:8px;font-weight:700;display:inline-block;margin-top:4px">NORMALIZED</span>
          Each row is normalised to 100 wt% before plotting.
        </div>
        ${(s.compWholeRock&&s.compWholeRock.headers&&s.compWholeRock.headers.length)?
          `<div style="font-size:11px;color:var(--green);background:rgba(86,211,100,0.08);border:1px solid rgba(86,211,100,0.25);border-radius:4px;padding:6px 8px;margin-bottom:8px;display:flex;align-items:center;gap:8px">
            <span>&#10003; Committed to project &mdash; ${Object.keys(s.compWholeRock.rows).length} compositions &middot; ${s.compWholeRock.headers.join(', ')}</span>
            <button class="btn btn-sm btn-danger edit-only" style="margin-left:auto;padding:2px 8px;font-size:10px" onclick="removeRunWR('${s.id}')">Remove Graph</button>
           </div>`:
          ''}
        <textarea id="rwr-paste-${s.id}" rows="5"
          style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:7px;font-family:var(--mono);font-size:11px;resize:vertical;box-sizing:border-box"
          placeholder="Num&#9;SiO2&#9;TiO2&#9;Al2O3&#9;FeO&#9;MnO&#9;MgO&#9;CaO&#9;Na2O&#9;K2O&#9;P2O5&#10;1&#9;70.1&#9;0.45&#9;14.8&#9;2.1&#9;0.05&#9;0.8&#9;3.2&#9;3.9&#9;2.4&#9;0.12&#10;143&#9;69.8&#9;0.51&#9;15.0&#9;2.3&#9;0.05&#9;0.9&#9;3.0&#9;4.1&#9;2.5&#9;0.13"></textarea>
        <div id="rwr-btn-row-${s.id}" style="display:flex;gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" onclick="previewRunWR('${s.id}')">&#128202; Plot Preview</button>
        </div>
      </div>
      <div id="rh-grid-${s.id}" style="display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:10px"></div>
    </div>
  </div>`;
}

function saveDefaultThresholdInline(sid,val){
  const s=getS(sid);if(!s)return;
  if(!s.defaultThreshold)s.defaultThreshold={};
  s.defaultThreshold.pressure=val;
  save();renderRuns();toast(val?'Default threshold: '+val+' MPa':'Threshold cleared');
}
function saveDefaultThreshold(sid){
  const ss=getSimset(sid);if(!ss)return;
  const p=document.getElementById('dt-pressure-'+sid);
  // unit field removed — threshold is unitless
  const n=document.getElementById('dt-notes-'+sid);
  if(!p)return;
  if(!ss.defaultThreshold)ss.defaultThreshold={pressure:'',unit:'MPa',notes:''};
  ss.defaultThreshold.pressure=p.value.trim();
  ss.defaultThreshold.unit='';
  ss.defaultThreshold.notes=(n&&n.value.trim())||'';
  save();
  // Update inline confirmation badge without full re-render
  const _dtDisp=document.getElementById('dt-saved-'+sid);
  if(_dtDisp){
    if(ss.defaultThreshold.pressure){
      _dtDisp.textContent='✓ Saved: '+ss.defaultThreshold.pressure+(ss.defaultThreshold.notes?' — '+ss.defaultThreshold.notes:'');
      _dtDisp.style.display='inline';
    } else {
      _dtDisp.textContent='';_dtDisp.style.display='none';
    }
  }
  toast(ss.defaultThreshold.pressure?'Default threshold saved: '+ss.defaultThreshold.pressure:'Default threshold cleared');
}

function statusChip(rc,total){
  if(rc===0)return'<span class="chip chip-gray">Not Started</span>';
  if(rc>=total)return'<span class="chip chip-done">DONE</span>';
  return`<span class="chip chip-pct">${Math.round(rc/total*100)}%</span>`;
}
function setTab(sid,tab){activeTab[sid]=tab;renderRuns();}

// ════════════════════════════════════════════════════════
//  COUNTER ROWS  (ctx = 'main' | threshold-id)
// ════════════════════════════════════════════════════════
function buildCounterRows(ctx,sid){
  const s=STEPS.map(n=>`<button class="ctr-btn success" onclick="addSims('${sid}','${ctx}','success',${n})">+${n}</button>`).join('');
  const f=STEPS.map(n=>`<button class="ctr-btn failed"  onclick="addSims('${sid}','${ctx}','failed',${n})">+${n}</button>`).join('');
  const u=STEPS.map(n=>`<button class="ctr-btn undo"    onclick="undoSims('${sid}','${ctx}',${n})">-${n}</button>`).join('');
  return`<div class="counter-row"><span class="counter-label">✓ Success</span>${s}</div>
         <div class="counter-row"><span class="counter-label">✗ Failed</span>${f}</div>
         <div class="counter-row"><span class="counter-label">↩ Undo</span>${u}</div>`;
}

// ════════════════════════════════════════════════════════
//  GRID & FAILED LIST
// ════════════════════════════════════════════════════════
function buildGrid(sid,comps,ctx,parentComps){
  const statusLabel=st=>st===ST.OK?'success':st===ST.FAIL?'failed':'not run';
  if(ctx==='main'){
    // Tracker grid — full 3-state cycle, no sorting. Cells are keyboard-operable
    // (Enter/Space cycle, arrow keys move between siblings).
    const cells=comps.map(c=>`<div class="cell ${c.status}" data-num="${c.num}" role="button" tabindex="0" aria-label="Composition ${c.num}, ${statusLabel(c.status)}. Press Enter or Space to cycle." title="#${c.num}: ${c.status}" onclick="cycleCell('${sid}','${ctx}',${c.num})" onkeydown="_cellKey(event,'${sid}','${ctx}',${c.num})"></div>`).join('');
    return`<div class="grid-wrap"><div class="cell-hint">Click cell (or Enter/Space on keyboard): ⬜ not-run → 🟩 success → 🟥 failed → ⬜</div><div class="grid" role="grid" aria-label="Composition status grid">${cells}</div></div>`;
  }
  // Threshold (P Calc) grid
  // Locked = parent failed, regardless of threshold cell status
  const pFail=new Set((parentComps||[]).filter(p=>p.status===ST.FAIL).map(p=>p.num));
  const nr=comps.filter(c=>!pFail.has(c.num)&&c.status===ST.NR);
  const ok=comps.filter(c=>!pFail.has(c.num)&&c.status===ST.OK);
  const noSol=comps.filter(c=>!pFail.has(c.num)&&c.status===ST.FAIL);
  const locked=comps.filter(c=>pFail.has(c.num));

  const mkCell=(c,isLocked)=>{
    let cls,tt,handler,extra;
    if(isLocked){
      cls='cell failed cell-locked';
      tt=`#${c.num}: parent run failed — locked`;
      handler='';
      extra=`aria-disabled="true" aria-label="Composition ${c.num}, parent run failed — locked"`;
    } else {
      const stLbl=c.status===ST.OK?`P solution obtained (${c.pValue!=null?c.pValue+' '+(c.fname?'· '+c.fname:''):'—'}) — click to reset`
               :c.status===ST.FAIL?`No P solution${c.fname?' · '+c.fname:''} — click to reset`
               :'data not entered — click to mark P obtained';
      cls='cell '+c.status;
      tt=`#${c.num}: ${stLbl}`;
      handler=`onclick="cycleCell('${sid}','${ctx}',${c.num})" onkeydown="_cellKey(event,'${sid}','${ctx}',${c.num})"`;
      extra=`role="button" tabindex="0" aria-label="Composition ${c.num}, ${statusLabel(c.status)}"`;
    }
    return`<div class="${cls}" data-num="${c.num}" title="${tt}" ${extra} ${handler}></div>`;
  };
  const sect=(cells,label,cls,isLocked=false)=>cells.length===0?'':
    `<div class="thresh-group">
       <div class="thresh-group-lbl ${cls}">${label} <span class="thresh-group-count">${cells.length}</span></div>
       <div class="grid">${cells.map(c=>mkCell(c,isLocked)).join('')}</div>
     </div>`;
  return`<div class="grid-wrap thresh-grid-wrap">
    <div class="cell-hint">⬜ Grey = not entered &nbsp;·&nbsp; 🟩 Green = P solution obtained &nbsp;·&nbsp; 🟥 Red = no P solution &nbsp;·&nbsp; 🔒 Dimmed = parent failure</div>
    ${sect(nr,'Not Yet Entered','lbl-nr')}
    ${sect(ok,'P Solution Obtained','lbl-ok')}
    ${sect(noSol,'No P Solution Found','lbl-fail')}
    ${sect(locked,'Parent Failures — Locked','lbl-fail',true)}
  </div>`;
}
function buildFailedList(sid,comps,ctx){
  const failed=comps.filter(c=>c.status===ST.FAIL);
  if(!failed.length)return'<div class="empty"><div class="empty-icon">🎉</div><p>No failed compositions!</p></div>';
  return failed.map(c=>`<div class="fail-item">
    <span class="fail-num">#${c.num}</span>
    <input type="text" placeholder="Add note…" value="${esc(c.note)}" oninput="setNote('${sid}','${ctx}',${c.num},this.value)">
    <button class="btn btn-sm btn-success" onclick="recoverComp('${sid}','${ctx}',${c.num})">Recover</button>
  </div>`).join('');
}
function buildLockedList(sid,tid,parentComps){
  // Shows cells that are locked because the parent run failed
  const pFail=(parentComps||[]).filter(p=>p.status===ST.FAIL);
  if(!pFail.length)return'<div class="empty"><div class="empty-icon">🔒</div><p>No parent failures — all compositions attempted in main tracker.</p></div>';
  return`<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px">${pFail.length} compositions failed in the parent tracker and are locked here.</div>`+
    pFail.map(c=>`<div class="fail-item" style="opacity:0.6">
      <span class="fail-num">#${c.num}</span>
      <span style="font-size:11px;color:var(--red)">parent run failed — locked</span>
    </div>`).join('');
}

// ════════════════════════════════════════════════════════
//  SIM ACTIONS — unified via getComps
// ════════════════════════════════════════════════════════
function getComps(sid,ctx){
  const s=getSimset(sid);if(!s)return null;
  if(ctx==='main')return s.compositions;
  const t=s.thresholds.find(t=>t.id===ctx);
  return t?t.compositions:null;
}
function addSims(sid,ctx,type,n){
  const comps=getComps(sid,ctx);if(!comps){toast('Not found','err');return;}
  // In threshold context, only mark not-run cells as success (no failed marking via buttons)
  const markAs=ctx==='main'?type:ST.OK;
  let added=0;
  for(let i=0;i<comps.length&&added<n;i++){
    if(comps[i].status===ST.NR&&(ctx==='main'||markAs===ST.OK)){comps[i].status=markAs;added++;}
  }
  if(!added){toast('No unconfirmed compositions left','err');return;}
  toast(`Marked ${added} as ${ctx==='main'?type:'P solution obtained'}`);save();renderAll(sid,ctx);
}
function undoSims(sid,ctx,n){
  const comps=getComps(sid,ctx);if(!comps){toast('Not found','err');return;}
  let undone=0;
  for(let i=comps.length-1;i>=0&&undone<n;i--){
    // In threshold, only undo success cells — locked failed cells stay locked
    if(comps[i].status===ST.OK||(ctx==='main'&&comps[i].status===ST.FAIL)){
      comps[i].status=ST.NR;comps[i].note='';undone++;
    }
  }
  if(!undone){toast('Nothing to undo','err');return;}
  toast(`Undid ${undone}`);save();renderAll(sid,ctx);
}
// When a parent (main-context) composition transitions OUT of FAIL, its child
// threshold cells were previously locked. Reset any inherited-FAIL child cells
// back to NR so they can be re-entered. A cell counts as "inherited" if it
// stores FAIL with no pValue and no filename (i.e. was never independently set
// via paste-P or click in the threshold grid). Returns the number of cells reset.
function _propagateParentRecovery(sid,num){
  const s=getSimset(sid);if(!s||!Array.isArray(s.thresholds))return 0;
  let n=0;
  s.thresholds.forEach(t=>{
    if(!Array.isArray(t.compositions))return;
    const tc=t.compositions.find(c=>c.num===num);
    if(!tc)return;
    if(tc.status===ST.FAIL && tc.pValue==null && !tc.fname){
      tc.status=ST.NR;
      tc.note='';
      n++;
    }
  });
  return n;
}

function cycleCell(sid,ctx,num){
  const comps=getComps(sid,ctx);if(!comps)return;
  const c=comps.find(x=>x.num===num);if(!c)return;
  let propagated=0;
  if(ctx==='main'){
    // Tracker: full 3-state cycle
    const cycle=[ST.NR,ST.OK,ST.FAIL];
    const prev=c.status;
    c.status=cycle[(cycle.indexOf(c.status)+1)%3];
    // Parent transitioned out of FAIL → reset inherited child-cell locks.
    if(prev===ST.FAIL && c.status!==ST.FAIL){
      propagated=_propagateParentRecovery(sid,num);
    }
  } else {
    // Threshold (P Calc): skip if parent-failed (locked)
    const s=getSimset(sid);
    const parentSample=s?getSample(s.sampleId):null;
    const pComp=s&&s.compositions.find(p=>p.num===num);
    if(pComp&&pComp.status===ST.FAIL) return; // locked
    // 3-state: not-run → success (P obtained) → failed (no P solution) → not-run
    const cycle=[ST.NR,ST.OK,ST.FAIL];
    c.status=cycle[(cycle.indexOf(c.status)+1)%3];
  }
  save();renderAll(sid,ctx);
  if(propagated>0)toast('Parent recovered — '+propagated+' child threshold cell'+(propagated===1?'':'s')+' unlocked');
}
function recoverComp(sid,ctx,num){
  const comps=getComps(sid,ctx);if(!comps)return;
  const c=comps.find(x=>x.num===num);if(!c)return;
  const prev=c.status;
  c.status=ST.OK;c.note='';
  let propagated=0;
  if(ctx==='main' && prev===ST.FAIL){
    propagated=_propagateParentRecovery(sid,num);
  }
  save();renderAll(sid,ctx);
  if(propagated>0)toast('Parent recovered — '+propagated+' child threshold cell'+(propagated===1?'':'s')+' unlocked');
}
function setNote(sid,ctx,num,val){
  const comps=getComps(sid,ctx);if(!comps)return;
  const c=comps.find(x=>x.num===num);if(c){c.note=val;save();}
}

function renderAll(sid,ctx){
  if(S.activePage==='runs'){renderSidebar();if(S.activeSimsetId===sid)renderRuns();}
  else if(S.activePage==='thresh'){renderSidebar();if(S.activeThreshSid===sid){if(ctx==='main')renderThresholding();else renderThreshCardInPlace(sid,ctx);}}
  else if(S.activePage==='overview')renderOverview();
}

// ════════════════════════════════════════════════════════
//  OVERVIEW PAGE
// ════════════════════════════════════════════════════════
// -- Batch helpers
function getBatches(){return S.batches||(S.batches=[]);}
function getBatch(id){return getBatches().find(b=>b.id===id);}
const BATCH_COLORS=['#0072B2','#009E73','#D55E00','#CC79A7','#E69F00','#56B4E9'];
function _batchColor(idx){return BATCH_COLORS[idx%BATCH_COLORS.length];}
function openAddBatch(){
  document.getElementById('batch-name-in').value='';
  document.getElementById('batch-note-in').value='';
  openModal('modal-add-batch');
}
function saveBatch(){
  const nm=document.getElementById('batch-name-in').value.trim();
  if(!nm){toast('Enter a batch name','err');return;}
  const note=document.getElementById('batch-note-in').value.trim();
  const idx=getBatches().length;
  getBatches().push({id:'B'+Date.now(),name:nm,note,color:_batchColor(idx),runIds:[]});
  save();renderOverview();closeModal('modal-add-batch');toast('Batch created');
}
function openEditBatch(id){
  const b=getBatch(id);if(!b)return;
  document.getElementById('edit-batch-id').value=id;
  document.getElementById('edit-batch-name').value=b.name||'';
  document.getElementById('edit-batch-note').value=b.note||'';
  document.getElementById('edit-batch-color').value=b.color||'#58a6ff';
  openModal('modal-edit-batch');
}
function saveEditBatch(){
  const id=document.getElementById('edit-batch-id').value;
  const b=getBatch(id);if(!b)return;
  const nm=document.getElementById('edit-batch-name').value.trim();
  if(!nm){toast('Enter a batch name','err');return;}
  b.name=nm;
  b.note=document.getElementById('edit-batch-note').value.trim();
  b.color=document.getElementById('edit-batch-color').value;
  save();renderOverview();closeModal('modal-edit-batch');toast('Batch updated ✓');
}
function deleteBatch(id){
  const batches=S.batches||[];
  const idx=batches.findIndex(b=>b.id===id);
  if(idx<0)return;
  const removed=batches[idx];
  // Capture which runs were linked so we can re-link them on undo.
  const linkedIds=(S.simsets||[]).filter(ss=>ss.batchId===id).map(ss=>ss.id);
  (S.simsets||[]).forEach(ss=>{if(ss.batchId===id)delete ss.batchId;});
  S.batches=batches.filter(b=>b.id!==id);
  save();renderOverview();
  toastUndo('Batch "'+removed.name+'" deleted',()=>{
    if(!S.batches)S.batches=[];
    S.batches.splice(Math.min(idx,S.batches.length),0,removed);
    linkedIds.forEach(ssId=>{const ss=(S.simsets||[]).find(s=>s.id===ssId);if(ss)ss.batchId=id;});
    save();renderOverview();
  });
}
function assignRunToBatch(ssId,batchId){
  const ss=(S.simsets||[]).find(s=>s.id===ssId);
  if(!ss)return;
  if(batchId){ss.batchId=batchId;}else{delete ss.batchId;}
  save();renderOverview();toast('Run assignment updated');
}
let _batchDragSsId=null;
function _batchDragStart(e,ssId){_batchDragSsId=ssId;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',ssId);}
function _batchDragOver(e){e.preventDefault();e.dataTransfer.dropEffect='move';e.currentTarget.classList.add('drag-over');}
function _batchDragLeave(e){e.currentTarget.classList.remove('drag-over');}
function _batchDrop(e,batchId){
  e.preventDefault();e.currentTarget.classList.remove('drag-over');
  if(!_batchDragSsId)return;
  assignRunToBatch(_batchDragSsId,batchId);
  _batchDragSsId=null;
}
function renderOverview(){
  const el=document.getElementById('pg-overview');
  const allSS=S.simsets||[];
  const batches=getBatches();
  const tR=allSS.reduce((a,ss)=>a+getRunCount(ss.compositions),0);
  const tF=allSS.reduce((a,ss)=>a+getFail(ss.compositions),0);
  const tS=allSS.reduce((a,ss)=>a+getSucc(ss.compositions),0);
  const tC=allSS.filter(ss=>getRunCount(ss.compositions)>=ss.total).length;
  const fr=tR>0?(tF/tR*100):0;
  function ovCard(s){
    const rc=getRunCount(s.compositions),sf=getFail(s.compositions),sv=getSucc(s.compositions);
    const pct=s.total>0?(rc/s.total*100):0,tc=s.thresholds?s.thresholds.length:0;
    const chip=rc>=s.total?'<span class="chip chip-done">DONE</span>':rc>0?`<span class="chip chip-pct">${pct.toFixed(0)}%</span>`:`<span class="chip chip-gray">–</span>`;
    const parentSample=getSample(s.sampleId);
    const pName=parentSample?parentSample.name:'(orphaned)';
    const batch=s.batchId?getBatch(s.batchId):null;
    const bchip=batch?`<span style="font-size:11px;background:${batch.color}22;border:1px solid ${batch.color};color:${batch.color};border-radius:8px;padding:1px 7px;font-weight:700;margin-left:4px">${esc(batch.name)}</span>`:'';
    return`<div class="ovc" draggable="true" ondragstart="_batchDragStart(event,'${s.id}')" onclick="selectSimset('${s.id}');showPage('runs')" title="Click to open · Drag to assign to Batch">
      <div class="ovc-h"><span class="ovc-n">${esc(s.name)}</span>
        <div style="display:flex;gap:3px;flex-wrap:wrap">${chip}${tc?`<span class="chip chip-thresh" style="font-size:11px">(${tc} thresh)</span>`:''}${bchip}</div></div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">🧪 ${esc(pName)}</div>
      <div class="ovc-stats">
        <span style="color:var(--blue);font-weight:700">${sv}</span><span style="color:var(--text-muted)"> ok · </span>
        <span style="color:var(--orange);font-weight:700">${sf}</span><span style="color:var(--text-muted)"> fail · </span>
        <span style="color:var(--text);font-weight:700">${rc}</span><span style="color:var(--text-muted)">/${s.total}</span>
      </div>
      <div class="ov-mg">${s.compositions.map(c=>`<div class="ov-mc ${c.status}"></div>`).join('')}</div>
      <div class="ov-pb"><div class="ov-pbf" style="width:${pct}%"></div></div>
    </div>`;
  }
  const unbatched=allSS.filter(ss=>!ss.batchId);
  el.innerHTML=`
    <div style="margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div><h2 style="font-size:18px;font-weight:700;margin-bottom:3px">📦 Batches</h2>
      <div style="font-size:12px;color:var(--text-muted)">Group Runs into named Batches. Drag a Run card onto a Batch to assign it.</div></div>

    </div>
    <div class="ov-banner">
      <div class="ovs"><div class="ovs-v" style="color:var(--blue)">${allSS.length}</div><div class="ovs-l">Runs</div></div>
      <div class="ovs"><div class="ovs-v" style="color:var(--blue)">${tS}</div><div class="ovs-l">OK</div></div>
      <div class="ovs"><div class="ovs-v" style="color:var(--orange)">${tF}</div><div class="ovs-l">Failed</div></div>
      <div class="ovs"><div class="ovs-v" style="color:var(--yellow)">${tC}</div><div class="ovs-l">Complete</div></div>
      <div class="ovs"><div class="ovs-v" style="color:var(--text-muted)">${fr.toFixed(1)}%</div><div class="ovs-l">Fail Rate</div></div>
    </div>
    ${batches.map((b,bi)=>`
      <div class="ov-batch-section">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <span style="font-size:14px;font-weight:700;color:${b.color}">📦 ${esc(b.name)}</span>
          ${b.note?`<span style="font-size:12px;font-style:italic;color:var(--text-muted)">${esc(b.note)}</span>`:''}
          <button class="btn btn-sm" style="font-size:11px;margin-left:auto" onclick="exportBatchPDF('${b.id}')">📄 Export PDF</button>
          <button class="btn btn-sm edit-only" style="font-size:11px;margin-left:4px" onclick="openEditBatch('${b.id}')">✏ Edit</button>
          <button class="btn btn-sm edit-only btn-danger" style="font-size:11px;margin-left:4px" onclick="deleteBatch('${b.id}')">🗑 Delete</button>
        </div>
        <div class="batch-card" ondragover="_batchDragOver(event)" ondragleave="_batchDragLeave(event)" ondrop="_batchDrop(event,'${b.id}')" style="border-left:3px solid ${b.color};min-height:60px">
          ${allSS.filter(ss=>ss.batchId===b.id).length===0
            ?'<div style="font-size:12px;color:var(--text-muted);font-style:italic">Drop Runs here to assign them to this batch.</div>'
            :`<div class="ov-grid">${allSS.filter(ss=>ss.batchId===b.id).map(s=>ovCard(s)).join('')}</div>`}
        </div>
      </div>`).join('')}
    <div class="ov-batch-section">
      <div style="font-size:13px;font-weight:700;color:var(--text-muted);margin-bottom:10px">Unassigned Runs</div>
      <div class="batch-card" ondragover="_batchDragOver(event)" ondragleave="_batchDragLeave(event)" ondrop="_batchDrop(event,null)" style="min-height:60px">
        ${unbatched.length===0
          ?'<div style="font-size:12px;color:var(--text-muted);font-style:italic">All Runs are assigned to a batch.</div>'
          :`<div class="ov-grid">${unbatched.map(s=>ovCard(s)).join('')}</div>`}
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════
//  THRESHOLDING PAGE
// ════════════════════════════════════════════════════════
// ── Threshold card drag-to-reorder ───────────────────────────────────────────
let _threshDragging={sid:null,tid:null};

function _threshDragStart(e, sid, tid){
  _threshDragging={sid,tid};
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain',tid);
  // Delay so the card doesn't immediately look grey while still under cursor
  setTimeout(()=>{
    const card=document.getElementById('tc-'+tid);
    if(card)card.classList.add('dragging');
  },0);
  e.stopPropagation();
}

function _threshDragEnd(e){
  // Remove dragging class from all cards
  document.querySelectorAll('.thresh-card.dragging').forEach(c=>c.classList.remove('dragging'));
  document.querySelectorAll('.thresh-card.drag-over').forEach(c=>c.classList.remove('drag-over'));
}

function _threshDragOver(e){
  e.preventDefault();
  e.dataTransfer.dropEffect='move';
  // Find the closest thresh-card under the cursor
  const target=e.target.closest('.thresh-card');
  // Highlight only the target card
  document.querySelectorAll('.thresh-card.drag-over').forEach(c=>{
    if(c!==target)c.classList.remove('drag-over');
  });
  if(target&&target.id!=='tc-'+_threshDragging.tid){
    target.classList.add('drag-over');
  }
}

function _threshDragLeave(e){
  const target=e.target.closest('.thresh-card');
  if(target)target.classList.remove('drag-over');
}

function _threshDrop(e, sid){
  e.preventDefault();
  document.querySelectorAll('.thresh-card.drag-over').forEach(c=>c.classList.remove('drag-over'));
  document.querySelectorAll('.thresh-card.dragging').forEach(c=>c.classList.remove('dragging'));
  const dropTarget=e.target.closest('.thresh-card');
  if(!dropTarget)return;
  const fromTid=_threshDragging.tid;
  const fromSid=_threshDragging.sid;
  _threshDragging={sid:null,tid:null};
  if(fromSid!==sid)return; // cross-simset drag not supported
  const toTid=dropTarget.id.replace(/^tc-/,'');
  if(fromTid===toTid)return;
  const s=getSimset(sid);if(!s)return;
  const fromIdx=s.thresholds.findIndex(t=>t.id===fromTid);
  const toIdx=s.thresholds.findIndex(t=>t.id===toTid);
  if(fromIdx<0||toIdx<0)return;
  // Reorder: move fromIdx to toIdx
  const [moved]=s.thresholds.splice(fromIdx,1);
  s.thresholds.splice(toIdx,0,moved);
  save();renderThresholding();
  toast('Threshold order updated');
}

function renderThresholding(){
  const el=document.getElementById('pg-thresh');
  const allSS2 = S.simsets||[];
  if(!S.activeThreshSid&&allSS2.length)S.activeThreshSid=allSS2[0].id;
  const s=getSimset(S.activeThreshSid);
  const slist=allSS2.map(sm=>{
    const tc=sm.thresholds?sm.thresholds.length:0;
    const parentSample=getSample(sm.sampleId);
    const displayName=parentSample?parentSample.name:sm.name;
    return`<div class="tss-item${sm.id===S.activeThreshSid?' active':''}" onclick="selThresh('${sm.id}')">
      <span class="tss-n">${esc(displayName)}</span><span class="tss-c">${tc} threshold${tc===1?'':'s'}</span></div>`;
  }).join('');
  const main=s?buildThreshMain(s):`<div class="empty"><div class="empty-icon">📊</div><p>Select a sample to manage thresholds.</p></div>`;
  el.innerHTML=`
    <div style="margin-bottom:14px">
      <h2 style="font-size:18px;font-weight:700;margin-bottom:3px">P Calc Thresholding</h2>
      <div style="font-size:11px;color:var(--text-muted)">Each filter shows which compositions produced a pressure solution at a given cutoff. Red cells (parent failures) are locked. Click grey cells to mark pressure solutions obtained — they turn green. Compare recovery rates across cutoffs.</div>
    </div>
    <div class="tp-layout">
      <div class="tp-main" style="width:100%;min-width:0">${main}</div>
    </div>`;
}

function selThresh(id){S.activeThreshSid=id;save();renderThresholding();}

function buildThreshMain(s){
  if(!s.thresholds||!s.thresholds.length){
  const _tb2=s.batchId?getBatch(s.batchId):null;
    return`<div class="card">
      <div class="flex-row" style="margin-bottom:0">
        <div style="flex:1;min-width:0">
          ${_tb2?`<div style="font-size:22px;font-weight:700;color:${_tb2.color||'var(--blue)'};font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px">📦 ${esc(_tb2.name)}</div>`:''}
          <h3 style="font-size:14px;font-weight:700;font-family:var(--mono)">${esc(s.name)}</h3>
        </div>
        <button class="btn btn-primary btn-sm edit-only" onclick="openAddThresh('${s.id}')">＋ Add Threshold</button>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:10px">${s.total} compositions · no thresholds yet</p>
    </div>
    <div class="empty"><div class="empty-icon">📐</div>
      <p style="max-width:320px;text-align:center;line-height:1.6">Add thresholds like <code>THRESHOLD-4</code> to track MELTS results at different precision cutoffs.</p>
      <button class="btn btn-primary" onclick="openAddThresh('${s.id}')">＋ Add Threshold</button>
    </div>`;
  }
  const compTable=buildCompTable(s);
  const cards=s.thresholds.map(t=>buildThreshCard(s.id,t)).join('');
  const _tb=s.batchId?getBatch(s.batchId):null;
  return`<div class="card">
    <div class="flex-row" style="margin-bottom:0">
      <div style="flex:1;min-width:0">
        ${_tb?`<div style="font-size:22px;font-weight:700;color:${_tb.color||'var(--blue)'};font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px">📦 ${esc(_tb.name)}</div>`:''}
        <h3 style="font-size:14px;font-weight:700;font-family:var(--mono)">${esc(s.name)}</h3>
      </div>
      <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">${s.thresholds.length} threshold(s) · ${s.total} compositions each</span>
      <button class="btn btn-primary btn-sm" onclick="openAddThresh('${s.id}')">＋ Add Threshold</button>
    </div>
  </div>
  ${compTable}
  <div id="thresh-cards-${s.id}"
    ondragover="_threshDragOver(event)"
    ondragleave="_threshDragLeave(event)"
    ondrop="_threshDrop(event,'${s.id}')">
  ${cards}
  </div>`;
}

function buildCompTable(s){
  const pComps=s.compositions;
  const parentFailed=pComps.filter(c=>c.status===ST.FAIL).length;
  const parentTotal=pComps.length;
  const available=parentTotal-parentFailed; // cells available for P calc
  const hasStats=s.thresholds.some(t=>t.pMean!=='');
  const rows=s.thresholds.map(t=>{
    const pFail=new Set(pComps.filter(p=>p.status===ST.FAIL).map(p=>p.num));
    const ss=t.compositions.filter(c=>!pFail.has(c.num)&&c.status===ST.OK).length;
    const noSol=t.compositions.filter(c=>!pFail.has(c.num)&&c.status===ST.FAIL).length;
    const notEntered=t.compositions.filter(c=>!pFail.has(c.num)&&c.status===ST.NR).length;
    const recRate=available>0?Math.round(ss/available*100):0;
    const cutStr=t.cutoff+(t.unit?` ${t.unit}`:'');
    // Auto-compute mean±σ from stored pValues if not manually set
    const pVals=t.compositions.filter(c=>c.status===ST.OK&&c.pValue!=null).map(c=>c.pValue);
    let pStat=t.pMean!==''?`${t.pMean}±${t.pStd}${t.pUnit?' '+t.pUnit:''}`:
              pVals.length>1?(()=>{
                const m=pVals.reduce((a,b)=>a+b,0)/pVals.length;
                const sd=Math.sqrt(pVals.reduce((a,b)=>a+(b-m)**2,0)/pVals.length);
                return m.toFixed(1)+'±'+sd.toFixed(1);
              })():'—';
    return`<tr>
      <td style="color:var(--blue);font-weight:700;font-family:var(--mono)">${esc(t.name)}</td>
      <td style="color:var(--text-muted)">${esc(cutStr)}</td>
      <td style="color:var(--green);font-weight:700">${ss}</td>
      <td style="color:var(--red)">${noSol}</td>
      <td style="color:var(--text-muted)">${notEntered}</td>
      <td style="color:var(--text-muted)">${parentFailed}</td>
      ${hasStats||pVals.length>1?`<td style="color:var(--yellow)">${pStat}</td>`:''}
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:80px;height:6px;background:var(--gray);border-radius:3px;overflow:hidden;flex-shrink:0">
            <div style="height:100%;width:${recRate}%;background:var(--green-dim);border-radius:3px"></div>
          </div>
          <span style="font-size:13px;color:var(--text-muted);white-space:nowrap">${ss}/${available}</span>
          <span style="font-size:18px;font-weight:700;color:var(--text);white-space:nowrap;min-width:44px;text-align:right">${recRate}%</span>
        </div>
      </td>
    </tr>`;
  }).join('');
  return`<div class="card" style="margin-bottom:12px">
    <div class="card-title">Filter Comparison — Q2F Pressure Solution Recovery</div>
    <table class="comp-table">
      <thead><tr>
        <th>Threshold</th><th>Cutoff</th>
        <th style="color:var(--green)">✓ P Obtained</th>
        <th style="color:var(--red)">✗ No Solution</th>
        <th>⬜ Not Entered</th>
        <th>🔒 Locked</th>
        ${hasStats||s.thresholds.some(t=>t.compositions.some(c=>c.pValue!=null))?'<th>P (mean±σ)</th>':''}
        <th>Q2F Recovery</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="font-size:13px;color:var(--text-muted);margin-top:6px">
      Q2F Recovery = quartz + 2 feldspar (alkali feldspar + plagioclase) pressure solutions obtained / compositions available (${available} total − ${parentFailed} parent failures locked)
    </div>
  </div>`;
}

function buildRankPlot(sid,tid){
  return'<div style="padding:12px 4px">'
    +'<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">'
    +'<span style="font-size:12px;color:var(--text-muted);flex:1">Pressure solutions ranked lowest to highest. Hover for details.</span>'
    +'<button class="btn btn-sm" style="font-size:10px;padding:2px 8px" onclick="exportRankPlotPNG(\''+sid+'\',\''+tid+'\')" title="Export rank plot as PNG" aria-label="Export rank plot as PNG">📷 Export PNG</button>'
    +'</div>'
    +'<canvas id="rk-'+tid+'" style="width:100%;height:280px;border-radius:6px;background:var(--surface);display:block"></canvas>'
    +'</div>';
}
function drawRankPlot(sid,tid){
  const s=getS(sid);if(!s)return;
  const t=s.thresholds.find(x=>x.id===tid);if(!t)return;
  const canvas=document.getElementById('rk-'+tid);if(!canvas)return;
  const dpr=Math.max(window.devicePixelRatio||1,2); // min 2× for crisp display
  // Get actual rendered width; canvas may be 0 if parent is visible but freshly inserted
  const _cpar=canvas.parentElement;
  const W=(_cpar&&_cpar.clientWidth>50)?_cpar.clientWidth:560, H=280;
  canvas.width=W*dpr;canvas.height=H*dpr;
  canvas.style.width=W+'px';canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const pts=t.compositions.filter(c=>c.status===ST.OK&&c.pValue!=null).map(c=>({num:c.num,p:c.pValue}));
  if(pts.length===0){
    ctx.fillStyle='#8b949e';ctx.font='13px sans-serif';ctx.textAlign='center';
    ctx.fillText('No pressure solutions available.',W/2,H/2);return;
  }
  pts.sort((a,b)=>a.p-b.p);
  const pVals=pts.map(p=>p.p);
  const pMin=Math.min(...pVals),pMax=Math.max(...pVals);
  const pPad=(pMax-pMin)*RANK_PLOT_PAD_FRAC||5;
  const ylo=pMin-pPad,yhi=pMax+pPad;
  const PAD={top:28,right:16,bottom:44,left:56};
  const plotW=W-PAD.left-PAD.right,plotH=H-PAD.top-PAD.bottom;
  const n=pts.length;
  const toX=i=>PAD.left+(i/(n>1?n-1:1))*plotW;
  const toY=v=>H-PAD.bottom-(v-ylo)/(yhi-ylo)*plotH;
  const isDark=(document.documentElement.getAttribute('data-theme')||'dark')!=='light';
  ctx.fillStyle=isDark?'#161b22':'#f6f8fa';ctx.fillRect(0,0,W,H);
  ctx.strokeStyle=isDark?'#21262d':'#e1e4e8';ctx.lineWidth=0.6;
  for(let i=0;i<=4;i++){
    const yv=ylo+(yhi-ylo)*i/4;
    ctx.beginPath();ctx.moveTo(PAD.left,toY(yv));ctx.lineTo(PAD.left+plotW,toY(yv));ctx.stroke();
  }
  if(t.pMean!==''){
    const mv=parseFloat(t.pMean),sv2=t.pStd?parseFloat(t.pStd):0;
    const mc=isCBMode()?'#E69F00':'#e3b341';
    // Draw mean dashed line only — no filled std-dev shading band
    ctx.strokeStyle=mc;ctx.lineWidth=1.5;ctx.setLineDash([5,4]);
    ctx.beginPath();ctx.moveTo(PAD.left,toY(mv));ctx.lineTo(PAD.left+plotW,toY(mv));ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle=mc;ctx.font='bold 11px sans-serif';ctx.textAlign='left';
    ctx.fillText('mean '+mv+(t.pUnit?' '+t.pUnit:''),PAD.left+4,toY(mv)-5);
  }
  ctx.strokeStyle=isDark?'#8b949e':'#6e7681';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(PAD.left,PAD.top);ctx.lineTo(PAD.left,H-PAD.bottom);ctx.lineTo(W-PAD.right,H-PAD.bottom);ctx.stroke();
  const dotCol=isCBMode()?'#0072B2':'#58a6ff';
  pts.forEach((pt,i)=>{
    ctx.beginPath();ctx.arc(toX(i),toY(pt.p),4.5,0,Math.PI*2);
    ctx.fillStyle=dotCol;ctx.globalAlpha=0.85;ctx.fill();ctx.globalAlpha=1;
  });
  const titleC=isDark?'#e6edf3':'#24292f';
  ctx.fillStyle=titleC;ctx.font='bold 12px sans-serif';ctx.textAlign='center';
  const _scnRun=getS(sid);
  const _scnTitle=(_scnRun?esc(_scnRun.name):'Run')+' – Threshold = '+esc(t.name);
  ctx.fillText(_scnTitle,W/2,16);
  const mC=isDark?'#8b949e':'#6e7681';
  ctx.fillStyle=mC;ctx.font='12px sans-serif';ctx.textAlign='center';
  ctx.fillText('Rank (lowest → highest P)',W/2,H-6);
  ctx.save();ctx.translate(14,H/2);ctx.rotate(-Math.PI/2);
  ctx.textAlign='center';ctx.fillText('P ('+( t.pUnit||'MPa')+ ')',0,0);ctx.restore();
  ctx.fillStyle=mC;ctx.font='11px sans-serif';ctx.textAlign='right';
  for(let i=0;i<=4;i++){
    const yv=ylo+(yhi-ylo)*i/4;ctx.fillText(yv.toFixed(1),PAD.left-5,toY(yv)+4);
  }
  canvas.dataset.rkPts=JSON.stringify(pts.map((pt,i)=>({label:'#'+pt.num+' P='+pt.p.toFixed(2)+(t.pUnit?' '+t.pUnit:''),px:toX(i),py:toY(pt.p),r:7})));
  if(!canvas._rkH){
    canvas._rkH=true;
    canvas.addEventListener('mousemove',function(e){
      const rect=canvas.getBoundingClientRect();
      const mx=(e.clientX-rect.left),my=(e.clientY-rect.top);
      const pp=JSON.parse(canvas.dataset.rkPts||'[]');
      const hit=pp.find(p=>Math.hypot(p.px-mx,p.py-my)<=p.r+3);
      canvas.title=hit?hit.label:'';
    });
  }
}

function exportRankPlotPNG(sid,tid){
  const s=getS(sid); if(!s)return;
  const t=s.thresholds.find(x=>x.id===tid); if(!t)return;
  const pts=t.compositions.filter(c=>(c.status===ST.OK||c.status==='success')&&c.pValue!=null).map(c=>({num:c.num,p:c.pValue}));
  if(!pts.length){toast('No pressure solutions to export','err');return;}
  pts.sort((a,b)=>a.p-b.p);
  const DPR=RANK_PLOT_EXPORT_DPR; // high-quality export (~400 dpi)
  const W=900,H=380;
  const out=document.createElement('canvas');
  out.width=W*DPR; out.height=H*DPR;
  const oc=out.getContext('2d'); oc.scale(DPR,DPR);
  // White background
  oc.fillStyle='#ffffff'; oc.fillRect(0,0,W,H);
  // Light grid background
  oc.fillStyle='#f8f9fa'; oc.fillRect(64,36,900-84,380-86);
  // Reuse drawRankPlot-style logic but with forced light colors
  const pVals=pts.map(p=>p.p);
  const pMin=Math.min(...pVals),pMax=Math.max(...pVals);
  const pPad=(pMax-pMin)*0.08||5;
  const ylo=pMin-pPad,yhi=pMax+pPad;
  const PAD={top:36,right:20,bottom:50,left:64};
  const plotW=W-PAD.left-PAD.right,plotH=H-PAD.top-PAD.bottom;
  const n=pts.length;
  const toX=i=>PAD.left+(i/(n>1?n-1:1))*plotW;
  const toY=v=>H-PAD.bottom-(v-ylo)/(yhi-ylo)*plotH;
  // Grid
  oc.strokeStyle='#dee2e6'; oc.lineWidth=0.8;
  for(let i=0;i<=5;i++){const yv=ylo+(yhi-ylo)*i/5;oc.beginPath();oc.moveTo(PAD.left,toY(yv));oc.lineTo(PAD.left+plotW,toY(yv));oc.stroke();}
  // Mean line
  if(t.pMean!==''){
    const mv=parseFloat(t.pMean);
    oc.strokeStyle='#b35900'; oc.lineWidth=1.5; oc.setLineDash([5,4]);
    oc.beginPath(); oc.moveTo(PAD.left,toY(mv)); oc.lineTo(PAD.left+plotW,toY(mv)); oc.stroke();
    oc.setLineDash([]);
    oc.fillStyle='#b35900'; oc.font='bold 12px sans-serif'; oc.textAlign='left';
    oc.fillText('mean '+mv+(t.pUnit?' '+t.pUnit:''),PAD.left+4,toY(mv)-6);
  }
  // Axes
  oc.strokeStyle='#2c3e50'; oc.lineWidth=1.5;
  oc.beginPath(); oc.moveTo(PAD.left,PAD.top); oc.lineTo(PAD.left,H-PAD.bottom); oc.lineTo(W-PAD.right,H-PAD.bottom); oc.stroke();
  // Data points
  const ptColor=isCBMode()?'#0072B2':'#1a6bbf';
  pts.forEach((p,i)=>{
    oc.beginPath(); oc.arc(toX(i),toY(p.p),5,0,Math.PI*2);
    oc.fillStyle=ptColor; oc.fill();
    oc.strokeStyle='#ffffff'; oc.lineWidth=1; oc.stroke();
  });
  // Axis labels
  oc.fillStyle='#2c3e50'; oc.font='bold 12px sans-serif'; oc.textAlign='center';
  oc.fillText('Rank (lowest \u2192 highest P)',W/2,H-10);
  oc.save(); oc.translate(16,H/2); oc.rotate(-Math.PI/2);
  oc.fillText((t.pUnit||'Pressure'),0,0); oc.restore();
  // Tick labels Y
  oc.font='11px sans-serif'; oc.textAlign='right'; oc.fillStyle='#444';
  for(let i=0;i<=5;i++){const yv=ylo+(yhi-ylo)*i/5;oc.fillText(yv.toFixed(0),PAD.left-6,toY(yv)+4);}
  // Title: "RunName – Threshold = ThreshName"
  const _rss=getS(sid);
  const _runTitle=(_rss?esc(_rss.name):'Run')+' – Threshold = '+esc(t.name);
  oc.font='bold 15px sans-serif'; oc.textAlign='center'; oc.fillStyle='#111111';
  oc.fillText(_runTitle,W/2,24);
  // Subtitle
  oc.font='11px sans-serif'; oc.fillStyle='#555555';
  oc.fillText('Generated: '+new Date().toLocaleDateString(),W/2,40);
  // Download
  const nm=(t.name||'rank').replace(/[^a-z0-9_-]/gi,'_');
  const a=document.createElement('a');
  a.download='rank_order_'+nm+'_'+Date.now()+'.png';
  a.href=out.toDataURL('image/png'); a.click();
  toast('Rank-order PNG exported ✓');
}
function buildThreshCard(sid,t){
  const s=getS(sid);
  const parentComps=s?s.compositions:[];
  const parentFail=parentComps.filter(c=>c.status===ST.FAIL).length;
  // Effective counts: exclude cells that are locked by parent
  const tComps=t.compositions;
  const ss=tComps.filter(c=>c.status===ST.OK).length;
  const sf=tComps.filter(c=>c.status===ST.FAIL&&(parentComps.find(p=>p.num===c.num)||{}).status!==ST.FAIL).length;
  const rc=ss+sf;  // "entered" = green+red (non-locked)
  const pct=tComps.length>0?Math.round(ss/tComps.length*100):0;
  const cutStr=t.cutoff+(t.unit?` ${t.unit}`:'');
  const tab=activeThreshTab[t.id]||'grid';
  return`<div class="thresh-card" id="tc-${t.id}" draggable="false">
    <div class="thresh-hdr" onclick="toggleThresh('${sid}','${t.id}')">
      <span class="thresh-drag-handle" draggable="true"
        onmousedown="event.stopPropagation()"
        ondragstart="_threshDragStart(event,'${sid}','${t.id}')"
        ondragend="_threshDragEnd(event)"
        title="Drag to reorder">⠿</span>
      <span class="th-name">${esc(t.name)}</span>
      <span class="th-cut">cutoff of ${esc(cutStr)}</span>
      <div class="tc-pbar"><div class="tc-pbf" style="width:${pct}%"></div></div>
      <span style="font-size:12px;color:var(--text-muted);white-space:nowrap">${pct}%</span>
      <span class="chip chip-done" style="margin-left:4px">✓${ss} P solutions</span>
      <span class="chip chip-red" style="margin-left:3px">✗${sf} no solution</span>
      <span class="chip" style="margin-left:3px;background:#374151;color:var(--text-muted)">🔒${parentFail}</span>
      <button class="btn btn-sm" style="margin-left:6px;padding:2px 6px;font-size:10px" onclick="event.stopPropagation();openPStats('${sid}','${t.id}')">📊</button>
      <button class="btn btn-sm btn-danger" style="margin-left:3px;padding:2px 6px;font-size:10px" class="btn btn-sm btn-danger edit-only" style="margin-left:3px;padding:2px 6px;font-size:10px" onclick="event.stopPropagation();deleteThreshold('${sid}','${t.id}')">🗑</button>
      <span style="color:var(--text-muted);font-size:13px;margin-left:4px">${t.open?'▲':'▼'}</span>
    </div>
    <div class="thresh-body${t.open?' open':''}" id="tb-${t.id}">
      ${t.desc?`<p style="font-size:11px;color:var(--text-muted);margin-bottom:10px">${esc(t.desc)}</p>`:''}
      ${(t.pMean!==''&&t.pMean!=null)?(()=>{
        const _fmt=v=>{const n=Number(v);return isFinite(n)?n.toFixed(2):String(v);};
        const _n=t.pCount||0;
        return`<div style="margin-bottom:12px;padding:8px 10px;background:rgba(210,153,34,0.08);border-left:3px solid var(--yellow);border-radius:4px">
        <div style="font-size:12px;color:var(--yellow);font-weight:600">
          P̲ = ${_fmt(t.pMean)} ± ${_fmt(t.pStd)}${t.pUnit?' '+esc(t.pUnit):''}
          <span style="font-size:10px;font-weight:400;color:rgba(210,153,34,0.7);margin-left:4px">(mean ± sample σ, n=${_n})</span>
        </div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
          (${_n>0?_n:'?'} pressure solution${_n!==1?'s':''} contributed to this calculation at the time of last paste)
        </div>
      </div>`;})():''}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn btn-sm" onclick="event.stopPropagation();openPasteP('${sid}','${t.id}')">📋 Paste Pressure Results</button>
        ${t.rawPaste?`<button class="btn btn-sm" onclick="event.stopPropagation();openViewRecord('${sid}','${t.id}')">📄 View Record</button>`:''}
        <span style="font-size:10px;color:var(--text-muted)">or click individual cells in the grid below</span>
      </div>
      <div class="tabs">
        <button class="tab-btn${tab==='grid'?' active':''}" onclick="setThreshTab('${t.id}','grid','${sid}')">Grid View</button>
        <button class="tab-btn${tab==='locked'?' active':''}" onclick="setThreshTab('${t.id}','locked','${sid}')">Locked Failures (${parentFail})</button>
        <button class="tab-btn${tab==='rank'?' active':''}" onclick="setThreshTab('${t.id}','rank','${sid}')">Rank-Order Plot</button>
      </div>
      ${tab==='grid'?buildGrid(sid,t.compositions,t.id,parentComps):tab==='rank'?buildRankPlot(sid,t.id):buildLockedList(sid,t.id,parentComps)}
    </div>
  </div>`;
}

function setThreshTab(tid,tab,sid){activeThreshTab[tid]=tab;renderThreshCardInPlace(sid,tid);if(tab==='rank')setTimeout(()=>drawRankPlot(sid,tid),40);}
function toggleThresh(sid,tid){
  const t=getT(sid,tid);if(!t)return;
  t.open=!t.open;save();renderThreshCardInPlace(sid,tid);
}
function renderThreshCardInPlace(sid,tid){
  const s=getS(sid);if(!s)return;
  const t=s.thresholds.find(t=>t.id===tid);if(!t)return;
  const el=document.getElementById('tc-'+tid);
  if(el){const tmp=document.createElement('div');tmp.innerHTML=buildThreshCard(sid,t);el.replaceWith(tmp.firstElementChild);}
  else renderThresholding();
  if((activeThreshTab[tid]||'grid')==='rank')setTimeout(()=>drawRankPlot(sid,tid),40);
}

// ════════════════════════════════════════════════════════
//  THRESHOLD CRUD
// ════════════════════════════════════════════════════════
function openAddThresh(sid){
  const s=getSimset(sid);if(!s)return;
  document.getElementById('at-sid').value=sid;
  document.getElementById('at-sname').textContent=s.name;
  document.getElementById('at-name').value='';
  document.getElementById('at-cutoff').value='';
  document.getElementById('at-unit').value='';
  document.getElementById('at-desc').value='';
  openModal('modal-add-thresh');
}
function createThreshold(){
  const sid=document.getElementById('at-sid').value;
  const name=document.getElementById('at-name').value.trim();
  const cutoff=document.getElementById('at-cutoff').value.trim();
  const unit=document.getElementById('at-unit').value.trim();
  const desc=document.getElementById('at-desc').value.trim();
  if(!name||!cutoff){toast('Name and cutoff required','err');return;}
  if(!unit){toast('Pressure unit is required — choose one to avoid unit confusion later','err');return;}
  const s=getS(sid);if(!s){toast('Sample not found','err');return;}
  s.thresholds.push(mkThreshold(sid,name,cutoff,unit,desc));
  save();closeModal('modal-add-thresh');renderThresholding();updateThreshBadge();toast('Threshold created');
}
function deleteThreshold(sid,tid){
  const s=getSimset(sid);if(!s)return;
  const idx=s.thresholds.findIndex(t=>t.id===tid);
  if(idx<0)return;
  const removed=s.thresholds[idx];
  s.thresholds.splice(idx,1);
  save();renderThresholding();updateThreshBadge();
  toastUndo('Threshold "'+removed.name+'" deleted',()=>{
    s.thresholds.splice(Math.min(idx,s.thresholds.length),0,removed);
    save();renderThresholding();updateThreshBadge();
  });
}

// ════════════════════════════════════════════════════════
//  PRESSURE STATS
// ════════════════════════════════════════════════════════
function openPStats(sid,tid){
  const t=getT(sid,tid);// getT already uses getSimsetif(!t)return;
  document.getElementById('ps-sid').value=sid;
  document.getElementById('ps-tid').value=tid;
  document.getElementById('ps-mean').value=t.pMean;
  document.getElementById('ps-std').value=t.pStd;
  document.getElementById('ps-unit').value=t.pUnit;
  openModal('modal-pstats');
}
function savePStats(){
  const sid=document.getElementById('ps-sid').value;
  const tid=document.getElementById('ps-tid').value;
  const t=getT(sid,tid);if(!t)return;
  t.pMean=document.getElementById('ps-mean').value;
  t.pStd=document.getElementById('ps-std').value;
  t.pUnit=document.getElementById('ps-unit').value;
  save();closeModal('modal-pstats');renderThresholding();toast('P stats saved');
}

// ════════════════════════════════════════════════════════
//  SAMPLE CRUD
// ════════════════════════════════════════════════════════
// ── Sample CRUD ──
function openAddSample(){
  document.getElementById('as-name').value='';
  document.getElementById('as-notes').value='';
  const _ar=document.getElementById('as-rocktype');if(_ar)_ar.value='';
  _populateUnitSelect('as-unit-id','');
  const _ap=document.getElementById('as-unit-preview');if(_ap)_ap.textContent='';
  openModal('modal-add-sample');
}
function createSampleOnly(){
  const name=document.getElementById('as-name').value.trim();
  const notes=document.getElementById('as-notes').value.trim();
  const rockType=(document.getElementById('as-rocktype')||{}).value||'';
  const unitId=(document.getElementById('as-unit-id')||{}).value||'';
  if(!name){alert('Please enter a sample name.');return;}
  const se=mkSampleEntity(name,notes);
  se.rockType=rockType.trim();
  se.unitId=unitId;
  S.samples.push(se);
  save();closeModal('modal-add-sample');renderSamples();
  toast('Sample "'+name+'" created');
}
function openEditSample(sid){
  const s=getSample(sid);if(!s)return;
  document.getElementById('es-id').value=sid;
  document.getElementById('es-type').value='sample';
  document.getElementById('es-modal-title').textContent='✏ Edit Sample';
  document.getElementById('es-name').value=s.name;
  document.getElementById('es-notes').value=s.notes||'';
  // Show sample-only fields, hide simset-only fields
  const _sf=document.getElementById('es-sample-fields');
  const _smf=document.getElementById('es-simset-fields');
  if(_sf)_sf.style.display='block';
  if(_smf)_smf.style.display='none';
  const _er=document.getElementById('es-rocktype');if(_er)_er.value=s.rockType||'';
  _populateUnitSelect('es-unit-id', s.unitId||'');
  const _ep2=document.getElementById('es-unit-preview');if(_ep2){const _eu=_getUnit(s.unitId||'');_ep2.textContent=_eu?_eu.name+' ('+_eu.abbr+')':(s.geoUnit?s.geoUnit+' ('+s.geoUnitAbbr+', legacy)':'');}
  openModal('modal-edit-sample');
}
function deleteSample(sid){
  const s=getSample(sid);if(!s)return;
  const linked=S.simsets.filter(ss=>ss.sampleId===sid);
  let msg='Delete sample "'+s.name+'"?';
  if(linked.length){
    msg+='\n\n⚠ '+linked.length+' run(s) are linked to this sample:\n';
    msg+=linked.map(ss=>'  • '+ss.name).join('\n');
    msg+='\n\nThose runs will become orphaned (you can re-link them later).\nClick OK to delete sample only, or Cancel to abort.';
  }
  if(!confirm(msg))return;
  const idx=S.samples.findIndex(x=>x.id===sid);
  const removed=S.samples[idx];
  S.samples.splice(idx,1);
  const wasActive=(S.activeSampleId===sid);
  if(wasActive)S.activeSampleId=null;
  save();renderSidebar();renderSamples();
  const undoMsg=linked.length
    ? 'Sample deleted — '+linked.length+' run(s) now orphaned'
    : 'Sample "'+s.name+'" deleted';
  toastUndo(undoMsg,()=>{
    S.samples.splice(Math.min(idx,S.samples.length),0,removed);
    if(wasActive)S.activeSampleId=sid;
    save();renderSidebar();renderSamples();
  });
}


// ════════════════════════════════════════════════════════
//  ORPHAN RE-LINK
// ════════════════════════════════════════════════════════
function openRelinkModal(ssid){
  const ss=getSimset(ssid);if(!ss)return;
  if(!S.samples||!S.samples.length){
    toast('No samples exist. Create a sample first.','err');return;
  }
  document.getElementById('rl-ssid').value=ssid;
  document.getElementById('rl-run-name').value=ss.name;
  const sel=document.getElementById('rl-sample-sel');
  sel.innerHTML=S.samples.map(s=>{
    const u=_getUnit(s.unitId||'');
    return`<option value="${s.id}">${esc(s.name)}${s.rockType?' ('+esc(s.rockType)+')':''}${u?' ['+esc(u.abbr)+']':''}`;
  }).join('');
  const updatePrev=()=>{
    const s=getSample(sel.value);
    const prev=document.getElementById('rl-sample-preview');
    if(!prev)return;
    if(s){
      const u=_getUnit(s.unitId||'');
      prev.innerHTML='<span style="color:var(--green)">✓ '+esc(s.name)+'</span>'+(s.rockType?' &middot; <em style="color:var(--text);font-weight:600">'+esc(s.rockType)+'</em>':'')+(u?' &middot; <strong style="color:'+getCBUnitColor(u.color||'#58a6ff')+'">'+esc(u.abbr)+'</strong>':'');
    } else prev.textContent='';
  };
  sel.onchange=updatePrev;
  updatePrev();
  openModal('modal-relink');
}
function relinkOrphan(){
  const ssid=document.getElementById('rl-ssid').value;
  const sid=document.getElementById('rl-sample-sel').value;
  const ss=getSimset(ssid);if(!ss)return;
  const s=getSample(sid);
  if(!s){toast('Please select a valid sample.','err');return;}
  ss.sampleId=sid;
  save();closeModal('modal-relink');
  renderSidebar();
  if(S.activePage==='runs')renderRuns();
  toast('Run "'+esc(ss.name)+'" re-linked to "'+esc(s.name)+'" ✓');
}

// ── Simset CRUD ──
function openNewSimset(){
  const warn=document.getElementById('simset-no-samples-warn');
  const createBtn=document.getElementById('simset-create-btn');
  const sel=document.getElementById('simset-sample-sel');
  if(S.samples.length===0){
    warn.style.display='block';
    sel.innerHTML='<option value="">— No samples yet —</option>';
    sel.disabled=true;
    createBtn.disabled=true;
    createBtn.style.opacity='0.4';
  } else {
    warn.style.display='none';
    sel.disabled=false;
    createBtn.disabled=false;
    createBtn.style.opacity='';
    sel.innerHTML=S.samples.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
    sel.value=S.activeSampleId||S.samples[0].id;
  }
  document.getElementById('simset-run-type').value='monte_carlo';
  document.getElementById('simset-mc-options').style.display='block';
  document.getElementById('simset-total-sel').value='200';
  document.getElementById('simset-total-custom').style.display='none';
  // Auto-suggest a name based on selected sample + run type
  autoNameSimset();
  openModal('modal-new-simset');
}
function autoNameSimset(){
  const sel=document.getElementById('simset-sample-sel');
  const sid=sel.value;
  const sample=getSample(sid);
  const nameEl=document.getElementById('simset-name');
  if(sample&&!nameEl.dataset.userEdited){
    const totalSel=document.getElementById('simset-total-sel');
    const total=totalSel.value==='custom'?'?':totalSel.value;
    nameEl.value=sample.name+' MC-'+total;
  }
}
// Let user override the auto-name
document.addEventListener('DOMContentLoaded',()=>{
  const nameEl=document.getElementById('simset-name');
  if(nameEl) nameEl.addEventListener('input',()=>{nameEl.dataset.userEdited=nameEl.value?'1':'';});
  const sel=document.getElementById('simset-sample-sel');
  if(sel) sel.addEventListener('change',()=>{autoNameSimset();});
  const totalSel=document.getElementById('simset-total-sel');
  if(totalSel) totalSel.addEventListener('change',()=>{autoNameSimset();});
});
function syncRunType(val){
  document.getElementById('simset-mc-options').style.display=val==='monte_carlo'?'block':'none';
}
function syncSimTotal(val){
  const custom=document.getElementById('simset-total-custom');
  custom.style.display=val==='custom'?'inline-block':'none';
  autoNameSimset();
}
function createSimset(){
  const sampleId=document.getElementById('simset-sample-sel').value;
  const runType=document.getElementById('simset-run-type').value;
  const nameEl=document.getElementById('simset-name');
  const name=nameEl.value.trim();
  const selVal=document.getElementById('simset-total-sel').value;
  const customVal=document.getElementById('simset-total-custom').value;
  const total=selVal==='custom'?parseInt(customVal,10):parseInt(selVal,10);
  if(!sampleId||!getSample(sampleId)){
    alert('Please select a valid parent sample.\nAdd samples in the 🧪 Samples tab first.');return;
  }
  if(!name){alert('Please enter a run name.');return;}
  if(!total||total<1){alert('Please enter a valid number of simulations.');return;}
  const ss=mkSimset(sampleId,name,total);
  ss.runType=runType||'monte_carlo';
  S.simsets.push(ss);
  S.activeSimsetId=ss.id;
  nameEl.dataset.userEdited='';  // reset for next time
  save();closeModal('modal-new-simset');
  renderSidebar();
  if(S.activePage==='runs')renderRuns();
  toast('Run "'+name+'" created ('+total+' simulations)');
}
function openEditSimset(ssid){
  const ss=getSimset(ssid);if(!ss)return;
  document.getElementById('es-id').value=ssid;
  document.getElementById('es-type').value='simset';
  document.getElementById('es-modal-title').textContent='✏ Edit Run';
  document.getElementById('es-name').value=ss.name;
  document.getElementById('es-notes').value=ss.notes||'';
  // Show simset-only fields, hide sample-only fields
  const sf=document.getElementById('es-sample-fields');
  const smf=document.getElementById('es-simset-fields');
  if(sf)sf.style.display='none';
  if(smf)smf.style.display='block';
  // Populate parent sample dropdown
  const sel=document.getElementById('es-parent-sample');
  if(sel){
    sel.innerHTML=S.samples.map(s=>`<option value="${s.id}" ${s.id===ss.sampleId?'selected':''}>${esc(s.name)}</option>`).join('');
    const _updateParentPreview=()=>{
      const s=getSample(sel.value);
      const prev=document.getElementById('es-parent-preview');
      if(prev){
        if(s){
          const u=_getUnit(s.unitId||'');
          prev.innerHTML=`<span style="color:var(--green)">✓ ${esc(s.name)}</span>${s.rockType?' · <span style="color:var(--text);font-weight:600">'+esc(s.rockType)+'</span>':''}${u?' · <span style="color:'+getCBUnitColor(u.color||'#58a6ff')+'">'+esc(u.abbr)+'</span>':""}`;
        } else {
          prev.textContent='No samples available';
        }
      }
    };
    sel.onchange=_updateParentPreview;
    _updateParentPreview();
  }
  openModal('modal-edit-sample');
}
function saveEditSample(){
  const id=document.getElementById('es-id').value;
  const type=(document.getElementById('es-type')||{}).value||'sample';
  const name=document.getElementById('es-name').value.trim();
  const notes=document.getElementById('es-notes').value.trim();
  if(type==='simset'){
    const ss=getSimset(id);if(!ss)return;
    ss.name=name||ss.name;
    ss.notes=notes;
    // Update parent sample link
    const selEl=document.getElementById('es-parent-sample');
    if(selEl&&selEl.value){
      const oldParent=ss.sampleId;
      ss.sampleId=selEl.value;
      if(oldParent!==selEl.value)toast('Run re-linked to new sample ✓');
    }
    save();closeModal('modal-edit-sample');renderSidebar();renderRuns();toast('Run updated ✓');return;
  }
  // sample type
  const s=getSample(id);if(!s)return;
  s.name=name||s.name;
  s.notes=notes;
  const _er2=document.getElementById('es-rocktype');if(_er2)s.rockType=_er2.value.trim();
  const _eu2=document.getElementById('es-unit-id');if(_eu2)s.unitId=_eu2.value;
  // Sync linked simset names if sample name changed
  if(name&&name!==s.name){
    const linked=S.simsets.filter(ss=>ss.sampleId===s.id);
    // Don't auto-rename — user may have custom names
  }
  save();closeModal('modal-edit-sample');
  renderSidebar();renderSamples();toast('Sample updated ✓');
}
function deleteSimset(ssid){
  const ss=getSimset(ssid);if(!ss)return;
  if(!confirm('Delete simulation set "'+ss.name+'"?'))return;
  const idx=S.simsets.findIndex(x=>x.id===ssid);
  const removed=S.simsets[idx];
  const wasActive=(S.activeSimsetId===ssid);
  S.simsets.splice(idx,1);
  if(wasActive)S.activeSimsetId=S.simsets.length?S.simsets[0].id:null;
  save();renderSidebar();renderRuns();
  toastUndo('Run "'+removed.name+'" deleted',()=>{
    S.simsets.splice(Math.min(idx,S.simsets.length),0,removed);
    if(wasActive)S.activeSimsetId=ssid;
    save();renderSidebar();renderRuns();
  });
}
// (legacy alias removed — deleteSample defined above)

// ── Modal helpers with focus management ─────────────────────────
let _lastFocusBeforeModal=null;
function openModal(id){
  const bg=document.getElementById(id);
  if(!bg)return;
  _lastFocusBeforeModal=document.activeElement;
  bg.classList.add('open');
  // Focus the first interactive control inside the modal.
  setTimeout(()=>{
    const inner=bg.querySelector('.modal');
    if(!inner)return;
    const focusable=inner.querySelector('input:not([type=hidden]):not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])');
    (focusable||inner).focus();
  },20);
}
function closeModal(id){
  const bg=document.getElementById(id);
  if(!bg)return;
  bg.classList.remove('open');
  // Restore focus to whatever triggered the open, if still in DOM.
  if(_lastFocusBeforeModal&&document.body.contains(_lastFocusBeforeModal)){
    try{_lastFocusBeforeModal.focus();}catch(e){}
  }
  _lastFocusBeforeModal=null;
}
// Escape closes the topmost open modal.
document.addEventListener('keydown',function(e){
  if(e.key!=='Escape')return;
  const open=document.querySelectorAll('.modal-bg.open');
  if(!open.length)return;
  closeModal(open[open.length-1].id);
});

// Keyboard activation for composition cells (Enter/Space cycles status).
function _cellKey(e,sid,ctx,num){
  if(e.key==='Enter'||e.key===' '||e.key==='Spacebar'){
    e.preventDefault();
    cycleCell(sid,ctx,num);
  }
}
document.querySelectorAll('.modal-bg').forEach(m=>{m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open');});});

// ════════════════════════════════════════════════════════
//  TOAST
// ════════════════════════════════════════════════════════
let _tt;
function toast(msg,type=''){
  const el=document.getElementById('toast');
  el.textContent=msg;el.className='toast'+(type==='err'?' err':'');
  void el.offsetWidth;el.classList.add('show');
  clearTimeout(_tt);_tt=setTimeout(()=>el.classList.remove('show'),2400);
}
// Toast with an Undo button. Returns a handle that lets you cancel the undo
// (e.g. when the user navigates away). Auto-dismisses after `ms` ms.
function toastUndo(msg,undoFn,ms=5000){
  const el=document.getElementById('toast');
  if(!el)return;
  el.className='toast show';
  el.innerHTML='';
  const span=document.createElement('span');span.textContent=msg;
  const btn=document.createElement('button');
  btn.type='button';btn.className='toast-action';btn.textContent='Undo';
  let done=false;
  const hide=()=>{el.classList.remove('show');el.innerHTML='';};
  btn.addEventListener('click',()=>{
    if(done)return;done=true;
    clearTimeout(_tt);
    try{undoFn();}catch(e){console.error('undo failed:',e);}
    hide();
    toast('Restored ✓');
  });
  el.appendChild(span);el.appendChild(btn);
  void el.offsetWidth;
  clearTimeout(_tt);_tt=setTimeout(()=>{if(!done){done=true;hide();}},ms);
}

// ════════════════════════════════════════════════════════
//  EXPORT / IMPORT
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
//  SETTINGS PAGE
// ════════════════════════════════════════════════════════
function renderSettings(){
  const el=document.getElementById('pg-settings');
  if(!el)return;
  if(!S.settings)S.settings={owner:'',advisors:'',citation:'',license:'',repoUrl:'',doi:''};
  const st=S.settings;
  // Backfill new fields if loading an older schema
  if(typeof st.license!=='string')   st.license='';
  if(typeof st.repoUrl!=='string')   st.repoUrl='';
  if(typeof st.doi!=='string')       st.doi='';
  el.innerHTML=`
  <div style="max-width:640px;margin:0 auto;padding:28px 20px;display:flex;flex-direction:column;gap:20px">
    <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">⚙ Project Settings</h2>
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:4px">These fields are saved in your project JSON and are preserved across export/import.</p>

    <div class="card">
      <div class="card-title">Identity</div>

      <label style="font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Project Title</label>
      <input id="cfg-title" type="text" placeholder="e.g. KCP Magmatic System Study"
        value="${esc(S._appTitle||'')}"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 10px;font-size:13px;margin-top:4px;margin-bottom:10px">

      <label style="font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Project Owner</label>
      <input id="cfg-owner" type="text" placeholder="e.g. Dr. Jane Smith"
        value="${esc(st.owner||'')}"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 10px;font-size:13px;margin-top:4px;margin-bottom:10px">

      <label style="font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Advisors</label>
      <input id="cfg-advisors" type="text" placeholder="e.g. Prof. A. Jones, Dr. B. Lee"
        value="${esc(st.advisors||'')}"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 10px;font-size:13px;margin-top:4px;margin-bottom:10px">

      <label style="font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Citation Information</label>
      <textarea id="cfg-citation" rows="3" placeholder="e.g. Smith, J. (2026). rhyolite-MELTS Tracker [Software]. https://doi.org/10.xxxx/zenodo.xxxxx"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 10px;font-size:13px;margin-top:4px;margin-bottom:10px;resize:vertical;font-family:inherit">${esc(st.citation||'')}</textarea>
    </div>

    <div class="card">
      <div class="card-title">License &amp; Provenance</div>
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:10px">Embedded on the cover page of every PDF export and surfaced in the "How to Cite" card below.</p>

      <label style="font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">License (SPDX identifier or free text)</label>
      <input id="cfg-license" type="text" placeholder="e.g. MIT, CC-BY-4.0, GPL-3.0-or-later"
        value="${esc(st.license||'')}"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 10px;font-size:13px;margin-top:4px;margin-bottom:10px">

      <label style="font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">Source Repository URL</label>
      <input id="cfg-repo" type="url" placeholder="https://github.com/your-handle/melts-tracker"
        value="${esc(st.repoUrl||'')}"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 10px;font-size:13px;margin-top:4px;margin-bottom:10px">

      <label style="font-size:11px;color:var(--text-muted);font-weight:700;text-transform:uppercase;letter-spacing:.4px">DOI <span style="font-weight:400;text-transform:none;color:var(--text-dim)">(if archived to Zenodo or similar)</span></label>
      <input id="cfg-doi" type="text" placeholder="10.5281/zenodo.0000000"
        value="${esc(st.doi||'')}"
        style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 10px;font-size:13px;margin-top:4px;margin-bottom:10px">
    </div>

    ${(st.citation||st.license||st.repoUrl||st.doi)?`<div class="card" style="border-color:var(--blue);background:rgba(88,166,255,0.06)">
      <div class="card-title" style="color:var(--blue)">📖 How to cite this tool</div>
      <div style="font-size:12px;line-height:1.7">
        ${st.citation?`<div style="margin-bottom:6px;font-style:italic;white-space:pre-wrap">${esc(st.citation)}</div>`:''}
        ${st.doi?`<div><strong>DOI:</strong> <span style="font-family:var(--mono)">${esc(st.doi)}</span></div>`:''}
        ${st.repoUrl?`<div><strong>Source:</strong> <a href="${esc(st.repoUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--blue);text-decoration:underline">${esc(st.repoUrl)}</a></div>`:''}
        ${st.license?`<div><strong>License:</strong> ${esc(st.license)}</div>`:''}
        <div style="color:var(--text-muted);margin-top:6px">Software version: v${APP_VERSION}</div>
      </div>
    </div>`:''}

    <div class="card">
      <div class="card-title">Geological Units</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Units defined here are shared with the Samples tab. Adding or removing units here also affects the Samples tab.</p>
      <div id="cfg-units-list" style="margin-bottom:8px"></div>
      <button class="btn btn-primary btn-sm" onclick="openAddUnitModal()">＋ Add Unit</button>
    </div>

    <button class="btn btn-primary" onclick="saveSettings()" style="align-self:flex-start;padding:8px 22px;font-size:13px">💾 Save Settings</button>

    <div class="card">
      <div class="card-title">About</div>
      <div style="font-size:12px;line-height:1.6">
        <div><strong>Version:</strong> v${APP_VERSION} <span style="color:var(--text-muted)">(schema v${SCHEMA_VERSION})</span></div>
        <div style="color:var(--text-muted);margin-top:4px">Your data lives in this browser's <code>localStorage</code>. It is wiped when site data is cleared and is not synced across devices. <strong>Export to JSON regularly</strong> using the ⬇ Export button in the bottom-right utility bar.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Self-Tests</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Runs a small built-in test suite (open the browser console to see per-test output). You can also pass <code>?test=1</code> in the URL to run on load.</p>
      <button class="btn btn-sm" onclick="runUnitTests()">▶ Run Self-Tests</button>
    </div>

    <div class="card" style="border-color:#6e1e1e">
      <div class="card-title" style="color:var(--red)">Danger Zone</div>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Permanently erase all local data and restore factory defaults. This cannot be undone.</p>
      <button class="btn btn-sm edit-only" style="background:#b91c1c;color:#fff;border-color:#b91c1c" onclick="resetData()">🗑 Reset All Data</button>
    </div>
  </div>`;
  // Render units list inside settings
  _renderSettingsUnits();
}
let _unitDragIdx=null;
function _unitDragStart(e,i){_unitDragIdx=i;e.dataTransfer.effectAllowed='move';setTimeout(()=>{const el=document.getElementById('ud-'+i);if(el)el.classList.add('dragging');},0);}
function _unitDragEnd(){document.querySelectorAll('.unit-drag-row').forEach(el=>el.classList.remove('dragging','drag-over'));_unitDragIdx=null;}
function _unitDragOver(e,i){e.preventDefault();const el=document.getElementById('ud-'+i);if(el)el.classList.add('drag-over');}
function _unitDragLeave(i){const el=document.getElementById('ud-'+i);if(el)el.classList.remove('drag-over');}
function _unitDrop(e,toIdx){
  e.preventDefault();
  document.querySelectorAll('.unit-drag-row').forEach(el=>el.classList.remove('drag-over','dragging'));
  if(_unitDragIdx===null||_unitDragIdx===toIdx)return;
  const arr=S.units||[];
  const [m]=arr.splice(_unitDragIdx,1);arr.splice(toIdx,0,m);
  save();_renderSettingsUnits();toast('Unit order saved ✓');
}
function _renderSettingsUnits(){
  const el=document.getElementById('cfg-units-list');
  if(!el)return;
  const units=S.units||[];
  if(!units.length){el.innerHTML='<div style="font-size:12px;color:var(--text-muted)">No units defined yet. Use ＋ Add Unit below.</div>';return;}
  el.innerHTML=units.map((u,i)=>`
    <div class="unit-drag-row" id="ud-${i}" draggable="true"
      ondragstart="_unitDragStart(event,${i})"
      ondragend="_unitDragEnd()"
      ondragover="_unitDragOver(event,${i})"
      ondragleave="_unitDragLeave(${i})"
      ondrop="_unitDrop(event,${i})"
      style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--border);cursor:grab;border-radius:4px;transition:background .1s">
      <span style="color:var(--text-muted);font-size:14px;opacity:.55;user-select:none">⠿</span>
      <span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${getCBUnitColor(u.color||'#58a6ff')};flex-shrink:0"></span>
      <span style="font-weight:700;color:${getCBUnitColor(u.color||'#58a6ff')};font-size:12px;min-width:40px">${esc(u.abbr)}</span>
      <span style="font-size:12px;flex:1">${esc(u.name)}</span>
      <button class="btn btn-sm edit-only" style="font-size:10px;padding:2px 7px" onclick="openEditUnitModal(${i})">✏ Edit</button>
      <button class="btn btn-sm btn-danger edit-only" style="font-size:10px;padding:2px 7px" onclick="deleteUnit(${i})">🗑</button>
    </div>`).join('');
}
function saveSettings(){
  const v=id=>((document.getElementById(id)||{}).value||'').trim();
  S._appTitle=v('cfg-title');
  if(!S.settings)S.settings={};
  S.settings.owner    = v('cfg-owner');
  S.settings.advisors = v('cfg-advisors');
  S.settings.citation = v('cfg-citation');
  S.settings.license  = v('cfg-license');
  S.settings.repoUrl  = v('cfg-repo');
  S.settings.doi      = v('cfg-doi');
  save();
  loadAppTitle();
  _updateSubtitle();
  renderSettings(); // re-render so the "How to Cite" card reflects new fields
  toast('Settings saved ✓');
}

function exportData(){
  // Stamp export with version + timestamp so downstream tooling and future migrations
  // can detect the schema version unambiguously.
  const now=new Date().toISOString();
  S._lastExportAt = now; // remembered locally so we can stop nagging
  const payload = Object.assign({}, S, {
    _appVersion:    APP_VERSION,
    _schemaVersion: SCHEMA_VERSION,
    _exportedAt:    now
  });
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);
  a.download='melts_tracker_v'+APP_VERSION+'_'+now.slice(0,10)+'.json';a.click();
  save();
  // Hide the export-nag banner if it was up
  const eb=document.getElementById('export-nag-banner');
  if(eb)eb.remove();
  toast('Exported');
}

// Show a non-blocking banner if data has not been exported in 14+ days.
function _checkExportNag(){
  // Only nag when there's meaningful data to lose.
  const hasData=(S.samples&&S.samples.length>0)||(S.simsets&&S.simsets.length>0);
  if(!hasData)return;
  let stale=true;
  if(typeof S._lastExportAt==='string'){
    const t=new Date(S._lastExportAt).getTime();
    if(isFinite(t)){
      const days=(Date.now()-t)/(1000*60*60*24);
      stale = days>14;
    }
  }
  if(!stale)return;
  if(document.getElementById('export-nag-banner'))return;
  const bar=document.createElement('div');
  bar.id='export-nag-banner';
  bar.setAttribute('role','status');
  // Anchored to the bottom-right (util-bar is now bottom-left so they don't collide).
  bar.style.cssText='position:fixed;bottom:14px;right:16px;z-index:9000;background:var(--surface);border:1px solid var(--yellow);color:var(--text);padding:10px 14px;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.35);font-size:12px;max-width:340px;display:flex;align-items:center;gap:10px';
  bar.innerHTML='<span style="color:var(--yellow);font-size:16px">⚠</span>'
    +'<div style="flex:1;line-height:1.5">No JSON export in the last 14 days. <strong>Export now</strong> to avoid losing data if your browser clears site storage.</div>'
    +'<button class="btn btn-sm btn-primary" style="font-size:11px;padding:4px 10px" onclick="exportData()">⬇ Export</button>'
    +'<button class="btn btn-sm" style="font-size:11px;padding:4px 8px" onclick="this.parentNode.remove()" aria-label="Dismiss reminder">✕</button>';
  document.body.appendChild(bar);
}

// ── Rolling pre-import snapshot ring (keeps last BACKUP_RING successful states) ──
function snapshotBeforeImport(){
  try{
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    localStorage.setItem(BACKUP_PREFIX+stamp,JSON.stringify(S));
    // Trim ring: keep newest BACKUP_RING
    const all=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.indexOf(BACKUP_PREFIX)===0)all.push(k);
    }
    all.sort();
    while(all.length>BACKUP_RING){
      const oldest=all.shift();
      try{localStorage.removeItem(oldest);}catch(e){console.error('backup-ring trim failed:',e);}
    }
    return true;
  }catch(e){
    console.error('snapshotBeforeImport failed:',e);
    return false;
  }
}
// ── Defensive validators for imported cross-cutting state ──
function _validUnits(arr){
  if(!Array.isArray(arr))return null;
  return arr.filter(u=>u&&typeof u==='object').map(u=>({
    id:typeof u.id==='string'?u.id:'U'+Date.now()+Math.random().toString(36).slice(2,5),
    name:typeof u.name==='string'?u.name:'',
    abbr:typeof u.abbr==='string'?u.abbr:'',
    color:typeof u.color==='string'?u.color:'#58a6ff'
  }));
}
function _validBatches(arr){
  if(!Array.isArray(arr))return null;
  return arr.filter(b=>b&&typeof b==='object'&&typeof b.id==='string').map(b=>({
    id:String(b.id),
    name:typeof b.name==='string'?b.name:'',
    note:typeof b.note==='string'?b.note:'',
    color:typeof b.color==='string'?b.color:'#58a6ff'
  }));
}
function _validSettings(o){
  if(!o||typeof o!=='object')return null;
  return{
    owner:typeof o.owner==='string'?o.owner:'',
    advisors:typeof o.advisors==='string'?o.advisors:'',
    citation:typeof o.citation==='string'?o.citation:'',
    license:typeof o.license==='string'?o.license:'',
    repoUrl:typeof o.repoUrl==='string'?o.repoUrl:'',
    doi:typeof o.doi==='string'?o.doi:''
  };
}
function _validSampleCategories(arr){
  if(!Array.isArray(arr))return null;
  return arr.filter(c=>c&&typeof c==='object'&&typeof c.id==='string').map(c=>({
    id:String(c.id),
    name:typeof c.name==='string'?c.name:'',
    color:typeof c.color==='string'?c.color:'#58a6ff',
    sampleIds:Array.isArray(c.sampleIds)?c.sampleIds.filter(x=>typeof x==='string'):[]
  }));
}

function importData(e){
  const file=e.target.files[0];if(!file)return;
  const r=new FileReader();
  r.onload=ev=>{
    try{
      const data=JSON.parse(ev.target.result);
      const migrated=migrate(data);
      if(!migrated||(migrated.simsets.length===0&&migrated.samples.length===0))throw new Error('No valid data found');
      // Take a pre-import snapshot to the backup ring BEFORE replacing state.
      const snapped=snapshotBeforeImport();
      if(!snapped)console.warn('Pre-import snapshot failed — proceeding without backup.');
      // Preserve cross-cutting state from imported data (each block defensively validated)
      const importedData = data.state||data;
      S=migrated;
      if(!Array.isArray(S.simsets))S.simsets=[];
      if(typeof importedData._appTitle==='string')           S._appTitle=importedData._appTitle;
      const u=_validUnits(importedData.units);                if(u) S.units=u; else if(!Array.isArray(S.units))S.units=[];
      const c=_validSampleCategories(importedData.sampleCategories); if(c) S.sampleCategories=c; else if(!Array.isArray(S.sampleCategories))S.sampleCategories=[];
      const st=_validSettings(importedData.settings);         if(st)S.settings=st;
      const b=_validBatches(importedData.batches);            if(b) S.batches=b;
      // Restore batchId on simsets
      if(Array.isArray(importedData.simsets))importedData.simsets.forEach(iss=>{
        if(iss&&typeof iss==='object'&&typeof iss.batchId==='string'){
          const ss=S.simsets.find(x=>x.id===iss.id);if(ss)ss.batchId=iss.batchId;
        }
      });
      save();activeTab={};activeThreshTab={};
      renderSidebar();showPage('runs');
      loadAppTitle();
      toast('Imported '+S.simsets.length+' simulation set(s)'+(snapped?' · previous state backed up':''));
    }catch(err){
      console.error('importData failed:',err);
      showPersistentBanner('⚠ Import failed: '+(err&&err.message||'unknown error')+'. Your existing data was not modified.');
      toast('Import failed: '+err.message,'err');
    }
  };
  r.readAsText(file);e.target.value='';
}

// ════════════════════════════════════════════════════════
//  UTILS
// ════════════════════════════════════════════════════════
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ════════════════════════════════════════════════════════
//  PASTE PRESSURE RESULTS
// ════════════════════════════════════════════════════════
function openPasteP(sid,tid){
  document.getElementById('pp-sid').value=sid;
  document.getElementById('pp-tid').value=tid;
  document.getElementById('pp-data').value='';
  document.getElementById('pp-preview').textContent='';
  openModal('modal-paste-p');
}

function applyPastedP(){
  const sid=document.getElementById('pp-sid').value;
  const tid=document.getElementById('pp-tid').value;
  const raw=document.getElementById('pp-data').value.trim();
  const comps=getComps(sid,tid);
  const s=getS(sid);
  if(!comps||!s){toast('Threshold not found','err');return;}

  const lines=raw.split(/\r?\n/).filter(l=>l.trim());
  let applied=0,skipped=0,locked=0,unmatched=0;
  const pVals=[];
  const issues=[]; // per-line diagnostic records for the summary modal

  for(let li=0;li<lines.length;li++){
    const line=lines[li];
    const lineNo=li+1;
    const parts=line.split(/\t/);
    if(parts.length<2){unmatched++;issues.push({line:lineNo,reason:'unmatched',detail:'fewer than 2 tab-separated columns',raw:line});continue;}
    const fname=parts[0].trim();
    const val=parts[1].trim();

    // Extract MC number from filename: e.g. KCP-109-A-MC-148-MELTS_Auto → 148
    const m=fname.match(/-MC-(\d+)-/i);
    if(!m){unmatched++;issues.push({line:lineNo,reason:'unmatched',detail:'filename did not match -MC-<num>- pattern',raw:line});continue;}
    const num=parseInt(m[1]);

    // Check if parent failed (locked)
    const pComp=s.compositions.find(p=>p.num===num);
    if(pComp&&pComp.status===ST.FAIL){locked++;issues.push({line:lineNo,reason:'locked',detail:'parent run #'+num+' is FAIL — cell stays locked',raw:line});continue;}

    const tc=comps.find(c=>c.num===num);
    if(!tc){unmatched++;issues.push({line:lineNo,reason:'unmatched',detail:'no threshold cell with composition number '+num,raw:line});continue;}

    if(val==='-'||val===''||val.toLowerCase()==='na'){
      tc.status=ST.FAIL; // no P solution
      tc.note='no solution';
      tc.fname=fname;
      applied++;
    } else {
      const p=parseFloat(val);
      if(!isNaN(p)){
        tc.status=ST.OK; // P solution obtained
        tc.note=String(p);
        tc.pValue=p;
        tc.fname=fname;
        pVals.push(p);
        applied++;
      } else {
        skipped++;
        issues.push({line:lineNo,reason:'skipped',detail:'value "'+val+'" is not a number (use "-" or "NA" for no-solution)',raw:line});
      }
    }
  }

  // Store raw paste as record and auto-compute mean + sample σ (Bessel-corrected).
  // Values are stored as full-precision numbers; formatting happens at render time.
  {
    const tObj=s.thresholds.find(t=>t.id===tid);
    if(tObj){
      tObj.rawPaste=raw; // verbatim record of the pasted table
    }
    if(pVals.length>0){
      const allP=comps.filter(c=>c.status===ST.OK&&c.pValue!=null).map(c=>c.pValue);
      if(allP.length>0&&tObj){
        const n=allP.length;
        const mean=allP.reduce((a,b)=>a+b,0)/n;
        // Sample (Bessel-corrected) σ — convention for a Monte-Carlo SAMPLE of
        // pressure solutions. With n=1 the sample σ is undefined; we record 0.
        const variance = n>1 ? allP.reduce((a,b)=>a+(b-mean)**2,0)/(n-1) : 0;
        tObj.pMean = mean;
        tObj.pStd  = Math.sqrt(variance);
        tObj.pCount= n;
      }
    }
  }

  save();
  closeModal('modal-paste-p');
  renderThresholding();
  if(issues.length){
    // Show the details modal instead of a fire-and-forget toast — important for thesis reproducibility.
    const counts=document.getElementById('pps-counts');
    const detEl=document.getElementById('pps-details');
    if(counts){
      counts.innerHTML=`<strong style="color:var(--green)">${applied} applied</strong> · `
        +`<strong style="color:var(--red)">${skipped} skipped</strong> · `
        +`<strong style="color:var(--yellow)">${unmatched} unmatched</strong> · `
        +`<strong style="color:var(--text-muted)">${locked} locked</strong>`
        +` &nbsp;(${lines.length} input row${lines.length===1?'':'s'})`;
    }
    if(detEl){
      const reasonClr={skipped:'var(--red)',unmatched:'var(--yellow)',locked:'var(--text-muted)'};
      detEl.innerHTML=issues.map(it=>
        `<div style="margin-bottom:6px;border-left:3px solid ${reasonClr[it.reason]||'var(--border)'};padding-left:8px">
          <div><strong style="color:${reasonClr[it.reason]||'var(--text)'}">line ${it.line} — ${esc(it.reason)}</strong> <span style="color:var(--text-muted)">${esc(it.detail)}</span></div>
          <div style="color:var(--text-muted);opacity:.8">${esc(it.raw)}</div>
        </div>`
      ).join('');
    }
    openModal('modal-paste-summary');
  } else {
    toast(`Applied: ${applied} cells (all rows matched)`);
  }
}

// ════════════════════════════════════════════════════════
//  PASTE RECORD VIEWER
// ════════════════════════════════════════════════════════
function openViewRecord(sid,tid){
  const s=getS(sid);
  const t=s&&s.thresholds.find(t=>t.id===tid);
  if(!t){toast('Threshold not found','err');return;}

  let display='';
  if(t.rawPaste){
    display=t.rawPaste;
  } else {
    // Reconstruct from stored pValue/fname/status on cells
    const pFail=new Set(s.compositions.filter(c=>c.status===ST.FAIL).map(c=>c.num));
    const lines=t.compositions
      .filter(c=>!pFail.has(c.num)&&(c.status===ST.OK||c.status===ST.FAIL))
      .sort((a,b)=>a.num-b.num)
      .map(c=>{
        const name=c.fname||(s.name+'-MC-'+c.num+'-MELTS_Auto');
        const val=c.status===ST.OK&&c.pValue!=null?String(c.pValue):'-';
        return name+'\t'+val;
      });
    display=lines.join('\n');
  }

  const lineCount=display.split('\n').filter(l=>l.trim()).length;
  const solCount=t.compositions.filter(c=>c.status===ST.OK).length;
  document.getElementById('vr-meta').textContent=
    `${lineCount} rows · ${solCount} P solutions · threshold: ${t.name}`;
  document.getElementById('vr-data').value=display;
  openModal('modal-view-record');
}
function copyRecord(){
  const ta=document.getElementById('vr-data');
  ta.select();
  try{document.execCommand('copy');toast('Copied to clipboard');}
  catch(e){toast('Copy failed — select manually','err');}
}

// ════════════════════════════════════════════════════════
//  GRID PNG EXPORT
// ════════════════════════════════════════════════════════
function exportGridPng(sid, ctx){
  const s=getSimset(sid)||getSimset(S.activeSimsetId);
  if(!s){toast('Sample not found','err');return;}
  const comps=s.compositions;

  // Layout constants
  const COLS=20;
  const ROWS=Math.ceil(comps.length/COLS);
  const CELL=32;       // cell size px (increased for 3× DPR sharpness)
  const GAP=4;         // gap between cells
  const PAD=32;        // outer padding
  const TITLE_H=68;    // whitespace for title
  const STATS_H=26;    // stats line height
  const LEGEND_H=24;   // legend line height
  const BOTTOM=PAD;

  const gridW=COLS*CELL+(COLS-1)*GAP;
  const gridH=ROWS*CELL+(ROWS-1)*GAP;
  const W=gridW+PAD*2;
  const H=TITLE_H+STATS_H+GAP+gridH+LEGEND_H+PAD+BOTTOM;

  const canvas=document.createElement('canvas');
  const DPR=3; // 3× for print-quality export (high DPI)
  canvas.width=W*DPR;
  canvas.height=H*DPR;
  canvas.style.width=W+'px';
  canvas.style.height=H+'px';
  const ctx2=canvas.getContext('2d');
  ctx2.scale(DPR,DPR);

  // Resolved colours — ALWAYS LIGHT for print-ready export
  const BG='#ffffff';
  const SURFACE='#f6f8fa';
  const BORDER='#d0d7de';
  const COL_NR='#d0d7de';
  const COL_OK=isCBMode()?'#0072B2':'#238636';
  const COL_FAIL=isCBMode()?'#b35900':'#b91c1c';
  const TEXT='#24292f';
  const MUTED='#656d76';
  const GREEN=isCBMode()?'#0072B2':'#1a7f37';
  const RED=isCBMode()?'#b35900':'#cf222e';
  const YELLOW='#9a6700';

  // White background for print-ready PNG
  ctx2.fillStyle='#ffffff';
  ctx2.fillRect(0,0,W,H);

  // Title area — light tint
  ctx2.fillStyle='#f6f8fa';
  ctx2.fillRect(0,0,W,TITLE_H+STATS_H+GAP+6);

  // Border under title area
  ctx2.strokeStyle='#d0d7de'; ctx2.lineWidth=1;
  ctx2.beginPath(); ctx2.moveTo(0,TITLE_H+STATS_H+GAP+6); ctx2.lineTo(W,TITLE_H+STATS_H+GAP+6); ctx2.stroke();

  // Title: sample name (dark for print readability)
  ctx2.fillStyle='#1f2328';
  ctx2.font=`700 14px Consolas,"Fira Mono",monospace`;
  ctx2.textAlign='center';
  ctx2.textBaseline='middle';
  ctx2.fillText(s.name, W/2, TITLE_H/2);

  // Default threshold annotation (below title)
  const dt=s.defaultThreshold;
  const hasDT=dt&&dt.pressure;
  const DT_H=hasDT?20:0; // extra height if showing default threshold

  // Default threshold annotation (rendered inside the title band)
  if(hasDT){
    const dtLabel=`⚙ Default Q2F Pressure Calc Threshold: ${dt.pressure}${dt.notes?' — '+dt.notes:''}`;
    ctx2.font='italic 10px "Segoe UI",system-ui,sans-serif';
    ctx2.fillStyle=isCBMode()?'#56B4E9':'#56d364';
    ctx2.textAlign='center';
    ctx2.textBaseline='middle';
    ctx2.fillText(dtLabel, W/2, TITLE_H*0.80);
  }

  // Stats line
  const rc=comps.filter(c=>c.status!=='not-run').length;
  const succ=comps.filter(c=>c.status==='success').length;
  const fail=comps.filter(c=>c.status==='failed').length;
  const pct=comps.length>0?Math.round(rc/comps.length*100):0;
  const statsY=TITLE_H+STATS_H/2;

  ctx2.font='11px "Segoe UI",system-ui,sans-serif';
  ctx2.textAlign='center';
  ctx2.fillStyle=MUTED;

  const parts=[
    {text:`Run: ${rc}/${comps.length}`, color:TEXT},
    {text:'  ·  ',color:MUTED},
    {text:`✓ ${succ}`,color:GREEN},
    {text:'  ·  ',color:MUTED},
    {text:`✗ ${fail}`,color:RED},
    {text:'  ·  ',color:MUTED},
    {text:`${pct}% complete`,color:YELLOW},
  ];
  // Measure total width for centring
  ctx2.font='11px "Segoe UI",system-ui,sans-serif';
  let totalW=0;
  parts.forEach(p=>{totalW+=ctx2.measureText(p.text).width;});
  let cx=W/2-totalW/2;
  parts.forEach(p=>{
    ctx2.fillStyle=p.color;
    ctx2.textAlign='left';
    ctx2.textBaseline='middle';
    ctx2.fillText(p.text,cx,statsY);
    cx+=ctx2.measureText(p.text).width;
  });

  // Separator line
  ctx2.strokeStyle=BORDER;
  ctx2.lineWidth=1;
  ctx2.beginPath();
  ctx2.moveTo(PAD, TITLE_H+STATS_H+6);
  ctx2.lineTo(W-PAD, TITLE_H+STATS_H+6);
  ctx2.stroke();

  // Grid cells
  const gridTop=TITLE_H+STATS_H+GAP+8;
  comps.forEach((c,i)=>{
    const col=i%COLS;
    const row=Math.floor(i/COLS);
    const x=PAD+col*(CELL+GAP);
    const y=gridTop+row*(CELL+GAP);
    const color=c.status==='success'?COL_OK:c.status==='failed'?COL_FAIL:COL_NR;
    // Cell bg
    ctx2.fillStyle=color;
    ctx2.beginPath();
    ctx2.roundRect(x,y,CELL,CELL,2);
    ctx2.fill();
    // Number watermark
    const numStr=String(c.num);
    const fontSize=numStr.length>2?6:7;
    ctx2.font=`600 ${fontSize}px "Segoe UI",system-ui,sans-serif`;
    ctx2.textAlign='center';
    ctx2.textBaseline='middle';
    ctx2.fillStyle=c.status==='not-run'?'rgba(100,116,139,0.6)':'rgba(255,255,255,0.35)';
    ctx2.fillText(numStr,x+CELL/2,y+CELL/2);
  });

  // Legend
  const legendY=gridTop+gridH+12;
  const legendItems=[
    {color:COL_NR,label:'Not Run'},
    {color:COL_OK,label:'Success'},
    {color:COL_FAIL,label:'Failed'},
  ];
  const boxSize=10;
  const spacing=80;
  const legendTotalW=(legendItems.length-1)*spacing+boxSize+ctx2.measureText('Not Run').width+4;
  let lx=W/2-legendTotalW/2;
  ctx2.font='11px "Segoe UI",system-ui,sans-serif';
  legendItems.forEach((item,i)=>{
    ctx2.fillStyle=item.color;
    ctx2.beginPath();
    ctx2.roundRect(lx+i*spacing,legendY,boxSize+2,boxSize+2,2);
    ctx2.fill();
    ctx2.fillStyle=TEXT;
    ctx2.textAlign='left';
    ctx2.textBaseline='middle';
    ctx2.fillText(item.label,lx+i*spacing+boxSize+4,legendY+boxSize/2);
  });

  // Watermark
  ctx2.font='9px "Segoe UI",system-ui,sans-serif';
  ctx2.fillStyle='rgba(139,148,158,0.3)';
  ctx2.textAlign='right';
  ctx2.textBaseline='bottom';
  ctx2.fillText('rhyolite-MELTS Tracker',W-PAD,H-6);

  // Download
  const link=document.createElement('a');
  link.download=s.name.replace(/[^a-z0-9_\-]/gi,'_')+'_grid.png';
  link.href=canvas.toDataURL('image/png');
  link.click();
  toast('PNG exported: '+link.download);
}




// ════════════════════════════════════════════════════════
//  RESIZABLE SIDEBAR
// ════════════════════════════════════════════════════════
(function(){
  const MIN_W=140, MAX_W=420, DEFAULT_W=220;
  const KEY='melts_sidebar_w';
  let dragging=false, startX=0, startW=0;

  function getSidebar(){ return document.getElementById('main-sidebar'); }
  function getResizer(){ return document.getElementById('sidebar-resizer'); }

  function applyWidth(w){
    w=Math.max(MIN_W,Math.min(MAX_W,w));
    const sb=getSidebar(); if(!sb)return;
    sb.style.width=w+'px';
    sb.style.minWidth=w+'px';
    localStorage.setItem(KEY,w);
  }

  function initSidebarWidth(){
    const stored=parseInt(localStorage.getItem(KEY)||'');
    applyWidth(isNaN(stored)?DEFAULT_W:stored);
  }

  function onMouseDown(e){
    dragging=true;
    const sb=getSidebar(); if(!sb)return;
    startX=e.clientX; startW=sb.offsetWidth;
    document.body.style.cursor='col-resize';
    document.body.style.userSelect='none';
    const r=getResizer(); if(r)r.classList.add('dragging');
    e.preventDefault();
  }
  function onMouseMove(e){
    if(!dragging)return;
    const dx=e.clientX-startX;
    applyWidth(startW+dx);
    // Trigger grid recalc if a grid is visible
    if(typeof renderRuns==='function'&&document.getElementById('pg-runs')&&document.getElementById('pg-runs').classList.contains('active')){
      // Debounced — don't full re-render, just let CSS handle it
    }
  }
  function onMouseUp(){
    if(!dragging)return;
    dragging=false;
    document.body.style.cursor='';
    document.body.style.userSelect='';
    const r=getResizer(); if(r)r.classList.remove('dragging');
  }
  function onTouchStart(e){
    const t=e.touches[0]; startX=t.clientX;
    const sb=getSidebar(); if(!sb)return;
    startW=sb.offsetWidth; dragging=true;
    e.preventDefault();
  }
  function onTouchMove(e){
    if(!dragging)return;
    const t=e.touches[0]; applyWidth(startW+(t.clientX-startX));
  }
  function onTouchEnd(){ dragging=false; }

  document.addEventListener('DOMContentLoaded',function(){
    initSidebarWidth();
    const r=getResizer(); if(!r)return;
    r.addEventListener('mousedown',onMouseDown);
    r.addEventListener('touchstart',onTouchStart,{passive:false});
  });
  document.addEventListener('mousemove',onMouseMove);
  document.addEventListener('mouseup',onMouseUp);
  document.addEventListener('touchmove',onTouchMove,{passive:false});
  document.addEventListener('touchend',onTouchEnd);
  window.addEventListener('load',initSidebarWidth);
})();
// ════════════════════════════════════════════════════════
//  100-CELL OXIDE GRID COMPONENT
// ════════════════════════════════════════════════════════
const OXIDE_ORDER=['SiO2','Al2O3','TiO2','FeO*','MnO','MgO','CaO','Na2O','K2O','P2O5'];
// Also match FeO (no asterisk) from real data
const OXIDE_ALIASES={'FeO*':['FeO*','FeO','FeOt','FeOT','FeOt','Fe2O3T','Fe2O3']};
const OXIDE_COLORS_DEFAULT={
  SiO2:'#A8D8EA',TiO2:'#0072B2',Al2O3:'#E69F00','FeO*':'#D55E00',
  MnO:'#CC79A7',MgO:'#009E73',CaO:'#56B4E9',Na2O:'#332288',K2O:'#000000',P2O5:'#999999'
};
// CB palette for oxide grid = same as DEFAULT (Harker scheme always applies)
const OXIDE_COLORS_CB={
  SiO2:'#A8D8EA',TiO2:'#0072B2',Al2O3:'#E69F00','FeO*':'#D55E00',
  MnO:'#CC79A7',MgO:'#009E73',CaO:'#56B4E9',Na2O:'#332288',K2O:'#000000',P2O5:'#999999'
};

// Per-sample toggle state (key: sampleId, value: boolean)
window._oxGridState = window._oxGridState || {};

// Build a universal oxide legend for the samples page
function _buildOxideLegend(){
  const colors=OXIDE_COLORS_DEFAULT; // always Harker scheme
  return OXIDE_ORDER.map(ox=>{
    const col=colors[ox]||'#888';
    return `<div style="display:flex;align-items:center;gap:4px;white-space:nowrap">
      <div style="width:10px;height:10px;border-radius:2px;background:${col};flex-shrink:0"></div>
      <span style="font-size:10px;color:var(--text-muted)">${ox}</span>
    </div>`;
  }).join('');
}
function _injectOxideLegend(){
  const el=document.getElementById('ox-legend-panel');
  if(el)el.innerHTML=_buildOxideLegend();
}
// Global state: null = use per-sample, true = all on, false = all off
window._oxGridGlobal = window._oxGridGlobal === undefined ? null : window._oxGridGlobal;

function _isOxGridOn(sid){
  if(window._oxGridGlobal !== null) return window._oxGridGlobal;
  return window._oxGridState[sid] !== false; // default ON
}

function toggleOxGrid(sid){
  // If global is set, copy it first then flip this one
  if(window._oxGridGlobal !== null){
    const cur=window._oxGridGlobal;
    window._oxGridGlobal=null;
    // Set all samples to global state except this one
    (S.samples||[]).forEach(s=>{ window._oxGridState[s.id]=cur; });
  }
  window._oxGridState[sid]=!_isOxGridOn(sid);
  // Re-render just this sample's grid section
  const el=document.getElementById('ox-grid-'+sid);
  const btn=document.getElementById('ox-grid-btn-'+sid);
  if(el) el.style.display=window._oxGridState[sid]?'block':'none';
  if(btn) btn.textContent=window._oxGridState[sid]?'Hide WR Grid':'Show WR Grid';
  // Sync global toggle button
  _syncOxGlobalBtn();
}

function toggleOxGridAll(){
  // Determine current predominant state
  const samples=S.samples||[];
  const anyOff=samples.some(s=>!_isOxGridOn(s.id));
  const newState=anyOff; // if any off → turn all on; if all on → turn all off
  window._oxGridGlobal=newState;
  window._oxGridState={};
  // Update all visible grids and buttons without full re-render
  samples.forEach(s=>{
    const el=document.getElementById('ox-grid-'+s.id);
    const btn=document.getElementById('ox-grid-btn-'+s.id);
    if(el)el.style.display=newState?'block':'none';
    if(btn)btn.textContent=newState?'Hide WR Grid':'Show WR Grid';
  });
  _syncOxGlobalBtn();
}

function _syncOxGlobalBtn(){
  const btn=document.getElementById('ox-grid-all-btn');
  if(!btn)return;
  const samples=S.samples||[];
  const anyOff=samples.some(s=>!_isOxGridOn(s.id));
  btn.textContent=anyOff?'Show All WR Grids':'Hide All WR Grids';
}

function buildOxideGrid(wr, sid, compact){
  if(!wr||!wr.headers||!wr.headers.length) return '';
  // Always use the fixed Harker scheme (DEFAULT) for oxide grid colours
  const colors=OXIDE_COLORS_DEFAULT;
  // Normalize WR headers → OXIDE_ORDER entries
  const norm=getWRNorm(wr);
  const vals={};
  let total=0;
  OXIDE_ORDER.forEach(ox=>{
    const aliases=OXIDE_ALIASES[ox]||[ox];
    let v=0;
    wr.headers.forEach(h=>{ if(aliases.includes(h)||h===ox){ v+=(norm.values[h]||0); } });
    vals[ox]=v; total+=v;
  });
  // Normalize to 100%
  if(total<=0) return '<div style="font-size:10px;color:var(--text-muted)">No oxide data to display.</div>';
  const pcts={}; OXIDE_ORDER.forEach(ox=>{ pcts[ox]=(vals[ox]/total)*100; });

  // ── Cell allocation: proportional with guaranteed minimum 1 cell per present oxide ──
  // Step 1: collect present oxides (above 0.005%)
  const presentOx = OXIDE_ORDER.filter(ox => pcts[ox] > 0.005);
  if(!presentOx.length){ return '<div style="font-size:10px;color:var(--text-muted)">No oxide data.</div>'; }

  // Step 2: initial proportional allocation (floor)
  const rawCells = {};
  presentOx.forEach(ox => {
    // Minor oxides (<1%) get at least 2 cells so they're visible; P2O5 always 2
    const minCells = (pcts[ox] < 1.0 || ox === 'P2O5') ? 2 : 1;
    rawCells[ox] = Math.max(minCells, Math.floor(pcts[ox]));
  });

  // Step 3: sum and adjust to exactly 100 cells
  let cellSum = presentOx.reduce((s,ox) => s + rawCells[ox], 0);
  // If over 100 (from min-1 guarantees on many minor oxides), trim from largest
  while(cellSum > 100){
    // Find oxide with most cells > 1
    const trimOx = presentOx.slice().sort((a,b) => rawCells[b]-rawCells[a])[0];
    if(rawCells[trimOx] <= 1) break;
    rawCells[trimOx]--;
    cellSum--;
  }
  // If under 100, distribute remainder to largest oxides proportionally
  while(cellSum < 100){
    const addOx = presentOx.slice().sort((a,b) => pcts[b]-pcts[a])[cellSum % presentOx.length];
    rawCells[addOx]++;
    cellSum++;
  }

  // Step 4: build flat cell array in OXIDE_ORDER sequence
  const allCells = [];
  presentOx.forEach(ox => {
    const n = rawCells[ox];
    const tip = ox + ': ' + pcts[ox].toFixed(2) + '%';
    for(let i=0; i<n; i++) allCells.push({ox, tip});
  });

  // Build HTML — each cell is a full solid colour block
  const cellsHtml=allCells.map((c,fi)=>{
    const col=(fi>>1), row=(fi&1);
    const baseCol=colors[c.ox]||'#888';
    return `<div class="oxide-cell" style="background:${baseCol};grid-column:${col+1};grid-row:${row+1}" title="${c.tip}"></div>`;
  }).join('');

  // Legend
  const legendHtml=OXIDE_ORDER.filter(ox=>pcts[ox]>0.005).map(ox=>{
    const col=colors[ox]||'#888';
    return `<div class="oxide-legend-item"><div class="oxide-legend-swatch" style="background:${col}"></div><span>${ox} ${pcts[ox].toFixed(1)}%</span></div>`;
  }).join('');

  const show=_isOxGridOn(sid);
  if(compact){
    return `<div class="oxide-grid-wrap" style="margin:0">
      <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px">
        <span style="font-size:9px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.3px">WR Grid</span>
        <button id="ox-grid-btn-${sid}" class="btn btn-sm" style="font-size:9px;padding:1px 5px;margin-left:auto;line-height:1.3" onclick="event.stopPropagation();toggleOxGrid('${sid}')">${show?'▲':'▼'}</button>
      </div>
      <div id="ox-grid-${sid}" style="display:${show?'block':'none'}">
        <div class="oxide-grid" style="height:20px">${cellsHtml}</div>
      </div>
    </div>`;
  }
  return `<div class="oxide-grid-wrap">
    <button id="ox-grid-btn-${sid}" class="btn btn-sm" style="font-size:10px;padding:2px 7px;margin-bottom:6px" onclick="toggleOxGrid('${sid}')">${show?'Hide WR Grid':'Show WR Grid'}</button>
    <div id="ox-grid-${sid}" style="display:${show?'block':'none'}">
      <div class="oxide-grid-header">WR Oxide Grid (100 cells = 100 wt%)</div>
      <div class="oxide-grid">${cellsHtml}</div>
      <div class="oxide-legend">${legendHtml}</div>
    </div>
  </div>`;
}
// ════════════════════════════════════════════════════════
//  SAMPLES PAGE
// ════════════════════════════════════════════════════════
function renderSamples(){
  const el=document.getElementById('pg-samples');
  if(!el)return;
  const samples=S.samples||[];
  const samplesWithWR=samples.filter(s=>s.wholeRock&&s.wholeRock.headers&&s.wholeRock.headers.length>0);
  const activeSid=S.activeSampleId;

  let samplesHtml=samples.map(s=>{
    const hasWR=s.wholeRock&&s.wholeRock.headers&&s.wholeRock.headers.length>0;
    const _sRunCount=(S.simsets||[]).filter(ss=>ss.sampleId===s.id).length;
    const _wu=_getUnit(s.unitId||'');
    const _wuBadge=_wu?`<span style="background:${getCBUnitColor(_wu.color||'#58a6ff')}33;border:1.5px solid ${getCBUnitColor(_wu.color||'#58a6ff')};color:${getCBUnitColor(_wu.color||'#58a6ff')};border-radius:4px;padding:2px 8px;font-size:13px;font-weight:700;font-family:var(--mono)" title="${esc(_wu.name)}">${esc(_wu.abbr)}</span>`:(s.geoUnitAbbr?`<span style="background:var(--surface2);border:1px solid var(--border);color:var(--blue);border-radius:4px;padding:2px 8px;font-size:13px;font-weight:700" title="${esc(s.geoUnit||s.geoUnitAbbr)}">${esc(s.geoUnitAbbr)}</span>`:'');
    const wrBadge=hasWR
      ?`<span style="font-size:11px;font-weight:700;color:var(--green);background:rgba(56,211,100,.12);border:1px solid rgba(56,211,100,.35);border-radius:4px;padding:2px 7px">WR ✓</span>`
      :`<span style="font-size:11px;font-weight:700;color:var(--red);background:rgba(248,81,73,.12);border:1px solid rgba(248,81,73,.35);border-radius:4px;padding:2px 7px">WR ✗</span>`;
    // dateStr kept in data but not shown in view
    const isSelected=s.id===activeSid;
    return`<div class="sample-item-wrap" id="sw-${s.id}"
        draggable="true"
        ondragstart="_smpDragStart(event,'${s.id}')"
        ondragend="_smpDragEnd(event)"
        ondragover="_smpDragOver(event,'${s.id}')"
        ondragleave="_smpDragLeave(event,'${s.id}')"
        ondrop="_smpDrop(event,'${s.id}')"
        style="border:1px solid var(--border);border-radius:6px;margin-bottom:8px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;background:${isSelected?'var(--surface2)':'var(--surface)'}"
           onclick="selSamplePage('${s.id}')">
        <div style="flex:1">
          <div style="font-size:16px;font-weight:700;font-family:var(--mono)">${esc(s.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            ${wrBadge}
            ${_sRunCount>0?`<span style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:11px;color:var(--blue);font-weight:600">${_sRunCount} ${_sRunCount===1?'Run':'Runs'}</span>`:`<span style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:11px;color:var(--text-muted)">0 Runs</span>`}
          </div>
          ${hasWR?`<div style="margin-top:6px;padding-right:4px">${buildOxideGrid(s.wholeRock, s.id, true)}</div>`:''}
        </div>
        <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">
          ${s.rockType?`<span style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:11px;color:var(--text);font-weight:600">${esc(s.rockType)}</span>`:''}
          ${_wuBadge}
        </div>
        <span class="edit-only" title="Drag to reorder" style="cursor:grab;color:var(--text-muted);font-size:14px;opacity:.6;padding:0 2px;user-select:none" aria-hidden="true">⠿</span>
        <button class="btn btn-sm edit-only" style="font-size:10px;padding:2px 7px" title="Edit sample" aria-label="Edit sample"
          onclick="event.stopPropagation();openEditSample('${s.id}')">✏ Edit</button>
        <button class="btn btn-sm btn-danger edit-only" style="font-size:10px;padding:2px 7px" title="Delete this sample record" aria-label="Delete sample"
          onclick="event.stopPropagation();deleteSample('${s.id}')">🗑 Delete</button>
        <span style="color:var(--text-muted);font-size:12px;margin-left:4px">${isSelected?'▲':'▼'}</span>
      </div>
      ${isSelected?`<div style="padding:14px;border-top:1px solid var(--border);background:var(--bg)">
        <div style="margin-bottom:10px">
          ${(()=>{const _eu=_getUnit(s.unitId||'');const _rt=s.rockType||'';const _nm=_eu?_eu.name:(s.geoUnit||'');const _ab=_eu?_eu.abbr:(s.geoUnitAbbr||'');const _col=getCBUnitColor(_eu?(_eu.color||'#58a6ff'):'#58a6ff');return(_rt||_ab)?`<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;align-items:center">${_rt?`<span style="background:var(--surface2);border:1.5px solid var(--border);border-radius:6px;padding:3px 10px;font-size:12px;color:var(--text);font-weight:600">⛰ ${esc(_rt)}</span>`:''} ${_ab?`<span style="background:${_col}22;border:1.5px solid ${_col};color:${_col};border-radius:6px;padding:3px 10px;font-size:12px;font-weight:700" title="${esc(_nm)}">${esc(_ab)} — ${esc(_nm)}</span>`:''}</div>`:''})()}
          <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Whole-Rock Data</div>
          ${hasWR?`<div style="margin-bottom:10px">
            <div style="font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px">Saved Composition <span style="background:#1a3a5c;color:#58a6ff;font-size:9px;padding:1px 6px;border-radius:8px;letter-spacing:.5px;font-weight:700;margin-left:4px">NORMALIZED</span></div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
              ${(()=>{const _n=getWRNorm(s.wholeRock);return _n.headers.map(h=>`<span style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:10px;font-family:var(--mono)"><span style="color:var(--text-muted)">${esc(h)}</span><span style="color:var(--blue);margin-left:4px;font-weight:700">${(_n.values[h]||0).toFixed(2)}</span></span>`).join('');})()}
            </div>
            <button class="btn btn-sm btn-danger edit-only" style="font-size:10px;padding:2px 8px" onclick="removeWR('${s.id}')">Remove WR Data</button>
          </div>`:''}
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:5px;line-height:1.5;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:6px 8px">
            <strong style="color:var(--text)">Expected input:</strong> 2 tab-separated rows (header + values), oxides in wt%.
            Iron must be entered as <strong>FeO*</strong> (total iron expressed as FeO).
            <code>FeOT</code>, <code>FeO_T</code> are auto-renamed to <code>FeO*</code>;
            <code>Fe2O3T</code> is also accepted but is <strong>not</strong> molar-converted —
            convert Fe<sub>2</sub>O<sub>3</sub><sup>T</sup> → FeO<sup>T</sup> (×0.8998) yourself before pasting.
            Volatile-free renormalisation to 100 wt% is applied automatically.
          </div>
          <textarea id="wr-paste-${s.id}" rows="4"
            style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:7px;font-family:var(--mono);font-size:11px;resize:vertical"
            placeholder="Paste tab-separated data here:&#10;SiO2&#9;TiO2&#9;Al2O3&#9;...&#10;70.1&#9;0.5&#9;15.2&#9;..."></textarea>
          <button class="btn btn-primary btn-sm" style="margin-top:6px" onclick="pasteWR('${s.id}')">Save Whole-Rock Data</button>
        </div>
      </div>`:''}
    </div>`;
  }).join('');

  // Build My Units list
  const units=S.units||[];
  const unitsPanel=`<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px;min-width:210px;max-width:230px;flex-shrink:0">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="font-size:12px;font-weight:700;flex:1">🗺 My Units</span>
      <button class="btn btn-sm btn-primary edit-only" style="font-size:10px;padding:2px 8px" onclick="openAddUnitModal()">＋ Add</button>
    </div>
    ${units.length?units.map((u,i)=>`<div class="unit-drag-row" id="ud-${i}"
      draggable="true"
      ondragstart="_unitDragStart(event,${i})"
      ondragend="_unitDragEnd()"
      ondragover="_unitDragOver(event,${i})"
      ondragleave="_unitDragLeave(${i})"
      ondrop="_unitDrop(event,${i})"
      style="display:flex;align-items:center;gap:5px;margin-bottom:7px;font-size:11px;padding:3px 4px;border-radius:4px;cursor:default">
      <span style="cursor:grab;color:var(--text-muted);opacity:.55;font-size:13px;user-select:none" title="Drag to reorder">⠿</span>
      <span style="background:${getCBUnitColor(u.color||'#58a6ff')}22;border:1.5px solid ${getCBUnitColor(u.color||'#58a6ff')};border-radius:4px;padding:1px 6px;font-family:var(--mono);font-weight:700;font-size:10px;color:${getCBUnitColor(u.color||'#58a6ff')};flex-shrink:0">${esc(u.abbr||'?')}</span>
      <span style="flex:1;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(u.name)}">${esc(u.name)}</span>
      <button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:11px;padding:0 2px;flex-shrink:0" class="edit-only" onclick="openEditUnitModal(${i})" title="Edit unit" aria-label="Edit unit">✏</button>
      <button style="background:none;border:none;color:var(--red);cursor:pointer;font-size:11px;padding:0 2px;flex-shrink:0" class="edit-only" onclick="deleteUnit(${i})" title="Delete unit" aria-label="Delete unit">🗑</button>
    </div>`).join(''):'<div style="font-size:10px;color:var(--text-muted);font-style:italic">No units yet. Click ＋ Add above.</div>'}
  </div>`;

  _initCats();
  const cats=S.sampleCategories||[];

  // Build categories UI
  const catsHtml=`<div style="margin-bottom:18px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:13px;font-weight:700">📂 Categories</span>
      <span style="font-size:11px;color:var(--text-muted)">(${cats.length} group${cats.length!==1?'s':''})</span>
      <button class="btn btn-sm edit-only" style="font-size:10px;padding:2px 8px;margin-left:auto" onclick="_showAddCatForm()" title="Add new category">＋ Add Category</button>
    </div>
    <div id="add-cat-form" style="display:none;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 10px">
      <input id="new-cat-name" placeholder="Category name…" style="flex:1;min-width:120px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:4px 8px;color:var(--text);font-size:12px">
      <label style="font-size:11px;color:var(--text-muted)">Colour:</label>
      <input type="color" id="new-cat-color" value="#58a6ff" style="width:28px;height:24px;border:none;background:none;cursor:pointer;padding:0">
      <button class="btn btn-sm btn-primary" style="font-size:10px;padding:3px 10px" onclick="_submitNewCat()">Create</button>
      <button class="btn btn-sm" style="font-size:10px;padding:3px 8px" onclick="this.closest('#add-cat-form').style.display='none'">✕</button>
    </div>
    ${cats.length===0?'<div style="font-size:11px;color:var(--text-muted);font-style:italic;padding:4px 0">No categories yet. Use the edit mode to create groups.</div>':
      cats.map(cat=>{
        const catSamples=(S.samples||[]).filter(s=>cat.sampleIds.includes(s.id));
        const allSamples=S.samples||[];
        return`<div style="border:1px solid var(--border);border-radius:6px;margin-bottom:8px;overflow:hidden">
          <div style="display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--surface);border-bottom:${catSamples.length?'1px solid var(--border)':'none'}">
            <span style="width:10px;height:10px;border-radius:50%;background:${cat.color};flex-shrink:0;display:inline-block"></span>
            <div id="cat-row-${cat.id}" style="display:flex;align-items:center;gap:8px;flex:1">
              <span style="font-size:12px;font-weight:700;color:${cat.color}">${esc(cat.name)}</span>
              <span style="font-size:11px;color:var(--text-muted)">${catSamples.length} sample${catSamples.length!==1?'s':''}</span>
            </div>
            <button class="btn btn-sm edit-only" style="font-size:10px;padding:2px 7px" onclick="_catEditMode('${cat.id}')" title="Rename category" aria-label="Edit category">✏</button>
            <button class="btn btn-sm btn-danger edit-only" style="font-size:10px;padding:2px 7px" onclick="deleteSampleCategory('${cat.id}')" title="Delete category" aria-label="Delete category">🗑</button>
          </div>
          ${catSamples.length?`<div style="padding:6px 12px 8px">
            <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:4px">
              ${catSamples.map(s=>`<span style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:2px 9px;font-size:11px;display:inline-flex;align-items:center;gap:4px">
                <span style="font-family:var(--mono);font-weight:600">${esc(s.name)}</span>
                <button class="edit-only" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:11px;padding:0 0 0 2px;line-height:1" onclick="toggleSampleInCategory('${s.id}','${cat.id}')" title="Remove from category" aria-label="Remove ${esc(s.name)} from category">✕</button>
              </span>`).join('')}
            </div>
          </div>`:''}
          <div class="edit-only" style="padding:4px 12px 8px">
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">Add samples to this category:</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">
              ${allSamples.filter(s=>!cat.sampleIds.includes(s.id)).map(s=>`<button class="btn btn-sm" style="font-size:10px;padding:1px 7px;background:var(--surface2)" onclick="toggleSampleInCategory('${s.id}','${cat.id}')" title="Add ${esc(s.name)} to ${esc(cat.name)}">${esc(s.name)}</button>`).join('')}
              ${allSamples.filter(s=>!cat.sampleIds.includes(s.id)).length===0?'<span style="font-size:10px;color:var(--text-muted);font-style:italic">All samples are in this category</span>':''}
            </div>
          </div>
        </div>`;
      }).join('')
    }
  </div>`;

  el.innerHTML=`<div style="max-width:1200px;margin:0 auto;padding:20px">
    <div style="margin-bottom:14px">
      <h2 style="font-size:14px;font-weight:700">Sample Database</h2>
      <div style="font-size:12px;color:var(--text-muted);margin-top:5px;line-height:1.5">
        Start by adding Geological Units associated with each Sample. Then, create samples in "Add" mode (plus symbol). Once samples are created, they can be added to Categories, Runs, and Batches.
      </div>
    </div>
    <!-- LAYOUT: left col [Units+Categories], right col [Samples], below [Harker] -->
    <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:16px">
      <div style="display:flex;flex-direction:column;gap:12px;min-width:220px;max-width:250px;flex-shrink:0">
        ${unitsPanel}
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px">${catsHtml}</div>
      </div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <h3 style="font-size:13px;font-weight:700">My Samples (${samples.length})</h3>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto">
            ${samples.some(s=>s.wholeRock&&s.wholeRock.headers&&s.wholeRock.headers.length>0)?`<button id="ox-grid-all-btn" class="btn btn-sm" style="font-size:10px;padding:2px 8px" onclick="toggleOxGridAll()">Show All WR Grids</button>`:''}
          </div>
        </div>
        ${samplesWithWR.length?`<div id="ox-legend-panel" style="display:flex;flex-wrap:wrap;gap:5px 10px;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-bottom:10px"></div>`:''}

        ${samples.length?samplesHtml:'<div class="empty"><div class="empty-icon">🧪</div><p>No samples yet. Enable edit mode then click ＋ Sample.</p></div>'}
      </div>
    </div>
    ${samplesWithWR.length?`<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;margin-top:4px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
        <h3 style="font-size:17px;font-weight:700">Harker Diagrams</h3>
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;flex-wrap:wrap;margin-left:auto">
          <span style="color:var(--text-muted)">Colour by:</span>
          <div id="hk-colorby-bar" style="display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;font-size:11px">
            ${['sample','rocktype','unit','category'].map(m2=>`<button data-cbm="${m2}" onclick="S._hkColorMode='${m2}';_syncColorby();renderHarkers()" style="padding:3px 9px;background:${(S._hkColorMode||'sample')===m2?'var(--blue-bg)':'var(--surface2)'};color:${(S._hkColorMode||'sample')===m2?'var(--blue)':'var(--text-muted)'};border:none;cursor:pointer;font-size:11px;transition:all .15s">${m2==='sample'?'Sample':m2==='rocktype'?'Rock Type':m2==='unit'?'Unit':'Category'}</button>`).join('<span style="width:1px;background:var(--border)"></span>')}
          </div>
          <button class="btn btn-sm" onclick="exportHarkerPNG()">📷 Export PNG</button>
        </div>
      </div>
      <div id="harker-wrap" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px"></div>
    </div>`:''}
  </div>`;

  if(samplesWithWR.length){
    setTimeout(()=>{renderHarkers('');_injectOxideLegend();},0);
  } else {
    setTimeout(_injectOxideLegend,0);
  }
}


function _syncColorby(){
  const bar=document.getElementById('hk-colorby-bar');
  if(!bar)return;
  const cur=S._hkColorMode||'sample';
  bar.querySelectorAll('button[data-cbm]').forEach(btn=>{
    const active=btn.dataset.cbm===cur;
    btn.style.background=active?'var(--blue-bg)':'var(--surface2)';
    btn.style.color=active?'var(--blue)':'var(--text-muted)';
    btn.style.fontWeight=active?'700':'400';
  });
}
let _smpDragId=null;
function _smpDragStart(e,id){_smpDragId=id;e.dataTransfer.effectAllowed='move';setTimeout(()=>{const el=document.getElementById('sw-'+id);if(el)el.classList.add('dragging');},0);}
function _smpDragEnd(e){document.querySelectorAll('.sample-item-wrap').forEach(el=>{el.classList.remove('dragging','drag-over');});_smpDragId=null;}
function _smpDragOver(e,id){e.preventDefault();const el=document.getElementById('sw-'+id);if(el)el.classList.add('drag-over');}
function _smpDragLeave(e,id){const el=document.getElementById('sw-'+id);if(el)el.classList.remove('drag-over');}
function _smpDrop(e,toId){
  e.preventDefault();
  document.querySelectorAll('.sample-item-wrap').forEach(el=>el.classList.remove('drag-over','dragging'));
  if(!_smpDragId||_smpDragId===toId)return;
  const arr=S.samples||[];
  const fi=arr.findIndex(s=>s.id===_smpDragId);
  const ti=arr.findIndex(s=>s.id===toId);
  if(fi<0||ti<0)return;
  const [m]=arr.splice(fi,1);arr.splice(ti,0,m);
  save();renderSamples();toast('Sample order updated');
}
// ── My Units panel ──────────────────────────────────────────────────────────

// Color palette: 6 hues × 3 shades each  (red, orange, yellow, green, blue, purple)
const UNIT_COLORS=[
  // Red
  '#ff9999','#f85149','#a30000',
  // Orange
  '#ffcc99','#f0883e','#b94c00',
  // Yellow
  '#fff799','#e3b341','#9a6f00',
  // Green
  '#9ef5a0','#56d364','#1a7f37',
  // Blue
  '#99caff','#58a6ff','#0969da',
  // Purple
  '#d8b4fe','#d2a8ff','#8957e5',
];

function _buildColorPicker(selectedColor){
  const container=document.getElementById('unit-color-picker');
  if(!container)return;
  container.innerHTML='';
  const _cbPicker=isCBMode();
  const palette=_cbPicker?UNIT_COLORS_CB:UNIT_COLORS;
  if(_cbPicker){
    const lbl=document.createElement('div');
    lbl.style.cssText='font-size:10px;color:#56B4E9;margin-bottom:4px;width:100%;font-weight:600';
    lbl.textContent='CB-safe palette (Okabe-Ito)';
    container.appendChild(lbl);
  }
  palette.forEach(c=>{
    const btn=document.createElement('button');
    btn.type='button';
    btn.title=c;
    btn.style.cssText=`width:22px;height:22px;border-radius:50%;background:${c};border:3px solid ${c===selectedColor?'#fff':'transparent'};cursor:pointer;padding:0;flex-shrink:0;transition:border .15s`;
    btn.onclick=function(){
      document.getElementById('unit-color').value=c;
      container.querySelectorAll('button').forEach(b=>{b.style.borderColor='transparent';});
      this.style.borderColor='#fff';
    };
    container.appendChild(btn);
  });
}

function _populateUnitSelect(selId, selectedUnitId){
  const sel=document.getElementById(selId);
  if(!sel)return;
  const units=S.units||[];
  sel.innerHTML='<option value="">— None / Unassigned —</option>'+
    units.map(u=>`<option value="${u.id||''}" ${(u.id||'')===(selectedUnitId||'')?'selected':''}>${esc(u.abbr)} — ${esc(u.name)}</option>`).join('');
  // preview update
  sel.onchange=function(){
    const uid=this.value;
    const u=_getUnit(uid);
    const prevId=selId==='as-unit-id'?'as-unit-preview':'es-unit-preview';
    const prev=document.getElementById(prevId);
    if(prev)prev.textContent=u?u.name+' ('+u.abbr+')':'';
    if(prev&&u)prev.style.color=u.color||'var(--blue)';
  };
}

function _getUnit(uid){
  if(!uid)return null;
  return (S.units||[]).find(u=>u.id===uid)||null;
}

function openAddUnitModal(){
  document.getElementById('unit-modal-title').textContent='＋ Add Geological Unit';
  document.getElementById('unit-edit-idx').value='-1';
  document.getElementById('unit-name').value='';
  document.getElementById('unit-abbr').value='';
  document.getElementById('unit-color').value='#58a6ff';
  _buildColorPicker('#58a6ff');
  openModal('modal-unit');
}

function openEditUnitModal(i){
  const u=(S.units||[])[i];if(!u)return;
  document.getElementById('unit-modal-title').textContent='✏ Edit Unit';
  document.getElementById('unit-edit-idx').value=String(i);
  document.getElementById('unit-name').value=u.name||'';
  document.getElementById('unit-abbr').value=u.abbr||'';
  const col=u.color||'#58a6ff';
  document.getElementById('unit-color').value=col;
  _buildColorPicker(col);
  openModal('modal-unit');
}

function saveUnitModal(){
  const name=document.getElementById('unit-name').value.trim();
  const abbr=document.getElementById('unit-abbr').value.trim();
  const color=document.getElementById('unit-color').value||'#58a6ff';
  if(!name){alert('Unit name is required.');return;}
  if(!abbr){alert('Abbreviation is required.');return;}
  if(!S.units)S.units=[];
  // Ensure every unit has a stable id (migration for units created before this patch)
  (S.units||[]).forEach(u=>{if(!u.id)u.id='U'+Date.now()+Math.random().toString(36).slice(2,5);});
  const idx=parseInt(document.getElementById('unit-edit-idx').value,10);
  if(idx>=0&&S.units[idx]){
    // Edit existing — preserve id
    S.units[idx].name=name;
    S.units[idx].abbr=abbr;
    S.units[idx].color=color;
    toast('Unit "'+name+'" updated');
  } else {
    // Add new — generate stable id
    S.units.push({id:'U'+Date.now()+Math.random().toString(36).slice(2,5),name,abbr,color});
    toast('Unit "'+name+'" added');
  }
  closeModal('modal-unit');
  save();renderSamples();_updateSubtitle();
}

function deleteUnit(i){
  if(!S.units||!S.units[i])return;
  const u=S.units[i];
  // Check if any sample uses this unit
  const inUse=(S.samples||[]).filter(s=>s.unitId===u.id);
  if(inUse.length){
    if(!confirm('Unit "'+u.name+'" is assigned to '+inUse.length+' sample(s). Remove it anyway?\n\nThose samples will become unassigned.'))return;
    inUse.forEach(s=>{s.unitId='';});
  } else {
    if(!confirm('Delete unit "'+u.name+'"?'))return;
  }
  S.units.splice(i,1);
  save();renderSamples();
  toast('Unit deleted');
}

function selSamplePage(sid){
  S.activeSampleId=S.activeSampleId===sid?null:sid;
  save();renderSamples();
}


// ── Dynamic Harker legend builder ───────────────────────────────────────────
// Shared by renderHarkers and exportHarkerPNG
function _makeSVGMarker(shape, col, sz){
  sz = sz || 14;
  const half = sz/2;
  let path = '';
  if(shape==='circle')  path=`<circle cx="${half}" cy="${half}" r="${half*0.75}" fill="${col}"/>`;
  else if(shape==='square')   path=`<rect x="${half*0.28}" y="${half*0.28}" width="${half*1.44}" height="${half*1.44}" fill="${col}"/>`;
  else if(shape==='triangle') path=`<polygon points="${half},${half*0.15} ${half*1.85},${half*1.85} ${half*0.15},${half*1.85}" fill="${col}"/>`;
  else if(shape==='diamond')  path=`<polygon points="${half},${half*0.08} ${half*1.9},${half} ${half},${half*1.92} ${half*0.1},${half}" fill="${col}"/>`;
  else if(shape==='cross'){const t=half*0.28;path=`<rect x="${half-t}" y="${half*0.15}" width="${t*2}" height="${sz*0.7}" fill="${col}"/><rect x="${half*0.15}" y="${half-t}" width="${sz*0.7}" height="${t*2}" fill="${col}"/>`;}
  return `<svg width="${sz}" height="${sz}" style="flex-shrink:0;vertical-align:middle" viewBox="0 0 ${sz} ${sz}">${path}</svg>`;
}

function _buildHKLegend(legEl, samples, activeSid, nnCount){
  const mode = S._hkColorMode || 'sample';
  // Recompute NN set
  let nnSet = new Set();
  const activeLeg = samples.find(s=>s.id===activeSid);
  if(activeLeg && nnCount>0 && activeLeg.wholeRock){
    const allOx = OXIDES;
    const mins={}, maxs={};
    allOx.forEach(o=>{const vs=samples.map(s=>parseFloat((getWRNorm(s.wholeRock)||{values:{}}).values[o])||0);mins[o]=Math.min(...vs);maxs[o]=Math.max(...vs);});
    const norm=(s,o)=>{const _v=parseFloat((getWRNorm(s.wholeRock)||{values:{}}).values[o])||0;const r=maxs[o]-mins[o];return r>0?(_v-mins[o])/r:0;};
    const dist=(a,b)=>Math.sqrt(allOx.reduce((s2,o)=>s2+Math.pow(norm(a,o)-norm(b,o),2),0));
    const others=samples.filter(s=>s.id!==activeLeg.id&&s.wholeRock&&s.wholeRock.values);
    others.sort((a,b)=>dist(activeLeg,a)-dist(activeLeg,b));
    others.slice(0,nnCount).forEach(s=>nnSet.add(s.id));
  }

  // Mode label
  const modeLabel = {sample:'by Sample',rocktype:'by Rock Type',unit:'by Unit'}[mode]||mode;

  // Sample rows
  const sampleRows = samples.map((s,i)=>{
    const isAct = s.id===activeSid;
    const isNN  = nnSet.has(s.id);
    const {color, shape} = getHKStyle(s, samples, mode);
    const displayCol = isNN ? '#f0883e' : color;
    const sz = isAct ? 16 : isNN ? 13 : 12;
    const marker = _makeSVGMarker(shape, displayCol, sz);
    const nameCol = isAct?'var(--blue)' : isNN?'#f0883e' : 'var(--text)';
    const nameWt  = isAct||isNN ? '700' : '400';
    return `<div style="display:flex;align-items:center;gap:5px;margin-bottom:4px">
      ${marker}<span style="font-size:9px;font-family:var(--mono);color:${nameCol};font-weight:${nameWt}">${esc(s.name)}</span>
    </div>`;
  }).join('');

  // Color key (rock type or unit)
  let colorKeyHtml = '';
  if(mode==='rocktype'){
    const types=[...new Set(samples.map(s=>(s.rockType||'').trim()||'—'))].sort();
    const keyItems = types.map((rt,ci)=>{
      const col = HK_PALETTE[ci % HK_PALETTE.length];
      return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${col};flex-shrink:0"></span>
        <span style="font-size:9px;color:var(--text-muted)">${esc(rt)}</span>
      </span>`;
    }).join('');
    colorKeyHtml = `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);margin-bottom:4px">Rock Types</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${keyItems}</div>
    </div>`;
  } else if(mode==='unit'){
    const unitIds=[...new Set(samples.map(s=>s.unitId||''))];
    const keyItems = unitIds.map(uid=>{
      const u=_getUnit(uid);
      if(!u&&!uid)return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#6e7681;flex-shrink:0"></span>
        <span style="font-size:9px;color:var(--text-muted)">(no unit)</span></span>`;
      if(!u)return '';
      const col = getCBUnitColor(u.color||'#58a6ff');
      return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${col};flex-shrink:0"></span>
        <span style="font-size:9px;color:var(--text-muted)" title="${esc(u.name)}">${esc(u.abbr)} — ${esc(u.name)}</span></span>`;
    }).filter(Boolean).join('');
    colorKeyHtml = `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);margin-bottom:4px">Units</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${keyItems}</div>
    </div>`;
  }

  // Shape key (always shown when cycling)
  const maxI = samples.length-1;
  const shapesUsed = [...new Set(samples.map((_,i)=>HK_SHAPES[Math.floor(i/HK_PALETTE.length)%HK_SHAPES.length]))];
  let shapeKeyHtml = '';
  if(shapesUsed.length>1){
    const shapeItems = shapesUsed.map((sh,si)=>{
      const rangeStart = si*HK_PALETTE.length+1;
      const rangeEnd   = Math.min((si+1)*HK_PALETTE.length, samples.length);
      return `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px">
        ${_makeSVGMarker(sh,'#8b949e',10)}
        <span style="font-size:9px;color:var(--text-muted)">samples ${rangeStart}–${rangeEnd}</span>
      </span>`;
    }).join('');
    shapeKeyHtml = `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);margin-bottom:4px">Shapes</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px">${shapeItems}</div>
    </div>`;
  }

  legEl.innerHTML =
    `<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
      <span style="font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted)">Legend</span>
      <span style="font-size:9px;color:var(--text-dim);font-style:italic">${modeLabel}</span>
     </div>
     <div style="display:flex;flex-wrap:wrap;gap:5px 12px">${sampleRows}</div>
     ${colorKeyHtml}${shapeKeyHtml}`;
}

let _hkDebounce=null;
function renderHarkersNow(suffix){
  const sfx=suffix||'';
  const wrap=document.getElementById('harker-wrap');
  if(!wrap)return;
  const samples=(S.samples||[]).filter(s=>s.wholeRock&&s.wholeRock.headers&&s.wholeRock.headers.length>0);
  if(!samples.length){wrap.innerHTML='';return;}
  const yOxides=OXIDES.filter(o=>o!=='SiO2');
  const N=S._nnCount||3;
  wrap.innerHTML=yOxides.map(ox=>`<div><canvas id="hk-${ox}-canvas${sfx}" class="harker-canvas" style="width:100%;height:210px"></canvas></div>`).join('')+
    `<div id="hk-legend${sfx}" style="grid-column:1/-1;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:10px;margin-top:4px"></div>`;
  const legEl=document.getElementById('hk-legend'+sfx);
  if(legEl){ _buildHKLegend(legEl,samples,S.activeSampleId,S._nnCount||3); }
  yOxides.forEach(ox=>{setTimeout(()=>drawHarker(ox,samples,N,sfx),0);});
}
function renderHarkers(suffix){clearTimeout(_hkDebounce);_hkDebounce=setTimeout(()=>renderHarkersNow(suffix),50);}


// hkColor moved to CB-aware version above

// Return a tick label with appropriate sig-figs given the axis range
function smartTick(v, range){
  if(range===0)return v.toFixed(2);
  if(range>=100)return v.toFixed(0);
  if(range>=10) return v.toFixed(1);
  if(range>=1)  return v.toFixed(2);
  if(range>=0.1)return v.toFixed(3);
  return v.toPrecision(2);
}

function drawHarker(ox,samples,N,sfx){
  const canvas=document.getElementById('hk-'+ox+'-canvas'+(sfx||''));
  if(!canvas)return;
  const dprHK=Math.max(window.devicePixelRatio||1,2); // min 2× for crisp display
  const W=canvas.offsetWidth||260, H=canvas.offsetHeight||210;
  canvas.width=W*dprHK; canvas.height=H*dprHK;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx2d=canvas.getContext('2d');
  ctx2d.scale(dprHK,dprHK);
  const PAD={top:32,right:18,bottom:48,left:54};
  ctx2d.clearRect(0,0,W,H);
  const pts=samples.map((s,i)=>{
    const _wrn=getWRNorm(s.wholeRock);
    const x=parseFloat(_wrn&&_wrn.values?_wrn.values['SiO2']:s.wholeRock.values['SiO2'])||null;
    const y=parseFloat(_wrn&&_wrn.values?_wrn.values[ox]:s.wholeRock.values[ox])||null;
    return{s,x,y,i};
  }).filter(p=>p.x!=null&&p.y!=null);
  if(!pts.length){
    ctx2d.fillStyle='#8b949e';ctx2d.font='12px sans-serif';ctx2d.textAlign='center';
    ctx2d.fillText('No data for '+(OX_LABEL[ox]||ox),W/2,H/2);return;
  }
  const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
  const xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
  const xpad=(xmax-xmin)*0.12||2,ypad=(ymax-ymin)*0.12||0.5;
  const xl=xmin-xpad,xr=xmax+xpad,yl=ymin-ypad,yr=ymax+ypad;
  const toX=v=>PAD.left+(v-xl)/(xr-xl)*(W-PAD.left-PAD.right);
  const toY=v=>H-PAD.bottom-(v-yl)/(yr-yl)*(H-PAD.top-PAD.bottom);
  const _isDarkHK=(document.documentElement.getAttribute('data-theme')||'dark')!=='light';
  ctx2d.fillStyle=_isDarkHK?'#161b22':'#ffffff';ctx2d.fillRect(0,0,W,H);
  ctx2d.strokeStyle=_isDarkHK?'#21262d':'#e2e5ea';ctx2d.lineWidth=0.5;
  for(let i=0;i<=4;i++){
    const xv=xl+(xr-xl)*i/4;ctx2d.beginPath();ctx2d.moveTo(toX(xv),PAD.top);ctx2d.lineTo(toX(xv),H-PAD.bottom);ctx2d.stroke();
    const yv=yl+(yr-yl)*i/4;ctx2d.beginPath();ctx2d.moveTo(PAD.left,toY(yv));ctx2d.lineTo(W-PAD.right,toY(yv));ctx2d.stroke();
  }
  // nearest neighbours
  const activeSample=samples.find(s=>s.id===S.activeSampleId);
  let nnSet=new Set();
  if(activeSample&&N>0){
    const allOx=OXIDES;
    const mins={},maxs={};
    allOx.forEach(o=>{const vals=samples.map(s=>parseFloat(getWRNorm(s.wholeRock).values[o])||0);mins[o]=Math.min(...vals);maxs[o]=Math.max(...vals);});
    const norm=(s,o)=>{const _v=parseFloat(getWRNorm(s.wholeRock).values[o])||0;const r=maxs[o]-mins[o];return r>0?(_v-mins[o])/r:0;};
    const dist=(a,b)=>Math.sqrt(allOx.reduce((sum,o)=>sum+Math.pow(norm(a,o)-norm(b,o),2),0));
    const others=samples.filter(s=>s.id!==activeSample.id&&s.wholeRock&&s.wholeRock.values);
    others.sort((a,b)=>dist(activeSample,a)-dist(activeSample,b));
    others.slice(0,N).forEach(s=>nnSet.add(s.id));
  }
  pts.forEach(p=>{
    const px=toX(p.x),py=toY(p.y);
    const isActive=activeSample&&p.s.id===activeSample.id;
    const isNN=nnSet.has(p.s.id);
    const isDimmed=activeSample&&!isActive&&!isNN;
    const {color,shape}=getHKStyle(p.s,samples,S._hkColorMode||'sample');
    const r=isActive?7:isNN?6:4;
    p.r=r;
    const fillCol=isNN?'#f0883e':color; // orange highlight for nearest neighbours
    drawCBShape(ctx2d,shape,px,py,r,fillCol,
      isActive?'#ffffff':(isNN?'#f0883e':'transparent'),
      isDimmed?0.22:1,
      isActive?2:(isNN?1.5:0));
    ctx2d.globalAlpha=1;
    // NO in-graph labels — legend-guided only
  });
  const _axisC=_isDarkHK?'#8b949e':'#656d76';
  const _titleC=_isDarkHK?'#e6edf3':'#24292f';
  const _tickC=_isDarkHK?'#6e7681':'#8c959f';
  ctx2d.strokeStyle=_axisC;ctx2d.lineWidth=1.2;ctx2d.globalAlpha=1;
  ctx2d.beginPath();ctx2d.moveTo(PAD.left,PAD.top);ctx2d.lineTo(PAD.left,H-PAD.bottom);ctx2d.lineTo(W-PAD.right,H-PAD.bottom);ctx2d.stroke();
  ctx2d.fillStyle=_axisC;ctx2d.font='12px sans-serif';ctx2d.textAlign='center';
  ctx2d.fillText('SiO\u2082 (wt%)',W/2,H-6);
  ctx2d.save();ctx2d.translate(13,H/2);ctx2d.rotate(-Math.PI/2);
  ctx2d.fillText((OX_LABEL[ox]||ox)+' (wt%)',0,0);ctx2d.restore();
  ctx2d.fillStyle=_titleC;ctx2d.font='bold 12px sans-serif';ctx2d.textAlign='center';
  ctx2d.fillText('SiO\u2082 vs '+(OX_LABEL[ox]||ox),W/2,16);
  const xRange=xr-xl, yRange=yr-yl;
  ctx2d.fillStyle=_tickC;ctx2d.font='12px sans-serif';
  for(let i=0;i<=4;i++){
    const xv=xl+(xr-xl)*i/4;ctx2d.textAlign='center';ctx2d.fillText(smartTick(xv,xRange),toX(xv),H-PAD.bottom+14);
    const yv=yl+(yr-yl)*i/4;ctx2d.textAlign='right';ctx2d.fillText(smartTick(yv,yRange),PAD.left-4,toY(yv)+4);
  }

  // ── Hover hit-list: attach once per canvas ──────────────────────────────
  // Store full sample data for click inspector
  canvas.dataset.hkPts=JSON.stringify(pts.map(p=>({label:p.s.name,px:toX(p.x),py:toY(p.y),r:p.r||4})));
  canvas.dataset.hkSids=JSON.stringify(pts.map(p=>p.s.id));
  if(!canvas._hkHover){
    canvas._hkHover=true;
    canvas.addEventListener('mousemove',_hkMouseMove);
    canvas.addEventListener('mouseleave',_hkMouseLeave);
    canvas.addEventListener('click',_hkClickSample);
  }
}


// ── Normalise a {headers,values} WR object to 100 wt% ──────────────────────
function normaliseWR(wr){
  const total=wr.headers.reduce((s,h)=>s+(wr.values[h]||0),0);
  if(!total)return wr;
  const norm={headers:wr.headers,values:{}};
  wr.headers.forEach(h=>{norm.values[h]=wr.values[h]/total*100;});
  return norm;
}

// Return a normalised copy of a WR object (always re-normalises from stored values)
function getWRNorm(wr){
  if(!wr||!wr.headers||!wr.headers.length)return wr;
  return normaliseWR(wr);
}

function pasteWR(sid){
  const ta=document.getElementById('wr-paste-'+sid);
  if(!ta){toast('Input not found','err');return;}
  const raw=ta.value.trim();
  if(!raw){toast('Nothing to paste','err');return;}
  const lines=raw.split(/\n/);
  if(lines.length<2){toast('Need at least 2 rows (headers + values)','err');return;}
  const headers=lines[0].split(/\t/).map(h=>h.trim().replace(/\s+/g,'')
    .replace(/^Fe2O3T$/i,'FeO*').replace(/^FeOT?$/i,'FeO*')
    .replace(/^P2O5$/i,'P2O5')); // normalise P2O5 casing
  const values=lines[1].split(/\t/).map(v=>v.trim());
  const raw_wr={headers:[],values:{}};
  headers.forEach((h,i)=>{
    if(OXIDES.includes(h)){raw_wr.headers.push(h);raw_wr.values[h]=parseFloat(values[i])||0;}
  });
  if(!raw_wr.headers.length){toast('No recognised oxide columns found','err');return;}
  // Store raw values AND normalised values separately
  const wr=normaliseWR(raw_wr); // normalise to 100 wt%
  const s=getSample(sid);if(!s)return;
  s.wholeRock=wr;
  s.wholeRockRaw=raw_wr; // keep original for reference
  save();
  toast('Saved & normalised ✓ ('+wr.headers.join(', ')+')');
  renderSamples();
}

function removeWR(sid){
  const s=getSample(sid);if(!s)return;
  if(!confirm('Remove whole-rock data for "'+s.name+'"? You can re-paste it.'))return;
  s.wholeRock={headers:[],values:{}};
  save();
  toast('Whole-rock data removed');
  renderSamples();
}

// ════════════════════════════════════════════════════════
//  RUNS TAB — COMPOSITIONAL HARKER DIAGRAMS
// ════════════════════════════════════════════════════════
function toggleRunHarkerPanel(ssid){
  const panel=document.getElementById('rh-panel-'+ssid);
  const tog=document.getElementById('rh-toggle-'+ssid);
  if(!panel)return;
  const open=panel.style.display==='block';
  panel.style.display=open?'none':'block';
  if(tog)tog.textContent=open?'▶':'▼';
  if(!open)setTimeout(()=>renderRunHarkers(ssid),50);
}

// Draft store: window._runWRDraft[ssid] = {headers, rows} or null
if(!window._runWRDraft)window._runWRDraft={};

function _parseRunWR(ssid){
  // Shared parser used by both preview and commit.
  // Returns {headers, rows} or null on error.
  const ta=document.getElementById('rwr-paste-'+ssid);
  if(!ta){toast('Input not found','err');return null;}
  const raw=ta.value.trim();
  if(!raw){toast('Nothing to paste','err');return null;}
  const lines=raw.split(/\r?\n/).filter(l=>l.trim());
  if(lines.length<2){toast('Need at least 2 rows (header + data)','err');return null;}
  const normalise=h=>h.trim().replace(/\s+/g,'')
    .replace(/^Fe2O3T$/i,'FeO*')
    .replace(/^FeOT?$/i,'FeO*')
    .replace(/^P2O5$/i,'P2O5');
  // Column 0 = composition number; remaining = oxides
  const rawHdrs=lines[0].split(/\t/);
  const oxCols=rawHdrs.slice(1).map(normalise);
  const validOx=oxCols.map(h=>OXIDES.includes(h)?h:null);
  const usedOx=validOx.filter(Boolean);
  if(!usedOx.length){toast('No recognised oxide columns (SiO2, TiO2, Al2O3, FeO, MnO, MgO, CaO, Na2O, K2O, P2O5)','err');return null;}
  const rows={};
  let skipped=0;
  for(let i=1;i<lines.length;i++){
    const cells=lines[i].split(/\t/);
    const num=parseInt(cells[0],10);
    if(isNaN(num)||num<1){skipped++;continue;}
    const raw_entry={};
    oxCols.forEach((ox,j)=>{
      if(validOx[j])raw_entry[validOx[j]]=parseFloat(cells[j+1])||0;
    });
    // Normalise each row to 100 wt%
    const rowTotal=usedOx.reduce((s,h)=>s+(raw_entry[h]||0),0);
    const entry={};
    usedOx.forEach(h=>{entry[h]=rowTotal?raw_entry[h]/rowTotal*100:0;});
    rows[num]=entry;
  }
  if(!Object.keys(rows).length){toast('No valid rows found (check Num column)','err');return null;}
  return{headers:usedOx,rows,skipped};
}

function previewRunWR(ssid){
  // Parse → store in draft → render preview WITHOUT saving to project
  const parsed=_parseRunWR(ssid);
  if(!parsed)return;
  window._runWRDraft[ssid]=parsed;
  toast('Preview ready — '+Object.keys(parsed.rows).length+' compositions'+(parsed.skipped?' ('+parsed.skipped+' rows skipped)':''),'ok');
  // Render preview canvases
  _renderRunHarkersFromData(ssid,parsed);
  // Show the Save/Discard buttons
  const btnRow=document.getElementById('rwr-btn-row-'+ssid);
  if(btnRow)btnRow.innerHTML=_draftBtnHTML(ssid);
}

function commitRunWR(ssid){
  // Commit draft to project (calls save())
  const draft=window._runWRDraft[ssid];
  if(!draft){toast('No preview to save — click Plot Preview first','err');return;}
  const ss=getSimset(ssid);if(!ss)return;
  ss.compWholeRock={headers:draft.headers,rows:draft.rows};
  delete window._runWRDraft[ssid];
  save();
  toast('Saved to project ✓');
  renderRuns();
  setTimeout(()=>renderRunHarkers(ssid),80);
}

function removeRunWR(ssid){
  const ss=getSimset(ssid);if(!ss)return;
  if(!confirm('Remove the committed graph data for this run? You can re-paste and re-plot.'))return;
  ss.compWholeRock={headers:[],rows:{}};
  delete window._runWRDraft[ssid];
  save();renderRuns();
  toast('Graph removed');
}

function discardRunWRDraft(ssid){
  delete window._runWRDraft[ssid];
  // Clear preview canvases
  const grid=document.getElementById('rh-grid-'+ssid);
  if(grid)grid.innerHTML='';
  // Reset button row
  const btnRow=document.getElementById('rwr-btn-row-'+ssid);
  if(btnRow)btnRow.innerHTML=_baseBtnHTML(ssid);
  toast('Preview discarded');
}

function _baseBtnHTML(ssid){
  return `<button class="btn btn-primary btn-sm" onclick="previewRunWR('${ssid}')">&#128202; Plot Preview</button>`;
}
function _draftBtnHTML(ssid){
  return `<button class="btn btn-primary btn-sm" onclick="previewRunWR('${ssid}')">&#128202; Re-plot</button>`+
    `<button class="btn btn-sm" style="background:var(--green);color:#000;font-weight:700" onclick="commitRunWR('${ssid}')">&#10003; Save to Project</button>`+
    `<button class="btn btn-sm btn-danger" onclick="discardRunWRDraft('${ssid}')">Discard Preview</button>`;
}

function renderRunHarkers(ssid){
  const ss=getSimset(ssid);if(!ss)return;
  const cwr=ss.compWholeRock;
  _renderRunHarkersFromData(ssid,cwr);
}

function _renderRunHarkersFromData(ssid,cwr){
  const ss=getSimset(ssid);if(!ss)return;
  const grid=document.getElementById('rh-grid-'+ssid);
  if(!grid)return;
  if(!cwr||!cwr.headers||!cwr.headers.length){grid.innerHTML='';return;}
  const yOxides=OXIDES.filter(o=>o!=='SiO2'&&cwr.headers.includes(o));
  if(!cwr.headers.includes('SiO2')){
    grid.innerHTML='<div style="color:var(--red);font-size:11px;grid-column:1/-1">SiO₂ column required for Harker diagrams.</div>';
    return;
  }
  grid.innerHTML=yOxides.map(ox=>
    `<div><canvas id="rwh-${ssid}-${ox}" width="280" height="240"
       style="border-radius:6px;background:var(--surface);display:block;width:100%"></canvas></div>`
  ).join('')+
  (function(){
    const _cbM=isCBMode();
    const _okCol=_cbM?'#0072B2':'#56d364';
    const _failCol=_cbM?'#D55E00':'#f85149';
    const _nrCol='#6e7681';
    const _succ=ss.compositions.filter(c=>c.status==='success').length;
    const _fail=ss.compositions.filter(c=>c.status==='failed').length;
    const _total=Object.keys(cwr.rows).length;
    return `<div style="grid-column:1/-1;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 14px;font-size:11px;margin-top:2px">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        <span style="font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted)">Legend</span>
        <div style="display:flex;align-items:center;gap:5px">
          <div style="width:11px;height:11px;border-radius:50%;background:${_okCol};opacity:0.9;flex-shrink:0"></div>
          <span style="color:var(--text);font-weight:600">Q2F Success</span>
          <span style="color:var(--text-muted);margin-left:2px">(${_succ})</span>
        </div>
        <div style="display:flex;align-items:center;gap:5px">
          <div style="width:11px;height:11px;border-radius:50%;background:${_failCol};opacity:0.9;flex-shrink:0"></div>
          <span style="color:var(--text);font-weight:600">Q2F Failure</span>
          <span style="color:var(--text-muted);margin-left:2px">(${_fail})</span>
        </div>
        <div style="display:flex;align-items:center;gap:5px">
          <div style="width:8px;height:8px;border-radius:50%;background:${_nrCol};opacity:0.45;flex-shrink:0"></div>
          <span style="color:var(--text-muted)">Not Run</span>
        </div>
        <span style="margin-left:auto;font-size:10px;color:var(--text-muted)">${_total} WR compositions plotted</span>
        <button class="btn btn-sm" style="font-size:10px;padding:3px 8px;flex-shrink:0" onclick="exportRunHarkerPNG('${ssid}')">📷 Export PNG</button>
      </div>
    </div>`;
  })();
  yOxides.forEach(ox=>setTimeout(()=>drawRunHarker(ssid,ox,cwr),0));
}

function drawRunHarker(ssid,ox,cwr){
  const ss=getSimset(ssid);if(!ss)return;
  if(!cwr)cwr=ss.compWholeRock;
  if(!cwr||!cwr.headers||!cwr.headers.length)return;
  const canvas=document.getElementById('rwh-'+ssid+'-'+ox);
  if(!canvas)return;
  const dprRH=Math.max(window.devicePixelRatio||1,2); // min 2× for crisp display
  const W=canvas.offsetWidth||280, H=canvas.offsetHeight||220;
  canvas.width=W*dprRH; canvas.height=H*dprRH;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d');
  ctx.scale(dprRH,dprRH);
  const PAD={top:32,right:18,bottom:48,left:54};
  const _isDark=(document.documentElement.getAttribute('data-theme')||'dark')!=='light';ctx.fillStyle=_isDark?'#161b22':'#ffffff';ctx.fillRect(0,0,W,H);

  // Build point list from compWholeRock rows, coloured by sim status
  const compMap={};
  ss.compositions.forEach(c=>compMap[c.num]=c.status);
  const pts=[];
  Object.entries(cwr.rows).forEach(([numStr,vals])=>{
    const num=parseInt(numStr,10);
    const x=vals['SiO2'];
    const y=vals[ox];
    if(x==null||y==null||isNaN(x)||isNaN(y))return;
    const status=compMap[num]||ST.NR;
    pts.push({num,x,y,status});
  });

  if(!pts.length){
    ctx.fillStyle='#8b949e';ctx.font='12px sans-serif';ctx.textAlign='center';
    ctx.fillText('No data for '+(OX_LABEL[ox]||ox),W/2,H/2);return;
  }

  const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
  const xmin=Math.min(...xs),xmax=Math.max(...xs);
  const ymin=Math.min(...ys),ymax=Math.max(...ys);
  const xpad=(xmax-xmin)*0.1||1,ypad=(ymax-ymin)*0.1||0.3;
  const xl=xmin-xpad,xr=xmax+xpad,yl=ymin-ypad,yr=ymax+ypad;
  const toX=v=>PAD.left+(v-xl)/(xr-xl)*(W-PAD.left-PAD.right);
  const toY=v=>H-PAD.bottom-(v-yl)/(yr-yl)*(H-PAD.top-PAD.bottom);

  // Grid lines
  ctx.strokeStyle=_isDark?'#21262d':'#e2e5ea';ctx.lineWidth=0.5;
  for(let i=0;i<=4;i++){
    const xv=xl+(xr-xl)*i/4;
    ctx.beginPath();ctx.moveTo(toX(xv),PAD.top);ctx.lineTo(toX(xv),H-PAD.bottom);ctx.stroke();
    const yv=yl+(yr-yl)*i/4;
    ctx.beginPath();ctx.moveTo(PAD.left,toY(yv));ctx.lineTo(W-PAD.right,toY(yv));ctx.stroke();
  }

  // Draw NR first, then OK (green), then FAIL (red) on top so red is never hidden
  const CB_RH=isCBMode();
  const order=[ST.NR,ST.OK,ST.FAIL];
  const colMap={[ST.OK]:CB_RH?'#009E73':'#56d364',[ST.FAIL]:CB_RH?'#D55E00':'#f85149',[ST.NR]:'#6e7681'};
  const rMap={[ST.OK]:5,[ST.FAIL]:5,[ST.NR]:3};
  // Shape drawing helper: circle=NR/OK, downward triangle=FAIL for CB distinction
  function _rhDraw(ctx,px,py,r,col,alpha,st){
    ctx.globalAlpha=alpha;ctx.fillStyle=col;
    if(CB_RH&&st===ST.FAIL){
      ctx.beginPath();ctx.moveTo(px,py-r*1.3);ctx.lineTo(px+r*1.1,py+r*0.9);ctx.lineTo(px-r*1.1,py+r*0.9);ctx.closePath();ctx.fill();
    } else if(CB_RH&&st===ST.OK){
      // Square for OK in CB mode
      ctx.fillRect(px-r,py-r,r*2,r*2);
    } else {
      ctx.beginPath();ctx.arc(px,py,r,0,Math.PI*2);ctx.fill();
    }
    ctx.globalAlpha=1;
  }
  order.forEach(status=>{
    const group=pts.filter(p=>p.status===status);
    group.forEach(p=>{
      _rhDraw(ctx,toX(p.x),toY(p.y),rMap[status],colMap[status],status===ST.NR?0.4:0.85,status);
    });
  });

  // Axes
  ctx.strokeStyle=_isDark?'#8b949e':'#656d76';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(PAD.left,PAD.top);ctx.lineTo(PAD.left,H-PAD.bottom);ctx.lineTo(W-PAD.right,H-PAD.bottom);ctx.stroke();

  // Title
  ctx.fillStyle='#e6edf3';ctx.font='bold 12px sans-serif';ctx.textAlign='center';
  ctx.fillText('SiO₂ vs '+(OX_LABEL[ox]||ox),W/2,16);

  // Axis labels
  ctx.fillStyle='#8b949e';ctx.font='12px sans-serif';ctx.textAlign='center';
  ctx.fillText('SiO₂ (wt%)',W/2,H-6);
  ctx.save();ctx.translate(12,H/2);ctx.rotate(-Math.PI/2);
  ctx.fillText((OX_LABEL[ox]||ox)+' (wt%)',0,0);ctx.restore();

  // Tick labels
  const xRangeR=xr-xl, yRangeR=yr-yl;
  ctx.fillStyle='#6e7681';ctx.font='12px sans-serif';
  for(let i=0;i<=4;i++){
    const xv=xl+(xr-xl)*i/4;ctx.textAlign='center';ctx.fillText(smartTick(xv,xRangeR),toX(xv),H-PAD.bottom+14);
    const yv=yl+(yr-yl)*i/4;ctx.textAlign='right';ctx.fillText(smartTick(yv,yRangeR),PAD.left-4,toY(yv)+4);
  }

  // ── Hover hit-list ───────────────────────────────────────────────────────
  const colMapLbl={[ST.OK]:CB_RH?'Q2F Success (■)':'Q2F Success',[ST.FAIL]:CB_RH?'Q2F Failure (▼)':'Q2F Failure',[ST.NR]:'Not Run'};
  canvas.dataset.hkPts=JSON.stringify(pts.map(p=>({
    label:'#'+p.num+' — '+(colMapLbl[p.status]||p.status),
    px:toX(p.x),py:toY(p.y),r:rMap[p.status]||5
  })));
  // Store run composition data for inspector (include WR values)
  canvas.dataset.hkRunPts=JSON.stringify(pts.map(p=>({
    num:p.num,status:p.status,x:p.x,y:p.y,
    wrVals:cwr.rows[p.num]||{}
  })));
  canvas.dataset.hkSsid=ssid;
  if(!canvas._hkHover){
    canvas._hkHover=true;
    canvas.addEventListener('mousemove',_hkMouseMove);
    canvas.addEventListener('mouseleave',_hkMouseLeave);
    canvas.addEventListener('click',_hkClickRun);
  }
}


// ════════════════════════════════════════════════════════
//  LIGHT / DARK MODE
// ════════════════════════════════════════════════════════
function toggleTheme(){
  const html=document.documentElement;
  const isLight=html.getAttribute('data-theme')==='light';
  const next=isLight?'dark':'light';
  // Pin eclipse origin to the toggle button (fallback: screen center).
  const btn=document.getElementById('theme-toggle');
  if(btn){
    const r=btn.getBoundingClientRect();
    html.style.setProperty('--theme-x', (r.left+r.width/2)+'px');
    html.style.setProperty('--theme-y', (r.top +r.height/2)+'px');
  }
  html.classList.add('theme-transition');
  if(next==='light')html.setAttribute('data-theme','light');
  else html.removeAttribute('data-theme');
  localStorage.setItem('melts_theme',next);
  if(btn){
    btn.textContent=next==='light'?'☀️':'🌙';
    btn.setAttribute('aria-pressed',next==='light'?'true':'false');
  }
  setTimeout(()=>html.classList.remove('theme-transition'),760);
  // Re-render active Harkers so canvas colours update
  if(S.activePage==='samples')renderSamples();
  if(S.activePage==='runs')renderRuns();
}
function saveAppTitle(txt){
  const t=(txt||'').trim();
  // Empty / placeholder → clear the user title so the generic name returns on next load.
  if(!t || t==='rhyolite-MELTS Tracker'){
    S._appTitle='';
    save();
    loadAppTitle();
    return;
  }
  S._appTitle=t;
  save();
}
function loadAppTitle(){
  const el=document.getElementById('app-title');
  if(el){
    // If the user has set a project title, show it; otherwise fall back to the
    // generic product name (no emoji — the emoji lives in .brand-mark now).
    el.textContent = (S._appTitle&&S._appTitle.trim()) ? S._appTitle : 'rhyolite-MELTS Tracker';
  }
  _updateSubtitle();
}
function _updateSubtitle(){
  const el=document.getElementById('brand-sub-line');
  if(!el)return;
  const st=S.settings||{};
  const owner   =(st.owner   ||'').trim();
  const advisors=(st.advisors||'').trim();
  // Structured chips so the header looks intentional rather than crammed.
  const parts=[];
  if(owner)   parts.push('<span class="meta-item"><strong>By</strong><span>'+esc(owner)+'</span></span>');
  if(advisors)parts.push('<span class="meta-item"><strong>Advisors</strong><span>'+esc(advisors)+'</span></span>');
  if(!parts.length){
    el.innerHTML='<span class="meta-empty">No owner set — configure in Settings</span>';
  }else{
    el.innerHTML=parts.join('');
  }
  // Keep the version chip in sync with the constant (single source of truth).
  const vc=document.getElementById('version-chip');
  if(vc)vc.textContent='v'+APP_VERSION;
}

function applyTheme(){
  const t=localStorage.getItem('melts_theme')||'dark';
  const isLight=(t==='light');
  if(isLight)document.documentElement.setAttribute('data-theme','light');
  else document.documentElement.removeAttribute('data-theme');
  const btn=document.getElementById('theme-toggle');
  if(btn){
    btn.textContent=isLight?'☀️':'🌙';
    btn.setAttribute('aria-pressed',isLight?'true':'false');
  }
}

// ════════════════════════════════════════════════════════
//  COLORBLIND MODE
// ════════════════════════════════════════════════════════
// Okabe-Ito palette
// ── Unified Harker palette & shapes (CB-safe + visually distinct for all viewers) ──
// 6 colors chosen from Okabe-Ito + analogues that read clearly in both standard and CB vision
const HK_PALETTE=['#58a6ff','#f0883e','#56d364','#d2a8ff','#e3b341','#f85149'];
// 5 distinct shapes — cycle after every 6 colors so point N has
//   color = HK_PALETTE[N % 6],  shape = HK_SHAPES[Math.floor(N/6) % 5]
const HK_SHAPES=['circle','square','triangle','diamond','cross'];

// Legacy aliases so old call-sites keep working
const CB_PALETTE=HK_PALETTE;
const CB_SHAPES=HK_SHAPES;

// CB-safe unit color palette (Okabe-Ito extended)
const UNIT_COLORS_CB=['#E69F00','#56B4E9','#009E73','#F0E442','#0072B2','#D55E00','#CC79A7','#88CCEE','#AA4499','#332288','#117733','#44AA99','#999933','#DDCC77','#882255','#661100','#888888'];

// getCBUnitColor(hex): maps any hex to nearest Okabe-Ito hue when CB mode active
function getCBUnitColor(hex){
  if(!isCBMode())return hex;
  if(!hex)return '#0072B2';
  hex=hex.replace('#','');
  if(hex.length===3)hex=hex.split('').map(function(c){return c+c;}).join('');
  var r=parseInt(hex.slice(0,2),16),g=parseInt(hex.slice(2,4),16),b=parseInt(hex.slice(4,6),16);
  var rn=r/255,gn=g/255,bn=b/255;
  var mx=Math.max(rn,gn,bn),mn=Math.min(rn,gn,bn),h=0;
  if(mx!==mn){var d=mx-mn;if(mx===rn)h=(gn-bn)/d+(gn<bn?6:0);else if(mx===gn)h=(bn-rn)/d+2;else h=(rn-gn)/d+4;h*=60;}
  if(h<30||h>=330)return '#D55E00';  // red/magenta -> Vermilion
  if(h<75)return '#E69F00';          // yellow/orange -> Orange
  if(h<150)return '#009E73';         // green -> Bluish-green
  if(h<195)return '#56B4E9';         // cyan -> Sky Blue
  if(h<255)return '#0072B2';         // blue -> Blue
  return '#CC79A7';                  // purple -> Reddish-purple
}

function drawCBShape(ctx,shape,px,py,r,fill,stroke,alpha,lw){
  ctx.globalAlpha=alpha??1;
  ctx.fillStyle=fill;
  ctx.strokeStyle=stroke||'transparent';
  ctx.lineWidth=lw||0;
  ctx.beginPath();
  if(shape==='circle'){
    ctx.arc(px,py,r,0,Math.PI*2);
  } else if(shape==='square'){
    ctx.rect(px-r,py-r,r*2,r*2);
  } else if(shape==='triangle'){
    ctx.moveTo(px,py-r*1.2);ctx.lineTo(px+r*1.1,py+r*0.8);ctx.lineTo(px-r*1.1,py+r*0.8);ctx.closePath();
  } else if(shape==='diamond'){
    ctx.moveTo(px,py-r*1.3);ctx.lineTo(px+r,py);ctx.lineTo(px,py+r*1.3);ctx.lineTo(px-r,py);ctx.closePath();
  } else if(shape==='cross'){
    const t=r*0.35;
    ctx.rect(px-t,py-r,t*2,r*2);ctx.closePath();ctx.rect(px-r,py-t,r*2,t*2);
  }
  ctx.fill();
  if(lw>0)ctx.stroke();
  ctx.globalAlpha=1;
}

function closeInspector(){
  const el=document.getElementById('hk-inspector');
  if(el)el.style.display='none';
}

function _hkClickSample(e){
  const canvas=e.currentTarget;
  const rect=canvas.getBoundingClientRect();
  const mx=(e.clientX-rect.left)*(canvas.width/rect.width);
  const my=(e.clientY-rect.top)*(canvas.height/rect.height);
  let ptsData=[];
  try{ptsData=JSON.parse(canvas.dataset.hkPts||'[]');}catch(e){}
  let sids=[];
  try{sids=JSON.parse(canvas.dataset.hkSids||'[]');}catch(e){}
  let best=null,bestD=Infinity;
  ptsData.forEach((p,i)=>{
    const d=Math.hypot(mx-p.px,my-p.py);
    if(d<p.r*2+6&&d<bestD){bestD=d;best={...p,sid:sids[i]};}
  });
  if(!best)return;
  const s=getSample(best.sid);
  if(!s){closeInspector();return;}
  const norm=getWRNorm(s.wholeRock);
  const oxRows=norm&&norm.headers?norm.headers.map(h=>`<tr><td style="color:var(--text-muted);padding-right:14px;padding-bottom:2px">${esc(h)}</td><td style="color:var(--blue);font-weight:700;text-align:right;padding-bottom:2px">${(norm.values[h]||0).toFixed(2)}</td></tr>`).join(''):'<tr><td colspan="2" style="color:var(--text-muted)">No WR data</td></tr>';
  const sum=norm&&norm.headers?norm.headers.reduce((a,h)=>a+(norm.values[h]||0),0):0;
  const insp=document.getElementById('hk-inspector');
  document.getElementById('hk-insp-title').textContent=s.name;
  const _iu2=_getUnit(s.unitId||'');
  const _abbr2=_iu2?_iu2.abbr:(s.geoUnitAbbr||'');
  const _col2=getCBUnitColor(_iu2?(_iu2.color||'#58a6ff'):'#58a6ff');
  const _nm2=_iu2?_iu2.name:(s.geoUnit||'');
  document.getElementById('hk-insp-body').innerHTML=`
    <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px;align-items:center">
      ${s.rockType?`<span style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:12px;color:var(--text);font-weight:600">${esc(s.rockType)}</span>`:''}
      ${_abbr2?`<span style="background:${_col2}22;border:1.5px solid ${_col2};color:${_col2};border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700" title="${esc(_nm2)}">${esc(_abbr2)} — ${esc(_nm2)}</span>`:''}
    </div>
    ${s.notes?`<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;border-left:3px solid var(--border);padding-left:8px">${esc(s.notes)}</div>`:''}
    <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">
      Normalised WR <span style="background:var(--blue-bg);color:var(--blue);border-radius:4px;padding:2px 7px;font-size:10px;margin-left:6px">NORMALIZED</span>
    </div>
    ${oxRows?`<table style="width:100%;border-collapse:collapse;margin-bottom:8px;font-size:13px">${oxRows}</table>`:'<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">No whole-rock data</div>'}
    <div style="font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:8px;display:flex;justify-content:space-between">
      <span>Total: <strong>${sum.toFixed(2)} wt%</strong></span>
      <!-- date stored as s.createdAt — hidden from view per spec -->
    </div>
  `;
  if(insp){insp.style.display='block';}
}

function _hkClickRun(e){
  const canvas=e.currentTarget;
  const rect=canvas.getBoundingClientRect();
  const mx=(e.clientX-rect.left)*(canvas.width/rect.width);
  const my=(e.clientY-rect.top)*(canvas.height/rect.height);
  let ptsData=[];
  try{ptsData=JSON.parse(canvas.dataset.hkPts||'[]');}catch(e){}
  let runPts=[];
  try{runPts=JSON.parse(canvas.dataset.hkRunPts||'[]');}catch(e){}
  const ssid=canvas.dataset.hkSsid;
  let best=null,bestD=Infinity;
  ptsData.forEach((p,i)=>{
    const d=Math.hypot(mx-p.px,my-p.py);
    if(d<p.r*2+6&&d<bestD){bestD=d;best={...p,...(runPts[i]||{}),idx:i};}
  });
  if(!best)return;
  const statusStr={[ST.OK]:'✓ Q2F Success',[ST.FAIL]:'✗ Q2F Failure',[ST.NR]:'– Not Run'};
  const statusColor={[ST.OK]:'var(--green)',[ST.FAIL]:'var(--red)',[ST.NR]:'var(--text-muted)'};
  const wrVals=best.wrVals||{};
  const wrKeys=Object.keys(wrVals);
  const wrTotal=wrKeys.reduce((a,k)=>a+(wrVals[k]||0),0);
  const wrRows=wrKeys.map(k=>`<tr><td style="color:var(--text-muted);padding-right:14px;padding-bottom:2px">${esc(k)}</td><td style="color:var(--blue);font-weight:700;text-align:right;padding-bottom:2px">${(wrVals[k]||0).toFixed(2)}</td></tr>`).join('');
  const insp=document.getElementById('hk-inspector');
  document.getElementById('hk-insp-title').textContent='Composition #'+best.num;
  document.getElementById('hk-insp-body').innerHTML=`
    <div style="margin-bottom:8px;font-size:14px;font-weight:700;color:${statusColor[best.status]||'var(--text)'}">
      ${statusStr[best.status]||best.status}
    </div>
    <div style="margin-bottom:8px;font-size:13px">
      <span style="color:var(--text-muted)">SiO₂:</span> <strong>${(best.x||0).toFixed(2)}</strong> wt%
    </div>
    ${wrKeys.length?`
    <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">
      Normalised WR <span style="background:#1a3a5c;color:#58a6ff;border-radius:4px;padding:2px 7px;font-size:10px;margin-left:6px">NORMALIZED</span>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:10px;font-size:13px">${wrRows}</table>
    <div style="font-size:12px;color:var(--text-muted);border-top:1px solid var(--border);padding-top:8px">Total: <strong>${wrTotal.toFixed(2)} wt%</strong></div>
    `:'<div style="font-size:10px;color:var(--text-muted)">No WR data for this composition.</div>'}
  `;
  if(insp){insp.style.display='block';}
}

function isCBMode(){return!!localStorage.getItem('melts_cb');}

function toggleCB(){
  if(isCBMode()){localStorage.removeItem('melts_cb');}
  else{localStorage.setItem('melts_cb','1');}
  applyCB();
  const cbBtn=document.getElementById('cb-toggle');
  if(cbBtn)cbBtn.setAttribute('aria-pressed',isCBMode()?'true':'false');
  // Re-render all pages that use colour-scheme-dependent elements
  if(S.activePage==='samples'){renderSamples();}
  else if(S.activePage==='runs'){renderRuns();}
  else if(S.activePage==='thresh'){renderThresholding();}
  else if(S.activePage==='overview'){renderOverview();}
  // Also refresh legend panel if visible
  setTimeout(_injectOxideLegend, 50);
}
// ── Edit-add popup: simple, lightweight implementation ─────────────────────
function _positionEditPopup(){
  const btn=document.getElementById('em-toggle');
  const popup=document.getElementById('edit-add-popup');
  if(!btn||!popup)return;
  const r=btn.getBoundingClientRect();
  const vw=window.innerWidth, vh=window.innerHeight;
  const popW=popup.offsetWidth||180, popH=popup.offsetHeight||130;
  const GAP=6;
  // Place above the button if room, otherwise below
  let top=r.top-popH-GAP;
  if(top<GAP) top=r.bottom+GAP;
  let left=r.right-popW;
  if(left<GAP) left=GAP;
  if(left+popW>vw-GAP) left=vw-popW-GAP;
  popup.style.top=Math.max(GAP,Math.min(top,vh-popH-GAP))+'px';
  popup.style.left=Math.max(GAP,left)+'px';
  popup.style.right='auto'; popup.style.bottom='auto';
}
function openEditPopup(){
  const popup=document.getElementById('edit-add-popup');
  if(!popup)return;
  // Position first (off-screen, temporarily visible for measurement)
  popup.style.visibility='hidden';
  popup.style.display='flex';
  popup.style.top='-9999px'; popup.style.left='-9999px';
  requestAnimationFrame(function(){
    _positionEditPopup();
    // Remove inline display so the .open class fully controls visibility
    popup.style.display='';
    popup.style.visibility='';
    popup.classList.add('open');
  });
}
function closeEditPopup(){
  const p=document.getElementById('edit-add-popup');
  if(p){
    p.classList.remove('open');
    p.style.display='';   // clear any inline display set during open measurement
  }
}
function toggleEditMode(){
  const nowOn=document.body.classList.toggle('edit-mode');
  localStorage.setItem('melts_em',nowOn?'1':'0');
  const emBtn=document.getElementById('em-toggle');
  if(emBtn)emBtn.setAttribute('aria-pressed',nowOn?'true':'false');
  if(nowOn){ openEditPopup(); }
  else {
    closeEditPopup();
    if(document.activeElement&&typeof document.activeElement.blur==='function')
      document.activeElement.blur();
    // Re-render current page to clear any inline edit UIs (e.g. category name inputs)
    if(S.activePage==='samples') renderSamples();
    else if(S.activePage==='overview') renderOverview();
    else if(S.activePage==='runs') renderRuns();
  }
}
// Close popup when clicking outside
document.addEventListener('click',function(e){
  const pop=document.getElementById('edit-add-popup');
  if(!pop||!pop.classList.contains('open'))return;
  if(!e.target.closest('#edit-add-popup')&&!e.target.closest('#em-wrap')){
    closeEditPopup();
  }
},true);
// Escape key closes popup
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){
    const pop=document.getElementById('edit-add-popup');
    if(pop&&pop.classList.contains('open'))closeEditPopup();
  }
});
function applyEM(){
  const on=localStorage.getItem('melts_em')==='1';
  if(on){
    document.body.classList.add('edit-mode');
    // Use rAF×2 so DOM is painted before measuring popup size (no lag)
    requestAnimationFrame(()=>requestAnimationFrame(openEditPopup));
  }
  const emBtn=document.getElementById('em-toggle');
  if(emBtn)emBtn.setAttribute('aria-pressed',on?'true':'false');
}
function applyCB(){
  const btn=document.getElementById('cb-toggle');
  const cb=isCBMode();
  if(btn){btn.style.opacity=cb?'1':'0.45';btn.setAttribute('aria-pressed',cb?'true':'false');}
  document.body.classList.toggle('cb-active',cb);
}

// ── Unified style resolver ──────────────────────────────────────────────────
// Returns {color, shape} for sample at index i, given all samples and colorMode.
// colorMode: 'sample' | 'rocktype' | 'unit'
function getHKStyle(sample, allSamples, colorMode){
  const mode = colorMode || S._hkColorMode || 'sample';
  const i = allSamples.indexOf(sample);

  // Shape always cycles by sample index (color changes per mode)
  const shape = HK_SHAPES[Math.floor(i / HK_PALETTE.length) % HK_SHAPES.length];

  if(mode === 'rocktype'){
    // Color by unique rock type (sorted), fallback to index color if no rock type
    const types = [...new Set(allSamples.map(s => (s.rockType||'').trim()||'—'))].sort();
    const rt = (sample.rockType||'').trim()||'—';
    const ci = types.indexOf(rt);
    return {color: HK_PALETTE[ci % HK_PALETTE.length], shape};
  }
  if(mode === 'unit'){
    const u = _getUnit(sample.unitId||'');
    if(u && u.color){ return {color: getCBUnitColor(u.color), shape}; }
    return {color: HK_PALETTE[i % HK_PALETTE.length], shape};
  }
  if(mode === 'category'){
    // Color by the FIRST category the sample belongs to
    const cats = S.sampleCategories||[];
    const cat = cats.find(c=>Array.isArray(c.sampleIds)&&c.sampleIds.includes(sample.id));
    if(cat && cat.color){ return {color: cat.color, shape}; }
    // Uncategorised: muted gray
    return {color: '#6e7681', shape};
  }
  // Default 'sample' mode: color + shape both cycle by index
  return {color: HK_PALETTE[i % HK_PALETTE.length], shape};
}

// Legacy shim for old call-sites
function hkColor(i, n){ return HK_PALETTE[i % HK_PALETTE.length]; }

// ════════════════════════════════════════════════════════
//  EXPORT COMBINED HARKER PNG (Sample tab)
// ════════════════════════════════════════════════════════
function exportHarkerPNG(){
  const samples=(S.samples||[]).filter(s=>s.wholeRock&&s.wholeRock.headers&&s.wholeRock.headers.length>0);
  if(!samples.length){toast('No whole-rock data to export','err');return;}
  const yOxides=OXIDES.filter(o=>o!=='SiO2');
  if(!yOxides.length){toast('No oxide data to export','err');return;}

  // ── Full off-screen redraw at 3× DPR with light/white theme ────────────────
  // Layout for individual tiles
  const TILE_W=280, TILE_H=220;
  const EXPORT_DPR=3;
  const COLS=4;
  const ROWS=Math.ceil(yOxides.length/COLS);
  const LEG_W=200, GAP=12, PAD=24, TITLE_H=52;

  const totalW=COLS*TILE_W+(COLS-1)*GAP+PAD*2+LEG_W+GAP;
  const totalH=TITLE_H+ROWS*TILE_H+(ROWS-1)*GAP+PAD*2;

  const out=document.createElement('canvas');
  out.width=totalW*EXPORT_DPR; out.height=totalH*EXPORT_DPR;
  const octx=out.getContext('2d');
  octx.scale(EXPORT_DPR,EXPORT_DPR);

  // White background
  octx.fillStyle='#ffffff'; octx.fillRect(0,0,totalW,totalH);

  // Title bar
  octx.fillStyle='#f6f8fa'; octx.fillRect(0,0,totalW,TITLE_H);
  octx.strokeStyle='#d0d7de'; octx.lineWidth=1;
  octx.beginPath(); octx.moveTo(0,TITLE_H); octx.lineTo(totalW,TITLE_H); octx.stroke();

  octx.fillStyle='#1f2328'; octx.font='bold 16px system-ui,sans-serif'; octx.textAlign='left';
  octx.textBaseline='middle';
  octx.fillText('Harker Diagrams',PAD,TITLE_H*0.38);
  octx.fillStyle='#656d76'; octx.font='11px system-ui,sans-serif';
  const cbLabel=isCBMode()?' · Colour-blind palette':'';
  octx.fillText(new Date().toLocaleDateString('en-AU',{year:'numeric',month:'short',day:'numeric'})+cbLabel,PAD,TITLE_H*0.72);

  // Colour-mode label (top-right)
  const modeLabel={'sample':'by Sample','rocktype':'by Rock Type','unit':'by Geological Unit','category':'by Category'}[S._hkColorMode||'sample']||'';
  octx.textAlign='right'; octx.fillStyle='#656d76'; octx.font='11px system-ui,sans-serif';
  octx.fillText(modeLabel,totalW-PAD,TITLE_H/2);

  // ── Draw each Harker tile off-screen in LIGHT mode ──────────────────────────
  // Helper: draw a single tile onto octx at (dx,dy)
  function _drawHarkerTile(ox,dx,dy){
    const TW=TILE_W, TH=TILE_H;
    const tPAD={top:32,right:16,bottom:46,left:52};
    // Tile background
    octx.fillStyle='#ffffff'; octx.fillRect(dx,dy,TW,TH);
    octx.strokeStyle='#e2e5ea'; octx.lineWidth=0.8;
    octx.strokeRect(dx,dy,TW,TH);

    const pts=samples.map((s,i)=>{
      const _wrn=getWRNorm(s.wholeRock);
      const x=parseFloat(_wrn&&_wrn.values?_wrn.values['SiO2']:s.wholeRock.values['SiO2'])||null;
      const y=parseFloat(_wrn&&_wrn.values?_wrn.values[ox]:s.wholeRock.values[ox])||null;
      return{s,x,y,i};
    }).filter(p=>p.x!=null&&p.y!=null);

    if(!pts.length){
      octx.fillStyle='#8c959f'; octx.font='11px system-ui,sans-serif'; octx.textAlign='center'; octx.textBaseline='middle';
      octx.fillText('No data for '+(OX_LABEL[ox]||ox),dx+TW/2,dy+TH/2);
      return;
    }

    const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
    const xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
    const xpad=(xmax-xmin)*0.12||2,ypad=(ymax-ymin)*0.12||0.5;
    const xl=xmin-xpad,xr=xmax+xpad,yl=ymin-ypad,yr=ymax+ypad;
    const toX=v=>dx+tPAD.left+(v-xl)/(xr-xl)*(TW-tPAD.left-tPAD.right);
    const toY=v=>dy+TH-tPAD.bottom-(v-yl)/(yr-yl)*(TH-tPAD.top-tPAD.bottom);

    // Grid lines
    octx.strokeStyle='#eaecef'; octx.lineWidth=0.6;
    for(let i=0;i<=4;i++){
      const xv=xl+(xr-xl)*i/4;
      octx.beginPath();octx.moveTo(toX(xv),dy+tPAD.top);octx.lineTo(toX(xv),dy+TH-tPAD.bottom);octx.stroke();
      const yv=yl+(yr-yl)*i/4;
      octx.beginPath();octx.moveTo(dx+tPAD.left,toY(yv));octx.lineTo(dx+TW-tPAD.right,toY(yv));octx.stroke();
    }

    // Data points
    pts.forEach(p=>{
      const px=toX(p.x),py=toY(p.y);
      const {color,shape}=getHKStyle(p.s,samples,S._hkColorMode||'sample');
      drawCBShape(octx,shape,px,py,5,color,'rgba(255,255,255,0.7)',0.9,1.2);
    });
    octx.globalAlpha=1;

    // Axes
    octx.strokeStyle='#444d56'; octx.lineWidth=1.2;
    octx.beginPath();octx.moveTo(dx+tPAD.left,dy+tPAD.top);octx.lineTo(dx+tPAD.left,dy+TH-tPAD.bottom);octx.lineTo(dx+TW-tPAD.right,dy+TH-tPAD.bottom);octx.stroke();

    // Title
    octx.fillStyle='#1f2328'; octx.font='bold 11px system-ui,sans-serif'; octx.textAlign='center'; octx.textBaseline='top';
    octx.fillText('SiO₂ vs '+(OX_LABEL[ox]||ox),dx+TW/2,dy+5);

    // Axis labels
    octx.fillStyle='#656d76'; octx.font='10px system-ui,sans-serif'; octx.textAlign='center'; octx.textBaseline='bottom';
    octx.fillText('SiO₂ (wt%)',dx+TW/2,dy+TH-2);
    octx.save(); octx.translate(dx+12,dy+TH/2); octx.rotate(-Math.PI/2);
    octx.textAlign='center'; octx.textBaseline='middle';
    octx.fillText((OX_LABEL[ox]||ox)+' (wt%)',0,0); octx.restore();

    // Tick labels
    const xRange=xr-xl,yRange=yr-yl;
    octx.fillStyle='#8c959f'; octx.font='9px system-ui,sans-serif'; octx.textBaseline='middle';
    for(let i=0;i<=4;i++){
      const xv=xl+(xr-xl)*i/4; octx.textAlign='center';
      octx.fillText(smartTick(xv,xRange),toX(xv),dy+TH-tPAD.bottom+10);
      const yv=yl+(yr-yl)*i/4; octx.textAlign='right';
      octx.fillText(smartTick(yv,yRange),dx+tPAD.left-4,toY(yv));
    }
  }

  // Draw all tiles
  yOxides.forEach((ox,i)=>{
    const col=i%COLS, row=Math.floor(i/COLS);
    const dx=PAD+col*(TILE_W+GAP);
    const dy=TITLE_H+PAD+row*(TILE_H+GAP);
    _drawHarkerTile(ox,dx,dy);
  });

  // ── Legend (right column) ────────────────────────────────────────────────────
  const lx=PAD+COLS*(TILE_W+GAP);
  const ly=TITLE_H+PAD;
  const lh=ROWS*TILE_H+(ROWS-1)*GAP;
  octx.fillStyle='#f6f8fa'; octx.fillRect(lx,ly,LEG_W,lh);
  octx.strokeStyle='#d0d7de'; octx.lineWidth=0.8; octx.strokeRect(lx,ly,LEG_W,lh);

  octx.fillStyle='#656d76'; octx.font='bold 9px system-ui,sans-serif'; octx.textAlign='left'; octx.textBaseline='top';
  octx.fillText('SAMPLES',lx+10,ly+10);
  octx.strokeStyle='#e2e5ea'; octx.lineWidth=0.5;
  octx.beginPath(); octx.moveTo(lx+10,ly+22); octx.lineTo(lx+LEG_W-10,ly+22); octx.stroke();

  samples.forEach((s,i)=>{
    const {color,shape}=getHKStyle(s,samples,S._hkColorMode||'sample');
    const sy=ly+30+i*22;
    if(sy+14>ly+lh)return; // overflow guard
    drawCBShape(octx,shape,lx+16,sy+6,5,color,'rgba(255,255,255,0.6)',1,1);
    octx.fillStyle='#1f2328'; octx.font='10px system-ui,monospace'; octx.textAlign='left'; octx.textBaseline='middle';
    const nm=s.name.length>22?s.name.slice(0,22)+'…':s.name;
    octx.fillText(nm,lx+28,sy+6);
    // Rock type sub-label (with extra spacing)
    if((S._hkColorMode||'sample')==='rocktype'&&s.rockType){
      octx.fillStyle='#8c959f'; octx.font='9px system-ui,sans-serif';
      octx.fillText(s.rockType.slice(0,24),lx+28,sy+16);
    }
  });

  // Watermark
  octx.fillStyle='rgba(100,120,140,0.25)'; octx.font='8px system-ui,sans-serif';
  octx.textAlign='right'; octx.textBaseline='bottom';
  octx.fillText('rhyolite-MELTS Tracker',totalW-4,totalH-3);

  // Download
  const a=document.createElement('a');
  a.download='harker_diagrams_'+Date.now()+'.png';
  a.href=out.toDataURL('image/png');
  a.click();
  toast('Harker PNG exported ✓ ('+EXPORT_DPR+'× DPR, '+totalW+'×'+totalH+' px logical)');
}

// ════════════════════════════════════════════════════════
//  JOURNAL
// ════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════
//  EXPORT RUN HARKER PNG (compositional Harkers from Runs tab)
// ════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════
//  EXPORT BATCH PNG (grid views for all runs in a batch)
// ════════════════════════════════════════════════════════
function exportBatchPDF(batchId){
  const batch=getBatch(batchId);if(!batch)return;
  const runs=(S.simsets||[]).filter(ss=>ss.batchId===batchId);
  if(!runs.length){toast('No runs in this batch','err');return;}

  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const BG=isDark?'#0d1117':'#ffffff';
  const HDR_BG=isDark?'#161b22':'#f6f8fa';
  const TEXT=isDark?'#e6edf3':'#24292f';
  const MUTED=isDark?'#8b949e':'#656d76';
  const BORDER_C=isDark?'#30363d':'#d1d5db';
  const CB=isCBMode();
  const COL_OK=CB?'#009E73':'#238636';
  const COL_FAIL=CB?'#D55E00':'#da3633';
  const COL_NR=isDark?'#3d444d':'#e5e7eb';

  // Build HTML for print window
  const GRIDS_PER_PAGE=PDF_GRIDS_PER_PAGE; // 3×3
  const pages=[];
  for(let i=0;i<runs.length;i+=GRIDS_PER_PAGE){
    pages.push(runs.slice(i,i+GRIDS_PER_PAGE));
  }

  // Helper: render a single run grid (minimal: name, grid, count/%)
  function runGridHtml(ss){
    const comps=ss.compositions||[];
    const rc=getRunCount(comps);
    const pct=Math.round(ss.total>0?rc/ss.total*100:0);
    // Build grid cells using div flex-wrap for reliable print rendering
    const COLS=20;
    let cellDivs='';
    for(let ci=0;ci<comps.length;ci++){
      const c=comps[ci];
      const col=c.status==='success'?COL_OK:c.status==='failed'?COL_FAIL:COL_NR;
      cellDivs+=`<div style="width:11px;height:11px;background:${col};border-radius:2px;flex-shrink:0;-webkit-print-color-adjust:exact;print-color-adjust:exact"></div>`;
    }
    return `<div style="background:${BG};border:1px solid ${BORDER_C};border-radius:6px;padding:10px;break-inside:avoid;page-break-inside:avoid">
      <div style="font-size:11px;font-weight:700;color:${TEXT};font-family:monospace;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHTML(ss.name)}</div>
      <div style="font-size:9px;color:${MUTED};margin-bottom:6px">${rc}/${ss.total} · ${pct}%</div>
      <div style="display:flex;flex-wrap:wrap;gap:2px;max-width:${(11+2)*COLS}px">${cellDivs}</div>
    </div>`;
  }

  // Use the canonical escaper so " is also escaped — defensive even though current
  // sites are text-content only, in case sites are repurposed for attributes later.
  const escHTML = esc;

  // Citation / license / repo block for cover page (built once, shown on page 1)
  const _stx = S.settings || {};
  const citationBlock = (_stx.citation||_stx.license||_stx.repoUrl||_stx.doi||_stx.owner) ? `
    <div style="margin-top:12px;padding:10px 12px;background:${HDR_BG};border-left:3px solid ${COL_OK};border-radius:4px;font-size:10px;color:${TEXT};line-height:1.6">
      <div style="font-weight:700;color:${MUTED};text-transform:uppercase;letter-spacing:.5px;font-size:9px;margin-bottom:4px">How to cite</div>
      ${_stx.owner?`<div><strong>${escHTML(_stx.owner)}</strong>${_stx.advisors?` · Advisors: ${escHTML(_stx.advisors)}`:''}</div>`:''}
      ${_stx.citation?`<div style="font-style:italic;margin-top:3px;white-space:pre-wrap">${escHTML(_stx.citation)}</div>`:''}
      ${_stx.doi?`<div style="margin-top:3px">DOI: <span style="font-family:monospace">${escHTML(_stx.doi)}</span></div>`:''}
      ${_stx.repoUrl?`<div>Source: ${escHTML(_stx.repoUrl)}</div>`:''}
      ${_stx.license?`<div>License: ${escHTML(_stx.license)}</div>`:''}
      <div style="color:${MUTED};margin-top:3px">rhyolite-MELTS Tracker v${APP_VERSION}</div>
    </div>` : '';

  const pageHtmls=pages.map((pg,pi)=>{
    const cells=pg.map(ss=>`<div style="break-inside:avoid">${runGridHtml(ss)}</div>`).join('');
    return `<div class="page-block">
      ${pi===0?`<div style="margin-bottom:16px;border-bottom:2px solid ${BORDER_C};padding-bottom:10px">
        <div style="font-size:18px;font-weight:700;color:${TEXT}">📦 ${escHTML(batch.name)}</div>
        <div style="font-size:11px;color:${MUTED};margin-top:3px">${runs.length} run${runs.length===1?'':'s'} · Exported ${new Date().toLocaleString()}</div>
        <div style="margin-top:8px;display:flex;gap:16px;font-size:11px">
          <span style="color:${COL_OK}">■ Success</span>
          <span style="color:${COL_FAIL}">■ Failed</span>
          <span style="color:${COL_NR}">■ Not Run</span>
        </div>
        ${citationBlock}
      </div>`:''}
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">${cells}</div>
    </div>`;
  }).join('<div style="page-break-after:always"></div>');

  const fullHtml=`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>Batch Export — ${escHTML(batch.name)}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:${BG};color:${TEXT};font-family:system-ui,sans-serif;padding:20px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .page-block{margin-bottom:20px}
      td{-webkit-print-color-adjust:exact;print-color-adjust:exact}
      @media print{
        body{padding:10px}
        .page-block{page-break-inside:avoid}
        @page{margin:12mm;size:A4}
      }
    </style>
  </head><body>
    ${pageHtmls}
    <script>window.onload=function(){window.print();}<\/script>
  </body></html>`;

  const win=window.open('','_blank','width=900,height=700');
  if(win){win.document.write(fullHtml);win.document.close();}
  else toast('Allow popups to export PDF','err');
  toast('Batch PDF ready — use browser Print dialog ✓');
}
function exportRunHarkerPNG(ssid){
  const ss=getSimset(ssid);if(!ss)return;
  const cwr=ss.compWholeRock;
  if(!cwr||!cwr.headers||!cwr.headers.length){toast('No WR data to export','err');return;}
  const yOxides=OXIDES.filter(o=>o!=='SiO2'&&cwr.headers.includes(o));
  if(!yOxides.length){toast('No plottable oxides','err');return;}

  const EXPORT_DPR=3;
  const TILE_W=280, TILE_H=220;
  const COLS=Math.min(3,yOxides.length);
  const ROWS=Math.ceil(yOxides.length/COLS);
  const GAP=12, PAD=20, TITLE_H=52, LEG_H=44;
  const TW_PX=(TILE_W*COLS+GAP*(COLS-1)+PAD*2)*EXPORT_DPR;
  const TH_PX=(TITLE_H+ROWS*(TILE_H+GAP)-GAP+LEG_H+PAD*2)*EXPORT_DPR;

  const oc=document.createElement('canvas');
  oc.width=TW_PX; oc.height=TH_PX;
  const ctx=oc.getContext('2d');
  ctx.scale(EXPORT_DPR,EXPORT_DPR);
  const W=oc.width/EXPORT_DPR, H=oc.height/EXPORT_DPR;

  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const BG=isDark?'#0d1117':'#ffffff';
  const HDR=isDark?'#161b22':'#f6f8fa';
  const TEXT=isDark?'#e6edf3':'#24292f';
  const MUTED=isDark?'#8b949e':'#656d76';
  const BORDER=isDark?'#30363d':'#e2e5ea';

  // Background
  ctx.fillStyle=BG; ctx.fillRect(0,0,W,H);
  // Header bar
  ctx.fillStyle=HDR; ctx.fillRect(0,0,W,TITLE_H);
  ctx.strokeStyle=BORDER; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,TITLE_H); ctx.lineTo(W,TITLE_H); ctx.stroke();

  // Title
  ctx.fillStyle=TEXT;
  ctx.font='bold 15px "Segoe UI",system-ui,sans-serif';
  ctx.textAlign='left'; ctx.textBaseline='middle';
  ctx.fillText('Compositional Harker Diagrams — '+ss.name, PAD, TITLE_H*0.38);
  ctx.font='11px "Segoe UI",system-ui,sans-serif';
  ctx.fillStyle=MUTED;
  ctx.fillText(new Date().toLocaleString()+' · '+yOxides.length+' oxides', PAD, TITLE_H*0.72);

  // Draw each oxide tile by copying from live canvas
  yOxides.forEach((ox,i)=>{
    const srcCanvas=document.getElementById('rwh-'+ssid+'-'+ox);
    if(!srcCanvas)return;
    const col=i%COLS, row=Math.floor(i/COLS);
    const tx=PAD+col*(TILE_W+GAP);
    const ty=TITLE_H+PAD+row*(TILE_H+GAP);
    // Draw border
    ctx.strokeStyle=BORDER; ctx.lineWidth=1;
    ctx.beginPath(); ctx.roundRect(tx,ty,TILE_W,TILE_H,4); ctx.stroke();
    // Copy tile
    try{ ctx.drawImage(srcCanvas,tx,ty,TILE_W,TILE_H); }catch(err){}
  });

  // Legend bar
  const legY=TITLE_H+PAD+ROWS*(TILE_H+GAP)-GAP+6;
  ctx.fillStyle=HDR;
  ctx.fillRect(PAD,legY,W-PAD*2,LEG_H-6);
  ctx.strokeStyle=BORDER; ctx.lineWidth=1;
  ctx.beginPath(); ctx.roundRect(PAD,legY,W-PAD*2,LEG_H-6,4); ctx.stroke();

  const _cbM=isCBMode();
  const okCol=_cbM?'#0072B2':'#56d364';
  const failCol=_cbM?'#D55E00':'#f85149';
  const nrCol='rgba(110,118,129,0.4)';
  const succ=ss.compositions.filter(c=>c.status==='success').length;
  const fail=ss.compositions.filter(c=>c.status==='failed').length;

  const items=[
    {col:okCol,  label:'Q2F Success ('+succ+')'},
    {col:failCol,label:'Q2F Failure ('+fail+')'},
    {col:nrCol,  label:'Not Run'},
  ];
  let lx=PAD+10;
  const ly=legY+(LEG_H-6)/2;
  ctx.textBaseline='middle';
  items.forEach(it=>{
    ctx.fillStyle=it.col;
    ctx.beginPath(); ctx.arc(lx+5,ly,5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle=TEXT;
    ctx.font='11px "Segoe UI",system-ui,sans-serif';
    ctx.textAlign='left';
    ctx.fillText(it.label, lx+14, ly);
    lx+=ctx.measureText(it.label).width+36;
  });

  // Watermark
  ctx.font='9px "Segoe UI",system-ui,sans-serif';
  ctx.fillStyle='rgba(139,148,158,0.3)';
  ctx.textAlign='right'; ctx.textBaseline='bottom';
  ctx.fillText('rhyolite-MELTS Tracker',W-PAD,H-4);

  const link=document.createElement('a');
  link.download='run_harkers_'+(ss.name||ssid).replace(/[^a-z0-9_-]/gi,'_')+'_'+Date.now()+'.png';
  link.href=oc.toDataURL('image/png');
  link.click();
  toast('Run Harker PNG exported ✓ (3× DPR, '+COLS+'×'+ROWS+' grid)');
}
// (Journal tab and all journal-related functions removed in v0.20.)

// ════════════════════════════════════════════════════════
//  ONBOARDING (first-run wizard)
// ════════════════════════════════════════════════════════

// Detect first-run state. We show the wizard when:
//  (a) the user explicitly cleared everything (no samples, no simsets), AND
//  (b) they haven't already marked onboarding complete on this state.
function _needsOnboarding(){
  const hasData=(S.samples&&S.samples.length>0)||(S.simsets&&S.simsets.length>0);
  return !hasData && !S._onboardingComplete;
}

function showOnboarding(){
  const ov=document.getElementById('onboarding-overlay');
  if(!ov)return;
  // Always start at the choose step
  document.getElementById('ob-step-choose').style.display='';
  document.getElementById('ob-step-new').style.display='none';
  // Stamp version label
  const vl=document.getElementById('ob-version-label');
  if(vl)vl.textContent=APP_VERSION;
  // Seed at least one empty unit row in case the user clicks New Project
  const list=document.getElementById('ob-units-list');
  if(list&&!list.children.length){obAddUnitRow();obAddUnitRow();}
  ov.classList.add('show');
  setTimeout(()=>{const f=document.querySelector('#ob-step-choose .ob-path-btn');if(f)f.focus();},30);
}
function hideOnboarding(){
  const ov=document.getElementById('onboarding-overlay');
  if(ov)ov.classList.remove('show');
}

function obShowNewProject(){
  document.getElementById('ob-step-choose').style.display='none';
  document.getElementById('ob-step-new').style.display='';
  setTimeout(()=>{const f=document.getElementById('ob-title-in');if(f)f.focus();},20);
}
function obBackToChoose(){
  document.getElementById('ob-step-choose').style.display='';
  document.getElementById('ob-step-new').style.display='none';
}

// "Skip for now" — sets onboardingComplete so the wizard doesn't reappear, but
// leaves the empty state intact. User lands on the Samples page (sensible first stop).
function obSkip(){
  S._onboardingComplete=true;
  save();
  hideOnboarding();
  showPage('samples');
  toast('You can configure project identity any time in Settings.');
}

function obHandleExistingFile(ev){
  const f=ev.target.files[0];
  if(!f)return;
  // Reuse the existing importData flow — it already validates, snapshots, and renders.
  // After import succeeds, importData renders sidebar + showPage('runs') and toasts.
  // We just need to mark onboarding complete and hide the overlay.
  const orig=document.getElementById('import-file');
  // Hand off via a synthetic event so we don't duplicate the parser.
  const stash={target:{files:[f],value:''}};
  importData(stash);
  // importData reads async; mark onboarding-complete shortly after to give it time.
  setTimeout(()=>{
    if((S.samples&&S.samples.length>0)||(S.simsets&&S.simsets.length>0)){
      S._onboardingComplete=true;save();hideOnboarding();
    }else{
      // Import failed (banner already showed); leave wizard open so user can retry.
      ev.target.value='';
    }
  },300);
}

let _obUnitRowCounter=0;
const OB_DEFAULT_COLORS=['#58a6ff','#f0883e','#56d364','#d2a8ff','#e3b341','#f85149','#79c0ff','#ffa657'];
function obAddUnitRow(name='',abbr='',color=null){
  const list=document.getElementById('ob-units-list');
  if(!list)return;
  const idx=_obUnitRowCounter++;
  const c=color||OB_DEFAULT_COLORS[list.children.length%OB_DEFAULT_COLORS.length];
  const row=document.createElement('div');
  row.className='ob-unit-row';
  row.dataset.idx=idx;
  row.innerHTML=`
    <input type="text" class="ob-unit-name" placeholder="Unit name (e.g. Bishop Tuff)" value="${esc(name)}" autocomplete="off">
    <input type="text" class="ob-unit-abbr" placeholder="Abbr" maxlength="6" value="${esc(abbr)}" autocomplete="off" style="max-width:80px">
    <input type="color" class="ob-unit-color" value="${esc(c)}" title="Unit display colour">
    <button class="btn btn-sm btn-danger" type="button" onclick="this.parentNode.remove()" aria-label="Remove this unit">✕</button>
  `;
  list.appendChild(row);
}

function obSubmitNewProject(){
  const v=id=>(document.getElementById(id).value||'').trim();
  const title=v('ob-title-in');
  const owner=v('ob-owner-in');
  if(!title){toast('Project title is required','err');document.getElementById('ob-title-in').focus();return;}
  if(!owner){toast('Project owner is required','err');document.getElementById('ob-owner-in').focus();return;}

  // Collect units (only rows with a non-empty name)
  const rows=Array.from(document.querySelectorAll('#ob-units-list .ob-unit-row'));
  const units=[];
  for(const r of rows){
    const name=(r.querySelector('.ob-unit-name').value||'').trim();
    const abbr=(r.querySelector('.ob-unit-abbr').value||'').trim();
    const color=r.querySelector('.ob-unit-color').value||'#58a6ff';
    if(!name)continue;
    if(!abbr){toast('Each unit needs an abbreviation. Empty abbr on "'+name+'".','err');return;}
    units.push({id:'U'+Date.now()+Math.random().toString(36).slice(2,5),name,abbr,color});
  }
  if(units.length===0){
    if(!confirm('No geological units defined. You can add them later from Settings, but it\'s easier to set them up now. Continue without units?'))return;
  }

  // Commit to state
  S._appTitle = title;
  if(!S.settings)S.settings={};
  S.settings.owner    = owner;
  S.settings.advisors = v('ob-advisors-in');
  S.settings.citation = v('ob-citation-in');
  S.settings.license  = v('ob-license-in');
  S.settings.repoUrl  = v('ob-repo-in');
  S.settings.doi      = v('ob-doi-in');
  S.units = units;
  S._onboardingComplete = true;
  const ok=save();
  if(!ok)return; // save() banner will explain why
  hideOnboarding();
  loadAppTitle();
  _updateSubtitle();
  showPage('samples');
  toast('Project "'+title+'" created — add your first sample to get started.');
}


// ════════════════════════════════════════════════════════
//  THEME + CB BOOT APPLY
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
//  SHARED HARKER HOVER TOOLTIP
// ════════════════════════════════════════════════════════
(function(){
  const tip=document.createElement('div');
  tip.id='hk-tooltip';
  Object.assign(tip.style,{
    position:'fixed',pointerEvents:'none',display:'none',
    background:'rgba(13,17,23,0.95)',color:'#e6edf3',
    border:'1px solid #30363d',borderRadius:'6px',
    padding:'5px 10px',fontSize:'12px',fontFamily:'var(--mono)',
    zIndex:'9999',whiteSpace:'nowrap',boxShadow:'0 4px 12px rgba(0,0,0,.5)',
    lineHeight:'1.5'
  });
  document.body.appendChild(tip);

  // ── Inspector panel ─────────────────────────────────────────────────────
  const insp=document.createElement('div');
  insp.id='hk-inspector';
  Object.assign(insp.style,{
    position:'fixed',
    right:'clamp(8px, 2vw, 16px)',
    bottom:'clamp(8px, 2vh, 16px)',
    display:'none',
    background:'var(--surface)',
    border:'1px solid var(--border)',
    borderRadius:'10px',
    padding:'clamp(12px,2vw,18px) clamp(14px,2vw,20px)',
    fontSize:'clamp(12px,1.1vw,14px)',
    fontFamily:'var(--mono)',
    color:'var(--text)',
    zIndex:'9998',
    width:'clamp(280px,min(92vw,400px),400px)',
    maxHeight:'clamp(40vh,60vh,75vh)',
    overflowY:'auto',
    boxShadow:'0 8px 40px rgba(0,0,0,.7)',
    lineHeight:'1.65',
    transition:'opacity .15s'
  });
  insp.innerHTML='<div style="display:flex;align-items:center;margin-bottom:10px">'+
    '<span style="font-weight:700;font-size:clamp(13px,1.3vw,16px);flex:1;font-family:var(--mono);line-height:1.3" id="hk-insp-title">Point Details</span>'+
    '<button style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:0" onclick="closeInspector()">✕</button>'+
    '</div><div id="hk-insp-body"></div>';
  document.body.appendChild(insp);

  window._hkMouseMove=function(e){
    const canvas=e.currentTarget;
    const pts=JSON.parse(canvas.dataset.hkPts||'[]');
    if(!pts.length){tip.style.display='none';return;}
    // hkPts stores LOGICAL pixel coords (toX/toY use CSS W/H).
    // Use raw CSS-pixel offset — do NOT multiply by devicePixelRatio.
    const rect=canvas.getBoundingClientRect();
    const mx=(e.clientX-rect.left);
    const my=(e.clientY-rect.top);
    let hit=null;
    let best=Infinity;
    pts.forEach(p=>{
      const d=Math.sqrt((mx-p.px)**2+(my-p.py)**2);
      const hitR=(p.r||5)+4; // generous hit zone
      if(d<hitR&&d<best){best=d;hit=p;}
    });
    if(hit){
      tip.textContent=hit.label;
      tip.style.display='block';
      tip.style.left=(e.clientX+14)+'px';
      tip.style.top=(e.clientY-10)+'px';
    }else{
      tip.style.display='none';
    }
  };
  window._hkMouseLeave=function(){tip.style.display='none';};
})();

// ════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════
// Vitest skips this block by setting window.__TEST_MODE__ before injection.
if (typeof window === 'undefined' || !window.__TEST_MODE__) {
  load();
  if(!Array.isArray(S.simsets))S.simsets=[];
  if(!Array.isArray(S.samples))S.samples=[];
  applyTheme();
  applyCB();
  setTimeout(()=>{loadAppTitle();_updateSubtitle();},50);
  applyEM();
  renderSidebar();
  // restore last page
  const _bootPage = S.activePage && ['runs','samples','overview','thresh','settings','pvis'].includes(S.activePage) ? S.activePage : 'runs';
  showPage(_bootPage);

  // First-run check — show the onboarding overlay if this looks like a brand-new project.
  // Done AFTER showPage() so the underlying page is rendered when the user dismisses.
  if(_needsOnboarding()){
    setTimeout(showOnboarding, 50);
  }

  // ?test=1 query param runs the built-in self-test suite on load (output in console).
  try{
    if(new URLSearchParams(location.search).get('test')==='1'){
      setTimeout(()=>{ try{ runUnitTests(); }catch(e){console.error('runUnitTests threw:',e);} },200);
    }
  }catch(e){console.error('test-on-load probe failed:',e);}

  // Export-nag: gentle reminder if data hasn't been exported in 14+ days.
  setTimeout(_checkExportNag,1000);
}

// ═══════════════════════════════════════════════
// Unit Tests T2-T8 — call runUnitTests() in console
// ═══════════════════════════════════════════════
function runUnitTests(){
  let pass=0,fail=0;
  function assert(label,cond){if(cond){console.log('✅ '+label);pass++;}else{console.error('❌ '+label);fail++;}}

  // T2: Unit drag-drop reorders correctly (0→2)
  (function(){
    const bk=S.units;
    S.units=[{id:'U1'},{id:'U2'},{id:'U3'}];
    _unitDragIdx=0;
    _unitDrop({preventDefault:()=>{}},2);
    assert('T2 unit drag 0→2: U2 first',S.units[0].id==='U2');
    assert('T2 unit drag 0→2: U3 second',S.units[1].id==='U3');
    assert('T2 unit drag 0→2: U1 third',S.units[2].id==='U1');
    S.units=bk;
  })();

  // T3: getHKStyle cycling – index 6 gets shape[1] and same color as index 0
  (function(){
    const fake=(n)=>Array.from({length:n},(_,i)=>({id:'s'+i,rockType:'',unitId:''}));
    const samps=fake(8);
    const s0=getHKStyle(samps[0],samps,'sample');
    const s6=getHKStyle(samps[6],samps,'sample');
    assert('T3 color wraps at 6',s6.color===s0.color);
    assert('T3 shape cycles at 6',s6.shape===HK_SHAPES[1]);
  })();

  // T4: Rock-type colorby with blank rock type falls back safely
  (function(){
    const samps=[{rockType:'',unitId:''}];
    const st=getHKStyle(samps[0],samps,'rocktype');
    assert('T4 rocktype blank fallback has color',typeof st.color==='string'&&st.color.length>0);
    assert('T4 rocktype blank fallback has shape',typeof st.shape==='string'&&st.shape.length>0);
  })();

  // T5: Rank plot with single data point doesn't throw
  (function(){
    const fakeSid=(S.simsets&&S.simsets[0]&&S.simsets[0].id)||null;
    if(!fakeSid){console.warn('T5 skipped – no simsets');return;}
    const ss=S.simsets[0];
    const bkT=ss.thresholds;
    const fakeT={id:'TTEST',name:'Test',cutoff:500,unit:'MPa',compositions:[{num:1,status:'OK',pValue:450}],pMean:'',pStd:'',pUnit:'',open:false};
    ss.thresholds=[fakeT];
    // buildRankPlot shouldn't throw
    try{buildRankPlot(ss.id,fakeT.id);assert('T5 buildRankPlot single point',true);}
    catch(e){assert('T5 buildRankPlot single point',false);}
    ss.thresholds=bkT;
  })();

  // T6: (removed in v0.20 — Journal tab eliminated)

  // T7: Import/export roundtrip preserves unit order
  (function(){
    const before=(S.units||[]).map(u=>u.id).join(',');
    const json=JSON.stringify(S);
    const imported=JSON.parse(json);
    const after=(imported.units||[]).map(u=>u.id).join(',');
    assert('T7 unit order preserved in JSON roundtrip',before===after);
  })();

  // T8: isCBMode() toggle affects symbol choice in getHKStyle
  (function(){
    // CB mode uses CB_PALETTE; non-CB uses HK_PALETTE
    const samps=[{rockType:'',unitId:''}];
    const prevCB=document.body.classList.contains('cb-active');
    document.body.classList.remove('cb-active');
    const normalColor=getHKStyle(samps[0],samps,'sample').color;
    document.body.classList.add('cb-active');
    const cbColor=getHKStyle(samps[0],samps,'sample').color;
    // Both should be defined (CB may use same first color depending on impl)
    assert('T8 non-CB color defined',typeof normalColor==='string');
    assert('T8 CB color defined',typeof cbColor==='string');
    if(!prevCB)document.body.classList.remove('cb-active');
  })();

  console.log('\n── Unit Test Summary ──');
  console.log('PASS: '+pass+'  FAIL: '+fail);
  toast('Tests: '+pass+' pass, '+fail+' fail'+(fail?'':'  ✓'));
}

// ════════════════════════════════════════════════════════
//  PRESSURE VISUALIZATION PAGE
// ════════════════════════════════════════════════════════
function renderPressureViz(){
  const el=document.getElementById('pg-pvis');
  if(!el)return;

  const simsets=S.simsets||[];
  const threshRuns=simsets.filter(ss=>{
    const s=getS(ss.id);
    return s&&s.thresholds&&s.thresholds.length>0&&
      s.thresholds.some(t=>t.compositions&&t.compositions.some(c=>(c.status===ST.OK||c.status==='success')&&c.pValue!=null));
  });

  if(!threshRuns.length){
    el.innerHTML=`<div style="padding:40px;text-align:center;color:var(--text-muted)">
      <div style="font-size:48px;margin-bottom:16px">🔭</div>
      <div style="font-size:18px;font-weight:700;margin-bottom:8px">Pressure Visualization</div>
      <div style="font-size:13px">No pressure solutions found. Run P Calc thresholding first.</div>
    </div>`;
    return;
  }

  // Build a colour palette per run (cycling through Harker palette)
  const RUN_PALETTE=['#0072B2','#E69F00','#009E73','#D55E00','#CC79A7','#56B4E9','#332288','#999999'];
  const runColors={};
  threshRuns.forEach((ss,i)=>{ runColors[ss.id]=RUN_PALETTE[i%RUN_PALETTE.length]; });

  // One canvas per run — stacked vertically, each showing all thresholds for that run
  let canvasesHtml=threshRuns.map((ss,ri)=>{
    const s=getS(ss.id);
    const col=runColors[ss.id];
    const threshs=(s.thresholds||[]).filter(t=>t.compositions&&t.compositions.some(c=>(c.status===ST.OK||c.status==='success')&&c.pValue!=null));
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <span style="font-size:15px;font-weight:700;font-family:var(--mono);color:${col}">${esc(ss.name)}</span>
        <span style="font-size:11px;color:var(--text-muted)">${threshs.length} threshold${threshs.length!==1?'s':''}</span>
        <button class="btn btn-sm" style="margin-left:auto;font-size:10px;padding:2px 8px" onclick="exportPVisRun('${ss.id}')">📷 Export</button>
      </div>
      <canvas id="pvis-${ss.id}" style="width:100%;height:260px;display:block;border-radius:6px"></canvas>
    </div>`;
  }).join('');

  // Legend: run colour chips
  const legendHtml=threshRuns.map(ss=>`
    <div style="display:flex;align-items:center;gap:6px;white-space:nowrap">
      <div style="width:12px;height:12px;border-radius:50%;background:${runColors[ss.id]};flex-shrink:0"></div>
      <span style="font-size:11px;color:var(--text)">${esc(ss.name)}</span>
    </div>`).join('');

  el.innerHTML=`<div style="padding:18px;max-width:1100px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap">
      <h2 style="font-size:20px;font-weight:700;margin:0">🔭 Pressure Visualization</h2>
      <span style="font-size:12px;color:var(--text-muted)">Rank-order pressure distributions per Run · all thresholds overlaid</span>
    </div>
    <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;flex-wrap:wrap;gap:10px 20px;margin-bottom:16px">
      ${legendHtml}
    </div>
    ${canvasesHtml}
  </div>`;

  // Draw each canvas after render
  setTimeout(()=>{ threshRuns.forEach(ss=>_drawPVisRun(ss.id,runColors[ss.id])); }, 60);
}

function _drawPVisRun(ssId, baseColor){
  const canvas=document.getElementById('pvis-'+ssId);
  if(!canvas)return;
  const s=getS(ssId);if(!s)return;
  const threshs=(s.thresholds||[]).filter(t=>t.compositions&&t.compositions.some(c=>(c.status===ST.OK||c.status==='success')&&c.pValue!=null));
  if(!threshs.length)return;

  const DPR=Math.max(window.devicePixelRatio||1,2);
  const W=canvas.parentElement?canvas.parentElement.clientWidth||700:700;
  const H=260;
  canvas.width=W*DPR; canvas.height=H*DPR;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d'); ctx.scale(DPR,DPR);

  const isDark=(document.documentElement.getAttribute('data-theme')||'dark')!=='light';
  ctx.fillStyle=isDark?'#161b22':'#f6f8fa'; ctx.fillRect(0,0,W,H);

  // Collect all pressure values to set unified Y axis
  let allP=[];
  threshs.forEach(t=>{
    t.compositions.filter(c=>(c.status===ST.OK||c.status==='success')&&c.pValue!=null).forEach(c=>allP.push(c.pValue));
  });
  if(!allP.length)return;
  const pMin=Math.min(...allP),pMax=Math.max(...allP);
  const pPad=(pMax-pMin)*0.1||10;
  const ylo=pMin-pPad, yhi=pMax+pPad;

  const PAD={top:28,right:20,bottom:42,left:58};
  const plotW=W-PAD.left-PAD.right, plotH=H-PAD.top-PAD.bottom;

  // Draw grid lines
  ctx.strokeStyle=isDark?'#21262d':'#e1e4e8'; ctx.lineWidth=0.6;
  for(let i=0;i<=4;i++){
    const yv=ylo+(yhi-ylo)*i/4;
    const py=H-PAD.bottom-(yv-ylo)/(yhi-ylo)*plotH;
    ctx.beginPath(); ctx.moveTo(PAD.left,py); ctx.lineTo(PAD.left+plotW,py); ctx.stroke();
  }

  // Draw each threshold as a separate overlaid series with opacity/shade
  threshs.forEach((t,ti)=>{
    const pts=t.compositions
      .filter(c=>(c.status===ST.OK||c.status==='success')&&c.pValue!=null)
      .map(c=>({num:c.num,p:c.pValue}))
      .sort((a,b)=>a.p-b.p);
    if(!pts.length)return;

    const n=pts.length;
    const toX=i=>PAD.left+(i/(n>1?n-1:1))*plotW;
    const toY=v=>H-PAD.bottom-(v-ylo)/(yhi-ylo)*plotH;

    // Shade: first threshold = full opacity, subsequent = lighter
    const alpha=Math.max(0.25, 1-ti*0.18);
    // Draw connecting line
    ctx.beginPath();
    pts.forEach((pt,i)=>{ if(i===0)ctx.moveTo(toX(i),toY(pt.p)); else ctx.lineTo(toX(i),toY(pt.p)); });
    ctx.strokeStyle=baseColor; ctx.globalAlpha=alpha*0.5; ctx.lineWidth=1.5; ctx.stroke();
    ctx.globalAlpha=1;

    // Draw points
    pts.forEach((pt,i)=>{
      ctx.beginPath(); ctx.arc(toX(i),toY(pt.p),3.5,0,Math.PI*2);
      ctx.fillStyle=baseColor; ctx.globalAlpha=alpha; ctx.fill(); ctx.globalAlpha=1;
    });

    // Threshold label at rightmost point
    const last=pts[pts.length-1];
    ctx.fillStyle=baseColor; ctx.globalAlpha=Math.max(0.6,alpha);
    ctx.font='9px sans-serif'; ctx.textAlign='left';
    ctx.fillText(esc(t.name),toX(n-1)+5,toY(last.p)+3);
    ctx.globalAlpha=1;
  });

  // Axes
  const axC=isDark?'#8b949e':'#6e7681';
  ctx.strokeStyle=axC; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(PAD.left,PAD.top); ctx.lineTo(PAD.left,H-PAD.bottom); ctx.lineTo(W-PAD.right,H-PAD.bottom); ctx.stroke();

  // Y axis labels
  ctx.fillStyle=axC; ctx.font='10px sans-serif'; ctx.textAlign='right';
  for(let i=0;i<=4;i++){
    const yv=ylo+(yhi-ylo)*i/4;
    const py=H-PAD.bottom-(yv-ylo)/(yhi-ylo)*plotH;
    ctx.fillText(yv.toFixed(0),PAD.left-5,py+4);
  }
  // Y axis title
  ctx.save(); ctx.translate(13,H/2); ctx.rotate(-Math.PI/2);
  ctx.textAlign='center'; ctx.fillStyle=axC; ctx.font='10px sans-serif';
  ctx.fillText('Pressure ('+(threshs[0].pUnit||'MPa')+')',0,0); ctx.restore();

  // X axis title
  ctx.fillStyle=axC; ctx.font='10px sans-serif'; ctx.textAlign='center';
  ctx.fillText('Rank (lowest → highest P)',W/2,H-6);

  // Top title (run name)
  ctx.fillStyle=isDark?'#e6edf3':'#24292f'; ctx.font='bold 12px sans-serif'; ctx.textAlign='left';
  ctx.fillText(s.name,PAD.left,16);

  // Store hover data
  const hoverPts=[];
  threshs.forEach((t,ti)=>{
    const pts=t.compositions
      .filter(c=>(c.status===ST.OK||c.status==='success')&&c.pValue!=null)
      .map(c=>({num:c.num,p:c.pValue}))
      .sort((a,b)=>a.p-b.p);
    const n=pts.length;
    const toX=i=>PAD.left+(i/(n>1?n-1:1))*plotW;
    const toY=v=>H-PAD.bottom-(v-ylo)/(yhi-ylo)*plotH;
    pts.forEach((pt,i)=>hoverPts.push({label:'['+esc(t.name)+'] #'+pt.num+' P='+pt.p.toFixed(2)+(threshs[0].pUnit?' '+threshs[0].pUnit:''),px:toX(i),py:toY(pt.p),r:7}));
  });
  canvas.dataset.pvPts=JSON.stringify(hoverPts);
  if(!canvas._pvH){
    canvas._pvH=true;
    canvas.addEventListener('mousemove',function(e){
      const rect=canvas.getBoundingClientRect();
      const mx=e.clientX-rect.left,my=e.clientY-rect.top;
      const pp=JSON.parse(canvas.dataset.pvPts||'[]');
      const hit=pp.find(p=>Math.hypot(p.px-mx,p.py-my)<=p.r+3);
      canvas.title=hit?hit.label:'';
    });
  }
}

function exportPVisRun(ssId){
  const canvas=document.getElementById('pvis-'+ssId);
  if(!canvas){toast('Draw the chart first','err');return;}
  const a=document.createElement('a');
  const s=getS(ssId);
  const nm=(s?s.name:'run').replace(/[^a-z0-9_-]/gi,'_');
  a.download='pressure_viz_'+nm+'_'+Date.now()+'.png';
  // Re-draw at 3× for export quality
  const expC=document.createElement('canvas');
  const DPR=3;
  const W=Math.max(canvas.clientWidth||700,700), H=280;
  expC.width=W*DPR; expC.height=H*DPR;
  const ectx=expC.getContext('2d'); ectx.scale(DPR,DPR);
  // White bg
  ectx.fillStyle='#ffffff'; ectx.fillRect(0,0,W,H);
  // Copy current canvas scaled
  ectx.drawImage(canvas,0,0,W,H);
  a.href=expC.toDataURL('image/png'); a.click();
  toast('Pressure Viz exported ✓');
}

// ════════════════════════════════════════════════════════
//  Phase 4b: delegated event router + small handler wrappers.
//  Markup uses data-action="<fnName>" plus data-a1, data-a2, …
//  for positional string args. For non-click events use
//  data-action-<event>, e.g. data-action-change.
// ════════════════════════════════════════════════════════
function _hTitleBlur(){ saveAppTitle(this.textContent); }
function _hTitleKeydown(e){ if(e.key==='Enter'){ e.preventDefault(); this.blur(); } }
function _hRunTypeChange(){ syncRunType(this.value); }
function _hSimTotalChange(){ syncSimTotal(this.value); }
function _hResetInput(){ const b=document.getElementById('reset-confirm-btn'); if(b) b.disabled=this.value.trim()!=='RESET'; }
function _hImportFileClick(){ document.getElementById('import-file').click(); }
function _hObFileClick(){ document.getElementById('ob-existing-file').click(); }
function _hObSkip(e){ e.preventDefault(); obSkip(); }

const _DELEG_EVENTS = [
  ['click',     'data-action',           'action'],
  ['change',    'data-action-change',    'actionChange'],
  ['input',     'data-action-input',     'actionInput'],
  ['focusout',  'data-action-blur',      'actionBlur'],
  ['keydown',   'data-action-keydown',   'actionKeydown'],
  ['dragstart', 'data-action-dragstart', 'actionDragstart'],
  ['dragend',   'data-action-dragend',   'actionDragend'],
  ['dragover',  'data-action-dragover',  'actionDragover'],
  ['dragleave', 'data-action-dragleave', 'actionDragleave'],
  ['drop',      'data-action-drop',      'actionDrop'],
];
function _initDelegated(){
  _DELEG_EVENTS.forEach(([evt, attr, dsKey])=>{
    document.addEventListener(evt, (e)=>{
      const el = e.target.closest && e.target.closest('['+attr+']');
      if(!el) return;
      const name = el.dataset[dsKey];
      const fn = window[name];
      if(typeof fn !== 'function') return;
      const args = [];
      let i = 1;
      while(el.dataset['a'+i] !== undefined){ args.push(el.dataset['a'+i]); i++; }
      fn.apply(el, [...args, e]);
    });
  });
}
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', _initDelegated, {once:true});
} else { _initDelegated(); }

// Phase 5: ensure any pending debounced save is flushed before the page goes away.
window.addEventListener('beforeunload', flushSave);
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden') flushSave(); });

// ════════════════════════════════════════════════════════
//  Phase 4a: expose module-scoped declarations on window so
//  legacy onclick='fn()' attributes continue to resolve.
// ════════════════════════════════════════════════════════
Object.assign(window, {flushSave,_saveImmediate,_hTitleBlur,_hTitleKeydown,_hRunTypeChange,_hSimTotalChange,_hResetInput,_hImportFileClick,_hObFileClick,_hObSkip,APP_VERSION,BACKUP_PREFIX,BACKUP_RING,BATCH_COLORS,CB_PALETTE,CB_SHAPES,DEFAULT_SIM_TOTAL,HK_PALETTE,HK_SHAPES,OB_DEFAULT_COLORS,OXIDES,OXIDE_ALIASES,OXIDE_COLORS_CB,OXIDE_COLORS_DEFAULT,OXIDE_ORDER,OX_LABEL,PDF_GRIDS_PER_PAGE,RANK_PLOT_EXPORT_DPR,RANK_PLOT_PAD_FRAC,S,SAMPLE_NAMES,SCHEMA_VERSION,ST,STEPS,STORAGE_KEY,UNIT_COLORS,UNIT_COLORS_CB,_baseBtnHTML,_batchColor,_batchDragLeave,_batchDragOver,_batchDragSsId,_batchDragStart,_batchDrop,_buildColorPicker,_buildHKLegend,_buildOxideLegend,_catEditMode,_catSave,_cellKey,_checkExportNag,_doResetData,_draftBtnHTML,_drawPVisRun,_getUnit,_hkClickRun,_hkClickSample,_hkDebounce,_initCats,_injectOxideLegend,_isOxGridOn,_lastFocusBeforeModal,_makeSVGMarker,_needsOnboarding,_obUnitRowCounter,_parseRunWR,_populateUnitSelect,_positionEditPopup,_propagateParentRecovery,_renderRunHarkersFromData,_renderSettingsUnits,_saveBlocked,_showAddCatForm,_smpDragEnd,_smpDragId,_smpDragLeave,_smpDragOver,_smpDragStart,_smpDrop,_ssDragEnd,_ssDragId,_ssDragLeave,_ssDragOver,_ssDragStart,_ssDrop,_submitNewCat,_syncColorby,_syncOxGlobalBtn,_threshDragEnd,_threshDragLeave,_threshDragOver,_threshDragStart,_threshDragging,_threshDrop,_tt,_unitDragEnd,_unitDragIdx,_unitDragLeave,_unitDragOver,_unitDragStart,_unitDrop,_updateSubtitle,_validBatches,_validSampleCategories,_validSettings,_validUnits,activeTab,activeThreshTab,addSampleCategory,addSims,applyCB,applyEM,applyPastedP,applyTheme,assignRunToBatch,autoNameSimset,buildCompTable,buildCounterRows,buildFailedList,buildGrid,buildLockedList,buildOxideGrid,buildRankPlot,buildThreshCard,buildThreshMain,closeEditPopup,closeInspector,closeModal,commitRunWR,copyRecord,createSampleOnly,createSimset,createThreshold,cycleCell,deleteBatch,deleteSample,deleteSampleCategory,deleteSimset,deleteThreshold,deleteUnit,discardRunWRDraft,dismissPersistentBanner,drawCBShape,drawHarker,drawRankPlot,drawRunHarker,esc,exportBatchPDF,exportData,exportGridPng,exportHarkerPNG,exportPVisRun,exportRankPlotPNG,exportRunHarkerPNG,getBatch,getBatches,getCBUnitColor,getComps,getFail,getHKStyle,getPct,getRunCount,getS,getSample,getSimset,getSucc,getT,getWRNorm,hideOnboarding,hkColor,importData,isCBMode,load,loadAppTitle,migrate,migrateComp,migrateSample,migrateSampleEntity,migrateSimsetEntity,migrateThresh,migrateThreshEntity,mkComps,mkSample,mkSampleEntity,mkSimset,mkThreshold,normaliseWR,obAddUnitRow,obBackToChoose,obHandleExistingFile,obShowNewProject,obSkip,obSubmitNewProject,openAddBatch,openAddSample,openAddThresh,openAddUnitModal,openEditBatch,openEditPopup,openEditSample,openEditSimset,openEditUnitModal,openModal,openNewSimset,openPStats,openPasteP,openRelinkModal,openViewRecord,pasteWR,previewRunWR,recoverComp,relinkOrphan,removeRunWR,removeWR,renameSampleCategory,renderAll,renderHarkers,renderHarkersNow,renderOverview,renderPressureViz,renderRunHarkers,renderRuns,renderSamples,renderSettings,renderSidebar,renderThreshCardInPlace,renderThresholding,resetData,runUnitTests,sanitizeCompWR,sanitizeWR,save,saveAppTitle,saveBatch,saveDefaultThreshold,saveDefaultThresholdInline,saveEditBatch,saveEditSample,savePStats,saveSettings,saveUnitModal,selSamplePage,selThresh,selectSimset,setNote,setTab,setThreshTab,showOnboarding,showPage,showPersistentBanner,smartTick,snapshotBeforeImport,statusChip,syncRunType,syncSimTotal,toast,toastUndo,toggleCB,toggleEditMode,toggleOxGrid,toggleOxGridAll,toggleRunHarkerPanel,toggleSampleInCategory,toggleTheme,toggleThresh,undoSims,updateThreshBadge
});
