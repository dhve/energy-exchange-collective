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
function indiaTime(value) {
  if(!value||!/(Z|[+-]\d{2}:\d{2})$/.test(String(value)))return null;
  const instant=Date.parse(value);if(!Number.isFinite(instant))return null;
  const india=new Date(instant+330*60*1000),hours=india.getUTCHours(),minutes=india.getUTCMinutes();
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return {date:`${india.getUTCDate()} ${months[india.getUTCMonth()]}`,day:india.toISOString().slice(0,10),clock:`${hours%12||12}${minutes?':'+String(minutes).padStart(2,'0'):''}`,period:hours<12?'AM':'PM'};
}
function timestamp(value) {
  const time=indiaTime(value);
  return time?`${time.date} · ${time.clock} ${time.period} (India time)`:'Unspecified';
}
function deliveryWindow(value) {
  const start=value?.delivery_start || value?.interval_start,end=value?.delivery_end || value?.interval_end;
  const first=indiaTime(start),last=indiaTime(end);
  if(!first||!last)return 'Delivery window not recorded';
  if(first.day!==last.day)return `${timestamp(start)} to ${timestamp(end)}`;
  return `${first.date} · ${first.clock}${first.period===last.period?'':' '+first.period}–${last.clock} ${last.period} (India time)`;
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
  for (const id of ['reset','parse','controlled','population','topology','seed','max-rounds','max-messages','cap','memory','price-tick','negotiation-mode']) $(id).disabled = value;
  document.querySelectorAll('[data-scenario]').forEach(b => b.disabled=value || !state.result || state.dirty);
  for(let i=0;i<3;i++) $(`example-${i}`).disabled=value || !state.result || state.dirty;
  if ($('confirm')) $('confirm').disabled = value;
  $('parse').disabled = value || !state.result || state.dirty || !$('instruction').value.trim();
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
    state.causal.clear(); state.storyFocused=false; state.storyKind=null; state.storyId=null; state.story=null; state.storyMarkup=null; state.stage=null; state.mapMode='animation'; state.history=null; clearDraft(); $('graph-loading').hidden=true;
    initializeAgents(); rebuildFrames(); state.index=Math.max(0,currentEvents().length-1);
    render(); notify(intervention ? 'Your change is ready. Watch the negotiations or compare the agreements.' : '');
    $('instruction-help').textContent='Choose an example, then edit the amount.';
    for(const id of ['export','trace-export','ledger-export']) $(id).disabled=false;
    if(intervention && typeof window!=='undefined' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches)play();
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
  renderOwn(); renderFrame(); renderAnalysis(); renderOutcome(); renderMethod(); renderImpactSummary();
  $('manifest').textContent=JSON.stringify(state.result.manifest,null,2);
  $('protocol-scope').textContent=typeof run.stability_scope==='string'?run.stability_scope:JSON.stringify(run.stability_scope || state.result.manifest?.protocol || 'See the manifest for protocol scope.');
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
  if(!after){$('simple-outcome').textContent='';return;}
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
function boundHTML(a, compact=false) { return bounds(a).map(([k,v])=>`<div class="bound"><span>${esc(compact?k.replace(' (private)',''):k)}</span><strong>${esc(v)}</strong></div>`).join(''); }
function preferencesHTML(a) {
  const p=a.negotiation_preferences;if(!p)return '';
  let window='Any time within the firm delivery window';
  if(p.delivery!=='any') {
    const start=Date.parse(a.interval_start),end=Date.parse(a.interval_end),middle=start+(end-start)/2;
    window=Number.isFinite(middle)&&end>start?deliveryWindow({delivery_start:new Date(p.delivery==='earlier'?start:middle).toISOString(),delivery_end:new Date(p.delivery==='earlier'?middle:end).toISOString()}):'Preferred window not recorded';
  }
  return `<section class="flexible-preferences"><h4>Flexible preferences</h4><p class="helper">These can change for a better offer. Firm limits always apply.</p><div class="bound"><span>Price aim</span><strong>₹${fmt(p.price_target)}/kWh · negotiable</strong></div><div class="bound"><span>Preferred delivery</span><strong>${esc(window)}</strong></div><div class="bound"><span>Preferred amount</span><strong>${p.quantity_direction==='at_least'?'At least':'At most'} ${fmt(p.preferred_quantity_kwh)} kWh per agreement</strong></div><details class="message-policy"><summary>How strongly this home prefers these terms</summary><p>Different time: ₹${fmt(p.time_premium)}/kWh. Different amount: ₹${fmt(p.quantity_premium)}/kWh. These are modeled preference costs, not extra payments. Both costs apply when both preferences are missed.</p></details></section>`;
}
function renderOwn() {
  const a=agentById(state.controlled);
  if(!a) return;
  $('own-name').textContent=a.name || a.id; $('own-id').textContent=`${a.id} · ${a.role==='seller'?'Solar seller':'Energy buyer'}`;
  $('own-role').textContent=a.role==='seller'?'SELLER':'BUYER';
  const nameArea=a.name?.match(/^(.*?)\s*\(([^)]+)\)$/),name=nameArea?.[1]?.trim() || a.name,identity=[a.id,nameArea?.[2]].filter(Boolean).join(', ');
  $('prompt-help').textContent=`You control ${name?name+'’s':'your'} home (${identity}). It ${a.role==='seller'?'sells spare solar energy':'buys energy'}.`;
  $('instruction').placeholder='Type your instruction here…';
  suggestedInstructions(a).forEach((example,index)=>{$(`example-${index}`).textContent=example.label;});
  $('own-context').textContent=typeof a.context==='string'?a.context:'Synthetic household preferences for this research experiment.';
  $('own-bounds').innerHTML=boundHTML(a);
  $('home-window').textContent=`Original window: ${deliveryWindow(a)}`;
  $('home-flexibility').textContent=a.time_price?policyValue('time_price',a.time_price):'One flexible energy pool within this window.';
  document.querySelector('.avatar').textContent=a.role==='seller'?'☀':'⌂';
}
function frameWorld() {
  const original=state.result?.world;
  if(state.view==='baseline'||!state.result?.intervention||state.stage==='starting')return original;
  const policyIndex=currentEvents().findIndex(event=>event.type==='policy_confirmed');
  if(policyIndex>=0&&state.index<policyIndex)return original;
  return state.result.updated_world || original;
}
function frameEvents() {
  if(state.stage==='starting')return state.result?.baseline?.events || [];
  return currentEvents().slice(0,state.index+1);
}
function recordedExchange(events,startIndex) {
  if(startIndex<0)return {index:-1,event:null,startIndex:-1};
  const first=events[startIndex],parties=new Set([first.actor_id,first.counterparty_id]);
  let end=startIndex;
  for(let index=startIndex+1;index<events.length;index++) {
    const event=events[index];
    if(['offer_sent','terminated','policy_confirmed'].includes(event.type))break;
    if(!parties.has(event.actor_id)||!parties.has(event.counterparty_id))continue;
    if(/counteroffer|price_counter|accepted|rejected|reserved|replaced|released/.test(event.type))end=index;
    if(/provisional_reserved|offer_replaced|offer_rejected/.test(event.type))break;
  }
  return {index:end,event:events[end],startIndex};
}
function replayStages() {
  const events=currentEvents(),intervention=state.view!=='baseline'&&state.result?.intervention;
  const find=predicate=>{const index=events.findIndex(predicate);return {index,event:index<0?null:events[index]};};
  const policy=intervention?find(e=>e.type==='policy_confirmed'):{index:-1,event:null};
  const opening=find(e=>['offer_sent','counteroffer_sent','price_counter','price_counters','offer_accepted','offer_rejected'].includes(e.type));
  const offers=recordedExchange(events,opening.index);
  const repair=intervention&&policy.event?find((e,index)=>index>policy.index&&(opening.index<0||index<opening.index)&&/released|replaced/.test(e.type)&&e.caused_by?.includes(policy.event.id)):{index:-1,event:null};
  const affected=repair.event?repair:{index:policy.index,event:null};
  const final={index:Math.max(0,events.length-1),event:events.at(-1)||null};
  return [
    {id:'starting',title:'Starting agreements',index:-1,event:null,explanation:'Original agreements before your change. These stay fixed as the reference.'},
    {id:'requirement',title:'Revised requirement',...policy,explanation:policy.event?recordedReason(policy.event):'No revised requirement is recorded. Review and apply an instruction to try a change.'},
    {id:'affected',title:'Affected agreement',...affected,explanation:affected.event?recordedReason(affected.event):'No prior agreement was released or directly changed by the policy before negotiation.'},
    {id:'offers',title:'Offers and responses',...offers,explanation:offers.event?`Recorded exchange, steps ${offers.startIndex+1} to ${offers.index+1}. ${eventDescription(offers.event)}`:'No offers or responses were recorded for this run.'},
    {id:'final',title:'Final allocation',...final,explanation:currentRun()?.status==='unresolved'?'The run did not produce a final allocation.':eventDescription(final.event)}
  ];
}
function selectStage(id) {
  const stage=replayStages().find(s=>s.id===id);if(!stage)return;
  stop();state.stage=id;state.index=Math.max(0,stage.index);renderFrame();
}
function selectView(view) {
  if(!state.result)return;
  stop();
  state.view=view;
  state.mapMode='animation';
  // Event indices belong to individual runs; they are not comparable across runs.
  state.stage='final';
  state.causal.clear();
  state.storyFocused=false;
  state.hoveredPair=null;
  state.focusedPair=null;
  rebuildFrames();
  state.index=Math.max(0,currentEvents().length-1);
  render();
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
function recordedReason(event) {
  if(!event)return '';
  const explanations={
    over_budget:"the offer exceeds the buyer's remaining budget",
    over_supply:"the offer exceeds the seller's available energy after reserves and existing agreements",
    over_demand:"the offer exceeds the buyer's remaining energy requirement",
    interval_mismatch:/released/.test(event.type)?'the prior delivery interval no longer fits the revised household windows':'the delivery windows do not overlap',
    deadline_passed:'the last permitted negotiation round has passed',
    price_below_floor:"the price is below the seller's minimum for these delivery terms",
    price_above_max:"the price is above the buyer's maximum",
    bundle_below_minimum:'the quantity is too small for the bundle discount',
    cap_exhausted:'the simulation trading cap has been reached',
    not_improving:'the proposed trade does not improve the household model utility enough',
    responder_not_improving:'the proposed replacement does not improve the responding household model utility enough',
    stale_replacement:'the agreement proposed for replacement is no longer available',
    strategy_exhausted:'the recorded strategy has no further permitted price concession',
    strategy_quote:'the price follows the recorded household strategy',
    accepted_quote:'the quoted terms were accepted after the recorded constraint checks',
    delivery_offer:'the offer uses the recorded household delivery window'
  };
  const reason=event.reason || event.reason_code || '';
  return reason.replace(/[a-z]+(?:_[a-z]+)+/g,code=>explanations[code] || words(code)) || 'No reason recorded.';
}
function homeLabel(id) {
  const a=agentById(id);return a?.name?`${a.name} · ${id}`:id || 'Market';
}
function eventLabel(type) {
  return ({offer_sent:'Offer',counteroffer_sent:'Counteroffer',offer_accepted:'Accepted terms',offer_rejected:'Declined',provisional_reserved:'Tentative agreement',provisional_released:'Agreement released',offer_replaced:'Replacement agreement'})[type] || label(type);
}
function negotiationExplanation(event) {
  if(event.reason_code==='strategy_quote')return `Recorded strategy, quote ${Number(event.strategy_step || 0)+1}: ${agentById(event.actor_id)?.role==='buyer'?'the buyer proposes its next buying price':'the seller proposes its next selling price'}. Prices follow the frozen strategy; no additional motive is recorded.`;
  if(event.reason_code==='accepted_quote')return 'The recorded constraint checks passed and the household accepted these terms. Reservation follows as a separate step.';
  return recordedReason(event);
}
// Compare all agreements for a pair, including multiple delivery windows.
function agreementDifferences(before,after) {
  const pairs=new Set([...before,...after].map(tradeKey));
  return [...pairs].map(key=>{
    const a=before.filter(t=>tradeKey(t)===key),b=after.filter(t=>tradeKey(t)===key);
    if(a.map(signature).sort().join('~')===b.map(signature).sort().join('~'))return null;
    const [seller,buyer]=key.split('|');
    return {key,seller,buyer,before:a,after:b,kind:!a.length?'new':!b.length?'removed':'revised'};
  }).filter(Boolean);
}
function frameDifferences() {
  return state.view!=='baseline'&&state.result?.intervention?agreementDifferences(state.result.baseline.trades || [],frameTrades()):[];
}
function ledgerTerms(trades) {
  return trades.length?trades.map(t=>`${fmt(t.quantity_kwh)} kWh · ₹${fmt(t.price)}/kWh · ${deliveryWindow(t)}`).join('; '):'No agreement';
}
function comparisonTrades() {
  const before=state.result?.baseline?.trades||[],after=frameTrades();
  const differences=new Map(agreementDifferences(before,after).map(d=>[d.key,d]));
  const name=id=>(agentById(id)?.name||id).split(' (')[0];
  return [...new Set([...before,...after].map(tradeKey))].map(key=>{
    const [seller,buyer]=key.split('|'),a=before.filter(t=>tradeKey(t)===key),b=after.filter(t=>tradeKey(t)===key);
    const kind=differences.get(key)?.kind||'unchanged';
    const price=ts=>qty(ts)?ts.reduce((n,t)=>n+Number(t.price)*Number(t.quantity_kwh),0)/qty(ts):null;
    const amount=kind==='unchanged'?`${fmt(qty(b))} kWh`:`${fmt(qty(a))} → ${fmt(qty(b))} kWh`;
    const pa=price(a),pb=price(b),average=a.length>1||b.length>1?'Avg ':'';
    let terms=kind==='removed'?'Agreement removed':kind==='new'?`₹${fmt(pb)}/kWh`:Math.abs(pa-pb)>.000001?`${average}₹${fmt(pa)} → ₹${fmt(pb)}/kWh`:`${average}₹${fmt(pb)}/kWh`;
    const windows=ts=>ts.map(t=>`${t.delivery_start}|${t.delivery_end}`).sort().join('~');
    const windowChanged=a.length&&b.length&&windows(a)!==windows(b);
    if(windowChanged)terms+=' · delivery changed';
    return {key,seller,buyer,kind,before:a,after:b,title:`${name(seller)} → ${name(buyer)}`,lines:[amount,terms],
      color:({removed:'#a14738',revised:'#ae650f',new:'#127568',unchanged:'#315d49'})[kind],
      own:[seller,buyer].includes(state.controlled),focused:state.focusedPair===key,
      description:`${name(seller)} → ${name(buyer)} · ${label(kind)}. Before: ${ledgerTerms(a)}. After: ${ledgerTerms(b)}.`};
  });
}
function comparisonExplanation() {
  const name=(agentById(state.controlled)?.name||state.controlled).split(' (')[0];
  const policy=frameEvents().find(e=>e.type==='policy_confirmed');
  const fields=(policy?.changed_fields||[]).filter(c=>c.agent_id===state.controlled);
  const change=fields.map(c=>`${name}’s ${c.field==='reserve_kwh'?'reserve':(fieldNames[c.field]||words(c.field)).toLowerCase()}: ${policyValue(c.field,c.before)} → ${policyValue(c.field,c.after)}.`).join(' ');
  const own=ts=>ts.filter(t=>t.seller_id===state.controlled||t.buyer_id===state.controlled);
  const before=qty(own(state.result.baseline.trades||[])),after=qty(own(frameTrades()));
  const direction=agentById(state.controlled)?.role==='seller'?'sales':'purchases';
  return `${change}${change?' ':''}${name}’s agreed ${direction}: ${fmt(before)} → ${fmt(after)} kWh.${frameDifferences().length?'':' No agreements changed.'}`;
}
function renderReplayContext() {
  const trades=frameTrades(),diffs=frameDifferences(),event=activeEvent();
  const ended=state.stage==='final'||event?.type==='terminated';
  const policy=state.view!=='baseline'&&state.stage!=='starting'?frameEvents().find(e=>e.type==='policy_confirmed'):null;
  $('policy-strip').hidden=!policy||state.view==='compare';
  $('comparison-note').hidden=state.view!=='compare';
  $('comparison-note').textContent=state.view==='compare'?comparisonExplanation():'';
  $('comparison-key').hidden=state.view!=='compare';
  $('policy-strip').innerHTML=policy?`<strong>Applied change</strong> ${(policy.changed_fields || []).map(c=>`${esc(c.agent_id)} · ${esc(fieldNames[c.field] || label(c.field))}: <b>${esc(policyValue(c.field,c.before))} → ${esc(policyValue(c.field,c.after))}</b>`).join(' · ')}`:'';
  $('graph-caption').textContent=`Selected: ${homeLabel(state.selected)}. Select a home or agreement to inspect it.`;
  $('frame-summary').innerHTML=`<strong>${ended?(state.view==='baseline'?'Original agreements':'At the end'):state.stage==='starting'?'Original agreements':'At this replay step'}: ${fmt(qty(trades))} kWh agreed</strong><span>${trades.length} ${trades.length===1?'agreement':'agreements'}${state.view!=='baseline'&&state.result?.intervention?` · ${diffs.length} ${diffs.length===1?'pair differs':'pairs differ'} from before`:''}</span>`;
  const a=frameWorld()?.agents?.find(a=>a.id===state.selected);
  const homeTrades=trades.filter(t=>t.seller_id===state.selected||t.buyer_id===state.selected);
  const lastDecision=frameEvents().findLast(e=>e.actor_id===state.selected||e.counterparty_id===state.selected);
  $('focus-home').innerHTML=a?`<span class="eyebrow">${frameWorld()===state.result.world?'Original settings':'Settings at this step'}</span><p>${esc(householdAvailability(a,trades))}</p><h4>Firm limits</h4>${boundHTML(a,true)}<div class="bound"><span>Delivery window</span><strong>${esc(deliveryWindow(a))}</strong></div>${a.time_price?`<div class="bound"><span>Later price</span><strong>${esc(policyValue('time_price',a.time_price))}</strong></div>`:''}${a.conditional_price?`<div class="bound"><span>Bundle sensitivity</span><strong>${esc(policyValue('conditional_price',a.conditional_price))}</strong></div>`:''}${preferencesHTML(a)}<h4>Agreements at this step</h4>${homeTrades.length?homeTrades.map(t=>`<div class="bound"><span>${esc(t.seller_id)} → ${esc(t.buyer_id)}</span><strong>${fmt(t.quantity_kwh)} kWh<br>₹${fmt(t.price)}/kWh<br><small>${esc(deliveryWindow(t))}</small></strong></div>`).join(''):'<p>No active agreement at this point.</p>'}<h4>Latest recorded decision</h4><p>${esc(lastDecision?recordedReason(lastDecision):'No decision recorded yet at this replay position.')}</p><small>Private settings shown for research inspection.</small>`:'';
  const box=$('trade-differences');box.hidden=state.view==='baseline'||!state.result?.intervention;
  const ordered=[...diffs].sort((a,b)=>Number([b.seller,b.buyer].includes(state.selected))-Number([a.seller,a.buyer].includes(state.selected)));
  const rows=ordered.map(d=>`<tr><th scope="row"><span class="change-tag ${d.kind}">${label(d.kind)}</span><button class="pair-select" data-home="${esc(d.seller)}" data-pair="${esc(d.key)}">${esc(homeLabel(d.seller))} → ${esc(homeLabel(d.buyer))}</button></th><td>${esc(ledgerTerms(d.before))}</td><td>${esc(ledgerTerms(d.after))}</td></tr>`);
  const table=items=>`<div class="table-scroll"><table><thead><tr><th>Trading pair</th><th>Before</th><th>${ended?'After':'At this step'}</th></tr></thead><tbody>${items.join('')}</tbody></table></div>`;
  box.innerHTML=`<h3>What changed ${ended?'by the end':'at this step'}?</h3><p class="helper">Compared with the original agreements. Select a pair to highlight it.</p>${rows.length?table(rows.slice(0,3))+(rows.length>3?`<details><summary>Show ${rows.length-3} more changed pairs</summary>${table(rows.slice(3))}</details>`:''):'<p>No agreement differences at this step.</p>'}`;
  box.querySelectorAll('[data-home]').forEach(b=>b.onclick=()=>{state.selected=b.dataset.home;state.focusedPair=b.dataset.pair;state.storyFocused=false;renderFrame();});
}
function renderImpactSummary() {
  if(state.result?.intervention?.status==='unresolved'){$('impact-summary').innerHTML='';return;}
  const rows=householdChanges().filter(r=>Math.abs(r.energy)>.000001||Math.abs(r.payment)>.000001);
  const signed=n=>`${n>0?'+':''}${fmt(n)}`;
  rows.sort((a,b)=>Number(b.id===state.controlled)-Number(a.id===state.controlled)||Math.abs(b.energy)-Math.abs(a.energy)||Math.abs(b.payment)-Math.abs(a.payment));
  $('impact-summary').innerHTML=rows.length?`<h3>Household impact · final comparison</h3><div class="impact-cards">${rows.slice(0,3).map(r=>`<article><strong>${esc(homeLabel(r.id))}</strong><p>${signed(r.energy)} kWh ${r.role==='seller'?'sold':'bought'}</p><small>${signed(r.payment)} rupees ${r.role==='seller'?'received':'spent'}</small></article>`).join('')}</div><p class="helper">Payment changes reflect both quantity and price. Lower spending alone does not mean a household is better off. All homes are listed in detailed results.</p>`:'';
}
function quoteNumber(value) {return Number(value).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:8});}
function sensitivityHTML(sensitivity) {
  if(!sensitivity?.rules.length)return '';
  const rules=sensitivity.rules.map(rule=>rule.kind==='quantity'
    ? `₹${quoteNumber(rule.floor)}/kWh for at least ${quoteNumber(rule.minimum_kwh)} kWh`
    : `₹${quoteNumber(rule.floor)}/kWh after ${timestamp(rule.after)}`);
  return `<details class="message-policy"><summary>Why this price can change</summary><p>Seller's rule at this step, separate from the message:</p>${sensitivity.rules.map((rule,i)=>`<p>${esc(rules[i])}. <strong>${rule.eligible===null?(rule.kind==='time'?'Delivery time was not recorded, so eligibility is unknown.':'Quantity was not recorded, so eligibility is unknown.'):rule.eligible?'These terms qualify.':'These terms do not qualify.'}</strong></p>`).join('')}${sensitivity.floor===null?'<p>The applicable minimum cannot be determined from this event.</p>':`<p>Minimum allowed for these terms: ₹${quoteNumber(sensitivity.floor)}/kWh.${sensitivity.discounted?' This recorded price is below the regular minimum.':' A qualifying rule does not mean a discount was used.'}</p>`}</details>`;
}
function negotiationHTML(event) {
  const n=event.negotiation;if(n?.version!==1)return '';
  const previous=n.previous_terms,terms=event.trade || event,changes=Array.isArray(n.changed)?n.changed:[],badges=[];
  const changed=field=>changes.includes(field);
  if(previous&&changed('price')&&previous.price!=null&&terms.price!=null&&previous.price!==terms.price)badges.push(`₹${quoteNumber(previous.price)} → ₹${quoteNumber(terms.price)}/kWh`);
  if(previous&&changed('quantity')&&previous.quantity_kwh!=null&&terms.quantity_kwh!=null&&previous.quantity_kwh!==terms.quantity_kwh)badges.push(`${quoteNumber(previous.quantity_kwh)} → ${quoteNumber(terms.quantity_kwh)} kWh`);
  if(previous&&changed('delivery')&&(previous.delivery_start!==terms.delivery_start||previous.delivery_end!==terms.delivery_end))badges.push('Different time');
  const compromises=Array.isArray(n.compromises)?n.compromises:[];
  for(const [field,name] of [['delivery','time'],['quantity','amount']])if(compromises.includes(field))badges.push(n.kind==='accept'?`Accepted a different ${name}`:`Flexible on ${name}`);
  let detail='';
  if(previous&&n.kind==='counter')detail+=`<p><strong>Previous offer</strong><br>${esc(eventTerms(previous))}</p><p><strong>New offer</strong><br>${esc(eventTerms(event))}</p>`;
  if(n.kind==='counter'&&n.same_terms_quote!=null)detail+=`<p>At this same bargaining step, this home's quote for the previous time and amount would be ₹${quoteNumber(n.same_terms_quote)}/kWh.</p>`;
  if(n.preference_cost>0)detail+=`<p>Modeled preference cost: ₹${fmt(n.preference_cost)} for this offer. This adjusts the home's satisfaction with the deal; it is not an extra payment.</p>`;
  return `${badges.length?`<div class="negotiation-changes" aria-label="Offer changes and compromises">${badges.map(b=>`<span>${esc(b)}</span>`).join('')}</div>`:''}${detail?`<details class="message-policy"><summary>Why this offer</summary>${detail}</details>`:''}`;
}
function historyEntry(card) {
  const t=card.terms,terms=[t.quantity_kwh!=null?`${quoteNumber(t.quantity_kwh)} kWh`:'',t.price!=null?`₹${quoteNumber(t.price)}/kWh`:''].filter(Boolean);
  return `<article class="conversation-entry" tabindex="0" data-message="${card.index}" data-participants="${esc(card.actor)}|${esc(card.counterparty)}" style="--agent-color:${EnergyReplay.color(card.actor)}" aria-label="${esc(homeLabel(card.actor))} to ${esc(homeLabel(card.counterparty))}, ${esc(eventLabel(card.type))}"><div class="message-meta"><span>Step ${card.index+1} · Round ${card.event.round ?? 0}</span><b>${esc(eventLabel(card.type))}</b></div><strong class="message-parties"><span style="color:${EnergyReplay.color(card.actor)}">${esc(homeLabel(card.actor))}</span> → <span style="color:${EnergyReplay.color(card.counterparty)}">${esc(homeLabel(card.counterparty))}</span></strong>${terms.length?`<p class="message-terms">${terms.map(esc).join(' at ')}</p>`:''}${t.delivery_start&&t.delivery_end?`<p class="message-delivery">${esc(deliveryWindow(t))}</p>`:''}<p class="message-reason">${esc(negotiationExplanation(card.event))}</p>${negotiationHTML(card.event)}${sensitivityHTML(card.sensitivity)}</article>`;
}
const storyKinds={disrupted:'Existing agreement disrupted',renegotiated:'Agreement renegotiated',replacement:'Replacement sought',other:'Other trading opportunities'};
function storyConsequence(story) {
  if(story.kind==='disrupted')return `Released ${fmt(qty(story.cards.map(c=>c.terms)))} kWh. ${recordedReason(story.last.event)}`;
  const trades=frameTrades().filter(t=>t.seller_id===story.seller&&t.buyer_id===story.buyer);
  const amount=qty(trades),before=qty(story.before),buyer=frameWorld()?.agents?.find(a=>a.id===story.buyer);
  const bought=qty(frameTrades().filter(t=>t.buyer_id===story.buyer));
  const shortage=buyer?Math.max(0,Number(buyer.demand_kwh)-bought):null;
  const attempt=story.outcome==='Declined'?'This attempt was declined. ':'';
  const consequence=amount?`${story.outcome==='Declined'?'Other attempts left this pair with':'This pair now has'} ${fmt(amount)} kWh agreed${before?` (originally ${fmt(before)} kWh)`:''}.`:'No energy agreement with this seller at this step.';
  return attempt+consequence+(shortage!==null?` ${homeLabel(story.buyer)} still needs ${fmt(shortage)} kWh across the market.`:'');
}
function renderStories() {
  const box=$('negotiation-stories'),detail=$('story-detail');
  const intervention=state.view==='intervention'&&state.stage!=='starting'&&state.result?.intervention;
  box.hidden=!intervention;detail.hidden=!intervention;
  if(!intervention){state.storyFocused=false;state.story=null;state.storyId=null;state.storyMarkup=null;return;}
  const cards=EnergyReplay.visible(state.history?.cards || EnergyReplay.messages(currentEvents(),state.result.world,state.result.updated_world),state.index);
  const stories=EnergyReplay.stories(cards,state.result.baseline.trades,agents());
  if(!stories.some(s=>s.kind===state.storyKind))state.storyKind=stories[0]?.kind;
  if(!stories.some(s=>s.id===state.storyId&&s.kind===state.storyKind))state.storyId=stories.find(s=>s.kind===state.storyKind)?.id;
  state.story=stories.find(s=>s.id===state.storyId)||null;
  const html=`<div class="story-heading"><div><span class="eyebrow">FOLLOW THE CHANGE</span><h3>What did the homes try?</h3></div><span>${stories.length} conversations through this step</span></div><p class="helper">Select a conversation to see its messages and highlight the homes. Declined attempts stay visible after playback.</p><div class="story-tabs" role="group" aria-label="Conversation purpose">${Object.entries(storyKinds).map(([kind,title])=>`<button type="button" data-story-kind="${kind}" aria-pressed="${state.storyKind===kind}" ${stories.some(s=>s.kind===kind)?'':'disabled'}>${title} <b>${stories.filter(s=>s.kind===kind).length}</b></button>`).join('')}</div><div class="story-groups">${Object.entries(storyKinds).map(([kind,title])=>{
    const group=stories.filter(s=>s.kind===kind);if(!group.length||kind!==state.storyKind)return '';
    const buttons=group.map(s=>`<button class="story-card ${s.id===state.storyId?'selected':''}" type="button" data-story="${esc(s.id)}" aria-pressed="${s.id===state.storyId}"><span class="story-status ${s.outcome==='Declined'?'declined':''}">${esc(s.outcome)}</span><strong>${esc(homeLabel(s.buyer))} ↔ ${esc(homeLabel(s.seller))}</strong><span>${s.kind==='disrupted'?`${fmt(qty(s.cards.map(c=>c.terms)))} kWh released`:esc(eventTerms(s.last.event))}</span><small>${s.attempts>1?`${s.attempts} attempts · `:''}${s.cards.length} recorded ${s.cards.length===1?'event':'events'} · ${s.dimensions.length?s.dimensions.map(d=>({delivery:'time',quantity:'quantity',price:'price'}[d]||d)).join(', ')+' changed':'offered terms'}</small></button>`);
    return `<section class="story-group"><h4>${title} <span>${group.length}</span></h4>${buttons.slice(0,2).join('')}${buttons.length>2?`<details><summary>${buttons.length-2} more conversations</summary>${buttons.slice(2).join('')}</details>`:''}</section>`;
  }).join('')}</div>${!stories.length?'<p>No negotiations yet at this replay step.</p>':''}`;
  if(html!==state.storyMarkup){
    const expanded=[...box.querySelectorAll('details[open]')].map(d=>d.parentElement.querySelector('h4')?.textContent);
    const focused=document.activeElement?.dataset?.story,focusedKind=document.activeElement?.dataset?.storyKind;
    box.innerHTML=html;state.storyMarkup=html;
    box.querySelectorAll('details').forEach(d=>{d.open=expanded.includes(d.parentElement.querySelector('h4')?.textContent);});
    box.querySelectorAll('[data-story-kind]').forEach(b=>{b.onclick=()=>{stop();state.storyKind=b.dataset.storyKind;selectStory(null);};if(b.dataset.storyKind===focusedKind)b.focus();});
    box.querySelectorAll('[data-story]').forEach(b=>{b.onclick=()=>selectStory(b.dataset.story);if(b.dataset.story===focused)b.focus();});
  }
  const s=state.story;if(!s){detail.innerHTML='<p>Messages will appear here as the simulation proceeds.</p>';state.storyDetailMarkup=null;state.storyDetailId=null;return;}
  const explanation=s.kind==='disrupted'?'An existing agreement was released during this run. The recorded reason appears below.':s.kind==='renegotiated'?'These homes had an original agreement and exchanged terms again.':s.kind==='replacement'?'After this buyer had an agreement released, these homes explored a new trade.':'These homes explored a trade during this run.';
  const detailHTML=`<span class="eyebrow">${esc(storyKinds[s.kind])}</span><h3>${esc(homeLabel(s.buyer))} ↔ ${esc(homeLabel(s.seller))}</h3><p>${explanation}</p><div class="story-consequence"><strong>${esc(s.outcome)}</strong><p>${esc(storyConsequence(s))}</p></div><p class="helper">Recorded offers below show quantity, price and delivery time. A declined offer is not an energy trade.</p><details class="story-messages"><summary>Read ${s.cards.length} recorded messages</summary>${s.cards.map(historyEntry).join('')}</details>`;
  if(detailHTML!==state.storyDetailMarkup){const open=state.storyDetailId===s.id&&detail.querySelector?.('details')?.open;detail.innerHTML=detailHTML;const messages=detail.querySelector?.('details');if(messages)messages.open=!!open;state.storyDetailMarkup=detailHTML;state.storyDetailId=s.id;}
}
function selectStory(id) {
  stop();state.storyId=id;state.storyFocused=true;state.hoveredPair=null;state.mapMode='agreements';
  renderStories();
  if(state.story){state.selected=state.story.buyer;state.focusedPair=`${state.story.seller}|${state.story.buyer}`;$('inspect-select').value=state.selected;}
  renderFrame();$('graph-wrap').scrollIntoView?.({block:'start',behavior:'smooth'});
}
function renderConversation() {
  const box=$('conversation'),event=activeEvent(),events=state.stage==='starting'?state.result.baseline.events:currentEvents();
  const index=state.stage==='starting'?events.length-1:state.index;
  const changedRun=state.history?.events!==events;
  if(changedRun){state.history={events,cards:EnergyReplay.messages(events,state.result.world,state.stage==='starting'||state.view==='baseline'?null:state.result.updated_world),count:0,index:-1};state.followLatest=true;state.hoveredPair=null;}
  const scope=state.messageScope==='all'?'all':state.controlled;
  $('messages-own').textContent=`${(agentById(state.controlled)?.name||state.controlled).split(' (')[0]}’s interactions`;
  const scopeChanged=state.history.scope!==scope;
  const cards=EnergyReplay.visible(state.history.cards,index).filter(c=>scope==='all'||c.actor===scope||c.counterparty===scope),oldScroll=box.scrollTop || 0;
  const reset=changedRun||scopeChanged||index<state.history.index;
  if(reset){
    box.innerHTML='<div class="history-heading"><strong>Chronological order</strong><button id="follow-latest" type="button">Following latest</button></div><p class="history-help">Hover or focus a message to find both homes. Scroll up to read earlier messages.</p><div id="conversation-summary" class="conversation-summary"></div>';
    state.history.count=0;
  }
  if(cards.length>state.history.count)box.insertAdjacentHTML('beforeend',cards.slice(state.history.count).map(historyEntry).join(''));
  state.history.count=cards.length;state.history.index=index;state.history.scope=scope;
  $('conversation-summary').innerHTML=event?.type==='terminated'?`<h3>Final allocation</h3><p>${esc(eventDescription(event))} ${cards.length} recorded messages match this filter.</p>`:event?.type==='policy_confirmed'?`<h3>Revised requirement</h3>${(event.changed_fields || []).map(c=>`<p>${esc(fieldNames[c.field]||label(c.field))}: ${esc(policyValue(c.field,c.before))} → ${esc(policyValue(c.field,c.after))}</p>`).join('')}`:!cards.length?'<p>No interactions match this filter at this step. Continue the replay or choose All interactions.</p>':'';
  box.scrollTop=state.followLatest?box.scrollHeight:scopeChanged?0:oldScroll;
  $('follow-latest').textContent=state.followLatest?'Following latest':'Follow latest ↓';
  $('follow-latest').onclick=()=>{state.followLatest=true;box.scrollTop=box.scrollHeight;$('follow-latest').textContent='Following latest';};
  box.onscroll=()=>{state.followLatest=box.scrollHeight-box.scrollTop-box.clientHeight<50;$('follow-latest').textContent=state.followLatest?'Following latest':'Follow latest ↓';};
}
function bindHistory(box) {
  const participants=target=>target?.closest?.('[data-participants]')?.dataset.participants.split('|');
  box.onmouseover=e=>{const pair=participants(e.target);if(pair&&!participants(document.activeElement))highlightMessage(pair);};
  box.onpointermove=e=>{const pair=participants(e.target);if(pair)highlightMessage(pair);};
  box.onmouseout=e=>{if(!participants(e.relatedTarget))highlightMessage(participants(document.activeElement)||null);};
  box.addEventListener('focusin',e=>{const pair=participants(e.target);if(pair){state.followLatest=false;highlightMessage(pair);}});
  box.addEventListener('focusout',e=>{if(!participants(e.relatedTarget))highlightMessage(null);});
}
function highlightMessage(pair) {state.hoveredPair=pair;updateTown();if(!state.town||state.view==='compare'||state.mapMode==='agreements')drawReplayGraphs();}
function updateTown() {
  if(!state.result)return;
  const starting=state.stage==='starting',events=starting?state.result.baseline.events:currentEvents(),event=activeEvent();
  if(!state.town&&typeof window!=='undefined'&&window.EnergyTown)state.town=window.EnergyTown.mount($('energy-town'),{
    onIndex(index){if(!state.townPlaying)return;state.index=index;renderFrame();},
    onStop(){stop();},
    onSelect(id){state.selected=id;state.focusedPair=null;state.storyFocused=false;$('inspect-select').value=id;renderFrame();},
    onPair(pair){state.focusedPair=pair;state.selected=pair.split('|')[0];state.storyFocused=false;$('inspect-select').value=state.selected;renderFrame();}
  });
  const showTown=!!state.town&&state.mapMode!=='agreements';
  $('energy-town').hidden=!showTown;$('graph').toggleAttribute('hidden',showTown);
  $('town-legend').hidden=!showTown||state.view==='compare';
  $('graph-wrap').classList.toggle('town-mode',showTown);
  state.town?.update({events,agents:state.result.world.agents,index:starting?events.length-1:state.index,playing:!!state.townPlaying&&!starting&&showTown,speed:1,
    selected:state.selected,controlled:state.controlled,trades:frameTrades(),comparison:state.view==='compare'?comparisonTrades():null,highlighted:state.hoveredPair || (state.causal.size?[...new Set(events.filter(e=>state.causal.has(e.id)).flatMap(e=>[e.actor_id,e.counterparty_id]).filter(Boolean))]:[event?.actor_id,event?.counterparty_id].filter(Boolean))});
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
  renderStages();renderConversation();renderStories();renderReplayContext();
  $('back').disabled=state.index===0; $('next').disabled=state.index>=events.length-1;
  $('graph-wrap').classList.toggle('comparing',state.view==='compare');
  updateTown();drawReplayGraphs();
  renderInspector(); renderDecisionAudit(); renderLog();
}
function drawReplayGraphs() {
  const event=activeEvent();
  if(!state.town||state.mapMode==='agreements')drawGraph($('graph'),frameTrades(),event,state.view==='compare'?'Before → After':state.view==='baseline'?'Before':state.stage==='starting'?'Original agreements':event?.type==='terminated'||state.stage==='final'?'After · final agreements':'After · at this step');
}
function eventDescription(event) {
  if(!event)return 'Each shape is a home. Lines show their energy agreements.';
  if(event.type==='terminated'){
    const run=currentRun();
    if(run?.status==='locally_stable')return 'No further trade was found under these rules.';
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
function clusterCenter(cluster) {
  const theta=-Math.PI/2+cluster*2*Math.PI/5;
  return {x:440+300*Math.cos(theta),y:310+170*Math.sin(theta),theta};
}
function positions() {
  const map=new Map(),list=agents(),clusters=5;
  list.forEach((a,i)=>{
    const cluster=i%clusters,members=Math.ceil((list.length-cluster)/clusters),item=Math.floor(i/clusters),center=clusterCenter(cluster);
    const angle=item*2*Math.PI/members+center.theta*.2,r=members>10?96:88,offset=state.nodeOffsets[a.id]||{x:0,y:0};
    map.set(a.id,{x:center.x+r*Math.cos(angle)+offset.x,y:center.y+r*Math.sin(angle)+offset.y});
  });
  return map;
}
function labelPositions(points,font) {
  const placed=[],labels=new Map(),overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  const nodes=[...points.values()].map(point=>({left:point.x-18,right:point.x+18,top:point.y-18,bottom:point.y+18}));
  for(const [id,point] of points) {
    const candidates=[[0,40],[0,-26],[42,6],[-42,6]];
    for(const radius of [38,50,62])for(let step=0;step<16;step++){const angle=Math.PI/2+step*Math.PI/8;candidates.push([radius*Math.cos(angle),radius*Math.sin(angle)+font*.375]);}
    let chosen;
    for(const [x,y] of candidates) {
      const half=id.length*font*.35+2,box={left:point.x+x-half,right:point.x+x+half,top:point.y+y-font-2,bottom:point.y+y+font*.25+2};
      if(box.left<8||box.right>872||box.top<35||box.bottom>582||nodes.some(node=>overlaps(box,node))||placed.some(label=>overlaps(box,label)))continue;
      chosen={x,y};placed.push(box);break;
    }
    labels.set(id,chosen || {x:0,y:40});
  }
  return labels;
}
function drawGraph(svg,trades,event,caption,world=frameWorld()) {
  svg.replaceChildren();
  const diffs=frameDifferences(),diffMap=new Map(diffs.map(d=>[d.key,d]));
  const pos=positions(),delta={affected:new Set(diffs.flatMap(d=>[d.seller,d.buyer]))};
  const markerPrefix=svg.id || (svg===$('compare-graph')?'comparison':'main');
  const defs=svgEl('defs',{},svg);
  for(const [name,color] of [['agreement','#527a59'],['message','#79548f'],['release','#a14738'],['new','#127568'],['revised','#ae650f']]) {
    const marker=svgEl('marker',{id:`${markerPrefix}-${name}`,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse',markerUnits:'strokeWidth'},defs);
    svgEl('path',{d:'M0 0 L10 5 L0 10 Z',fill:color},marker);
  }
  const root=svgEl('g',{transform:`translate(${state.pan.x} ${state.pan.y}) translate(440 300) scale(${state.zoom}) translate(-440 -300)`},svg);
  const textScale=Math.max(.4,Math.min((svg.clientWidth||880)/880,(svg.clientHeight||610)/610)),labels=labelPositions(pos,11/textScale);
  svgEl('text',{x:440,y:25,'text-anchor':'middle',fill:'#4c624c','font-size':14/textScale},root,caption);
  for(let c=0;c<5;c++){const center=clusterCenter(c);svgEl('circle',{cx:center.x,cy:center.y,r:agents().length>50?112:108,fill:'none',stroke:'#e4e9dc','stroke-dasharray':'3 6'},root);}
  const edges=svgEl('g',{},root),nodes=svgEl('g',{},root);
  function edge(from,to,attrs={}) {
    const a=pos.get(from),b=pos.get(to);if(!a||!b)return;
    const length=Math.hypot(b.x-a.x,b.y-a.y)||1,dx=(b.x-a.x)/length,dy=(b.y-a.y)/length;
    return svgEl('path',{d:`M${a.x+dx*20},${a.y+dy*20} Q${(a.x+b.x)/2+18},${(a.y+b.y)/2-18} ${b.x-dx*23},${b.y-dy*23}`,fill:'none',...attrs},edges);
  }
  const story=state.storyFocused?state.story:null;
  const original=svg===$('compare-graph'),showDiffs=state.view!=='baseline'&&!!state.result?.intervention;
  if(showDiffs&&!original)for(const d of diffs.filter(d=>d.kind==='removed'))edge(d.seller,d.buyer,{stroke:'#a14738','stroke-width':3,'stroke-dasharray':'6 5',opacity:.8,'marker-end':`url(#${markerPrefix}-release)`,'aria-label':`${d.seller} to ${d.buyer}: removed agreement`});
  for(const t of trades) {
    const difference=diffMap.get(tradeKey(t)),kind=difference?.kind;
    const active=[t.seller_id,t.buyer_id].includes(state.selected);
    const own=[t.seller_id,t.buyer_id].includes(state.controlled);
    const description=`${t.seller_id} → ${t.buyer_id}: ${fmt(t.quantity_kwh)} kWh at ₹${fmt(t.price)}/kWh · ${deliveryWindow(t)}`;
    const path=edge(t.seller_id,t.buyer_id,{stroke:kind==='removed'?'#a14738':kind==='revised'?'#ae650f':kind==='new'?'#127568':active?'#315d49':'#a6b995','stroke-width':kind?3.5:active?2.5:1,'stroke-dasharray':kind==='removed'?'6 5':'none',opacity:(story&&state.mapMode==='agreements'&&!original)? .15 :(kind || active) ? .95 : showDiffs ? .18 : .55,'marker-end':`url(#${markerPrefix}-${kind==='removed'?'release':kind==='new'?'new':kind==='revised'?'revised':'agreement'})`,class:'trade-edge',tabindex:0,role:'button','aria-label':description});
    if(path) {
      if(own){path.setAttribute('stroke-width','4.5');path.setAttribute('opacity','1');path.setAttribute('data-own-agreement','true');}
      svgEl('title',{},path,description);
      const inspect=()=>{state.selected=t.seller_id;state.focusedPair=tradeKey(t);state.storyFocused=false;$('inspect-select').value=state.selected;notify(description);renderFrame();};
      path.addEventListener('click',inspect);path.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();inspect();}});
    }
  }
  const focused=diffs.find(d=>d.key===state.focusedPair)||diffs.find(d=>[d.seller,d.buyer].includes(state.selected));
  if(focused&&state.view!=='compare'&&!(story&&state.mapMode==='agreements'&&!original)) {
    const p=pos.get(focused.seller),q=pos.get(focused.buyer);
    if(p&&q){const x=(p.x+q.x)/2+18,y=(p.y+q.y)/2-18;
      // Payments are rounded totals; use recorded quotes for unit prices.
      const quotedPrice=trades=>trades.reduce((n,t)=>n+Number(t.price)*Number(t.quantity_kwh),0)/qty(trades);
      const beforePrice=quotedPrice(focused.before),afterPrice=quotedPrice(focused.after);
      const change=qty(focused.before)!==qty(focused.after)?`${fmt(qty(focused.before))} → ${fmt(qty(focused.after))} kWh`:Math.abs(beforePrice-afterPrice)>.000001?`${focused.before.length>1||focused.after.length>1?'Avg ':''}₹${fmt(beforePrice)} → ₹${fmt(afterPrice)}/kWh`:'Agreement terms revised';
      const text=original?`${focused.seller} → ${focused.buyer}: ${fmt(qty(focused.before))} kWh`:`${focused.seller} → ${focused.buyer}: ${change}`;
      const width=Math.min(820,(text.length*6.7+20)/textScale),height=28/textScale,cx=Math.max(width/2+12,Math.min(868-width/2,x));
      const tag=svgEl('g',{'pointer-events':'none'},root);
      svgEl('rect',{x:cx-width/2,y:y-height*.65,width,height,rx:7,fill:'#fffef9',stroke:'#ae650f'},tag);
      svgEl('text',{x:cx,y:y+3/textScale,'text-anchor':'middle','font-size':12/textScale,fill:'#704307','font-weight':700},tag,text);
    }
  }
  const highlighted=state.causal.size?[...state.result.baseline.events,...(state.result.intervention?.events||[])].filter(e=>state.causal.has(e.id)):[event].filter(Boolean);
  for(const e of highlighted) {
    const message=/offer_sent|counteroffer_sent|price_counter|offer_accepted|offer_rejected/.test(e.type),release=/reject|release/.test(e.type),agreement=/reserved|replaced/.test(e.type);
    if(!message&&!release&&!agreement)continue;
    const kind=release?'release':message?'message':'agreement';
    edge(e.actor_id,e.counterparty_id,{stroke:release?'#a14738':message?'#79548f':'#315d49','stroke-width':2.5,'stroke-dasharray':message?'7 5':release?'3 4':'none','marker-end':`url(#${markerPrefix}-${kind})`,class:`event-edge ${message?'message-edge':release?'event-release':'event-accept'}`,opacity:.95});
  }
  if(story&&!original&&state.mapMode==='agreements'){
    const c=story.cards?.findLast(c=>['offer_sent','counteroffer_sent','offer_accepted','offer_rejected'].includes(c.type)) || story.last,p=pos.get(c.actor),q=pos.get(c.counterparty);
    const overlayLabel=story.outcome==='Agreement recorded'&&c.type==='offer_accepted'?'Accepted terms':story.outcome;
    edge(c.actor,c.counterparty,{stroke:'#79548f','stroke-width':4,'stroke-dasharray':'8 6','marker-end':`url(#${markerPrefix}-message)`,class:'story-message-edge','aria-label':`${c.actor} to ${c.counterparty}: ${overlayLabel}, ${fmt(c.terms.quantity_kwh)} kWh`});
    if(p&&q){const text=`${overlayLabel} · ${fmt(c.terms.quantity_kwh)} kWh`,width=(text.length*6.7+20)/textScale,x=Math.max(width/2+12,Math.min(868-width/2,(p.x+q.x)/2)),y=(p.y+q.y)/2-48;
      svgEl('rect',{x:x-width/2,y:y-20/textScale,width,height:28/textScale,rx:7,fill:'#fbf5ff',stroke:'#79548f'},root);
      svgEl('text',{x,y,'text-anchor':'middle','font-size':12/textScale,fill:'#613677','font-weight':700},root,text);
    }
  }
  const activeParties=new Set(state.hoveredPair || (story&&state.mapMode==='agreements'?[story.seller,story.buyer]:[event?.actor_id,event?.counterparty_id]));
  for(const a of world?.agents || []) {
    const point=pos.get(a.id);if(!point)continue;
    const affected=delta.affected.has(a.id),selected=a.id===state.selected,own=a.id===state.controlled,active=activeParties.has(a.id);
    const dim=!!((state.hoveredPair||(story&&state.mapMode==='agreements'))&&!active);
    const availability=householdAvailability(a,trades);
    const g=svgEl('g',{transform:`translate(${point.x} ${point.y})`,class:`node${affected?' changed-node':''}${active?' active-party':''}${own?' controlled-node':''}${selected?' inspected-node':''}`,'data-agent':a.id,tabindex:0,role:'button','aria-label':`Inspect ${a.id}, ${a.name || ''}, ${a.role}. ${availability}${affected?', affected':''}`,opacity:dim?.15:1},nodes);
    if(active)svgEl('circle',{r:28,fill:'#ede4f3',stroke:'#79548f','stroke-width':1.5},g);
    if(own)svgEl('circle',{r:20,fill:'none',stroke:'#40654d','stroke-width':2},g);
    if(selected)svgEl('circle',{r:24,fill:'none',stroke:'#254936','stroke-width':1.5,'stroke-dasharray':'3 3'},g);
    const attrs={fill:EnergyReplay.color(a.id),stroke:affected?'#ae650f':'#fffef9','stroke-width':affected?3:2,class:'node-shape'},radius=agents().length<=50?14:10;
    if(a.role==='seller')svgEl('circle',{r:radius,...attrs},g);else svgEl('rect',{x:-radius,y:-radius,width:radius*2,height:radius*2,rx:5,...attrs},g);
    if(own)svgEl('text',{'text-anchor':'middle',y:3,fill:'white','font-size':9,'font-weight':600},g,'✦');
    svgEl('text',{'text-anchor':'middle',...labels.get(a.id),fill:'#314b36','font-size':11/textScale,'font-weight':own?700:500,class:'node-label'},g,a.id);
    svgEl('title',{},g,`${a.id} · ${a.name || 'Home'} · ${a.role} · ${availability}`);
    const inspect=()=>{state.selected=a.id;state.focusedPair=null;state.storyFocused=false;$('inspect-select').value=a.id;renderFrame();};
    g.addEventListener('click',inspect);g.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();inspect();}});
  }
  if(state.view==='compare')for(const l of EnergyReplay.comparisonLabels(comparisonTrades(),pos,textScale,{left:0,right:880})) {
    const tag=svgEl('g',{class:'comparison-label','pointer-events':'none','aria-label':l.description},root);
    svgEl('path',{d:`M${l.anchor.x} ${l.anchor.y} L${l.x} ${l.y}`,stroke:l.color},tag);
    svgEl('rect',{x:l.x-l.width/2,y:l.y-l.height/2,width:l.width,height:l.height,rx:6/textScale,fill:'#fffef9',stroke:l.color},tag);
    [l.title,...l.lines].forEach((line,i)=>svgEl('text',{x:l.x,y:l.y+(i-1)*17/textScale+4/textScale,'text-anchor':'middle','font-size':12/textScale,fill:l.color,'font-weight':i===0?700:500},tag,line));
  }
  for(const l of state.view==='compare'?[]:EnergyReplay.agreementLabels(trades,state.controlled,world?.agents||[],pos,textScale,{left:0,right:880})){
    const tag=svgEl('g',{class:'own-agreement-label','pointer-events':'none','aria-label':`${l.title}: ${l.terms}`},root);
    svgEl('path',{d:`M${l.anchor.x} ${l.anchor.y} L${l.x} ${l.y}`,stroke:'#315d49','stroke-width':1/textScale},tag);
    svgEl('rect',{x:l.x-l.width/2,y:l.y-l.height/2,width:l.width,height:l.height,rx:6/textScale,fill:'#fffef9',stroke:'#315d49','stroke-width':1.5/textScale},tag);
    svgEl('text',{x:l.x,y:l.y-5/textScale,'text-anchor':'middle','font-size':12/textScale,'font-weight':700,fill:'#264b38'},tag,l.title);
    svgEl('text',{x:l.x,y:l.y+12/textScale,'text-anchor':'middle','font-size':12/textScale,fill:'#264b38'},tag,l.terms);
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
  const a=frameWorld()?.agents?.find(agent=>agent.id===state.selected); if(!a)return;
  const relevant=frameEvents().filter(e=>e.actor_id===a.id||e.counterparty_id===a.id),last=relevant.at(-1);
  let memory=a.memory || [];
  if(!Array.isArray(memory))memory=Object.entries(memory).map(([id,text])=>({id,text}));
  $('inspection').innerHTML=`<h3>${esc(homeLabel(a.id))}</h3><p class="helper">${frameWorld()===state.result.world?'Original settings':'Settings at this replay step'}</p><h4>Recorded rule checks</h4>${last?.rule_checks?`<p>${esc(Array.isArray(last.rule_checks)?last.rule_checks.join(', '):JSON.stringify(last.rule_checks))}</p>`:'<p>No rule checks recorded on the latest event.</p>'}<details><summary>Private context & memory (${memory.length})</summary><div class="private">Research inspection only. Private context is not shared in agent messages.</div><p>${esc(typeof a.context==='string'?a.context:JSON.stringify(a.context))}</p>${memory.map(m=>`<div class="memory-record">${esc(m.text || m.content || JSON.stringify(m))}<small>Source ${esc(m.id || m.record_id || 'synthetic memory')} · ${state.config.memory_enabled?'Retrieval enabled':'Retrieval disabled'}</small>${m.preference?.type==='preferred_counterparty'?`<small>Soft preference: ${esc(m.preference.agent_id)} wins equal-value ties</small>`:''}</div>`).join('')}<p class="muted small">Memory can rank feasible alternatives. It cannot override a hard constraint.</p></details>`;
}
function renderDecisionAudit() {
  const a=frameWorld()?.agents?.find(agent=>agent.id===state.selected);if(!a)return;
  const relevant=frameEvents().filter(e=>e.actor_id===a.id||e.counterparty_id===a.id);
  const decision=relevant.findLast(e=>e.utility_before&&a.id in e.utility_before),offer=relevant.at(-1);
  const retrieved=relevant.filter(e=>e.type==='profile_retrieved'&&e.actor_id===a.id);
  let html='';
  if(decision)html+=`<h4>Last allocation decision</h4><p>${esc(recordedReason(decision))}</p><div class="bound"><span>Utility before</span><strong>₹${fmt(decision.utility_before[a.id])}</strong></div><div class="bound"><span>Utility after</span><strong>₹${fmt(decision.utility_after[a.id])}</strong></div><p class="muted small">${esc(decision.id)} · Round ${decision.round}<br>${esc((decision.rule_checks||[]).map(words).join(', '))}</p>`;
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
  const comparison=state.result?.method_comparison,view=state.view==='baseline'||!state.result?.intervention?'baseline':'intervention';
  const pair=comparison?.[view],available=!!(pair?.bargaining&&pair?.midpoint);
  $('method-comparison').hidden=!available;
  $('method-comparison-table').innerHTML='';
  if(available) {
    const measures=[['Energy agreed','committed_kwh',' kWh'],['Unfilled demand','unfilled_demand_kwh',' kWh'],['Simulated payments','payments',' INR'],['Negotiation messages','message_count','']];
    $('method-comparison-title').textContent=`Same world, two methods${view==='intervention'?' after your change':' before your change'}`;
    $('method-comparison-context').textContent='Both methods use the same household profiles and delivery windows. Each method forms its own initial allocation before applying your change.';
    $('method-comparison-table').innerHTML=measures.map(([name,key,unit])=>`<tr><th scope="row">${name}</th><td>${fmt(pair.bargaining[key],key==='message_count'?0:2)}${unit}</td><td>${fmt(pair.midpoint[key],key==='message_count'?0:2)}${unit}</td></tr>`).join('');
    $('method-comparison-note').textContent=comparison.note || '';
    $('method-world-checksum').textContent=`Shared world checksum: ${comparison.world_checksum || 'not recorded'}`;
  }
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
    if(result.clarification_questions?.length){state.draft=null;$('proposal').className='proposal';$('proposal').hidden=false;$('proposal').innerHTML=`<h4>A detail is needed</h4>${result.clarification_questions.map(q=>`<p>${esc(q)}</p>`).join('')}${result.errors?.length?`<div class="unsupported-clauses"><strong>Also needs changing</strong>${result.errors.map(error=>`<p>${esc(error)}</p>`).join('')}</div>`:''}<p>Add your answer${result.errors?.length?' and remove or revise the unsupported parts':''} in the instruction above, then review it again. Nothing has been applied.</p>`;$('instruction-help').textContent='Keep your instruction and add the missing amount, unit or time.';}
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
function stop(){clearInterval(state.timer);state.timer=null;state.townPlaying=false;if(state.town)updateTown();$('replay-caption').setAttribute('aria-live','polite');$('play').textContent='▶ Watch negotiations';$('play').setAttribute('aria-label','Play the simulation');}
function play(){if(state.view==='compare'){state.view='intervention';document.querySelectorAll('[data-view]').forEach(b=>{const selected=b.dataset.view===state.view;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',selected);});}state.mapMode='animation';state.stage=null;if(state.timer||state.townPlaying){stop();return;}if(!currentEvents().length)return;$('replay-caption').setAttribute('aria-live','off');if(state.index>=currentEvents().length-1)state.index=0;$('play').textContent='Ⅱ Pause';$('play').setAttribute('aria-label','Pause the simulation');state.townPlaying=!!state.town;renderFrame();if(state.town)return;state.timer=setInterval(()=>{if(state.index>=currentEvents().length-1){stop();return;}state.index++;renderFrame();},1400);}
function download(name,text,type){if(state.exportURL)URL.revokeObjectURL(state.exportURL);state.exportURL=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=state.exportURL;a.download=name;a.textContent=`Download ${name}`;notify('Your export is ready. ');$('notice').append(a);$('export-title').textContent=`View or copy ${name}`;$('export-text').value=text;$('export-preview').hidden=false;$('notice').scrollIntoView?.({block:'nearest'});}
function exportLedger(){const q=s=>`"${String(s??'').replaceAll('"','""')}"`;const columns=['run','id','seller_id','buyer_id','quantity_kwh','price','payment','status','delivery_start','delivery_end'];const rows=[columns.join(',')];for(const name of ['baseline','intervention'])for(const t of state.result[name]?.trades||[])rows.push([name,...columns.slice(1).map(k=>t[k])].map(q).join(','));download('energy-trade-ledger.csv',rows.join('\n'),'text/csv');}
function bindPan(svg){let drag=null;svg.addEventListener('pointerdown',e=>{if(e.target.closest('.trade-edge'))return;const node=e.target.closest('.node'),id=node?.getAttribute('data-agent'),origin=id?(state.nodeOffsets[id]||{x:0,y:0}):state.pan;drag={x:e.clientX,y:e.clientY,px:origin.x,py:origin.y,id};if(id){state.selected=id;state.focusedPair=null;state.storyFocused=false;$('inspect-select').value=id;}});svg.addEventListener('pointermove',e=>{if(!drag||Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<4)return;if(!drag.moved)svg.setPointerCapture(e.pointerId);drag.moved=true;const rect=svg.getBoundingClientRect(),scale=1/Math.min(rect.width/880,rect.height/610)/(drag.id?state.zoom:1),next={x:drag.px+(e.clientX-drag.x)*scale,y:drag.py+(e.clientY-drag.y)*scale};if(drag.id)state.nodeOffsets[drag.id]=next;else state.pan=next;renderFrame();});svg.addEventListener('pointerup',()=>{const selected=drag?.id,moved=drag?.moved;drag=null;if((selected||moved)&&state.result)renderFrame();});svg.addEventListener('pointercancel',()=>drag=null);}
$('config-form').onsubmit=e=>{e.preventDefault();state.zoom=1;state.pan={x:0,y:0};state.nodeOffsets={};run();};
for(const id of ['population','topology','seed','max-rounds','max-messages','cap','memory','price-tick','negotiation-mode'])$(id).addEventListener('change',invalidate);
$('instruction').addEventListener('input',()=>{const hadDraft=!!state.draft;clearDraft();setBusy(state.busy);if(hadDraft)$('instruction-help').textContent='Your instruction changed. Review it again before applying.';});
$('controlled').onchange=()=>{state.controlled=$('controlled').value;state.selected=state.controlled;state.focusedPair=null;state.storyFocused=false;$('inspect-select').value=state.selected;clearDraft();state.causal.clear();render();};
$('inspect-select').onchange=()=>{state.selected=$('inspect-select').value;state.focusedPair=null;state.storyFocused=false;renderFrame();};
$('message-scope').onchange=()=>{state.messageScope=$('message-scope').value;state.followLatest=false;state.hoveredPair=null;if(state.result)renderFrame();};
$('parse').onclick=()=>preview();
document.querySelectorAll('[data-example-index]').forEach(b=>b.onclick=()=>useExample(Number(b.dataset.exampleIndex)));
document.querySelectorAll('[data-scenario]').forEach(b=>b.onclick=()=>preset(b.dataset.scenario));
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>selectView(b.dataset.view));
$('timeline').oninput=()=>{stop();state.stage=null;state.index=Number($('timeline').value);renderFrame();};
$('back').onclick=()=>{stop();state.stage=null;state.index=Math.max(0,state.index-1);renderFrame();};
$('next').onclick=()=>{stop();state.stage=null;state.index=Math.min(currentEvents().length-1,state.index+1);renderFrame();};
$('play').onclick=play;
$('event-filter').onchange=()=>{if(state.result)renderLog();};
$('export').onclick=()=>download(`energy-experiment-seed-${state.config.seed}.json`,JSON.stringify(state.result,null,2),'application/json');
$('trace-export').onclick=()=>download(`energy-${state.view}-trace.jsonl`,currentEvents().map(e=>JSON.stringify(e)).join('\n'),'application/x-ndjson');
$('ledger-export').onclick=exportLedger;
$('select-export').onclick=()=>{$('export-text').focus();$('export-text').select();};
bindHistory($('conversation'));bindHistory($('story-detail'));bindPan($('graph'));
if(typeof window!=='undefined') {
  let width=window.innerWidth,resizeTimer;
  window.addEventListener('resize',()=>{
    if(width===window.innerWidth)return;
    width=window.innerWidth;clearTimeout(resizeTimer);
    resizeTimer=setTimeout(()=>{if(state.result)renderFrame();},100);
  });
}
run();
