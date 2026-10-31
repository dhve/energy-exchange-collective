// Product regression harness. Run: node --test tests/test_collective_ui.cjs
// Executes the actual collective.js with a small DOM and a deferred API response.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function fixture() {
  const elements = new Map(); let svgCount=0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', hidden: false, disabled: false, listeners: {},
      classList: {toggle() {}, add() {}, remove() {}},
      setAttribute(key,value) { (this.attributeValues ||= {})[key]=String(value); }, getAttribute(key) { return this.attributeValues?.[key]; }, replaceChildren() { this.children=[]; }, addEventListener(type, callback) {
        (this.listeners[type] ||= []).push(callback);
      },
      dispatch(type) { for (const callback of this.listeners[type] || []) callback({target: this}); },
      reportValidity() { return true; }, querySelectorAll() { return []; },
      focus() {},
      append(child) { (this.children ||= []).push(child); },
      attributes: new Set(),
      toggleAttribute(name, force) { if (force) this.attributes.add(name); else this.attributes.delete(name); },
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    console, setInterval, clearInterval, setTimeout, Blob, URL,
    document: {getElementById: element, querySelector: element, querySelectorAll: () => [], createElementNS: (_,tag) => Object.assign(element('svg-'+svgCount++),{tag}), createElement: tag => ({tag,click(){}})},
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/energy_exchange/web/collective.js'), 'utf8');
  // Suppress only the initial automatic HTTP run. Event bindings remain real.
  vm.runInContext(source.replace(/\brun\(\);\s*$/, ''), context);
  const evaluate = code => vm.runInContext(code, context);
  evaluate(`
    state.config={population:20};
    state.result={world:{agents:[{id:'A17',role:'seller',min_price:6}]}};
    state.controlled='A17';
  `);
  return {context, evaluate, element};
}

test('editing instruction while preview is pending invalidates its eventual response', async () => {
  const f = fixture();
  f.element('instruction').value = 'Set my minimum price to 8';
  f.evaluate('api=()=>new Promise(resolve=>{globalThis.resolvePreview=resolve;}); globalThis.pending=preview();');
  f.element('instruction').value = 'Set my minimum price to 9';
  f.element('instruction').dispatch('input');
  f.context.resolvePreview({errors: [], changes: {min_price: 8}, recognized: []});
  await f.context.pending;
  assert.equal(f.evaluate('state.draft'), null, 'A response for the old instruction must not restore a confirmable draft');
  assert.equal(f.element('proposal').hidden, true);
});

for (const [control, event] of [['policy-value', 'input'], ['policy-field', 'change']]) {
  test(`editing structured ${control} invalidates a displayed draft`, () => {
    const f = fixture();
    f.evaluate("displayDraft({agent_id:'A17',scenario:'custom',changes:{min_price:8}});");
    f.element(control).value = control === 'policy-value' ? '9' : 'reserve_kwh';
    f.element(control).dispatch(event);
    assert.equal(f.evaluate('state.draft'), null, 'Structured input changes must invalidate a policy preview');
  });
}

test('selecting another controlled agent does not rewrite the completed experiment impact', async () => {
  const f = fixture();
  // Drive the real acceptance path so the app can retain the submitted origin.
  // Rendering is outside this data/confirmation test and is replaced with no-ops.
  f.evaluate(`
    initializeAgents=()=>{}; rebuildFrames=()=>{}; render=()=>{};
    const trade=(seller_id,buyer_id,quantity_kwh)=>({seller_id,buyer_id,quantity_kwh,price:5});
    api=async()=>({
      world:{agents:[]},updated_world:{agents:[]},
      baseline:{events:[],trades:[trade('A17','A02',1),trade('A03','A04',1)]},
      intervention:{events:[],trades:[trade('A17','A02',2),trade('A03','A04',2)]},
      comparison:{},manifest:{}
    });
    globalThis.pending=run({agent_id:'A17',scenario:'custom',changes:{min_price:8}});
  `);
  await f.context.pending;
  const before = f.evaluate('JSON.stringify(changed().indirect.slice().sort())');
  assert.equal(before, JSON.stringify(['A03', 'A04']));
  f.evaluate("state.controlled='A05';");
  const after = f.evaluate('JSON.stringify(changed().indirect.slice().sort())');
  assert.equal(after, before, 'Historical impact must stay tied to the accepted intervention origin');
});

test('no-change control requests a paired run with the original policy', () => {
  const f = fixture();
  f.evaluate("renderOwn=()=>{}; renderFrame=()=>{}; preset('none');");
  assert.equal(f.evaluate('state.draft.scenario'), 'custom');
  assert.equal(f.evaluate('state.draft.changes.min_price'), 6);
});

test('utility chart reads the engine per-agent summaries', () => {
  const f = fixture();
  assert.equal(f.evaluate("utilities({agents:{A17:{utility:12.34},A02:{utility:8}}}).A17"), 12.34);
});

test('message and round metrics use engine counters', () => {
  const f = fixture();
  const value=JSON.parse(f.evaluate("JSON.stringify(metrics({trades:[],events:[{type:'offer_rejected',round:1}],messages:27,rounds:4}))"));
  assert.equal(value.messages,27);
  assert.equal(value.rounds,4);
});

test('impact uses the engine causal classification when supplied', () => {
  const f = fixture();
  f.evaluate("state.result.comparison={affected_agents:['A03','A04'],direct_agents:[],indirect_agents:['A03','A04'],changed_kwh:2.5};");
  assert.equal(f.evaluate('changed().affected.size'),2);
  assert.equal(f.evaluate('changed().indirect.length'),2);
  assert.equal(f.evaluate('changed().changed_kwh'),2.5);
});

