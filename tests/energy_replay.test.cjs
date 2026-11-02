const test = require('node:test');
const assert = require('node:assert/strict');
const replay = require('../src/energy_exchange/web/energy-replay.js');
const world = {agents:[{id:'A17',name:'Yash',role:'seller',min_price:6,conditional_price:{floor:4,minimum_kwh:5},time_price:{floor:3,after:'2026-10-29T08:30:00Z'}},{id:'A22',role:'buyer'},{id:'A03',role:'seller'}]};
const quote = (extra={}) => ({id:'q1',type:'offer_sent',actor_id:'A17',counterparty_id:'A22',quantity_kwh:6,price:5.275,delivery_start:'2026-10-29T09:00:00Z',delivery_end:'2026-10-29T10:00:00Z',reason_code:'strategy_quote',...extra});

test('comparison labels stay separate and include unchanged own trades and an inspected remote trade',()=>{
  const items=Array.from({length:9},(_,i)=>({key:'A'+i,seller:'seller',buyer:'buyer',title:'Yash → Buyer '+i,lines:['2.50 → 2.00 kWh','₹6.65/kWh'],kind:i===1?'unchanged':'revised',own:i<2,focused:i===8}));
  const points=new Map([['seller',{x:300,y:100}],['buyer',{x:400,y:300}]]);
  const labels=replay.comparisonLabels(items,points,1,{left:0,right:880});
  assert.equal(labels.length,6);
  assert.ok(labels.some(l=>l.key==='A1'&&l.title.endsWith('Unchanged')));
  assert.equal(labels[0].key,'A8');
  for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){
    const a=labels[i],b=labels[j];
    assert.ok(Math.abs(a.x-b.x)>=(a.width+b.width)/2||Math.abs(a.y-b.y)>=(a.height+b.height)/2,'Labels must not cover one another');
  }
});

test('Omkar–Harish comparison labels avoid households, names, and every agreement line at different zoom levels',()=>{
  const points=new Map([['A17',{x:430,y:160}],['A18',{x:470,y:450}],['A27',{x:610,y:140}],['A22',{x:610,y:440}],['A02',{x:560,y:320}],['A06',{x:640,y:360}]]);
  const names={A17:'Yash · A17 (you)',A18:'Tanvi · A18',A27:'Omkar · A27',A22:'Harish · A22'};
  const items=[
    {key:'A17|A18',seller:'A17',buyer:'A18',title:'Yash → Tanvi',kind:'removed',own:true,lines:['2.50 → 0.00 kWh','Agreement removed']},
    {key:'A17|A22',seller:'A17',buyer:'A22',title:'Yash → Harish',kind:'removed',own:true,lines:['1.00 → 0.00 kWh','Agreement removed']},
    {key:'A27|A22',seller:'A27',buyer:'A22',title:'Omkar → Harish',kind:'new',lines:['0.00 → 0.88 kWh','₹7.65/kWh']}
  ];
  const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  for(const scale of [1,.6,.4])for(const moved of [false,true]){
    points.set('A22',{x:moved?480:610,y:440});
    const bounds={left:-400,right:1400,top:-150,bottom:1050};
    const labels=replay.comparisonLabels(items,points,scale,bounds,names);
    assert.equal(labels.length,3);
    for(const l of labels){
      const box={left:l.x-l.width/2,right:l.x+l.width/2,top:l.y-l.height/2,bottom:l.y+l.height/2};
      assert.ok(box.left>=bounds.left&&box.right<=bounds.right&&box.top>=bounds.top&&box.bottom<=bounds.bottom);
      for(const [id,p] of points){
        assert.equal(overlaps(box,{left:p.x-22,right:p.x+22,top:p.y-22,bottom:p.y+22}),false,`${l.title} covers ${id}'s node`);
        const half=names[id]?names[id].length*3.5:12;
        assert.equal(overlaps(box,{left:p.x-half,right:p.x+half,top:p.y+22,bottom:p.y+38}),false,`${l.title} covers ${id}'s name`);
      }
      for(const trade of items){
        const a=points.get(trade.seller),b=points.get(trade.buyer);
        // Sample the full connection, not merely its endpoints or midpoint.
        for(let step=0;step<=1000;step++){
          const t=step/1000,x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t;
          assert.ok(x<box.left||x>box.right||y<box.top||y>box.bottom,`${l.title} covers the ${trade.title} line`);
        }
      }
    }
  }
});

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

test('missing delivery or quantity is unknown eligibility, not a failed discount condition',()=>{
  const [card]=replay.messages([quote({type:'offer_replaced',quantity_kwh:undefined,delivery_start:undefined})],world);
  assert.deepEqual(card.sensitivity.rules.map(r=>r.eligible),[null,null]);
  assert.equal(card.sensitivity.floor,null);
  assert.equal(card.sensitivity.discounted,null);
});
