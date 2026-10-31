const test = require('node:test');
const assert = require('node:assert/strict');
const replay = require('../src/energy_exchange/web/energy-replay.js');
const world = {agents:[{id:'A17',name:'Yash',role:'seller',min_price:6,conditional_price:{floor:4,minimum_kwh:5},time_price:{floor:3,after:'2026-10-29T08:30:00Z'}},{id:'A22',role:'buyer'},{id:'A03',role:'seller'}]};
const quote = (extra={}) => ({id:'q1',type:'offer_sent',actor_id:'A17',counterparty_id:'A22',quantity_kwh:6,price:5.275,delivery_start:'2026-10-29T09:00:00Z',delivery_end:'2026-10-29T10:00:00Z',reason_code:'strategy_quote',...extra});

test('history includes every pair and survives termination, with no future messages after seek',()=>{
  const events=[quote(),quote({id:'q2',actor_id:'A03'}),{id:'done',type:'terminated'}];
  const cards=replay.messages(events,world);
  assert.deepEqual(cards.map(c=>c.id),['q1','q2']);
  assert.deepEqual(replay.visible(cards,0).map(c=>c.id),['q1']);
  assert.equal(replay.visible(cards,2).length,2);
});
test('terms preserve the recorded quote and never borrow a displaced delivery window',()=>{
  const cards=replay.messages([quote(),quote({id:'r',type:'offer_replaced',delivery_start:undefined,delivery_end:undefined,displaced_trade:{delivery_start:'old',delivery_end:'old'}})],world);
  assert.equal(cards[0].terms.price,5.275);
  assert.equal(cards[1].terms.delivery_start,undefined);
});
test('sensitivity uses historical policy and distinguishes eligibility from a realized discount',()=>{
  const updated={agents:world.agents.map(a=>a.id==='A17'?{...a,min_price:8,conditional_price:null,time_price:null}:a)};
  const events=[quote({price:6.5}),{id:'policy',type:'policy_confirmed'},quote({id:'later',price:8})];
  const [before,after]=replay.messages(events,world,updated);
  assert.equal(before.sensitivity.floor,3);
  assert.equal(before.sensitivity.discounted,false);
  assert.equal(before.sensitivity.rules.length,2);
  assert.equal(after.sensitivity.floor,8);
  assert.equal(after.sensitivity.rules.length,0);
});
test('quantity and time requirements do not qualify when the actual terms miss their thresholds',()=>{
  const [card]=replay.messages([quote({quantity_kwh:4,delivery_start:'2026-10-29T08:00:00Z'})],world);
  assert.equal(card.sensitivity.floor,6);
  assert.ok(card.sensitivity.rules.every(r=>!r.eligible));
});
test('same agent color is stable across world ordering and differs for the two participants',()=>{
  assert.equal(replay.color('A17'),replay.color('A17'));
  assert.notEqual(replay.color('A17'),replay.color('A22'));
});
test('animation maps real events to flights without adding future agreement edges',()=>{
  const events=[{type:'started'},quote(),{type:'terminated'}];
  const derived=replay.toDerived(events,world.agents);
  assert.equal(derived.flights.length,1);
  assert.equal(derived.flights[0].tStart,1);
  assert.equal(derived.flights[0].source,'A17');
  assert.equal(derived.agents[0].role,'seller');
  assert.deepEqual(derived.edges,[]);
});

test('ledger outcomes stay in history but are not animated as invented messages',()=>{
  const events=[quote(),quote({id:'reserved',type:'provisional_reserved'}),quote({id:'final',type:'commitment_finalized'})];
  assert.equal(replay.messages(events,world).length,3);
  assert.equal(replay.toDerived(events,world.agents).flights.length,1);
});

test('fit camera includes off-canvas household positions and leaves a label margin',()=>{
  const points=new Map([['A17',{x:210,y:-70}],['A22',{x:690,y:660}]]);
  const view=replay.fitView(points);
  for(const p of points.values()){
    assert.ok(p.x*view.k+view.x>=35&&p.x*view.k+view.x<=865);
    assert.ok(p.y*view.k+view.y>=35&&p.y*view.k+view.y<=545);
  }
});