test('dragged household positions remain fixed across replay renders', () => {
  const f=fixture();
  const initial=JSON.parse(f.evaluate("JSON.stringify(positions().get('A17'))"));
  f.evaluate("state.nodeOffsets={A17:{x:30,y:-20}};");
  for(let i=0;i<2;i++){
    const current=JSON.parse(f.evaluate("JSON.stringify(positions().get('A17'))"));
    assert.equal(current.x,initial.x+30);
    assert.equal(current.y,initial.y-20);
  }
});

test('round stepping moves to the adjacent recorded round', () => {
  const f=fixture();
  f.evaluate("state.result.baseline={events:[{round:0},{round:1},{round:1},{round:2}],trades:[]}; renderFrame=()=>{}; state.index=1; stepRound(1);");
  assert.equal(f.evaluate('state.index'),3);
  f.evaluate('stepRound(-1);');
  assert.equal(f.evaluate('state.index'),2);
});

test('comparison visibility changes the SVG hidden attribute', () => {
  const f=fixture();
  f.element('compare-graph').attributes.add('hidden');
  f.evaluate("drawGraph=()=>{};renderInspector=()=>{};renderDecisionAudit=()=>{};renderLog=()=>{};state.result.baseline={events:[],trades:[]};state.result.intervention={events:[],trades:[]};state.view='compare';renderFrame();");
  assert.equal(f.element('compare-graph').attributes.has('hidden'),false,'SVG visibility must remove the actual attribute');
  f.evaluate("state.view='baseline';renderFrame();");
  assert.equal(f.element('compare-graph').attributes.has('hidden'),true);
});

test('exports expose a persistent direct download link containing the displayed data', async () => {
  const f=fixture();
  f.evaluate("download('experiment.json',JSON.stringify({seed:42,events:[1,2,3]}),'application/json');");
  const link=f.element('notice').children?.at(-1);
  assert.ok(link,'An export must provide a visible download link');
  assert.equal(link.download,'experiment.json');
  assert.deepEqual(await (await fetch(link.href)).json(),{seed:42,events:[1,2,3]});
  assert.equal(f.element('export-preview').hidden,false);
  assert.deepEqual(JSON.parse(f.element('export-text').value),{seed:42,events:[1,2,3]});
  assert.match(f.element('export-title').textContent,/experiment\.json/);
  URL.revokeObjectURL(link.href);
});

test('suggested instructions match the selected household role', () => {
  const f=fixture();
  const seller=JSON.parse(f.evaluate("JSON.stringify(suggestedInstructions({role:'seller'}))"));
  const buyer=JSON.parse(f.evaluate("JSON.stringify(suggestedInstructions({role:'buyer'}))"));
  assert.equal(seller.length,3);
  assert.match(seller[0].text,/minimum price/);
  assert.match(seller[1].text,/Sell/);
  assert.match(buyer[0].text,/budget/);
  assert.match(buyer[1].text,/Buy/);
  assert.match(buyer[2].text,/maximum price/);
});

test('choosing an example clears a prior confirmation without applying any change', () => {
  const f=fixture();
  f.evaluate("displayDraft({agent_id:'A17',scenario:'custom',changes:{min_price:8}}); api=()=>{throw Error('An example must not send a request');}; useExample(0);");
  assert.match(f.element('instruction').value,/minimum price/);
  assert.equal(f.evaluate('state.draft'),null);
  assert.equal(f.element('proposal').hidden,true);
  assert.equal(f.element('parse').disabled,false);
});

test('an empty instruction is caught before a request is sent', async () => {
  const f=fixture();
  f.element('instruction').value='  ';
  f.evaluate("api=()=>{throw Error('Empty instructions must not reach the server');}; globalThis.pending=preview();");
  await f.context.pending;
  assert.match(f.element('instruction-help').textContent,/type|example/i);
  assert.equal(f.element('parse').disabled,true);
  assert.equal(f.evaluate('state.draft'),null);
});

test('examples and review are disabled while changed settings need rebuilding', () => {
  const f=fixture();
  f.element('instruction').value='Sell up to 3 kWh';
  f.evaluate('state.dirty=true;setBusy(false);');
  assert.equal(f.element('parse').disabled,true);
  for(let i=0;i<3;i++) assert.equal(f.element(`example-${i}`).disabled,true);
});

test('plain outcome reports a decrease correctly and discloses a search limit', () => {
  const f=fixture();
  f.evaluate(`
    state.result.baseline={trades:[{seller_id:'A17',buyer_id:'A02',quantity_kwh:4}],events:[],status:'locally_stable'};
    state.result.intervention={trades:[{seller_id:'A17',buyer_id:'A02',quantity_kwh:3}],events:[],status:'round_limited'};
    state.result.comparison={affected_agents:['A17','A02']};
    renderOutcome();
  `);
  assert.match(f.element('simple-outcome').textContent,/1\.00 kWh less/);
  assert.match(f.element('simple-outcome').textContent,/2 homes/);
  assert.match(f.element('simple-outcome').textContent,/limit/);
  assert.doesNotMatch(f.element('simple-outcome').textContent,/no better trade/i);
  assert.equal(f.element('run-view').hidden,false);
});

test('an initial run hides comparison and affected-home controls', () => {
  const f=fixture();
  f.evaluate("state.result.baseline={trades:[],events:[],status:'locally_stable'};renderOutcome();");
  assert.equal(f.element('run-view').hidden,true);
  assert.equal(f.element('affected-result').hidden,true);
  assert.equal(f.element('affected-list').hidden,true);
});

