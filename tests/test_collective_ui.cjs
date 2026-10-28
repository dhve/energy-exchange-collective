// Product regression harness. Run: node --test tests/test_collective_ui.cjs
// Executes the actual collective.js with a small DOM and a deferred API response.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function fixture() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', hidden: false, disabled: false, listeners: {},
      classList: {toggle() {}, add() {}, remove() {}},
      setAttribute() {}, addEventListener(type, callback) {
        (this.listeners[type] ||= []).push(callback);
      },
      dispatch(type) { for (const callback of this.listeners[type] || []) callback({target: this}); },
      reportValidity() { return true; },
      focus() {},
      append(child) { (this.children ||= []).push(child); },
      attributes: new Set(),
      toggleAttribute(name, force) { if (force) this.attributes.add(name); else this.attributes.delete(name); },
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    console, setInterval, clearInterval, setTimeout, Blob, URL,
    document: {getElementById: element, querySelectorAll: () => [], createElement: tag => ({tag,click(){}})},
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
