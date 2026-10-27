'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n, digits = 2) => Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-IN', {maximumFractionDigits:digits, minimumFractionDigits:digits}) : '—';
const words = s => String(s ?? '').replaceAll('_', ' ');
const label = s => words(s).replace(/^./, c => c.toUpperCase());
const ns = 'http://www.w3.org/2000/svg';
const state = {result:null, config:null, controlled:'A17', selected:'A17', view:'baseline', index:0, frames:[], timer:null, draft:null, draftRevision:0, interventionRoots:[], busy:false, dirty:false, zoom:1, pan:{x:0,y:0}, nodeOffsets:{}, causal:new Set(), request:0};
const fieldNames = {min_price:'Minimum price',max_price:'Maximum price',budget:'Budget',max_offer_kwh:'Maximum offer',forecast_surplus_kwh:'Forecast surplus',reserve_kwh:'Minimum reserve',demand_kwh:'Energy requirement',deadline_round:'Deadline round',conditional_price:'Conditional bundle',interval_start:'Interval start',interval_end:'Interval end'};
const tradeKey = t => `${t.seller_id}|${t.buyer_id}`;
const qty = trades => (trades || []).reduce((n,t) => n + Number(t.quantity_kwh || 0), 0);
const spend = trades => (trades || []).reduce((n,t) => n + Number(t.payment ?? t.price * t.quantity_kwh), 0);
const signature = t => `${tradeKey(t)}|${t.quantity_kwh}|${t.price}`;
const agents = updated => (updated && state.result?.updated_world?.agents || state.result?.world?.agents || []);
const agentById = (id, updated = false) => agents(updated).find(a => a.id === id);
const currentRun = () => state.result && (state.view === 'baseline' ? state.result.baseline : (state.result.intervention || state.result.baseline));
const currentEvents = () => currentRun()?.events || [];
function policyValue(field,value) {
  if(field==='conditional_price')return value?`₹${fmt(value.floor)}/kWh for at least ${fmt(value.minimum_kwh)} kWh`:'No bundle discount';
  if(value===null || value===undefined)return 'Unset';
  if(field.endsWith('_kwh'))return `${fmt(value,3)} kWh`;
  if(['min_price','max_price'].includes(field))return `₹${fmt(value)}/kWh`;
  if(field==='budget')return `₹${fmt(value)}`;
  if(field==='deadline_round')return `Round ${value}`;
  if(field==='interval_start'||field==='interval_end')return `${String(value).slice(0,10)} ${String(value).slice(11,16)} IST`;
  return String(value);
}