test('a message budget stop is described as a message limit', () => {
  const f=fixture();
  f.evaluate("state.result.baseline={trades:[],events:[],status:'locally_stable'};state.result.intervention={trades:[],events:[],status:'round_limited',termination_reason:'max_messages'};renderOutcome();");
  assert.match(f.element('simple-outcome').textContent,/message limit/);
  assert.doesNotMatch(f.element('simple-outcome').textContent,/round limit/);
});

test('a no-change review identifies unchanged rules without promising unchanged trades', () => {
  const f=fixture();
  f.evaluate("displayDraft({agent_id:'A17',scenario:'custom',changes:{min_price:6}});");
  assert.match(f.element('proposal').innerHTML,/rules.*same/i);
  assert.doesNotMatch(f.element('proposal').innerHTML,/trades.*same/i);
});

test('reviewing another change explains that it replaces the last intervention', () => {
  const f=fixture();
  f.evaluate("state.result.intervention={trades:[],events:[]};displayDraft({agent_id:'A17',scenario:'custom',changes:{min_price:8}});");
  assert.match(f.element('proposal').innerHTML,/replaces your previous change/i);
  assert.match(f.element('proposal').innerHTML,/starting simulation/i);
});

test('replay does not describe an unresolved simulation as a search limit', () => {
  const f=fixture();
  f.evaluate("state.result.baseline={status:'unresolved',termination_reason:'invariant_failure',events:[]};");
  const caption=f.evaluate("eventDescription({type:'terminated'})");
  assert.match(caption,/could not complete/i);
  assert.doesNotMatch(caption,/limit|repeated pattern/);
});

test('an unresolved experiment does not present provisional trades as an outcome', () => {
  const f=fixture();
  f.evaluate("state.result.baseline={trades:[],events:[],status:'locally_stable'};state.result.intervention={trades:[{seller_id:'A17',buyer_id:'A02',quantity_kwh:3}],events:[],status:'unresolved',termination_reason:'invariant_failed'};renderOutcome();");
  assert.match(f.element('simple-outcome').textContent,/no final energy agreements/i);
  assert.doesNotMatch(f.element('simple-outcome').textContent,/homes share|different agreements/);
  assert.equal(f.element('affected-result').hidden,true);
  assert.equal(f.element('affected-list').hidden,true);
});

test('clarification keeps the original instruction and provides no apply path', async () => {
  const f=fixture();
  f.element('instruction').value='Keep enough energy for later';
  f.evaluate(`api=async()=>({errors:[],changes:{reserve_kwh:3},recognized:[],normalized_prompt:'Keep energy in reserve',clarification_questions:['How many kWh should stay in reserve?'],assumptions:[],translation:{mode:'rules',status:'fallback'}}); globalThis.pending=preview();`);
  await f.context.pending;
  assert.equal(f.evaluate('state.draft'),null);
  assert.equal(f.element('instruction').value,'Keep enough energy for later');
  assert.match(f.element('proposal').innerHTML,/How many kWh/);
  assert.doesNotMatch(f.element('proposal').innerHTML,/id="confirm"/);
});

test('translated preview shows interpretation and assumptions but submits only policy fields', async () => {
  const f=fixture();
  f.element('instruction').value='Sell later for less';
  f.evaluate(`api=async()=>({errors:[],changes:{min_price:8},recognized:[],normalized_prompt:'Minimum price ₹8/kWh',clarification_questions:[],assumptions:['Applies to your current selling window'],translation:{mode:'llm',model:'test-model',status:'translated'}}); globalThis.pending=preview();`);
  await f.context.pending;
  assert.match(f.element('proposal').innerHTML,/Minimum price ₹8\/kWh/);
  assert.match(f.element('proposal').innerHTML,/current selling window/);
  f.evaluate('run=intervention=>{globalThis.submitted=intervention;};');
  f.element('confirm').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.submitted)),{agent_id:'A17',scenario:'custom',changes:{min_price:8}});
});

function replayFixture(f) {
  f.evaluate(`
    state.result.baseline={events:[{id:'b1',type:'offer_sent',round:1}],trades:[{id:'t1',seller_id:'A17',buyer_id:'A02',quantity_kwh:2,price:6}]};
    state.result.intervention={events:[
      {id:'i1',type:'policy_confirmed',round:0,actor_id:'A17',reason:'Floor changed'},
      {id:'i2',type:'provisional_released',caused_by:['i1'],round:0,actor_id:'A17',counterparty_id:'A02',trade_id:'t1',reason:'Price below new floor'},
      {id:'i3',type:'offer_sent',round:1,actor_id:'A17',counterparty_id:'A03',quantity_kwh:1.5,price:8,reason:'Available surplus',delivery_start:'2026-10-30T15:00:00+05:30',delivery_end:'2026-10-30T16:00:00+05:30'},
      {id:'i4',type:'terminated',round:2,reason:'No admissible move'}],trades:[]};
    state.view='intervention';rebuildFrames();
  `);
}

test('five replay stages point to real events and starting agreements stay frozen', () => {
  const f=fixture();replayFixture(f);
  const stages=JSON.parse(f.evaluate('JSON.stringify(replayStages())'));
  assert.equal(stages.length,5);
  assert.deepEqual(stages.map(s=>s.event?.id || null),[null,'i1','i2','i3','i4']);
  f.evaluate("renderFrame=()=>{};selectStage('starting');");
  assert.equal(f.evaluate('qty(frameTrades())'),2);
  assert.equal(f.evaluate('currentEvents().length'),4,'Stage navigation must never inject trace events');
});

