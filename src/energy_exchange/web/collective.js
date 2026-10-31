'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n, digits = 2) => Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-IN', {maximumFractionDigits:digits, minimumFractionDigits:digits}) : '—';
const words = s => String(s ?? '').replaceAll('_', ' ');
const label = s => words(s).replace(/^./, c => c.toUpperCase());
const ns = 'http://www.w3.org/2000/svg';
const state = {result:null, config:null, controlled:'A17', selected:'A17', view:'baseline', index:0, stage:null, frames:[], timer:null, draft:null, draftRevision:0, interventionRoots:[], busy:false, dirty:false, zoom:1, pan:{x:0,y:0}, nodeOffsets:{}, causal:new Set(), request:0};
const fieldNames = {min_price:'Lowest selling price',max_price:'Highest buying price',budget:'Spending limit',max_offer_kwh:'Energy offered for sale',forecast_surplus_kwh:'Expected spare energy',reserve_kwh:'Energy kept for your home',demand_kwh:'Energy to buy',deadline_round:'Last round to trade',time_price:'Later selling price',conditional_price:'Discount for a larger purchase',interval_start:'Trading starts',interval_end:'Trading ends'};
const tradeKey = t => `${t.seller_id}|${t.buyer_id}`;
const qty = trades => (trades || []).reduce((n,t) => n + Number(t.quantity_kwh || 0), 0);
const spend = trades => (trades || []).reduce((n,t) => n + Number(t.payment ?? t.price * t.quantity_kwh), 0);
const signature = t => `${tradeKey(t)}|${t.quantity_kwh}|${t.price}|${t.delivery_start || ''}|${t.delivery_end || ''}`;
const agents = updated => (updated && state.result?.updated_world?.agents || state.result?.world?.agents || []);
const agentById = (id, updated = false) => agents(updated).find(a => a.id === id);
const currentRun = () => state.result && (state.view === 'baseline' ? state.result.baseline : (state.result.intervention || state.result.baseline));
const currentEvents = () => currentRun()?.events || [];
function timestamp(value) {
  if(!value)return 'Unspecified';
  const text=String(value),zone=text.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1];
  return `${text.slice(0,10)} ${text.slice(11,16)}${zone?' UTC'+(zone==='Z'?'+00:00':zone):''}`;
}
function deliveryWindow(value) {
  const start=value?.delivery_start || value?.interval_start,end=value?.delivery_end || value?.interval_end;
  return start&&end?`${timestamp(start)} to ${timestamp(end)}`:'Delivery window not recorded';
}
function policyValue(field,value) {
  if(field==='time_price')return value?`₹${fmt(value.floor)}/kWh after ${timestamp(value.after)}`:'No later price';
  if(field==='conditional_price')return value?`₹${fmt(value.floor)}/kWh for at least ${fmt(value.minimum_kwh)} kWh`:'No bundle discount';
  if(value===null || value===undefined)return 'Unset';
  if(field.endsWith('_kwh'))return `${fmt(value,3)} kWh`;
  if(['min_price','max_price'].includes(field))return `₹${fmt(value)}/kWh`;
  if(field==='budget')return `₹${fmt(value)}`;
  if(field==='deadline_round')return `Round ${value}`;
  if(field==='interval_start'||field==='interval_end')return timestamp(value);
  return String(value);
}