function notify(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error',error); $('notice').hidden = !text; }
function readConfig() {
  if (!$('config-form').reportValidity()) throw Error('Check the experiment controls.');
  return {population:Number($('population').value),seed:Number($('seed').value),topology:$('topology').value,max_rounds:Number($('max-rounds').value),max_messages:Number($('max-messages').value),utility_cap_kwh:Number($('cap').value),memory_enabled:$('memory').checked,price_tick:Number($('price-tick').value)};
}
function setBusy(value) {
  state.busy = value;
  for (const id of ['reset','parse','structured','controlled','population','topology','seed','max-rounds','max-messages','cap','memory','price-tick']) $(id).disabled = value;
  document.querySelectorAll('[data-scenario]').forEach(b => b.disabled=value || !state.result);
  if ($('confirm')) $('confirm').disabled = value;
  $('parse').disabled = value || !state.result || state.dirty;
  $('structured').disabled = value || !state.result || state.dirty;
}
async function api(path, payload) {
  if (typeof window !== 'undefined' && window.collectiveTransport) return window.collectiveTransport(path, payload);
  const response = await fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  let body;
  try { body = await response.json(); } catch { throw Error('The server returned an unreadable response.'); }
  if (!response.ok) throw Error(Array.isArray(body.detail) ? body.detail.map(x => x.msg || x.message).join(' · ') : body.detail || `Request failed (${response.status})`);
  return body;
}
function clearDraft() { state.draft = null; state.draftRevision++; $('proposal').hidden = true; }
function invalidate() {
  state.dirty = true; clearDraft(); stop(); setBusy(false);
  notify('Experiment controls have changed. The displayed results belong to the previous run. Generate a new baseline before applying a policy.');
}
async function run(intervention = null) {
  stop(); setBusy(true); const request = ++state.request;
  try {
    const config = intervention ? state.config : readConfig();
    notify(intervention ? 'Running the confirmed intervention against a clone of the baseline…' : 'Generating households and negotiating the baseline…');
    const result = await api('/api/experiment', {config,intervention:intervention ? {...intervention,confirmed:true} : null});
    if (request !== state.request) return;
    state.result = result; state.config = config; state.dirty = false;
    $('export-preview').hidden=true;$('export-text').value='';
    state.interventionRoots = !intervention ? [] : intervention.scenario==='shock' ? result.world.agents.filter(a=>a.role==='seller').map(a=>a.id) : [intervention.agent_id];
    state.view = intervention && result.intervention ? 'intervention' : 'baseline';
    state.causal.clear(); clearDraft(); $('graph-loading').hidden=true;
    initializeAgents(); rebuildFrames(); state.index=Math.max(0,currentEvents().length-1);
    render(); notify(intervention ? 'Intervention complete. Replay the recorded negotiations or compare the paired outcomes.' : 'Baseline ready. Select an agent or preview a policy change to begin an experiment.');
    for(const id of ['export','trace-export','ledger-export']) $(id).disabled=false;
  } catch(error) {
    notify(error.message,true);
    if (!state.result) { $('graph-loading').innerHTML = `<strong>Could not generate the baseline</strong><p>${esc(error.message)}</p>`; $('metric-status').textContent='Unavailable'; }
  } finally { if (request === state.request) setBusy(false); }
}
function initializeAgents() {
  const list=agents();
  if (!list.some(a=>a.id===state.controlled)) state.controlled=list[0]?.id;
  if (!list.some(a=>a.id===state.selected)) state.selected=state.controlled;
  const options=list.map(a=>`<option value="${esc(a.id)}">${esc(a.id)} · ${esc(a.name || label(a.role))}</option>`).join('');
  $('controlled').innerHTML=options; $('inspect-select').innerHTML=options;
  $('controlled').value=state.controlled; $('inspect-select').value=state.selected;
  $('controlled').disabled=false; $('inspect-select').disabled=false;
}
function runFrames(run, initial=[]) {
  let trades=initial.map(t=>({...t}));
  return (run?.events || []).map(e=> {
    if (Array.isArray(e.trades_after)) trades=e.trades_after.map(t=>({...t}));
    else if (e.trade && ['provisional_reserved','offer_replaced','commitment_finalized'].includes(e.type)) { trades=trades.filter(t=>t.id!==e.trade.id); trades.push({...e.trade}); }
    else if (['provisional_released','trade_released'].includes(e.type)) trades=trades.filter(t=>t.id!==(e.trade?.id || e.trade_id));
    return trades.map(t=>({...t}));
  });
}
function rebuildFrames() {
  const useBaseline=state.view==='baseline' || !state.result.intervention;
  state.frames=runFrames(currentRun(),useBaseline ? [] : state.result.baseline.trades);
  if(state.frames.length) state.frames[state.frames.length-1]=(currentRun().trades || []).map(t=>({...t}));
}
function changed() {
  const a=state.result?.baseline?.trades || [], b=state.result?.intervention?.trades || a;
  const sa=new Set(a.map(signature)), sb=new Set(b.map(signature));
  const removed=a.filter(t=>!sb.has(signature(t))), added=b.filter(t=>!sa.has(signature(t)));
  const affected=new Set([...removed,...added].flatMap(t=>[t.seller_id,t.buyer_id]));
  const roots=new Set(state.interventionRoots), direct=new Set([...a,...b].filter(t=>roots.has(t.seller_id) || roots.has(t.buyer_id)).flatMap(t=>[t.seller_id,t.buyer_id]));
  for(const id of roots) direct.delete(id);
  const comparison=state.result?.comparison || {};
  return {removed,added,affected:new Set(comparison.affected_agents || affected),direct:new Set(comparison.direct_agents || direct),indirect:comparison.indirect_agents || [...affected].filter(id=>!roots.has(id)&&!direct.has(id)),changed_kwh:comparison.changed_kwh ?? Math.max(qty(removed),qty(added))};
}
function metrics(run, worldAgents=agents()) {
  if(!run) return {};
  const energy=qty(run.trades), demand=worldAgents.filter(a=>a.role==='buyer').reduce((n,a)=>n+Number(a.demand_kwh || 0),0);
  return {energy,demand:Math.max(0,demand-energy),unused:run.metrics?.unused_surplus_kwh,median:run.metrics?.median_price,payment:spend(run.trades),mean:energy?spend(run.trades)/energy:0,welfare:run.metrics?.welfare ?? Object.values(utilities(run)).reduce((sum,n)=>sum+Number(n),0),messages:run.messages ?? run.metrics?.message_count ?? run.events.filter(e=>/offer|message/.test(e.type)).length,rounds:run.rounds ?? run.metrics?.rounds ?? Math.max(0,...run.events.map(e=>Number(e.round || 0)))};
}
function render() {
  if(!state.result) return;
  document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('selected',b.dataset.view===state.view); b.setAttribute('aria-pressed',String(b.dataset.view===state.view)); b.disabled=b.dataset.view!=='baseline'&&!state.result.intervention;});
  const run=currentRun(), m=metrics(run,agents(state.view!=='baseline')), delta=changed();
  $('metric-energy').textContent=`${fmt(m.energy)} kWh`;
  $('metric-energy-sub').textContent='Final allocation in selected run';
  $('metric-demand').textContent=`${fmt(m.demand)} kWh`;
  $('metric-affected').textContent=delta.affected.size;
  $('metric-affected-sub').textContent=`${delta.indirect.length} indirect · ${fmt(delta.changed_kwh)} kWh changed`;
  $('metric-messages').textContent=fmt(m.messages,0); $('metric-rounds').textContent=`${m.rounds} rounds · ${run.events.length} trace events`;
  $('metric-status').textContent=label(run.status || 'complete');
  $('metric-status-sub').textContent=run.status==='locally_stable'?'Within the declared move set':words(run.termination_reason || 'Search stopped before stability');
  $('graph-subtitle').textContent=`${agents().length} households · ${state.config.topology==='local'?'Bounded local discovery':'Open discovery'} · Seed ${state.config.seed}`;
  renderOwn(); renderFrame(); renderAnalysis();
  $('manifest').textContent=JSON.stringify(state.result.manifest,null,2);
  $('protocol-scope').textContent=typeof run.stability_scope==='string'?run.stability_scope:JSON.stringify(run.stability_scope || state.result.manifest?.protocol || 'See the manifest for protocol scope.');
  $('footer-run').textContent=`Seed ${state.config.seed} · ${state.result.manifest?.protocol_version || state.result.manifest?.version || 'Deterministic bilateral protocol'}`;
}
function bounds(a) {
  if(!a) return [];
  return a.role==='seller' ? [['Forecast (private)',`${fmt(a.forecast_surplus_kwh)} kWh`],['Reserve (private)',`${fmt(a.reserve_kwh)} kWh`],['Offer ceiling',`${fmt(a.max_offer_kwh)} kWh`],['Price floor',`₹${fmt(a.min_price)} / kWh`]] : [['Required energy',`${fmt(a.demand_kwh)} kWh`],['Price ceiling',`₹${fmt(a.max_price)} / kWh`],['Budget (private)',`₹${fmt(a.budget)}`],['Deadline',a.deadline_round===null?'No deadline':`Round ${a.deadline_round || '—'}`]];
}
function boundHTML(a) { return bounds(a).map(([k,v])=>`<div class="bound"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join(''); }
function renderOwn() {
  const a=agentById(state.controlled);
  if(!a) return;
  $('own-name').textContent=a.name || a.id; $('own-id').textContent=`${a.id} · ${a.role==='seller'?'Solar seller':'Energy buyer'}`;
  $('own-role').textContent=a.role==='seller'?'SELLER':'BUYER';
  $('own-context').textContent=typeof a.context==='string'?a.context:'Synthetic household preferences for this research experiment.';
  $('own-bounds').innerHTML=boundHTML(a);
  document.querySelector('.avatar').textContent=a.role==='seller'?'☀':'⌂';
  const fields=a.role==='seller'?['min_price','max_offer_kwh','forecast_surplus_kwh','reserve_kwh']:['max_price','budget','demand_kwh','deadline_round'];
  const prev=$('policy-field').value;
  $('policy-field').innerHTML=fields.map(f=>`<option value="${f}">${fieldNames[f]}</option>`).join('');
  if(fields.includes(prev)) $('policy-field').value=prev;
}
function renderFrame() {
  const events=currentEvents(), event=events[state.index];
  $('timeline').max=Math.max(0,events.length-1); $('timeline').value=state.index;
  $('position').textContent=`${events.length?state.index+1:0} / ${events.length}`;
  $('back').disabled=state.index===0; $('next').disabled=state.index>=events.length-1;
  $('round-label').textContent=`Round ${event?.round ?? 0}`;
  $('event-type').textContent=words(event?.type || 'baseline').toUpperCase();
  $('event-title').textContent=event ? `${event.actor_id || 'Market'}${event.counterparty_id?' → '+event.counterparty_id:''} · ${label(event.type)}` : 'Baseline ready';
  $('event-reason').textContent=event?.reason || words(event?.reason_code) || 'Inspect the recorded event details in the trace export.';
  $('causal').hidden=!event?.caused_by?.length; $('causal').textContent=state.causal.size?'Clear causal highlight':'Highlight causal chain ↗';
  $('graph-wrap').classList.toggle('comparing',state.view==='compare'); $('compare-graph').toggleAttribute('hidden',state.view!=='compare');
  const trades=state.frames[state.index] || currentRun()?.trades || [];
  drawGraph($('graph'),trades,event,state.view==='baseline'?'BASELINE':'INTERVENTION');
  if(state.view==='compare') {
    const frames=runFrames(state.result.baseline), round=event?.round ?? 0;
    let ix=state.result.baseline.events.findLastIndex(e=>e.round<=round);
    drawGraph($('compare-graph'),frames[ix] || [],state.result.baseline.events[ix],'BASELINE · SAME ROUND');
  }
  renderInspector(); renderDecisionAudit(); renderLog();
}
function svgEl(tag, attrs={}, parent, text) { const n=document.createElementNS(ns,tag); for(const [k,v] of Object.entries(attrs)) n.setAttribute(k,String(v)); if(text!==undefined)n.textContent=text; if(parent)parent.append(n); return n; }
function positions() {
  const map=new Map(), list=agents(), clusters=5;
  list.forEach((a,i)=> { const cluster=i%clusters, members=Math.ceil((list.length-cluster)/clusters), item=Math.floor(i/clusters), theta=-Math.PI/2+cluster*2*Math.PI/clusters, angle=item*2*Math.PI/members+theta*.2, r=members>10?78:64;
    const offset=state.nodeOffsets[a.id]||{x:0,y:0};
    map.set(a.id,{x:440+190*Math.cos(theta)+r*Math.cos(angle)+offset.x,y:290+172*Math.sin(theta)+r*Math.sin(angle)+offset.y});
  }); return map;
}
function drawGraph(svg,trades,event,caption) {
  svg.replaceChildren(); const pos=positions(), delta=changed(), search=$('search').value.trim().toLowerCase(), only=$('only-affected').checked;
  const root=svgEl('g',{transform:`translate(${state.pan.x} ${state.pan.y}) translate(440 300) scale(${state.zoom}) translate(-440 -300)`},svg);
  svgEl('text',{x:440,y:25,'text-anchor':'middle',fill:'#8b9784','font-size':9,'letter-spacing':2},root,caption);
  for(let c=0;c<5;c++){const theta=-Math.PI/2+c*2*Math.PI/5,x=440+190*Math.cos(theta),y=290+172*Math.sin(theta);svgEl('circle',{cx:x,cy:y,r:98,fill:'none',stroke:'#e4e9dc','stroke-dasharray':'3 6'},root);svgEl('text',{x,y:y-106,'text-anchor':'middle',fill:'#a2ae97','font-size':8,'letter-spacing':1.7},root,`CLUSTER 0${c+1}`);}
  svgEl('text',{x:440,y:285,'text-anchor':'middle',fill:'#aab79e','font-size':26,'font-weight':400},root,String(agents().length));
  svgEl('text',{x:440,y:304,'text-anchor':'middle',fill:'#9aa88e','font-size':7,'letter-spacing':1.8},root,'HOUSEHOLDS');
  const edges=svgEl('g',{},root), nodes=svgEl('g',{},root);
  function edge(from,to,attrs={}) { const a=pos.get(from),b=pos.get(to);if(!a||!b)return; return svgEl('path',{d:`M${a.x},${a.y} Q${(a.x+b.x)/2+18},${(a.y+b.y)/2-18} ${b.x},${b.y}`,fill:'none',...attrs},edges); }
  if($('discovery').checked) for(const item of state.result.world.discovery_edges || []) { const from=Array.isArray(item)?item[0]:item.source || item.seller_id || item.from, to=Array.isArray(item)?item[1]:item.target || item.buyer_id || item.to; edge(from,to,{stroke:'#cbd4c0','stroke-width':.7,'stroke-dasharray':'3 6',opacity:.3}); }
  for(const t of trades){const active=[t.seller_id,t.buyer_id].includes(state.selected),affected=delta.affected.has(t.seller_id)||delta.affected.has(t.buyer_id); if(only&&!affected)continue;const p=edge(t.seller_id,t.buyer_id,{stroke:active?'#3f6b50':'#a6b995','stroke-width':active?2.5:1.3,opacity:active?.95:.5,class:'trade-edge',tabindex:0,role:'button','aria-label':`${t.seller_id} to ${t.buyer_id}, ${fmt(t.quantity_kwh)} kWh at INR ${fmt(t.price)}`});if(p){svgEl('title',{},p,`${t.seller_id} → ${t.buyer_id}: ${fmt(t.quantity_kwh)} kWh · ₹${fmt(t.price)}/kWh`);const click=()=>{state.selected=t.seller_id;$('inspect-select').value=state.selected;notify(`${t.id}: ${t.seller_id} → ${t.buyer_id}, ${fmt(t.quantity_kwh)} kWh at ₹${fmt(t.price)}/kWh. Status: ${t.status}.`);renderFrame();};p.addEventListener('click',click);p.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();click();}});}}
  const highlighted=state.causal.size?[...state.result.baseline.events,...(state.result.intervention?.events||[])].filter(e=>state.causal.has(e.id)):[event].filter(Boolean);
  for(const e of highlighted){const released=/reject|release/.test(e.type),accepted=/reserved|replaced/.test(e.type);edge(e.actor_id,e.counterparty_id,{stroke:released?'#b87964':accepted?'#315d49':'#9270a5','stroke-width':2.3,class:`event-edge ${released?'event-release':accepted?'event-accept':''}`,opacity:.85});}
  for(const a of agents(state.view!=='baseline')) {const p=pos.get(a.id);if(!p)continue;const affected=delta.affected.has(a.id),selected=a.id===state.selected,own=a.id===state.controlled,match=(!search||`${a.id} ${a.name}`.toLowerCase().includes(search))&&($('role-filter').value==='all'||$('role-filter').value===a.role),dim=(!match || (only&&!affected&&!own));
    const g=svgEl('g',{transform:`translate(${p.x} ${p.y})`,class:'node','data-agent':a.id,tabindex:0,role:'button','aria-label':`Inspect ${a.id}, ${a.name || ''}, ${a.role}${affected?', affected':''}`,opacity:dim?.15:1},nodes);
    if(own)svgEl('circle',{r:19,fill:'none',stroke:'#40654d','stroke-width':1.6},g);
    if(selected)svgEl('circle',{r:24,fill:'#dfe9c7',opacity:.6},g);
    const attrs={fill:a.role==='seller'?'#c59a55':'#5c9287',stroke:affected?'#718eb9':selected?'#254936':'#fffef9','stroke-width':affected?3:2,class:'node-shape'};
    if(a.role==='seller')svgEl('circle',{r:11,...attrs},g);else svgEl('rect',{x:-10,y:-10,width:20,height:20,rx:6,...attrs},g);
    if(own)svgEl('text',{'text-anchor':'middle',y:3,fill:'white','font-size':9,'font-weight':600},g,'✦');
    if(agents().length<100||selected||own||affected||search)svgEl('text',{'text-anchor':'middle',y:29,fill:selected?'#254936':'#7a8a70','font-size':9,'font-weight':own?700:400},g,a.id);
    svgEl('title',{},g,`${a.id} · ${a.name} · ${a.role}`);
    const select=()=>{state.selected=a.id;$('inspect-select').value=a.id;renderFrame();};g.addEventListener('click',select);g.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();select();}});
  }
}
function renderInspector() {
  const a=agentById(state.selected,state.view!=='baseline'); if(!a)return;
  const relevant=currentEvents().slice(0,state.index+1).filter(e=>e.actor_id===a.id||e.counterparty_id===a.id),last=relevant.at(-1);
  const trades=(state.frames[state.index]||[]).filter(t=>t.seller_id===a.id||t.buyer_id===a.id);
  let memory=a.memory || [];
  if(!Array.isArray(memory))memory=Object.entries(memory).map(([id,text])=>({id,text}));
  $('inspection').innerHTML=`<div class="inspector-id"><span class="role-tag">${esc(a.role.toUpperCase())}</span><span class="tiny-label">${esc(a.id)}</span></div><h3>${esc(a.name || a.id)}</h3><h4>Hard constraints</h4>${boundHTML(a)}${a.conditional_price?`<div class="bound"><span>Bundle discount (private)</span><strong>₹${fmt(a.conditional_price.floor)} for ≥${fmt(a.conditional_price.minimum_kwh)} kWh</strong></div>`:''}<div class="bound"><span>Time window</span><strong>14:00–16:00 IST</strong></div><h4>Reservations at this event</h4>${trades.length?trades.map(t=>`<div class="bound"><span>${esc(t.seller_id)} → ${esc(t.buyer_id)}</span><strong>${fmt(t.quantity_kwh)} kWh<br>₹${fmt(t.price)}/kWh</strong></div>`).join(''):'<p class="muted">No active reservation at this point.</p>'}<h4>Latest recorded decision</h4><p>${esc(last?.reason || words(last?.reason_code) || 'No decision recorded yet at this replay position.')}</p>${last?.rule_checks?`<p class="muted small">Checks: ${esc(Array.isArray(last.rule_checks)?last.rule_checks.join(', '):JSON.stringify(last.rule_checks))}</p>`:''}<details><summary>Private context & memory (${memory.length})</summary><div class="private">Research inspection only. Private context is not shared in agent messages.</div><p>${esc(typeof a.context==='string'?a.context:JSON.stringify(a.context))}</p>${memory.map(m=>`<div class="memory-record">${esc(m.text || m.content || JSON.stringify(m))}<small>Source ${esc(m.id || m.record_id || 'synthetic memory')} · ${state.config.memory_enabled?'Retrieval enabled':'Retrieval disabled'}</small>${m.preference?.type==='preferred_counterparty'?`<small>Soft preference: ${esc(m.preference.agent_id)} wins equal-value ties</small>`:''}</div>`).join('')}<p class="muted small">Memory can rank feasible alternatives. It cannot override a hard constraint.</p></details>`;
}
function renderDecisionAudit() {
  const a=agentById(state.selected,state.view!=='baseline');if(!a)return;
  const relevant=currentEvents().slice(0,state.index+1).filter(e=>e.actor_id===a.id||e.counterparty_id===a.id);
  const decision=relevant.findLast(e=>e.utility_before&&a.id in e.utility_before),offer=relevant.at(-1);
  const retrieved=relevant.filter(e=>e.type==='profile_retrieved'&&e.actor_id===a.id);
  let html='';
  if(decision)html+=`<h4>Last allocation decision</h4><p>${esc(words(decision.reason))}</p><div class="bound"><span>Utility before</span><strong>₹${fmt(decision.utility_before[a.id])}</strong></div><div class="bound"><span>Utility after</span><strong>₹${fmt(decision.utility_after[a.id])}</strong></div><p class="muted small">${esc(decision.id)} · Round ${decision.round}<br>${esc((decision.rule_checks||[]).map(words).join(', '))}</p>`;
  if(offer&&['offer_sent','counteroffer_sent'].includes(offer.type))html+=`<h4>Pending offer at this event</h4><p>${esc(offer.actor_id)} → ${esc(offer.counterparty_id)}<br>${fmt(offer.quantity_kwh)} kWh at ₹${fmt(offer.price)}/kWh</p>`;
  if(retrieved.length)html+=`<details><summary>Memory used in this run (${retrieved.length})</summary>${retrieved.map(e=>`<p>${esc(e.reason)}<br><small>Source ${(e.memory_ids||[]).map(esc).join(', ')} · ${esc(e.id)}</small></p>`).join('')}</details>`;
  $('inspection').insertAdjacentHTML('beforeend',html);
}
function renderLog() {
  const filter=$('event-filter').value;
  const all=currentEvents().map((e,i)=>({e,i})).filter(({e})=>filter==='agent'?(e.actor_id===state.selected||e.counterparty_id===state.selected):filter==='changes'?/reserved|released|replaced|finalized/.test(e.type):true);
  $('log-count').textContent=`${all.length} EVENTS`;
  const index=Math.max(0,all.findIndex(x=>x.i>=state.index)), start=Math.max(0,index-25), list=all.slice(start,start+100);
  $('event-log').innerHTML=list.length?list.map(({e,i})=>`<button class="log-entry ${i===state.index?'active':''}" data-event="${i}"><small>R${e.round} · ${esc(e.id || String(e.sequence))}</small><strong>${esc(e.actor_id || 'Market')}${e.counterparty_id?' → '+esc(e.counterparty_id):''}<br>${esc(label(e.type))}</strong></button>`).join(''):'<p class="log-empty">No events match this filter.</p>';
  $('event-log').querySelectorAll('[data-event]').forEach(b=>b.onclick=()=>{stop();state.index=Number(b.dataset.event);renderFrame();});
}
function utilities(run) {
  if(run?.agents)return Object.fromEntries(Object.entries(run.agents).map(([id,summary])=>[id,Number(summary.utility || 0)]));
  const source=run?.metrics?.agent_utilities || run?.metrics?.utilities || run?.utilities || {};
  if(Array.isArray(source))return Object.fromEntries(source.map(x=>[x.agent_id || x.id,Number(x.utility || 0)]));
  return source;
}
function renderAnalysis() {
  const a=metrics(state.result.baseline), b=state.result.intervention?metrics(state.result.intervention,agents(true)):null,delta=changed();
  const measures=[['Matched energy','energy',' kWh'],['Unfilled demand','demand',' kWh'],['Unused offered surplus','unused',' kWh'],['Simulated payment','payment',' INR'],['Volume-weighted price','mean',' INR/kWh'],['Median trade price','median',' INR/kWh'],['Model welfare','welfare',' INR'],['Negotiation messages','messages',''],['Rounds','rounds','']];
  $('comparison-table').innerHTML=measures.map(([name,key,unit])=>`<tr><td>${name}</td><td>${fmt(a[key],key==='messages'||key==='rounds'?0:2)}${unit}</td><td>${b?fmt(b[key],key==='messages'||key==='rounds'?0:2)+unit:'—'}</td><td>${b?(b[key]-a[key]>0?'+':'')+fmt(b[key]-a[key],key==='messages'||key==='rounds'?0:2):'—'}</td></tr>`).join('');
  const fields=state.result.manifest?.changed_fields || [];
  const changeDescription=fields.length?fields.map(f=>`${f.agent_id} ${fieldNames[f.field] || words(f.field)}`).join(' · '):'No policy fields changed';
  if(b)$('causal-summary').innerHTML=`<div><span>01</span><strong>Policy intervention</strong><small title="${esc(changeDescription)}">${esc(changeDescription.length>130?changeDescription.slice(0,127)+'…':changeDescription)}</small></div><span class="arrow">→</span><div><span>02</span><strong>${delta.removed.length} prior allocations changed</strong><small>${delta.added.length} new or revised allocations</small></div><span class="arrow">→</span><div><span>03</span><strong>${delta.affected.size} households affected</strong><small>${delta.indirect.length} indirect · ${fmt(delta.changed_kwh)} kWh changed</small></div>`;
  else $('causal-summary').innerHTML='<div><span>01</span><strong>Baseline ready</strong><small>Initial world and provisional allocations recorded</small></div><span class="arrow">→</span><div><span>02</span><strong>Change a policy</strong><small>Preview and confirm your instruction</small></div><span class="arrow">→</span><div><span>03</span><strong>Follow the response</strong><small>Compare the same world under changed rules</small></div>';
  const au=utilities(state.result.baseline),bu=utilities(state.result.intervention),values=agents().map(x=>({id:x.id,v:Number(bu[x.id]??0)-Number(au[x.id]??0)}));
  const hasUtilities=b&&Object.keys(bu).length>0;
  drawDistribution(hasUtilities?values:[]); drawTrajectory();
  const run=currentRun(), violations=run.metrics?.hard_constraint_violations ?? run.metrics?.constraint_violations ?? run.metrics?.violations ?? 'Unreported';
  $('integrity').innerHTML=[['Hard-constraint violations',Array.isArray(violations)?violations.length:violations],['Baseline / intervention seed',String(state.config.seed)],['Allocation changes',String(delta.affected.size)+' households'],['Released reservations',String(state.result.comparison?.displaced_count ?? 0)],['Causal cascade depth',String(state.result.comparison?.cascade_depth ?? 0)],['Termination',label(run.status)],['Recorded events',String(run.events.length)],['Engine runtime',fmt(run.metrics?.runtime_seconds,4)+' s']].map(([k,v])=>`<div class="integrity-line"><i>·</i><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('');
  const caveat=b&&state.result.baseline.status!=='locally_stable'?'The baseline stopped before local stability. Differences may include continued baseline negotiation as well as the policy change.':'';
  $('comparison-caveat').textContent=caveat;$('comparison-caveat').hidden=!caveat;
}
function drawDistribution(values) {
  const svg=$('distribution');svg.replaceChildren();svgEl('line',{x1:30,y1:95,x2:580,y2:95,stroke:'#dbe2d2'},svg);
  if(!values.length){svgEl('text',{x:300,y:85,'text-anchor':'middle',fill:'#95a08b','font-size':11},svg,'No intervention yet');$('distribution-note').textContent='Confirm an intervention to compare household outcomes.';return;}
  const max=Math.max(1,...values.map(x=>Math.abs(x.v))),w=540/values.length;
  values.forEach((x,i)=>{const h=Math.abs(x.v)/max*65,n=svgEl('rect',{x:32+i*w,y:x.v>=0?95-h:95,width:Math.max(2,w-2),height:Math.max(.6,h),fill:x.v>=0?'#739064':'#c29b7b',rx:1},svg);svgEl('title',{},n,`${x.id}: ${x.v>=0?'+':''}${fmt(x.v)}`);if(i%Math.ceil(values.length/10)===0)svgEl('text',{x:32+i*w,y:184,fill:'#939d89','font-size':8},svg,x.id);});
  svgEl('text',{x:2,y:29,fill:'#939d89','font-size':8},svg,'+'+fmt(max,0));svgEl('text',{x:2,y:163,fill:'#939d89','font-size':8},svg,'−'+fmt(max,0));
  $('distribution-note').textContent=`${values.filter(x=>x.v>1e-7).length} improved · ${values.filter(x=>x.v< -1e-7).length} reduced · ${values.filter(x=>Math.abs(x.v)<=1e-7).length} unchanged`;
}
function drawTrajectory() {
  const svg=$('trajectory');svg.replaceChildren(); const a=runFrames(state.result.baseline).map(qty),b=state.result.intervention?runFrames(state.result.intervention,state.result.baseline.trades).map(qty):[];
  const max=Math.max(1,...a,...b),width=550,height=115;
  for(let i=0;i<=3;i++){const y=20+i*height/3;svgEl('line',{x1:35,y1:y,x2:585,y2:y,stroke:'#e5eadd'},svg);svgEl('text',{x:0,y:y+3,fill:'#929d86','font-size':8},svg,fmt(max*(1-i/3),0));}
  for(const [values,color]of[[a,'#b1bea4'],[b,'#3e684c']])if(values.length)svgEl('path',{d:values.map((v,i)=>`${i?'L':'M'}${35+i/Math.max(1,values.length-1)*width},${20+(1-v/max)*height}`).join(' '),fill:'none',stroke:color,'stroke-width':2},svg);
  svgEl('text',{x:35,y:158,fill:'#929d86','font-size':8},svg,'First event');svgEl('text',{x:585,y:158,fill:'#929d86','font-size':8,'text-anchor':'end'},svg,'Last event (each run normalized)');
}
function displayDraft(draft, recognized=[]) {
  state.draft={...draft,fingerprint:JSON.stringify(state.config),controlled:state.controlled,revision:state.draftRevision};
  const entries=Object.entries(draft.changes || {}), a=agentById(draft.agent_id);
  const scenarioDiff=draft.previewChanges?.length?`<details><summary>Inspect all ${draft.previewChanges.length} forecast changes</summary>${draft.previewChanges.map(c=>`<div class="diff"><span>${esc(c.agent_id)}<br><small>Was ${fmt(c.before)} kWh</small></span><strong>${fmt(c.after)} kWh</strong></div>`).join('')}</details>`:'';
  $('proposal').className='proposal'; $('proposal').hidden=false;
  $('proposal').innerHTML=`<h4>Review proposed policy</h4><p>${esc(draft.description || 'Changes apply to a clone of the baseline.')} ${esc(draft.agent_id || '')}</p>${entries.map(([k,v])=>`<div class="diff"><span>${esc(fieldNames[k] || label(k))}<br><small>Was ${esc(policyValue(k,a?.[k]))}</small></span><strong>${esc(policyValue(k,v))}</strong></div>`).join('')}${scenarioDiff}${recognized.length?`<p>${esc(recognized.join(' · '))}</p>`:''}<button id="confirm" class="button primary full">Confirm & renegotiate →</button><button id="cancel" class="button light full">Cancel</button>`;
  $('confirm').onclick=()=>{if(!state.draft||state.dirty||state.draft.revision!==state.draftRevision||state.draft.fingerprint!==JSON.stringify(state.config)||state.draft.controlled!==state.controlled){clearDraft();notify('The preview is out of date. Preview the policy again.',true);return;}const {fingerprint,controlled,description,revision,previewChanges,...intervention}=state.draft;run(intervention);};
  $('cancel').onclick=clearDraft;
}
async function preview(text=$('instruction').value) {
  if(state.busy||state.dirty)return;
  stop();clearDraft();setBusy(true);const controlled=state.controlled, revision=state.draftRevision;
  try{const result=await api('/api/policy',{config:state.config,agent_id:controlled,text});
    if(revision!==state.draftRevision || controlled!==state.controlled || state.dirty)return;
    if(result.errors.length){state.draft=null;$('proposal').className='proposal error';$('proposal').hidden=false;$('proposal').innerHTML=`<h4>No changes applied</h4>${result.errors.map(e=>`<p>${esc(e)}</p>`).join('')}`;}
    else displayDraft({agent_id:controlled,scenario:'custom',changes:result.changes},result.recognized);
  }catch(e){notify(e.message,true);}finally{setBusy(false);}
}
function preset(scenario) {
  if(state.busy||state.dirty)return;
  let a=agentById(state.controlled),changes={},description='',previewChanges=[];
  if(['price','supply','shock'].includes(scenario)&&a.role!=='seller')a=agents().find(x=>x.role==='seller'&&x.id==='A17')||agents().find(x=>x.role==='seller');
  if(scenario==='budget'&&a.role!=='buyer')a=agents().find(x=>x.role==='buyer'&&state.result.baseline.trades.some(t=>t.buyer_id===x.id))||agents().find(x=>x.role==='buyer');
  state.controlled=a.id;state.selected=a.id;$('controlled').value=a.id;$('inspect-select').value=a.id;clearDraft();renderOwn();renderFrame();
  if(scenario==='price'){changes={min_price:Math.round((Number(a.min_price)+2)*100)/100};description='Raise this seller’s price floor by INR 2/kWh.';}
  if(scenario==='supply'){changes={forecast_surplus_kwh:Math.round(Math.max(Number(a.reserve_kwh),Number(a.forecast_surplus_kwh)*.5)*100)/100};description='Reduce forecast surplus. The hard reserve remains unchanged.';}
  if(scenario==='budget'){changes={budget:Math.round(Number(a.budget)*.4*100)/100};description='Reduce this buyer’s budget to 40% of its original value.';}
  if(scenario==='shock'){description='Reduce every seller’s forecast to 70%, rounded down to 0.1 kWh. Reserves remain unchanged.';previewChanges=agents().filter(x=>x.role==='seller').map(x=>({agent_id:x.id,before:x.forecast_surplus_kwh,after:Math.floor(Number(x.forecast_surplus_kwh)*7)/10}));}
  if(scenario==='none'){changes=a.role==='seller'?{min_price:a.min_price}:{budget:a.budget};description='Run the no-change control with this policy unchanged. A stable baseline should retain the same allocation.';}
  displayDraft({agent_id:a.id,scenario:scenario==='shock'?scenario:'custom',changes,description,previewChanges});
}
function stepRound(direction) {
  stop();const events=currentEvents(),round=events[state.index]?.round ?? 0;
  const next=direction>0?events.findIndex(e=>e.round>round):events.findLastIndex(e=>e.round<round);
  if(next>=0)state.index=next;
  renderFrame();
}
function stop(){clearInterval(state.timer);state.timer=null;$('play').textContent='▶';$('play').setAttribute('aria-label','Play recorded events');}
function play(){if(state.timer){stop();return;}if(!currentEvents().length)return;if(state.index>=currentEvents().length-1)state.index=0;$('play').textContent='Ⅱ';$('play').setAttribute('aria-label','Pause replay');renderFrame();state.timer=setInterval(()=>{if(state.index>=currentEvents().length-1){stop();return;}state.index++;renderFrame();},700/Number($('speed').value));}
function download(name,text,type){if(state.exportURL)URL.revokeObjectURL(state.exportURL);state.exportURL=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=state.exportURL;a.download=name;a.textContent=`Download ${name}`;notify('Your export is ready. ');$('notice').append(a);$('export-title').textContent=`View or copy ${name}`;$('export-text').value=text;$('export-preview').hidden=false;$('notice').scrollIntoView?.({block:'nearest'});}
function exportLedger(){const q=s=>`"${String(s??'').replaceAll('"','""')}"`;const columns=['run','id','seller_id','buyer_id','quantity_kwh','price','payment','status'];const rows=[columns.join(',')];for(const name of ['baseline','intervention'])for(const t of state.result[name]?.trades||[])rows.push([name,...columns.slice(1).map(k=>t[k])].map(q).join(','));download('energy-trade-ledger.csv',rows.join('\n'),'text/csv');}
function bindPan(svg){let drag=null;svg.addEventListener('pointerdown',e=>{if(e.target.closest('.trade-edge'))return;const node=e.target.closest('.node'),id=node?.getAttribute('data-agent'),origin=id?(state.nodeOffsets[id]||{x:0,y:0}):state.pan;drag={x:e.clientX,y:e.clientY,px:origin.x,py:origin.y,id};if(id){state.selected=id;$('inspect-select').value=id;}svg.setPointerCapture(e.pointerId);});svg.addEventListener('pointermove',e=>{if(!drag)return;const rect=svg.getBoundingClientRect(),scale=1/Math.min(rect.width/880,rect.height/610)/(drag.id?state.zoom:1),next={x:drag.px+(e.clientX-drag.x)*scale,y:drag.py+(e.clientY-drag.y)*scale};if(drag.id)state.nodeOffsets[drag.id]=next;else state.pan=next;renderFrame();});svg.addEventListener('pointerup',()=>{drag=null;if(state.result)renderFrame();});svg.addEventListener('pointercancel',()=>drag=null);}
$('config-form').onsubmit=e=>{e.preventDefault();state.zoom=1;state.pan={x:0,y:0};state.nodeOffsets={};run();};
for(const id of ['population','topology','seed','max-rounds','max-messages','cap','memory','price-tick'])$(id).addEventListener('change',invalidate);
$('instruction').addEventListener('input',clearDraft);
$('policy-value').addEventListener('input',clearDraft);
$('policy-field').addEventListener('change',clearDraft);
$('controlled').onchange=()=>{state.controlled=$('controlled').value;state.selected=state.controlled;$('inspect-select').value=state.selected;clearDraft();state.causal.clear();render();};
$('inspect-select').onchange=()=>{state.selected=$('inspect-select').value;renderFrame();};
$('parse').onclick=()=>preview();
$('structured').onclick=()=>{const v=$('policy-value').value,f=$('policy-field').value,phrases={min_price:`Set my minimum price to INR ${v}`,max_price:`Set my maximum price to INR ${v}`,max_offer_kwh:`Sell up to ${v} kWh`,forecast_surplus_kwh:`Set my surplus to ${v} kWh`,reserve_kwh:`Keep at least ${v} kWh in reserve`,budget:`Set my budget to INR ${v}`,demand_kwh:`Buy ${v} kWh`,deadline_round:`Set my deadline to round ${v}`};$('instruction').value=phrases[f];preview(phrases[f]);};
document.querySelectorAll('[data-example]').forEach(b=>b.onclick=()=>{$('instruction').value=b.dataset.example;clearDraft();$('instruction').focus();});
document.querySelectorAll('[data-scenario]').forEach(b=>b.onclick=()=>preset(b.dataset.scenario));
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{if(!state.result)return;stop();state.view=b.dataset.view;state.causal.clear();rebuildFrames();state.index=Math.min(state.index,Math.max(0,currentEvents().length-1));render();});
$('timeline').oninput=()=>{stop();state.index=Number($('timeline').value);renderFrame();};
$('back').onclick=()=>{stop();state.index=Math.max(0,state.index-1);renderFrame();};
$('next').onclick=()=>{stop();state.index=Math.min(currentEvents().length-1,state.index+1);renderFrame();};
$('previous-round').onclick=()=>stepRound(-1);$('next-round').onclick=()=>stepRound(1);
$('end').onclick=()=>{stop();state.index=Math.max(0,currentEvents().length-1);renderFrame();};
$('play').onclick=play;$('speed').onchange=()=>{if(state.timer){stop();play();}};
for(const id of ['search','discovery','only-affected','role-filter'])$(id).addEventListener(id==='search'?'input':'change',()=>{if(state.result)renderFrame();});
$('event-filter').onchange=()=>{if(state.result)renderLog();};
$('zoom-in').onclick=()=>{state.zoom=Math.min(2.5,state.zoom+.2);if(state.result)renderFrame();};
$('zoom-out').onclick=()=>{state.zoom=Math.max(.6,state.zoom-.2);if(state.result)renderFrame();};
$('fit').onclick=()=>{state.zoom=1;state.pan={x:0,y:0};state.nodeOffsets={};if(state.result)renderFrame();};
$('causal').onclick=()=>{if(state.causal.size){state.causal.clear();renderFrame();return;}const map=new Map([...state.result.baseline.events,...(state.result.intervention?.events||[])].map(e=>[e.id,e]));function visit(id){if(state.causal.has(id))return;state.causal.add(id);for(const parent of map.get(id)?.caused_by||[])visit(parent);}const e=currentEvents()[state.index];visit(e.id);renderFrame();};
$('export').onclick=()=>download(`energy-experiment-seed-${state.config.seed}.json`,JSON.stringify(state.result,null,2),'application/json');
$('trace-export').onclick=()=>download(`energy-${state.view}-trace.jsonl`,currentEvents().map(e=>JSON.stringify(e)).join('\n'),'application/x-ndjson');
$('ledger-export').onclick=exportLedger;
$('select-export').onclick=()=>{$('export-text').focus();$('export-text').select();};
bindPan($('graph'));bindPan($('compare-graph'));
run();