test('a missing affected agreement stage explains the absence without inventing a release', () => {
  const f=fixture();replayFixture(f);
  f.evaluate("state.result.intervention.events=state.result.intervention.events.filter(e=>e.type!=='provisional_released');");
  const stage=JSON.parse(f.evaluate("JSON.stringify(replayStages().find(s=>s.id==='affected'))"));
  assert.equal(stage.event,null);
  assert.match(stage.explanation,/no.*agreement.*released|no.*direct.*change/i);
});

test('comparison always uses starting agreements instead of matching negotiation rounds', () => {
  const f=fixture();replayFixture(f);
  f.evaluate(`renderInspector=()=>{};renderDecisionAudit=()=>{};renderLog=()=>{};renderConversation=()=>{};state.view='compare';state.index=2;drawGraph=(svg,trades,event,caption)=>{if(svg===$('compare-graph'))globalThis.compared={trades,event,caption};};renderFrame();`);
  assert.equal(f.context.compared.trades.length,1);
  assert.equal(f.context.compared.event,null);
  assert.match(f.context.compared.caption,/Before.*original agreements/i);
});

test('conversation uses actual recorded amounts, delivery window and authoritative reason', () => {
  const f=fixture();replayFixture(f);
  f.evaluate('state.index=2;renderConversation();');
  const html=f.element('conversation').innerHTML;
  assert.match(html,/A17.*A03/s);
  assert.match(html,/1\.50 kWh.*8\.00/s);
  assert.match(html,/30 Oct · 3–4 PM \(India time\)/);
  assert.match(html,/Available surplus/);
  assert.doesNotMatch(html,/A02/,'Unrelated conversations must not be fabricated');
});

test('inspecting another household preserves the visible controlled name and ID', () => {
  const f=fixture();
  f.evaluate("state.result.world.agents=[{id:'A17',name:'Mira',role:'seller',min_price:6},{id:'A02',name:'Arun',role:'buyer'}];renderOwn();renderFrame=()=>{};");
  f.element('inspect-select').value='A02';f.element('inspect-select').onchange();
  assert.equal(f.evaluate('state.controlled'),'A17');
  assert.equal(f.evaluate('state.selected'),'A02');
  assert.match(f.element('prompt-help').textContent,/Mira.*A17/);
});

test('delivery and time price summaries use declared timezone terms', () => {
  const f=fixture();
  assert.equal(f.evaluate("policyValue('time_price',{after:'2026-10-30T15:00:00+05:30',floor:5})"),'₹5.00/kWh after 30 Oct · 3 PM (India time)');
  assert.equal(f.evaluate("deliveryWindow({interval_start:'2026-10-30T14:30:00+05:30',interval_end:'2026-10-30T16:00:00+05:30'})"),'30 Oct · 2:30–4 PM (India time)');
});


function descendants(node) { return (node.children || []).flatMap(child=>[child,...descendants(child)]); }

test('network separates directed messages from agreements and identifies every home', () => {
  const f=fixture();replayFixture(f);
  f.evaluate("state.result.world.agents.push({id:'A02',name:'Arun',role:'buyer'},{id:'A03',name:'Leela',role:'buyer'});state.selected='A17';$('role-filter').value='all';drawGraph($('graph'),state.result.baseline.trades,currentEvents()[2],'After');");
  const nodes=descendants(f.element('graph'));
  const agreement=nodes.find(n=>n.getAttribute?.('class')==='trade-edge');
  const message=nodes.find(n=>n.getAttribute?.('class')?.includes('message-edge'));
  assert.ok(message,'A recorded offer must draw a distinct message arrow');
  assert.ok(agreement.getAttribute('marker-end'),'Agreements must have a delivery direction');
  assert.ok(message.getAttribute('marker-end'),'Messages must have a sender-to-recipient direction');
  assert.notEqual(message.getAttribute('stroke-dasharray'),agreement.getAttribute('stroke-dasharray'));
  for(const id of ['A17','A02','A03'])assert.ok(nodes.some(n=>n.tag==='text'&&n.textContent===id),`${id} must remain visible`);
  const active=nodes.find(n=>n.getAttribute?.('data-agent')==='A03');
  assert.match(active.getAttribute('class'),/active-party/);
});

test('inactive and exhausted homes have different explanations', () => {
  const f=fixture();replayFixture(f);
  f.evaluate("state.result.world.agents=[{id:'A17',role:'seller',forecast_surplus_kwh:3,reserve_kwh:1,max_offer_kwh:2},{id:'A02',role:'buyer',demand_kwh:3},{id:'A03',role:'seller',forecast_surplus_kwh:2,reserve_kwh:0,max_offer_kwh:2}];");
  assert.match(f.evaluate("householdAvailability(agentById('A17'),state.result.baseline.trades)"),/no free energy/i);
  assert.match(f.evaluate("householdAvailability(agentById('A03'),state.result.baseline.trades)"),/not in an agreement/i);
});

test('household results derive energy, payment and utility changes from actual ledgers', () => {
  const f=fixture();replayFixture(f);
  f.evaluate("state.result.baseline.agents={A17:{utility:10}};state.result.intervention.agents={A17:{utility:7}};");
  const row=JSON.parse(f.evaluate("JSON.stringify(householdChanges()[0])"));
  assert.equal(row.id,'A17');assert.equal(row.energy,-2);assert.equal(row.payment,-12);assert.equal(row.utility,-3);
});

test('method disclosure distinguishes frozen LLM planning and rules fallback', () => {
  const f=fixture();
  f.evaluate("state.result.manifest={config:{negotiation_mode:'bargaining'},strategy_plan:{source:'openai'}};renderMethod();");
  assert.match(f.element('method-summary').textContent,/LLM.planned bargaining/i);
  f.evaluate("state.result.manifest.strategy_plan.source='rules_fallback';renderMethod();");
  assert.match(f.element('method-summary').textContent,/rules.based fallback/i);
  f.evaluate("state.result.manifest.strategy_plan.source='llm_unavailable';renderMethod();");
  assert.match(f.element('method-summary').textContent,/rules.based fallback/i);
});

