const test=require('node:test');
const assert=require('node:assert/strict');
const replay=require('../src/energy_exchange/web/energy-replay.js');
const agents=[{id:'S',role:'seller'},{id:'B',role:'buyer'},{id:'L',role:'seller'}];
const baseline=[{seller_id:'S',buyer_id:'B',quantity_kwh:2.5,price:6.65}];
const event=(type,actor_id,counterparty_id,quantity_kwh=.5,price=6.3)=>({type,actor_id,counterparty_id,quantity_kwh,price});
const events=[event('provisional_released','S','B',2.5,6.65),event('offer_sent','S','B',2,6.75),event('counteroffer_sent','B','S',2,6.55),event('offer_accepted','S','B',2,6.55),event('provisional_reserved','B','S',2,6.55),event('offer_sent','B','L'),event('offer_rejected','L','B'),event('offer_sent','B','L'),event('offer_rejected','L','B'),{type:'terminated'}];
const cards=replay.messages(events,{agents});
const at=index=>replay.stories(replay.visible(cards,index),baseline,agents);
test('reserve change separates disruption, renegotiation and failed replacement with real terms',()=>{
 const stories=at(9);assert.equal(stories.length,3);
 const [release,repair,replacement]=stories;
 assert.equal(release.kind,'disrupted');assert.equal(release.outcome,'Released');
 assert.equal(repair.kind,'renegotiated');assert.equal(repair.outcome,'Agreement recorded');assert.deepEqual(repair.dimensions,['price']);
 assert.equal(replacement.kind,'replacement');assert.equal(replacement.outcome,'Declined');assert.equal(replacement.attempts,2);assert.equal(replacement.cards.length,4);assert.equal(replacement.last.terms.quantity_kwh,.5);
});
test('rewinding never reveals future attempts or outcomes',()=>{
 assert.equal(at(0).length,1);assert.equal(at(1)[1].outcome,'In progress');
 assert.equal(at(5)[2].outcome,'In progress');assert.equal(at(5)[2].attempts,1);
 assert.equal(at(3)[1].outcome,'Terms accepted');
});
test('successful and unsuccessful attempts with same seller remain separate',()=>{
 const expanded=[...events.slice(0,-1),event('offer_sent','B','L'),event('offer_accepted','L','B'),event('provisional_reserved','B','L')];
 const replacements=replay.stories(replay.messages(expanded,{agents}),baseline,agents).filter(s=>s.kind==='replacement');
 assert.equal(replacements.length,2);assert.deepEqual(replacements.map(s=>s.outcome),['Declined','Agreement recorded']);
});
test('an unrelated new buyer is not labelled a replacement without a prior loss',()=>{
 const stories=replay.stories(replay.messages([event('offer_sent','B','L')],{agents}),baseline,agents);
 assert.equal(stories[0].kind,'other');
});
test('quantity and delivery changes are labelled from recorded counteroffer terms',()=>{
 const first={...event('offer_sent','B','L',2),delivery_start:'2026-10-28T09:00:00Z',delivery_end:'2026-10-28T10:00:00Z'};
 const second={...event('counteroffer_sent','L','B',1),delivery_start:'2026-10-28T10:00:00Z',delivery_end:'2026-10-28T11:00:00Z'};
 const story=replay.stories(replay.messages([first,second],{agents}),baseline,agents)[0];
 assert.deepEqual(story.dimensions,['quantity','delivery']);
});
test('releasing a displaced agreement does not split the successful exchange',()=>{
 const extra=[...agents,{id:'C',role:'buyer'}];
 const sequence=[event('offer_sent','B','L'),event('offer_accepted','L','B'),event('offer_replaced','L','B'),event('provisional_released','L','C'),event('provisional_reserved','B','L')];
 const stories=replay.stories(replay.messages(sequence,{agents:extra}),baseline,extra);
 const success=stories.filter(s=>s.seller==='L'&&s.buyer==='B');
 assert.equal(success.length,1);assert.equal(success[0].cards.length,4);assert.equal(success[0].outcome,'Agreement recorded');
});