function notify(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error',error); $('notice').hidden = !text; }
function readConfig() {
  if (!$('config-form').reportValidity()) throw Error('Check the experiment controls.');
  return {negotiation_mode:$('negotiation-mode').value || 'bargaining',population:Number($('population').value),seed:Number($('seed').value),topology:$('topology').value,max_rounds:Number($('max-rounds').value),max_messages:Number($('max-messages').value),utility_cap_kwh:Number($('cap').value),memory_enabled:$('memory').checked,price_tick:Number($('price-tick').value)};
}
function setBusy(value) {
  state.busy = value;
  for (const id of ['reset','parse','structured','controlled','population','topology','seed','max-rounds','max-messages','cap','memory','price-tick','negotiation-mode']) $(id).disabled = value;
  document.querySelectorAll('[data-scenario]').forEach(b => b.disabled=value || !state.result || state.dirty);
  for(let i=0;i<3;i++) $(`example-${i}`).disabled=value || !state.result || state.dirty;
  if ($('confirm')) $('confirm').disabled = value;
  $('parse').disabled = value || !state.result || state.dirty || !$('instruction').value.trim();
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
  $('instruction-help').textContent='Settings changed. Select “Build the market” in Simulation settings before trying an instruction.';
  notify('These results use the previous settings. Build the market again to use your new settings.');
}
async function run(intervention = null) {
  stop(); setBusy(true); const request = ++state.request;
  try {
    const config = intervention ? state.config : readConfig();
    notify(intervention ? 'Trying your change. The homes are finding new agreements…' : 'Getting your neighbourhood ready…');
    const result = await api('/api/experiment', {config,intervention:intervention ? {...intervention,confirmed:true} : null});
    if (request !== state.request) return;
    state.result = result; state.config = config; state.dirty = false;
    $('export-preview').hidden=true;$('export-text').value='';
    state.interventionRoots = !intervention ? [] : intervention.scenario==='shock' ? result.world.agents.filter(a=>a.role==='seller').map(a=>a.id) : [intervention.agent_id];
    state.view = intervention && result.intervention ? 'intervention' : 'baseline';
    state.causal.clear(); state.stage=null; clearDraft(); $('graph-loading').hidden=true;
    initializeAgents(); rebuildFrames(); state.index=Math.max(0,currentEvents().length-1);
    render(); notify(intervention ? 'Your change is ready to explore. Play it back or compare before and after.' : 'Ready. Try an instruction, or play the simulation.');
    $('instruction-help').textContent='Choose an example, then edit the amount.';
    for(const id of ['export','trace-export','ledger-export']) $(id).disabled=false;
  } catch(error) {
    notify(error.message,true);
    if (!state.result) { $('graph-loading').innerHTML = `<strong>The simulation could not start</strong><p>${esc(error.message)}</p>`; $('metric-status').textContent='Unavailable'; }
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
  $('metric-energy').textContent=run.status==='unresolved'?'Not final':`${fmt(m.energy)} kWh`;
  $('metric-energy-sub').textContent=run.status==='unresolved'?'No final agreements':state.result.intervention?(state.view==='baseline'?'Before your change':'After your change'):'In the starting simulation';
  $('metric-demand').textContent=`${fmt(m.demand)} kWh`;
  $('metric-affected').textContent=delta.affected.size;
  $('metric-affected-sub').textContent='With different agreements';
  $('metric-messages').textContent=fmt(m.messages,0); $('metric-rounds').textContent=`${m.rounds} rounds · ${run.events.length} trace events`;
  $('metric-status').textContent=label(run.status || 'complete');
  $('metric-status-sub').textContent=run.status==='locally_stable'?'Within the declared move set':words(run.termination_reason || 'Search stopped before stability');
  $('graph-subtitle').textContent=`${agents().length} simulated homes ${state.config.topology==='local'?'trading with nearby homes':'able to trade across the neighbourhood'}`;
  renderOwn(); renderFrame(); renderAnalysis(); renderOutcome(); renderMethod();
  $('manifest').textContent=JSON.stringify(state.result.manifest,null,2);
  $('protocol-scope').textContent=typeof run.stability_scope==='string'?run.stability_scope:JSON.stringify(run.stability_scope || state.result.manifest?.protocol || 'See the manifest for protocol scope.');
  $('footer-run').textContent=`Seed ${state.config.seed} · ${state.result.manifest?.protocol_version || state.result.manifest?.version || 'Deterministic bilateral protocol'}`;
}
function renderOutcome() {
  const before=state.result.baseline, after=state.result.intervention, delta=changed();
  $('run-view').hidden=!after;
  $('affected-result').hidden=!after;
  $('affected-list').hidden=!after || !delta.affected.size;
  if((after || before).status==='unresolved'){
    $('affected-result').hidden=true;$('affected-list').hidden=true;
    $('simple-outcome').textContent='The simulation could not complete. No final energy agreements were produced. Open detailed results for the reason.';
    return;
  }
  if(!after){$('simple-outcome').textContent='Write an instruction to see how the agreements change.';return;}
  const difference=qty(after.trades)-qty(before.trades);
  const energy=Math.abs(difference)<.005?'The total energy shared is unchanged.':`After your change, homes share ${fmt(Math.abs(difference))} kWh ${difference>0?'more':'less'} energy.`;
  const homes=delta.affected.size?`${delta.affected.size} ${delta.affected.size===1?'home has':'homes have'} different agreements.`:'No homes changed their agreements.';
  const ending=after.status==='locally_stable'?'No further admissible trade was found under the recorded strategy and bounded rules.':after.status==='cycle_detected'?'The simulation stopped because trades started repeating.':after.termination_reason==='max_messages'?'The simulation reached its message limit; further changes may be possible.':after.status==='round_limited'?'The simulation reached its round limit; further changes may be possible.':'The simulation stopped before its search was complete.';
  $('simple-outcome').textContent=`${energy} ${homes} ${ending}`;
  $('affected-names').textContent=[...delta.affected].map(id=>`${agentById(id)?.name || 'Home'} (${id})`).join(', ');
}
function suggestedInstructions(agent) {
  return agent?.role==='buyer' ? [
    {label:'Spending limit',text:'Set my budget to ₹25'},
    {label:'Energy to buy',text:'Buy up to 3 kWh'},
    {label:'Buying price',text:'Set my maximum price to ₹8/kWh'},
  ] : [
    {label:'Selling price',text:'Raise my minimum price to ₹8/kWh'},
    {label:'Energy for sale',text:'Sell up to 3 kWh'},
    {label:'Keep some energy',text:'Keep 3 kWh in reserve'},
  ];
}
function useExample(index) {
  if(state.busy || state.dirty || !state.result)return;
  const example=suggestedInstructions(agentById(state.controlled))[index];
  if(!example)return;
  $('instruction').value=example.text;clearDraft();setBusy(false);
  $('instruction-help').textContent='You can edit the amount, then select “Review my change”.';
  $('instruction').focus();
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
  $('prompt-help').textContent=`You are guiding ${a.name || 'Home'} (${a.id}), which ${a.role==='seller'?'sells spare solar energy':'buys energy'}.`;
  $('instruction').placeholder='Type your instruction here…';
  suggestedInstructions(a).forEach((example,index)=>{$(`example-${index}`).textContent=example.label;});
  $('own-context').textContent=typeof a.context==='string'?a.context:'Synthetic household preferences for this research experiment.';
  $('own-bounds').innerHTML=boundHTML(a);
  $('home-window').textContent=deliveryWindow(a);
  $('home-flexibility').textContent=a.time_price?policyValue('time_price',a.time_price):'One flexible energy pool within this window.';
  document.querySelector('.avatar').textContent=a.role==='seller'?'☀':'⌂';
  const fields=a.role==='seller'?['min_price','max_offer_kwh','forecast_surplus_kwh','reserve_kwh']:['max_price','budget','demand_kwh','deadline_round'];
  const prev=$('policy-field').value;
  $('policy-field').innerHTML=fields.map(f=>`<option value="${f}">${fieldNames[f]}</option>`).join('');
  if(fields.includes(prev)) $('policy-field').value=prev;
}
function replayStages() {
  const events=currentEvents(),intervention=state.view!=='baseline'&&state.result?.intervention;
  const find=predicate=>{const index=events.findIndex(predicate);return {index,event:index<0?null:events[index]};};
  const policy=intervention?find(e=>e.type==='policy_confirmed'):{index:-1,event:null};
  const affected=intervention?find(e=>/released|replaced/.test(e.type)):{index:-1,event:null};
  const offers=find(e=>['offer_sent','counteroffer_sent','price_counter','price_counters','offer_accepted','offer_rejected'].includes(e.type));
  const final={index:Math.max(0,events.length-1),event:events.at(-1)||null};
  return [
    {id:'starting',title:'Starting agreements',index:-1,event:null,explanation:'Original agreements before your change. These stay fixed as the reference.'},
    {id:'requirement',title:'Revised requirement',...policy,explanation:policy.event?policy.event.reason:'No revised requirement is recorded. Review and apply an instruction to try a change.'},
    {id:'affected',title:'Affected agreement',...affected,explanation:affected.event?affected.event.reason:'No prior agreement was released or directly changed at this stage.'},
    {id:'offers',title:'Offers and responses',...offers,explanation:offers.event?eventDescription(offers.event):'No offers or responses were recorded for this run.'},
    {id:'final',title:'Final allocation',...final,explanation:currentRun()?.status==='unresolved'?'The run did not produce a final allocation.':eventDescription(final.event)}
  ];
}
function selectStage(id) {
  const stage=replayStages().find(s=>s.id===id);if(!stage)return;
  stop();state.stage=id;state.index=Math.max(0,stage.index);renderFrame();
}
function frameTrades() {
  if(state.stage==='starting')return state.result?.baseline?.trades || [];
  if(state.stage==='final')return currentRun()?.trades || [];
  if(state.stage){const stage=replayStages().find(s=>s.id===state.stage);if(stage&&!stage.event)return state.view==='baseline'?[]:state.result?.baseline?.trades || [];}
  return state.frames[state.index] || currentRun()?.trades || [];
}
function renderStages() {
  const focused=document.activeElement?.getAttribute?.('data-stage');
  $('replay-stages').innerHTML=replayStages().map((s,i)=>`<button type="button" data-stage="${s.id}" aria-pressed="${state.stage===s.id}"><span>${i+1}</span>${esc(s.title)}</button>`).join('');
  $('replay-stages').querySelectorAll('[data-stage]').forEach(b=>{b.onclick=()=>selectStage(b.dataset.stage);if(b.dataset.stage===focused)b.focus();});
}
function activeEvent() {
  return state.stage?replayStages().find(s=>s.id===state.stage)?.event:currentEvents()[state.index];
}
function eventTerms(event) {
  const terms=event.trade || event;
  const amount=terms.quantity_kwh!=null?`${fmt(terms.quantity_kwh)} kWh`:'';
  const price=terms.price!=null?` at ₹${fmt(terms.price)}/kWh`:'';
  const window=terms.delivery_start&&terms.delivery_end?` · ${deliveryWindow(terms)}`:'';
  return amount+price+window;
}
function renderConversation() {
  const event=activeEvent(),participants=[event?.actor_id,event?.counterparty_id].filter(Boolean);
  if(event?.type==='policy_confirmed') {
    $('conversation').innerHTML=`<h3>Revised requirement</h3><p>${esc(event.reason || 'Confirmed policy change')}</p>${(event.changed_fields || []).map(change=>`<p><strong>${esc(change.agent_id)} · ${esc(fieldNames[change.field] || label(change.field))}</strong><br>${esc(policyValue(change.field,change.before))} → ${esc(policyValue(change.field,change.after))}</p>`).join('')}`;
    return;
  }
  const messageTypes=['offer_sent','counteroffer_sent','price_counter','price_counters','offer_accepted','offer_rejected','provisional_reserved','provisional_released','offer_replaced'];
  const list=event&&participants.length===2?currentEvents().slice(0,state.index+1).filter(e=>messageTypes.includes(e.type)&&participants.includes(e.actor_id)&&participants.includes(e.counterparty_id)).slice(-3):[];
  $('conversation').innerHTML=list.length?`<h3>Active conversation · ${participants.map(esc).join(' ↔ ')}</h3>${list.map(e=>`<article class="conversation-entry"><strong>${esc(e.actor_id)} → ${esc(e.counterparty_id)} · ${esc(label(e.type))}</strong>${eventTerms(e)?`<p>${esc(eventTerms(e))}</p>`:''}<p>${esc(e.reason || words(e.reason_code) || 'No reason recorded.')}</p></article>`).join('')}`:`<h3>${state.stage==='starting'?'Starting agreements':'Recorded response'}</h3><p>${esc(state.stage?replayStages().find(s=>s.id===state.stage)?.explanation:event?.reason || 'Select Play or a replay stage to follow the homes. No conversation is active here.')}</p>`;
}
function translationDescription(translation) {
  const mode=translation.mode || 'unknown';
  return /llm|openai/i.test(mode)?`AI translation${translation.model?' · '+translation.model:''}. Check the interpretation before applying.`:`Rules-based translation${translation.status?' · '+words(translation.status):''}.`;
}
function renderFrame() {
  const events=currentEvents(), stage=state.stage?replayStages().find(s=>s.id===state.stage):null, event=stage?stage.event:events[state.index];
  $('timeline').max=Math.max(0,events.length-1); $('timeline').value=state.index;
  $('position').textContent=stage?stage.title:state.index>=events.length-1?'Final result':`Step ${state.index+1} of ${events.length}`;
  $('replay-caption').textContent=stage?.explanation || eventDescription(event);
  renderStages();renderConversation();
  $('back').disabled=state.index===0; $('next').disabled=state.index>=events.length-1;
  $('round-label').textContent=`Round ${event?.round ?? 0}`;
  $('event-type').textContent=words(event?.type || 'baseline').toUpperCase();
  $('event-title').textContent=event ? `${event.actor_id || 'Market'}${event.counterparty_id?' → '+event.counterparty_id:''} · ${label(event.type)}` : 'Baseline ready';
  $('event-reason').textContent=event?.reason || words(event?.reason_code) || 'Inspect the recorded event details in the trace export.';
  $('causal').hidden=!event?.caused_by?.length; $('causal').textContent=state.causal.size?'Clear causal highlight':'Highlight causal chain ↗';
  $('graph-wrap').classList.toggle('comparing',state.view==='compare'); $('compare-graph').toggleAttribute('hidden',state.view!=='compare');
  const trades=frameTrades();
  drawGraph($('graph'),trades,event,state.view==='baseline'?'Before your change':'After your change');
  if(state.view==='compare') {
    drawGraph($('compare-graph'),state.result.baseline.trades || [],null,'Original starting agreements');
  }
  renderInspector(); renderDecisionAudit(); renderLog();
}
function eventDescription(event) {
  if(!event)return 'Each shape is a home. Lines show their energy agreements.';
  if(event.type==='terminated'){
    const run=currentRun();
    if(run?.status==='locally_stable')return 'The homes have finished finding trades under these rules.';
    if(run?.status==='cycle_detected')return 'The simulation stopped because trades started repeating.';
    if(run?.status==='round_limited')return `The simulation reached its ${run.termination_reason==='max_messages'?'message':'round'} limit. Further changes may be possible.`;
    return 'The simulation could not complete. Open detailed results for the reason.';
  }
  if(event.type==='offer_rejected')return 'An offer was not accepted. The homes can look for another trade.';
  if(/released/.test(event.type))return 'An earlier energy agreement is being changed.';
  if(/reserved|replaced/.test(event.type))return `${event.actor_id || 'A home'} and ${event.counterparty_id || 'another home'} agree on a trade.`;
  if(/offer_sent|counteroffer_sent/.test(event.type))return `${event.actor_id || 'A home'} is discussing a trade with ${event.counterparty_id || 'another home'}.`;
  if(event.type==='commitment_finalized')return 'The final energy agreements are recorded.';
  return 'The homes are checking which trades fit their rules.';
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
  svg.replaceChildren();
  const pos=positions(),delta=changed(),search=$('search').value.trim().toLowerCase(),only=$('only-affected').checked;
  const markerPrefix=svg.id || (svg===$('compare-graph')?'comparison':'main');
  const defs=svgEl('defs',{},svg);
  for(const [name,color] of [['agreement','#527a59'],['message','#79548f'],['release','#a14738']]) {
    const marker=svgEl('marker',{id:`${markerPrefix}-${name}`,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse',markerUnits:'strokeWidth'},defs);
    svgEl('path',{d:'M0 0 L10 5 L0 10 Z',fill:color},marker);
  }
  const root=svgEl('g',{transform:`translate(${state.pan.x} ${state.pan.y}) translate(440 300) scale(${state.zoom}) translate(-440 -300)`},svg);
  const textScale=Math.max(.4,Math.min((svg.clientWidth||880)/880,(svg.clientHeight||610)/610));
  svgEl('text',{x:440,y:25,'text-anchor':'middle',fill:'#4c624c','font-size':14/textScale},root,caption);
  for(let c=0;c<5;c++){const theta=-Math.PI/2+c*2*Math.PI/5,x=440+190*Math.cos(theta),y=290+172*Math.sin(theta);svgEl('circle',{cx:x,cy:y,r:98,fill:'none',stroke:'#e4e9dc','stroke-dasharray':'3 6'},root);}
  const edges=svgEl('g',{},root),nodes=svgEl('g',{},root);
  function edge(from,to,attrs={}) {
    const a=pos.get(from),b=pos.get(to);if(!a||!b)return;
    const length=Math.hypot(b.x-a.x,b.y-a.y)||1,dx=(b.x-a.x)/length,dy=(b.y-a.y)/length;
    return svgEl('path',{d:`M${a.x+dx*20},${a.y+dy*20} Q${(a.x+b.x)/2+18},${(a.y+b.y)/2-18} ${b.x-dx*23},${b.y-dy*23}`,fill:'none',...attrs},edges);
  }
  if($('discovery').checked)for(const item of state.result.world.discovery_edges || []) {
    const from=Array.isArray(item)?item[0]:item.source || item.seller_id || item.from,to=Array.isArray(item)?item[1]:item.target || item.buyer_id || item.to;
    edge(from,to,{stroke:'#cbd4c0','stroke-width':.7,'stroke-dasharray':'3 6',opacity:.3});
  }
  for(const t of trades) {
    const active=[t.seller_id,t.buyer_id].includes(state.selected),affected=delta.affected.has(t.seller_id)||delta.affected.has(t.buyer_id);
    if(only&&!affected)continue;
    const description=`${t.seller_id} → ${t.buyer_id}: ${fmt(t.quantity_kwh)} kWh at ₹${fmt(t.price)}/kWh · ${deliveryWindow(t)}`;
    const path=edge(t.seller_id,t.buyer_id,{stroke:active?'#315d49':'#a6b995','stroke-width':active?3:1,opacity:active?.95:.55,'marker-end':`url(#${markerPrefix}-agreement)`,class:'trade-edge',tabindex:0,role:'button','aria-label':description});
    if(path) {
      svgEl('title',{},path,description);
      const inspect=()=>{state.selected=t.seller_id;$('inspect-select').value=state.selected;notify(description);renderFrame();};
      path.addEventListener('click',inspect);path.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();inspect();}});
    }
  }
  const highlighted=state.causal.size?[...state.result.baseline.events,...(state.result.intervention?.events||[])].filter(e=>state.causal.has(e.id)):[event].filter(Boolean);
  for(const e of highlighted) {
    const message=/offer_sent|counteroffer_sent|price_counter|offer_accepted|offer_rejected/.test(e.type),release=/reject|release/.test(e.type),agreement=/reserved|replaced/.test(e.type);
    if(!message&&!release&&!agreement)continue;
    const kind=release?'release':message?'message':'agreement';
    edge(e.actor_id,e.counterparty_id,{stroke:release?'#a14738':message?'#79548f':'#315d49','stroke-width':2.5,'stroke-dasharray':message?'7 5':release?'3 4':'none','marker-end':`url(#${markerPrefix}-${kind})`,class:`event-edge ${message?'message-edge':release?'event-release':'event-accept'}`,opacity:.95});
  }
  const activeParties=new Set([event?.actor_id,event?.counterparty_id]);
  for(const a of agents(state.view!=='baseline')) {
    const point=pos.get(a.id);if(!point)continue;
    const affected=delta.affected.has(a.id),selected=a.id===state.selected,own=a.id===state.controlled,active=activeParties.has(a.id);
    const match=(!search||`${a.id} ${a.name}`.toLowerCase().includes(search))&&($('role-filter').value==='all'||$('role-filter').value===a.role),dim=!match||(only&&!affected&&!own);
    const availability=householdAvailability(a,trades);
    const g=svgEl('g',{transform:`translate(${point.x} ${point.y})`,class:`node${active?' active-party':''}${own?' controlled-node':''}${selected?' inspected-node':''}`,'data-agent':a.id,tabindex:0,role:'button','aria-label':`Inspect ${a.id}, ${a.name || ''}, ${a.role}. ${availability}${affected?', affected':''}`,opacity:dim?.15:1},nodes);
    if(active)svgEl('circle',{r:28,fill:'#ede4f3',stroke:'#79548f','stroke-width':1.5},g);
    if(own)svgEl('circle',{r:20,fill:'none',stroke:'#40654d','stroke-width':2},g);
    if(selected)svgEl('circle',{r:24,fill:'none',stroke:'#254936','stroke-width':1.5,'stroke-dasharray':'3 3'},g);
    const attrs={fill:a.role==='seller'?'#c59a55':'#5c9287',stroke:affected?'#718eb9':'#fffef9','stroke-width':affected?3:2,class:'node-shape'},radius=agents().length<=50?14:10;
    if(a.role==='seller')svgEl('circle',{r:radius,...attrs},g);else svgEl('rect',{x:-radius,y:-radius,width:radius*2,height:radius*2,rx:5,...attrs},g);
    if(own)svgEl('text',{'text-anchor':'middle',y:3,fill:'white','font-size':9,'font-weight':600},g,'✦');
    svgEl('text',{'text-anchor':'middle',y:38,fill:'#314b36','font-size':11/textScale,'font-weight':own?700:500,class:'node-label'},g,a.id);
    svgEl('title',{},g,`${a.id} · ${a.name || 'Home'} · ${a.role} · ${availability}`);
    const inspect=()=>{state.selected=a.id;$('inspect-select').value=a.id;renderFrame();$('household-details').open=true;$('household-details').scrollIntoView?.({block:'nearest'});};
    g.addEventListener('click',inspect);g.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();inspect();}});
  }
}
function householdAvailability(a,trades) {
  const agreements=trades.filter(t=>t.seller_id===a.id||t.buyer_id===a.id),matched=qty(agreements);
  if(a.role==='seller') {
    const free=Math.min(Number(a.max_offer_kwh ?? Infinity),Math.max(0,Number(a.forecast_surplus_kwh || 0)-Number(a.reserve_kwh || 0)))-matched;
    if(free<=1e-7)return 'No free energy to offer at this point.';
    return agreements.length?`${fmt(Math.max(0,free))} kWh still available.`:`Not in an agreement; ${fmt(free)} kWh available.`;
  }
  const unfilled=Math.max(0,Number(a.demand_kwh || 0)-matched);
  return unfilled<=1e-7?'Energy requirement filled.':agreements.length?`${fmt(unfilled)} kWh still needed.`:`Not in an agreement; ${fmt(unfilled)} kWh still needed.`;
}
function renderInspector() {
  const a=agentById(state.selected,state.view!=='baseline'); if(!a)return;
  const relevant=currentEvents().slice(0,state.index+1).filter(e=>e.actor_id===a.id||e.counterparty_id===a.id),last=relevant.at(-1);
  const trades=frameTrades().filter(t=>t.seller_id===a.id||t.buyer_id===a.id);
  let memory=a.memory || [];
  if(!Array.isArray(memory))memory=Object.entries(memory).map(([id,text])=>({id,text}));
  $('inspection').innerHTML=`<div class="inspector-id"><span class="role-tag">${esc(a.role.toUpperCase())}</span><span class="tiny-label">${esc(a.id)}</span></div><h3>${esc(a.name || a.id)}</h3><h4>Hard constraints</h4>${boundHTML(a)}${a.conditional_price?`<div class="bound"><span>Bundle discount (private)</span><strong>₹${fmt(a.conditional_price.floor)} for ≥${fmt(a.conditional_price.minimum_kwh)} kWh</strong></div>`:''}<div class="bound"><span>Time window</span><strong>${esc(deliveryWindow(a))}</strong></div><p>${esc(householdAvailability(a,frameTrades()))}</p><h4>Reservations at this event</h4>${trades.length?trades.map(t=>`<div class="bound"><span>${esc(t.seller_id)} → ${esc(t.buyer_id)}</span><strong>${fmt(t.quantity_kwh)} kWh<br>₹${fmt(t.price)}/kWh<br><small>${esc(deliveryWindow(t))}</small></strong></div>`).join(''):'<p class="muted">No active reservation at this point.</p>'}<h4>Latest recorded decision</h4><p>${esc(last?.reason || words(last?.reason_code) || 'No decision recorded yet at this replay position.')}</p>${last?.rule_checks?`<p class="muted small">Checks: ${esc(Array.isArray(last.rule_checks)?last.rule_checks.join(', '):JSON.stringify(last.rule_checks))}</p>`:''}<details><summary>Private context & memory (${memory.length})</summary><div class="private">Research inspection only. Private context is not shared in agent messages.</div><p>${esc(typeof a.context==='string'?a.context:JSON.stringify(a.context))}</p>${memory.map(m=>`<div class="memory-record">${esc(m.text || m.content || JSON.stringify(m))}<small>Source ${esc(m.id || m.record_id || 'synthetic memory')} · ${state.config.memory_enabled?'Retrieval enabled':'Retrieval disabled'}</small>${m.preference?.type==='preferred_counterparty'?`<small>Soft preference: ${esc(m.preference.agent_id)} wins equal-value ties</small>`:''}</div>`).join('')}<p class="muted small">Memory can rank feasible alternatives. It cannot override a hard constraint.</p></details>`;
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
  $('event-log').querySelectorAll('[data-event]').forEach(b=>b.onclick=()=>{stop();state.stage=null;state.index=Number(b.dataset.event);renderFrame();});
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
  renderHouseholdChanges();
  const caveat=b&&state.result.baseline.status!=='locally_stable'?'The starting simulation stopped early. Some differences may come from continuing it, as well as your change.':'';
  $('comparison-caveat').textContent=caveat;$('comparison-caveat').hidden=!caveat;
}
function householdChanges() {
  const before=state.result.baseline,after=state.result.intervention;if(!after)return [];
  const au=utilities(before),bu=utilities(after);
  return agents().map(a=>{
    const ledger=run=>(run.trades||[]).filter(t=>t.seller_id===a.id||t.buyer_id===a.id);
    const first=ledger(before),last=ledger(after);
    return {id:a.id,role:a.role,energy:qty(last)-qty(first),payment:spend(last)-spend(first),utility:au[a.id]!=null&&bu[a.id]!=null?Number(bu[a.id])-Number(au[a.id]):null};
  });
}
function renderHouseholdChanges() {
  const rows=householdChanges(),signed=n=>`${n>0?'+':''}${fmt(n)}`;
  $('household-changes').innerHTML=rows.length?rows.map(row=>`<tr><th scope="row">${esc(row.id)} · ${esc(agentById(row.id)?.name || label(row.role))}</th><td>${signed(row.energy)} kWh</td><td>${signed(row.payment)} INR</td><td>${row.utility==null?'Unreported':signed(row.utility)+' INR'}</td></tr>`).join(''):'<tr><td colspan="4">Apply a change to compare each home.</td></tr>';
}
function renderMethod() {
  const manifest=state.result?.manifest || {},mode=manifest.config?.negotiation_mode || state.config?.negotiation_mode || 'midpoint',source=manifest.strategy_plan?.source || '';
  $('method-summary').textContent=mode==='midpoint'?'Midpoint comparison: rules choose the middle of the feasible price range.':(/openai|llm/i.test(source)&&!/fallback|unavailable|disabled/i.test(source))?'LLM-planned bargaining: frozen household strategies guide executable offers and price concessions.':'Bargaining with a rules-based fallback: frozen strategies guide offers and price concessions.';
  $('method-source').textContent=`Strategy source: ${source || 'not recorded'}. The original world and strategy plan are reused for your change. Replay makes no translation or planning requests.`;
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
  const modified=entries.filter(([key,value])=>JSON.stringify(a?.[key])!==JSON.stringify(value));
  const unchanged=entries.filter(([key,value])=>JSON.stringify(a?.[key])===JSON.stringify(value));
  const scenarioDiff=draft.previewChanges?.length?`<details><summary>Inspect all ${draft.previewChanges.length} forecast changes</summary>${draft.previewChanges.map(c=>`<div class="diff"><span>${esc(c.agent_id)}<br><small>Was ${fmt(c.before)} kWh</small></span><strong>${fmt(c.after)} kWh</strong></div>`).join('')}</details>`:'';
  $('proposal').className='proposal'; $('proposal').hidden=false;
  $('proposal').innerHTML=`<h4>Check your change</h4><p>For ${esc(a?.name || 'home')} (${esc(draft.agent_id || '')}). Nothing changes until you apply it.</p>${state.result?.intervention?'<p>This replaces your previous change. The result is compared with the starting simulation.</p>':''}${draft.normalized_prompt?`<p><strong>Understood as:</strong> ${esc(draft.normalized_prompt)}</p>`:''}${(draft.assumptions||[]).length?`<p><strong>Assumptions:</strong> ${draft.assumptions.map(esc).join(' · ')}</p>`:''}${draft.translation?`<p class="translation-note">${esc(translationDescription(draft.translation))}</p>`:''}${draft.description?`<p>${esc(draft.description)}</p>`:''}${modified.map(([k,v])=>`<div class="diff"><span>${esc(fieldNames[k] || label(k))}<br><small>Before: ${esc(policyValue(k,a?.[k]))}</small></span><strong>${esc(policyValue(k,v))}</strong></div>`).join('')}${!modified.length&&!draft.previewChanges?.length?'<p>This keeps your home’s rules the same.</p>':''}${unchanged.length?`<details><summary>Rules that stay the same</summary>${unchanged.map(([k,v])=>`<p>${esc(fieldNames[k])}: ${esc(policyValue(k,v))}</p>`).join('')}</details>`:''}${scenarioDiff}<button id="confirm" class="button primary full">Apply and see the result →</button><button id="cancel" class="button light full">Cancel</button>`;
  $('confirm').onclick=()=>{if(!state.draft||state.dirty||state.draft.revision!==state.draftRevision||state.draft.fingerprint!==JSON.stringify(state.config)||state.draft.controlled!==state.controlled){clearDraft();notify('The preview is out of date. Preview the policy again.',true);return;}const {agent_id,scenario,changes}=state.draft;run({agent_id,scenario,changes});};
  $('cancel').onclick=()=>{clearDraft();$('parse').focus();};
}
async function preview(text=$('instruction').value) {
  if(state.busy||state.dirty)return;
  if(!text.trim()){clearDraft();$('instruction-help').textContent='Type an instruction or choose an example first.';setBusy(false);$('instruction').focus();return;}
  stop();clearDraft();setBusy(true);const controlled=state.controlled, revision=state.draftRevision;
  try{const result=await api('/api/policy',{config:state.config,agent_id:controlled,text});
    if(revision!==state.draftRevision || controlled!==state.controlled || state.dirty)return;
    if(result.clarification_questions?.length){state.draft=null;$('proposal').className='proposal';$('proposal').hidden=false;$('proposal').innerHTML=`<h4>A detail is needed</h4>${result.clarification_questions.map(q=>`<p>${esc(q)}</p>`).join('')}<p>Add your answer to the instruction above, then review it again. Nothing has been applied.</p>`;$('instruction-help').textContent='Keep your instruction and add the missing amount, unit or time.';}
    else if(result.errors?.length){state.draft=null;$('proposal').className='proposal error';$('proposal').hidden=false;$('proposal').innerHTML=`<h4>No changes applied</h4>${result.errors.map(e=>`<p>${esc(e)}</p>`).join('')}<p>Use a short instruction like the examples above, then edit the numbers.</p>`;}
    else displayDraft({agent_id:controlled,scenario:'custom',changes:result.changes,normalized_prompt:result.normalized_prompt,assumptions:result.assumptions,translation:result.translation},result.recognized);
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
  stop();state.stage=null;const events=currentEvents(),round=events[state.index]?.round ?? 0;
  const next=direction>0?events.findIndex(e=>e.round>round):events.findLastIndex(e=>e.round<round);
  if(next>=0)state.index=next;
  renderFrame();
}
function stop(){clearInterval(state.timer);state.timer=null;$('replay-caption').setAttribute('aria-live','polite');$('play').textContent='▶ Play the simulation';$('play').setAttribute('aria-label','Play the simulation');}
function play(){state.stage=null;if(state.timer){stop();return;}if(!currentEvents().length)return;$('replay-caption').setAttribute('aria-live','off');if(state.index>=currentEvents().length-1)state.index=0;$('play').textContent='Ⅱ Pause';$('play').setAttribute('aria-label','Pause the simulation');renderFrame();state.timer=setInterval(()=>{if(state.index>=currentEvents().length-1){stop();return;}state.index++;renderFrame();},700/Number($('speed').value));}
function download(name,text,type){if(state.exportURL)URL.revokeObjectURL(state.exportURL);state.exportURL=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=state.exportURL;a.download=name;a.textContent=`Download ${name}`;notify('Your export is ready. ');$('notice').append(a);$('export-title').textContent=`View or copy ${name}`;$('export-text').value=text;$('export-preview').hidden=false;$('notice').scrollIntoView?.({block:'nearest'});}
function exportLedger(){const q=s=>`"${String(s??'').replaceAll('"','""')}"`;const columns=['run','id','seller_id','buyer_id','quantity_kwh','price','payment','status','delivery_start','delivery_end'];const rows=[columns.join(',')];for(const name of ['baseline','intervention'])for(const t of state.result[name]?.trades||[])rows.push([name,...columns.slice(1).map(k=>t[k])].map(q).join(','));download('energy-trade-ledger.csv',rows.join('\n'),'text/csv');}
function bindPan(svg){let drag=null;svg.addEventListener('pointerdown',e=>{if(e.target.closest('.trade-edge'))return;const node=e.target.closest('.node'),id=node?.getAttribute('data-agent'),origin=id?(state.nodeOffsets[id]||{x:0,y:0}):state.pan;drag={x:e.clientX,y:e.clientY,px:origin.x,py:origin.y,id};if(id){state.selected=id;$('inspect-select').value=id;}svg.setPointerCapture(e.pointerId);});svg.addEventListener('pointermove',e=>{if(!drag)return;const rect=svg.getBoundingClientRect(),scale=1/Math.min(rect.width/880,rect.height/610)/(drag.id?state.zoom:1),next={x:drag.px+(e.clientX-drag.x)*scale,y:drag.py+(e.clientY-drag.y)*scale};if(drag.id)state.nodeOffsets[drag.id]=next;else state.pan=next;renderFrame();});svg.addEventListener('pointerup',()=>{drag=null;if(state.result)renderFrame();});svg.addEventListener('pointercancel',()=>drag=null);}
$('config-form').onsubmit=e=>{e.preventDefault();state.zoom=1;state.pan={x:0,y:0};state.nodeOffsets={};run();};
for(const id of ['population','topology','seed','max-rounds','max-messages','cap','memory','price-tick','negotiation-mode'])$(id).addEventListener('change',invalidate);
$('instruction').addEventListener('input',()=>{const hadDraft=!!state.draft;clearDraft();setBusy(state.busy);if(hadDraft)$('instruction-help').textContent='Your instruction changed. Review it again before applying.';});
$('policy-value').addEventListener('input',clearDraft);
$('policy-field').addEventListener('change',clearDraft);
$('controlled').onchange=()=>{state.controlled=$('controlled').value;state.selected=state.controlled;$('inspect-select').value=state.selected;clearDraft();state.causal.clear();render();};
$('inspect-select').onchange=()=>{state.selected=$('inspect-select').value;renderFrame();};
$('parse').onclick=()=>preview();
$('structured').onclick=()=>{const v=$('policy-value').value,f=$('policy-field').value,phrases={min_price:`Set my minimum price to INR ${v}`,max_price:`Set my maximum price to INR ${v}`,max_offer_kwh:`Sell up to ${v} kWh`,forecast_surplus_kwh:`Set my surplus to ${v} kWh`,reserve_kwh:`Keep ${v} kWh in reserve`,budget:`Set my budget to INR ${v}`,demand_kwh:`Buy ${v} kWh`,deadline_round:`Set my deadline to round ${v}`};$('instruction').value=phrases[f];preview(phrases[f]);};
document.querySelectorAll('[data-example-index]').forEach(b=>b.onclick=()=>useExample(Number(b.dataset.exampleIndex)));
document.querySelectorAll('[data-scenario]').forEach(b=>b.onclick=()=>preset(b.dataset.scenario));
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{if(!state.result)return;stop();state.view=b.dataset.view;state.stage=null;state.causal.clear();rebuildFrames();state.index=Math.min(state.index,Math.max(0,currentEvents().length-1));render();});
$('timeline').oninput=()=>{stop();state.stage=null;state.index=Number($('timeline').value);renderFrame();};
$('back').onclick=()=>{stop();state.stage=null;state.index=Math.max(0,state.index-1);renderFrame();};
$('next').onclick=()=>{stop();state.stage=null;state.index=Math.min(currentEvents().length-1,state.index+1);renderFrame();};
$('previous-round').onclick=()=>stepRound(-1);$('next-round').onclick=()=>stepRound(1);
$('end').onclick=()=>{stop();state.stage=null;state.index=Math.max(0,currentEvents().length-1);renderFrame();};
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