test('revised requirement stage shows the recorded before and after policy values', () => {
  const f=fixture();replayFixture(f);
  f.evaluate("state.result.intervention.events[0].changed_fields=[{agent_id:'A17',field:'min_price',before:6,after:8}];state.stage='requirement';state.index=0;renderConversation();");
  assert.match(f.element('conversation').innerHTML,/Lowest selling price.*6\.00.*8\.00/s);
});

test('method comparison displays recorded results for the same world and current run view', () => {
  const f=fixture();
  f.evaluate(`state.result.method_comparison={world_checksum:'world-42',note:'Both runs reached their move limit.',baseline:{bargaining:{committed_kwh:7.25,unfilled_demand_kwh:2.75,payments:43.5,message_count:18},midpoint:{committed_kwh:8,unfilled_demand_kwh:2,payments:48,message_count:9}},intervention:{bargaining:{committed_kwh:5,unfilled_demand_kwh:5,payments:40,message_count:23},midpoint:{committed_kwh:6,unfilled_demand_kwh:4,payments:45,message_count:11}}};state.result.intervention={events:[],trades:[]};renderMethod();`);
  assert.equal(f.element('method-comparison').hidden,false);
  assert.match(f.element('method-comparison-table').innerHTML,/7\.25 kWh.*8\.00 kWh/s);
  assert.match(f.element('method-comparison-table').innerHTML,/43\.50 INR.*48\.00 INR/s);
  assert.match(f.element('method-comparison-note').textContent,/move limit/);
  assert.match(f.element('method-comparison-context').textContent,/same household profiles and delivery windows/i);
  assert.match(f.element('method-comparison-context').textContent,/own initial allocation/i);
  f.evaluate("state.view='intervention';renderMethod();");
  assert.match(f.element('method-comparison-table').innerHTML,/5\.00 kWh.*6\.00 kWh/s);
  assert.match(f.element('method-comparison-title').textContent,/after your change/i);
  f.evaluate("state.view='compare';renderMethod();");
  assert.match(f.element('method-comparison-table').innerHTML,/23.*11/s);
});

test('method comparison never substitutes starting metrics for an unavailable intervention comparison', () => {
  const f=fixture();
  f.evaluate("state.result.method_comparison={world_checksum:'world-42',baseline:{bargaining:{committed_kwh:9},midpoint:{committed_kwh:10}},intervention:null};state.result.intervention={};state.view='intervention';renderMethod();");
  assert.equal(f.element('method-comparison').hidden,true);
});

test('clarification also displays unsupported clauses so an answer cannot imply they will apply', async () => {
  const f=fixture();f.element('instruction').value='Keep enough for my party if it rains';
  f.evaluate(`api=async()=>({errors:['Rain conditions are unsupported.'],changes:{},clarification_questions:['How many kWh should stay in reserve?']});globalThis.pending=preview();`);
  await f.context.pending;
  assert.match(f.element('proposal').innerHTML,/How many kWh/);
  assert.match(f.element('proposal').innerHTML,/Rain conditions are unsupported/);
  assert.doesNotMatch(f.element('proposal').innerHTML,/id="confirm"/);
  assert.equal(f.evaluate('state.draft'),null);
});

test('conversation explains recorded constraint codes without inventing household quotes', () => {
  const f=fixture();replayFixture(f);
  f.evaluate("state.result.intervention.events[2]={id:'i3',type:'offer_rejected',round:1,actor_id:'A03',counterparty_id:'A17',quantity_kwh:1.5,price:8,reason:'A03 rejects: over_budget',reason_code:'over_budget'};state.index=2;renderConversation();");
  assert.match(f.element('conversation').innerHTML,/buyer.*remaining budget/i);
  assert.doesNotMatch(f.element('conversation').innerHTML,/over_budget/);
  f.evaluate("state.result.intervention.events[2].reason='A03 rejects: interval_mismatch';state.result.intervention.events[2].reason_code='interval_mismatch';renderConversation();");
  assert.match(f.element('conversation').innerHTML,/delivery windows do not overlap/i);
  assert.doesNotMatch(f.element('conversation').innerHTML,/I |my /i);
  f.evaluate("state.result.intervention.events[2].reason='A03 rejects: responder_not_improving';state.result.intervention.events[2].reason_code='responder_not_improving';renderConversation();");
  assert.match(f.element('conversation').innerHTML,/responding household model utility/);
  assert.doesNotMatch(f.element('conversation').innerHTML,/responder_/);
});

function snapshotFixture(f) {
  f.evaluate(`
    const original={id:'A17',name:'Mira',role:'seller',min_price:6,forecast_surplus_kwh:8,reserve_kwh:0,max_offer_kwh:8};
    state.result.world.agents=[original,{id:'A02',role:'buyer',demand_kwh:4,max_price:10,budget:40}];
    state.result.updated_world={agents:[{...original,min_price:9,max_offer_kwh:4},state.result.world.agents[1]]};
    state.result.baseline={events:[],trades:[{id:'t1',seller_id:'A17',buyer_id:'A02',quantity_kwh:4,price:7}]};
    state.result.intervention={events:[{id:'i1',type:'policy_confirmed',actor_id:'A17',round:0,reason:'Price floor raised'},{id:'i2',type:'terminated',round:1}],trades:[]};
    state.view='intervention';state.stage='starting';state.index=0;state.selected='A17';rebuildFrames();
  `);
}

test('starting agreements use original profiles in both inspection and node availability', () => {
  const f=fixture();snapshotFixture(f);
  f.evaluate("renderInspector();$('role-filter').value='all';drawGraph($('graph'),frameTrades(),null,'Starting');");
  assert.match(f.element('inspection').innerHTML,/Price floor.*6\.00/s);
  assert.doesNotMatch(f.element('inspection').innerHTML,/9\.00/);
  assert.match(f.element('inspection').innerHTML,/4\.00 kWh still available/);
  const own=descendants(f.element('graph')).find(n=>n.getAttribute?.('data-agent')==='A17');
  assert.match(own.getAttribute('aria-label'),/4\.00 kWh still available/);
  f.evaluate("state.stage='requirement';renderInspector();");
  assert.match(f.element('inspection').innerHTML,/Price floor.*9\.00/s);
});

test('fixed comparison graph explicitly uses original household profiles after a policy change', () => {
  const f=fixture();snapshotFixture(f);
  f.evaluate("renderDecisionAudit=()=>{};renderLog=()=>{};state.view='compare';state.stage=null;state.index=1;$('role-filter').value='all';renderFrame();");
  const before=descendants(f.element('compare-graph')).find(n=>n.getAttribute?.('data-agent')==='A17');
  assert.match(before.getAttribute('aria-label'),/4\.00 kWh still available/);
});

test('affected stage excludes replacements caused by later negotiations and stays before offers', () => {
  const f=fixture();replayFixture(f);
  f.evaluate(`state.result.intervention.events=[
    {id:'iv-1',type:'policy_confirmed',actor_id:'A02',round:0,reason:'Buying ceiling changed'},
    {id:'iv-2',type:'offer_sent',actor_id:'A02',counterparty_id:'A17',round:1},
    {id:'iv-51',type:'offer_accepted',actor_id:'A17',counterparty_id:'A02',round:1,caused_by:['iv-2']},
    {id:'iv-52',type:'offer_replaced',actor_id:'A17',counterparty_id:'A02',round:1,caused_by:['iv-51']},
    {id:'iv-53',type:'terminated',round:2}];renderFrame=()=>{};`);
  const affected=JSON.parse(f.evaluate("JSON.stringify(replayStages().find(stage=>stage.id==='affected'))"));
  assert.equal(affected.event,null,'A negotiated replacement cannot be presented as immediate policy repair');
  assert.match(affected.explanation,/no prior agreement.*policy.*before negotiation/i);
  f.evaluate("selectStage('affected');globalThis.affectedIndex=state.index;selectStage('offers');");
  assert.ok(f.evaluate('state.index>=globalThis.affectedIndex'),'The five-stage path must not move backward from later replacement to the first offer');
});

test('offers stage displays a recorded exchange through its response and matching allocation only', () => {
  const f=fixture();replayFixture(f);
  f.evaluate(`
    state.result.baseline.trades=[];
    const trade={id:'new-trade',seller_id:'A17',buyer_id:'A03',quantity_kwh:1.5,price:7};
    state.result.intervention.events=[
      {id:'p',type:'policy_confirmed',actor_id:'A17',round:0},
      {id:'offer',type:'offer_sent',actor_id:'A17',counterparty_id:'A03',round:1,quantity_kwh:1.5,price:8,reason:'Recorded opening offer'},
      {id:'counter',type:'counteroffer_sent',actor_id:'A03',counterparty_id:'A17',round:1,quantity_kwh:1.5,price:7,reason:'Recorded counteroffer',caused_by:['offer']},
      {id:'accept',type:'offer_accepted',actor_id:'A17',counterparty_id:'A03',round:1,quantity_kwh:1.5,price:7,reason:'Recorded acceptance',caused_by:['counter']},
      {id:'reserve',type:'provisional_reserved',actor_id:'A17',counterparty_id:'A03',round:1,trade,reason:'Recorded reservation',caused_by:['accept']},
      {id:'future',type:'offer_sent',actor_id:'A17',counterparty_id:'A03',round:2,quantity_kwh:3,price:99,reason:'Later independent exchange'},
      {id:'end',type:'terminated',round:2}
    ];
    state.result.intervention.trades=[{...trade,quantity_kwh:3}];rebuildFrames();
    renderInspector=()=>{};renderDecisionAudit=()=>{};renderLog=()=>{};
    drawGraph=(svg,trades,event)=>{if(svg===$('graph'))globalThis.visibleGraph={trades,event};};
    selectStage('offers');
  `);
  assert.match(f.element('conversation').innerHTML,/Offer.*Counteroffer.*Accepted terms.*Tentative agreement/s);
  assert.doesNotMatch(f.element('conversation').innerHTML,/99\.00|Later independent exchange/);
  assert.equal(f.evaluate('state.index'),4,'The timeline must be at the displayed exchange end');
  assert.equal(f.context.visibleGraph.event.id,'reserve');
  assert.equal(f.context.visibleGraph.trades[0].quantity_kwh,1.5,'Do not show a later allocation as already agreed');
  assert.match(f.element('replay-caption').textContent,/recorded exchange.*2.*5/i);
  assert.equal(f.evaluate('currentEvents().length'),7,'Stage presentation must not add trace events');
});

test('delivery repair explains invalid old terms without claiming partly overlapping windows do not overlap', () => {
  const f=fixture();replayFixture(f);
  f.evaluate(`
    const seller={id:'A17',role:'seller',interval_start:'2026-10-30T14:00:00+05:30',interval_end:'2026-10-30T16:00:00+05:30'};
    const buyer={id:'A02',role:'buyer',interval_start:'2026-10-30T14:00:00+05:30',interval_end:'2026-10-30T16:00:00+05:30'};
    state.result.world.agents=[seller,buyer];state.result.updated_world={agents:[seller,{...buyer,interval_start:'2026-10-30T15:00:00+05:30',interval_end:'2026-10-30T17:00:00+05:30'}]};
    Object.assign(state.result.intervention.events[1],{reason:'t1 no longer satisfies A02: interval_mismatch',reason_code:'interval_mismatch',trade:{...state.result.baseline.trades[0],delivery_start:seller.interval_start,delivery_end:seller.interval_end}});
    state.stage='affected';state.index=1;renderConversation();
  `);
  assert.match(f.element('conversation').innerHTML,/prior delivery interval no longer fits the revised household windows/i);
  assert.doesNotMatch(f.element('conversation').innerHTML,/windows do not overlap/i);
});


test('delivery windows use a short date and unambiguous India-time ranges with minutes', () => {
  const f=fixture();
  for(const [start,end,expected] of [
    ['2026-10-28T14:00:00+05:30','2026-10-28T16:00:00+05:30','28 Oct · 2–4 PM (India time)'],
    ['2026-10-28T11:30:00+05:30','2026-10-28T14:15:00+05:30','28 Oct · 11:30 AM–2:15 PM (India time)'],
    ['2026-10-28T14:05:00+05:30','2026-10-28T16:45:00+05:30','28 Oct · 2:05–4:45 PM (India time)'],
    ['2026-10-27T23:30:00Z','2026-10-28T01:30:00Z','28 Oct · 5–7 AM (India time)'],
  ]) {
    f.context.windowValue={delivery_start:start,delivery_end:end};
    assert.equal(f.evaluate('deliveryWindow(globalThis.windowValue)'),expected);
    assert.equal(f.context.windowValue.delivery_start,start,'Formatting must preserve exported timestamps');
  }
});

test('prompt names the controlled home in short sentences while retaining its area and ID', () => {
  const f=fixture();
  f.evaluate("state.result.world.agents=[{id:'A17',name:'Yash (Kandivali)',role:'seller',min_price:6}];renderOwn();");
  assert.equal(f.element('prompt-help').textContent,'You control Yash’s home (A17, Kandivali). It sells spare solar energy.');
});

test('fifty desktop home IDs avoid other nodes and labels while replay positions stay fixed', () => {
  const f=fixture();
  f.evaluate(`
    state.result.world.agents=Array.from({length:50},(_,i)=>({id:'A'+String(i+1).padStart(2,'0'),role:i%2?'buyer':'seller'}));
    state.result.baseline={events:[],trades:[]};state.result.intervention={events:[],trades:[]};
    $('graph').clientWidth=800;$('graph').clientHeight=410;$('role-filter').value='all';
    drawGraph($('graph'),[],null,'Starting agreements');
  `);
  const positions=JSON.parse(f.evaluate('JSON.stringify(Object.fromEntries(positions()))'));
  const groups=descendants(f.element('graph')).filter(n=>n.getAttribute?.('data-agent'));
  const labels=groups.map(group=>{
    const label=group.children.find(n=>n.getAttribute?.('class')==='node-label'),id=group.getAttribute('data-agent'),point=positions[id],font=Number(label.getAttribute('font-size'));
    const x=point.x+Number(label.getAttribute('x') || 0),y=point.y+Number(label.getAttribute('y'));
    return {id,left:x-id.length*font*.33-1,right:x+id.length*font*.33+1,top:y-font*.9-1,bottom:y+font*.2+1};
  });
  assert.equal(labels.length,50);
  for(const box of labels) {
    assert.ok(box.left>0&&box.right<880&&box.top>30&&box.bottom<585,`${box.id} must stay clear of the caption and graph edges`);
    for(const [id,point] of Object.entries(positions)) {
      const touching=box.left<point.x+16&&box.right>point.x-16&&box.top<point.y+16&&box.bottom>point.y-16;
      assert.equal(touching,false,`${box.id}'s ID must not overlap ${id}'s node`);
    }
    for(const other of labels)if(other.id!==box.id) {
      const touching=box.left<other.right&&box.right>other.left&&box.top<other.bottom&&box.bottom>other.top;
      assert.equal(touching,false,`${box.id}'s ID must not overlap ${other.id}'s ID`);
    }
  }
  f.evaluate("state.view='intervention';state.stage='starting';state.index=25;");
  assert.deepEqual(JSON.parse(f.evaluate('JSON.stringify(Object.fromEntries(positions()))')),positions);
});

test('final conversation explains termination plainly while keeping the recorded audit reason', () => {
  const f=fixture();
  for(const [status,termination,expected] of [
    ['locally_stable','sweep_clean',/No further trade was found under these rules/i],
    ['round_limited','max_messages',/message limit.*further changes may be possible/i],
    ['unresolved','invariant_failure',/could not complete/i],
  ]) {
    f.context.ending={status,termination_reason:termination,events:[{type:'terminated',reason:status+': '+termination,reason_code:termination}],trades:[]};
    f.evaluate("state.result.baseline=globalThis.ending;state.view='baseline';state.stage=null;state.index=0;renderConversation();");
    assert.match(f.element('conversation').innerHTML,/<h3>Final allocation<\/h3>/);
    assert.match(f.element('conversation').innerHTML,expected);
    assert.doesNotMatch(f.element('conversation').innerHTML,/sweep.clean|locally.stable|invariant.failure|max.messages/i);
    assert.equal(f.evaluate('currentEvents()[0].reason'),status+': '+termination,'Plain language must not rewrite recorded audit data');
  }
});

test('agreement differences detect price and delivery changes, preserving multiple trades per pair', () => {
  const f=fixture();
  const differences=f.evaluate(`agreementDifferences([
    {seller_id:'A17',buyer_id:'A02',quantity_kwh:4,price:6,delivery_start:'x',delivery_end:'y'},
    {seller_id:'A17',buyer_id:'A02',quantity_kwh:1,price:7,delivery_start:'y',delivery_end:'z'},
    {seller_id:'A03',buyer_id:'A04',quantity_kwh:2,price:5}
  ],[
    {seller_id:'A17',buyer_id:'A02',quantity_kwh:4,price:6.5,delivery_start:'x',delivery_end:'y'},
    {seller_id:'A17',buyer_id:'A02',quantity_kwh:1,price:7,delivery_start:'y',delivery_end:'later'},
    {seller_id:'A03',buyer_id:'A06',quantity_kwh:2,price:5}
  ])`);
  assert.deepEqual(Array.from(differences,d=>d.kind),['revised','removed','new']);
  assert.equal(differences[0].before.length,2);
  assert.equal(differences[0].after[0].price,6.5);
  assert.equal(differences[0].after[1].delivery_end,'later');
});

test('replay differences and policy cards use the displayed frame, without leaking final changes', () => {
  const f=fixture();
  f.evaluate(`
    const old={seller_id:'A17',buyer_id:'A02',quantity_kwh:4,price:6};
    const revised={...old,quantity_kwh:3};
    state.result={world:{agents:[{id:'A17',name:'Yash',role:'seller',reserve_kwh:2}]},updated_world:{agents:[{id:'A17',name:'Yash',role:'seller',reserve_kwh:3,time_price:{floor:5,after:'2025-10-29T21:00:00+05:30'}}]},baseline:{trades:[old]},intervention:{trades:[revised],events:[{type:'profile_retrieved'},{type:'policy_confirmed'},{type:'terminated'}]}};
    state.frames=[[old],[old],[revised]];state.view='intervention';state.index=0;renderReplayContext();
  `);
  assert.match(f.element('trade-differences').innerHTML,/No agreement differences/);
  assert.match(f.element('focus-home').innerHTML,/original settings.*2.00 kWh/s);
  assert.doesNotMatch(f.element('focus-home').innerHTML,/₹5.00/);
  f.evaluate('state.index=2;renderReplayContext();');
  assert.match(f.element('trade-differences').innerHTML,/4.00 kWh.*3.00 kWh/s);
  assert.match(f.element('frame-summary').innerHTML,/3.00 kWh agreed/);
  assert.match(f.element('focus-home').innerHTML,/settings at this step.*3.00 kWh.*₹5.00/s);
  f.evaluate("state.stage='starting';renderReplayContext();");
  assert.match(f.element('trade-differences').innerHTML,/No agreement differences/);
  assert.match(f.element('focus-home').innerHTML,/original settings.*2.00 kWh/s);
});

test('unchanged quantities with different prices remain visible in household impact cards', () => {
  const f=fixture();
  f.evaluate(`state.result={world:{agents:[{id:'A17',name:'Yash',role:'seller'}]},baseline:{trades:[{seller_id:'A17',buyer_id:'A02',quantity_kwh:4,price:6}]},intervention:{trades:[{seller_id:'A17',buyer_id:'A02',quantity_kwh:4,price:7}]}};renderImpactSummary();`);
  assert.match(f.element('impact-summary').innerHTML,/0.00 kWh sold/);
  assert.match(f.element('impact-summary').innerHTML,/\+4.00 rupees received/);
});

test('negotiation explanation distinguishes strategy steps from unrecorded motives', () => {
  const f=fixture();
  const text=f.evaluate(`negotiationExplanation({actor_id:'A17',reason_code:'strategy_quote',strategy_step:1,reason:'A17 proposes 3 kWh at INR 6.7/kWh'})`);
  assert.match(text,/quote 2.*seller proposes.*frozen strategy.*no additional motive is recorded/);
});

test('price-only changes have an explicit graph annotation rather than identical energy amounts', () => {
  const f=fixture();snapshotFixture(f);
  f.evaluate(`state.stage=null;state.index=1;state.view='compare';
    state.result.intervention.trades=[{id:'t2',seller_id:'A17',buyer_id:'A02',quantity_kwh:4,price:9}];
    rebuildFrames();drawGraph($('graph'),frameTrades(),null,'After');`);
  const texts=descendants(f.element('graph')).filter(n=>n.tag==='text').map(n=>n.textContent);
  assert.ok(texts.some(t=>t.includes('₹7.00 → ₹9.00/kWh')));
  const edge=descendants(f.element('graph')).find(n=>n.getAttribute?.('class')==='trade-edge');
  assert.equal(edge.getAttribute('stroke'),'#ae650f');
});

test('an unresolved intervention cannot show household changes as final results', () => {
  const f=fixture();snapshotFixture(f);
  f.evaluate("state.result.intervention.status='unresolved';renderImpactSummary();");
  assert.equal(f.element('impact-summary').innerHTML,'');
});

test('tapping a household refreshes the inline inspector even if SVG capture suppresses click', () => {
  const f=fixture();
  f.evaluate('globalThis.redraws=0;renderFrame=()=>{globalThis.redraws++;};');
  const graph=f.element('graph');
  graph.listeners.pointerdown[0]({clientX:10,clientY:20,target:{closest:selector=>selector==='.node'?{getAttribute:()=> 'A02'}:null}});
  assert.equal(f.context.redraws,0,'Do not remove the pressed element before pointerup');
  graph.listeners.pointerup[0]({});
  assert.equal(f.evaluate('state.selected'),'A02');
  assert.equal(f.context.redraws,1);
});
