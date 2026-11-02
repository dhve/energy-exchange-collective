/* Recorded energy events adapted for the vendored NandaTown player. No simulation or LLM calls. */
(function(root){
  'use strict';
  const types=new Set(['offer_sent','counteroffer_sent','price_counter','price_counters','offer_accepted','offer_rejected','provisional_reserved','provisional_released','trade_released','offer_replaced','commitment_finalized']);
  function color(id){
    // Stable for a household across runs and views. Names/IDs also identify every node.
    const number=Number(String(id).replace(/\D/g,''));
    const seed=number || [...String(id)].reduce((n,c)=>n*31+c.charCodeAt(0),0);
    return `hsl(${Math.round((seed*137.508)%360)} 48% 36%)`;
  }
  function sensitivity(terms, seller){
    if(!seller)return null;
    const rules=[];let floor=Number(seller.min_price);
    if(seller.conditional_price){
      const p=seller.conditional_price,eligible=terms.quantity_kwh==null?null:Number(terms.quantity_kwh)>=p.minimum_kwh;
      rules.push({kind:'quantity',floor:p.floor,minimum_kwh:p.minimum_kwh,eligible});
      if(eligible)floor=Math.min(floor,p.floor);
    }
    if(seller.time_price){
      const p=seller.time_price,eligible=!terms.delivery_start||!Number.isFinite(Date.parse(terms.delivery_start))?null:Date.parse(terms.delivery_start)>=Date.parse(p.after);
      rules.push({kind:'time',floor:p.floor,after:p.after,eligible});
      if(eligible)floor=Math.min(floor,p.floor);
    }
    if(rules.some(rule=>rule.eligible===null))floor=null;
    return {seller_id:seller.id,ordinaryFloor:seller.min_price,floor,rules,discounted:floor===null?null:terms.price!=null&&Number(terms.price)<Number(seller.min_price)&&Number(terms.price)>=floor};
  }
  function messages(events, world, updatedWorld){
    let profiles=new Map((world?.agents||[]).map(a=>[a.id,a]));
    return events.flatMap((event,index)=>{
      if(event.type==='policy_confirmed'&&updatedWorld)profiles=new Map(updatedWorld.agents.map(a=>[a.id,a]));
      if(!types.has(event.type))return [];
      const terms={...event,...(event.trade||{})};
      const actor=event.actor_id||terms.seller_id,counterparty=event.counterparty_id||terms.buyer_id;
      if(!actor||!counterparty||actor===counterparty)return [];
      const seller=[profiles.get(actor),profiles.get(counterparty)].find(a=>a?.role==='seller');
      return [{id:event.id||`event-${index}`,index,type:event.type,actor,counterparty,event,
        terms:{quantity_kwh:terms.quantity_kwh,price:terms.price,delivery_start:terms.delivery_start,delivery_end:terms.delivery_end},
        sensitivity:sensitivity(terms,seller)}];
    });
  }
  function visible(cards,index){return cards.filter(c=>c.index<=index);}
  function toDerived(events,agents){
    const ids=new Set(agents.map(a=>a.id)),tMax=Math.max(1,events.length-1);
    const flightTypes=new Set(['offer_sent','counteroffer_sent','price_counter','price_counters','offer_accepted','offer_rejected']);
    const flights=messages(events,{agents}).filter(c=>flightTypes.has(c.type)&&ids.has(c.actor)&&ids.has(c.counterparty)).map(c=>({source:c.actor,target:c.counterparty,tStart:c.index,tEnd:Math.min(tMax,c.index+2.2),kind:'send',msg:c.type}));
    return {agents:agents.map(a=>({id:a.id,role:a.role})),agentIndex:new Map(agents.map((a,i)=>[a.id,i])),flights,edges:[],tMin:0,tMax,totalSent:flights.length,totalReceived:flights.length,totalDropped:0,totalBroadcasts:0};
  }
  function fitView(positions){
    const points=[...positions.values()];if(!points.length)return {k:1,x:0,y:0};
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y),left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
    const k=Math.min(1.2,820/Math.max(1,right-left),500/Math.max(1,bottom-top));
    return {k,x:450-(left+right)/2*k,y:290-(top+bottom)/2*k};
  }
  // Summaries are derived only from messages already reached in the replay.
  // A replacement is a new partner approached after that buyer lost an agreement;
  // it is a chronological classification, not an invented private motivation.
  function stories(cards, baseline=[], profiles=[]) {
    const roles=new Map(profiles.map(a=>[a.id,a.role])),lostBuyers=new Set(),groups=new Map();
    let serial=0;const active=new Map();
    const pairOf=c=>roles.get(c.actor)==='buyer'?[c.counterparty,c.actor]:[c.actor,c.counterparty];
    for(const card of cards){
      const [seller,buyer]=pairOf(card),pair=`${seller}|${buyer}`;
      const released=['provisional_released','trade_released'].includes(card.type);
      if(released)lostBuyers.add(buyer);
      const before=baseline.filter(t=>t.seller_id===seller&&t.buyer_id===buyer);
      const kind=released?'disrupted':before.length?'renegotiated':lostBuyers.has(buyer)?'replacement':'other';
      let id;
      if(released){id=`disrupted:${pair}:${serial++}`;}
      else {
        if(card.type==='offer_sent'||!active.has(pair))active.set(pair,`${kind}:${pair}:${serial++}`);
        id=active.get(pair);
      }
      if(!groups.has(id))groups.set(id,{id,kind,seller,buyer,before,cards:[],dimensions:new Set(),attempts:0});
      const group=groups.get(id);group.cards.push(card);
      if(card.type==='offer_sent')group.attempts++;
      for(const dimension of card.event.negotiation?.changed||[])group.dimensions.add(dimension);
      const previous=group.cards.at(-2)?.terms;
      if(previous&&card.type==='counteroffer_sent'){
        if(previous.price!==card.terms.price)group.dimensions.add('price');
        if(previous.quantity_kwh!==card.terms.quantity_kwh)group.dimensions.add('quantity');
        if(previous.delivery_start!==card.terms.delivery_start||previous.delivery_end!==card.terms.delivery_end)group.dimensions.add('delivery');
      }
    }
    const episodes=[...groups.values()].map(group=>{
      const last=group.cards.at(-1),reserved=group.cards.filter(c=>['provisional_reserved','offer_replaced','commitment_finalized'].includes(c.type));
      const outcome=group.kind==='disrupted'?'Released':reserved.length?'Agreement recorded':last.type==='offer_accepted'?'Terms accepted':last.type==='offer_rejected'?'Declined':'In progress';
      return {...group,dimensions:[...group.dimensions],last,outcome,reserved};
    });
    // Repeated failed attempts share a card; successful exchanges stay separate.
    const merged=new Map();
    for(const episode of episodes){
      const key=episode.outcome==='Declined'?`${episode.kind}:${episode.seller}:${episode.buyer}:declined`:episode.id;
      const existing=merged.get(key);
      if(!existing){merged.set(key,episode);continue;}
      existing.cards.push(...episode.cards);existing.attempts+=episode.attempts;existing.last=episode.last;
      existing.dimensions=[...new Set([...existing.dimensions,...episode.dimensions])];
    }
    return [...merged.values()];
  }
  function labelObstacles(positions,names,scale) {
    const padding=6/scale;
    return [...positions].map(([id,p])=>({id,left:p.x-Math.max(24,String(names[id]||id).length*3.8)-padding,
      right:p.x+Math.max(24,String(names[id]||id).length*3.8)+padding,top:p.y-28-padding,bottom:p.y+46+padding}));
  }
  function lineCrossesBox(a,b,box,padding=0) {
    let enter=0,exit=1;
    for(const [axis,low,high] of [['x','left','right'],['y','top','bottom']]){
      const delta=b[axis]-a[axis],min=box[low]-padding,max=box[high]+padding;
      if(Math.abs(delta)<1e-9){if(a[axis]<min||a[axis]>max)return false;continue;}
      const t1=(min-a[axis])/delta,t2=(max-a[axis])/delta;
      enter=Math.max(enter,Math.min(t1,t2));exit=Math.min(exit,Math.max(t1,t2));
      if(enter>exit)return false;
    }
    return true;
  }
  function agreementLines(pairs,positions) {
    return pairs.flatMap(([from,to])=>{const a=positions.get(from),b=positions.get(to);return a&&b?[{a,b}]:[];});
  }
  function placeLabel(anchor,width,height,index,placed,obstacles,bounds,scale,parties,lines) {
    const gap=8/scale,halfW=width/2,halfH=height/2;
    const controls=Number.isFinite(bounds?.bottom)?{left:bounds.left,right:bounds.left+150/scale,top:bounds.bottom-64/scale,bottom:bounds.bottom}:null;
    const preferred={x:anchor.x+(index%2?1:-1)*(halfW+24/scale),y:anchor.y};
    const candidates=[preferred,{x:anchor.x-(preferred.x-anchor.x),y:anchor.y}];
    const blocks=[...obstacles,...placed,...(controls?[controls]:[]),...lines.map(({a,b})=>({left:Math.min(a.x,b.x),right:Math.max(a.x,b.x),top:Math.min(a.y,b.y),bottom:Math.max(a.y,b.y)}))];
    for(const b of blocks){
      const xs=[b.left-halfW-gap,b.right+halfW+gap],ys=[b.top-halfH-gap,b.bottom+halfH+gap];
      for(const x of xs){candidates.push({x,y:anchor.y});for(const y of ys)candidates.push({x,y});}
      for(const y of ys)candidates.push({x:preferred.x,y},{x:anchor.x,y});
    }
    if(bounds){
      const xs=[bounds.left+halfW+gap,bounds.right-halfW-gap];
      for(const x of xs){candidates.push({x,y:anchor.y});if(Number.isFinite(bounds.top)&&Number.isFinite(bounds.bottom))for(const y of [bounds.top+halfH+gap,bounds.bottom-halfH-gap])candidates.push({x,y});}
      if(Number.isFinite(bounds.top)&&Number.isFinite(bounds.bottom))for(const x of xs)for(let y=bounds.top+halfH+gap;y<=bounds.bottom-halfH-gap;y+=12/scale)candidates.push({x,y});
    }
    const area=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
    let best,bestScore=Infinity;
    for(const candidate of candidates){
      let {x,y}=candidate;
      if(bounds){
        x=Math.max(bounds.left+halfW+gap,Math.min(bounds.right-halfW-gap,x));
        if(Number.isFinite(bounds.top))y=Math.max(bounds.top+halfH+gap,y);
        if(Number.isFinite(bounds.bottom))y=Math.min(bounds.bottom-halfH-gap,y);
      }
      const box={left:x-halfW,right:x+halfW,top:y-halfH,bottom:y+halfH};
      if(controls&&area(box,controls)>0)continue;
      if(placed.some(b=>area(box,b)>0))continue;
      // A callout may move farther away, but must never hide an agreement segment.
      if(lines.some(({a,b})=>lineCrossesBox(a,b,box,6/scale)))continue;
      let score=Math.hypot(x-anchor.x,y-anchor.y)+Math.hypot(x-preferred.x,y-preferred.y)*.15;
      for(const b of obstacles)score+=area(box,b)*(parties.includes(b.id)?1e6:1e4);
      for(const b of placed)score+=area(box,b)*1e7;
      if(score<bestScore){bestScore=score;best={x,y,...box};}
    }
    // In a fully crowded viewport, leave the trade visible and its terms inspectable
    // instead of placing an obstructing label. Zooming can expose a clear position.
    if(!best)return null;
    placed.push({left:best.left-gap,right:best.right+gap,top:best.top-gap,bottom:best.bottom+gap});
    return {x:best.x,y:best.y};
  }
  // Labels only for the controlled home's actual agreements at this replay step.
  function agreementLabels(trades,home,agents,positions,scale=1,bounds=null) {
    const name=id=>(agents.find(a=>a.id===id)?.name||id).split(' (')[0];
    const number=n=>Number(n).toFixed(2),placed=[];
    const names=Object.fromEntries(agents.map(a=>[a.id,`${name(a.id)} · ${a.id}${a.id===home?' (you)':''}`]));
    const obstacles=labelObstacles(positions,names,scale);
    const lines=agreementLines(trades.map(t=>[t.seller_id,t.buyer_id]),positions);
    return trades.filter(t=>t.seller_id===home||t.buyer_id===home).sort((a,b)=>`${a.seller_id}|${a.buyer_id}|${a.delivery_start||''}`.localeCompare(`${b.seller_id}|${b.buyer_id}|${b.delivery_start||''}`)).flatMap((t,i)=>{
      const a=positions.get(t.seller_id),b=positions.get(t.buyer_id);if(!a||!b)return [];
      const title=`${name(t.seller_id)} → ${name(t.buyer_id)}`;
      const terms=`${number(t.quantity_kwh)} kWh · ₹${number(t.price)}/kWh`;
      const width=(Math.max(title.length,terms.length)*6.5+22)/scale,height=44/scale;
      const anchor={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      const location=placeLabel(anchor,width,height,i,placed,obstacles,bounds,scale,[t.seller_id,t.buyer_id],lines);if(!location)return [];
      const {x,y}=location;
      return [{trade:t,title,terms,x,y,width,height,anchor}];
    });
  }
  function comparisonLabels(items,positions,scale=1,bounds=null,names={}) {
    const placed=[];
    const obstacles=labelObstacles(positions,names,scale);
    const segments=agreementLines(items.map(t=>[t.seller,t.buyer]),positions);
    // Keep the controlled home's trades prominent; a selected edge takes priority.
    const shown=items.filter(t=>t.own||t.focused||t.kind!=='unchanged').sort((a,b)=>Number(b.focused)-Number(a.focused)||Number(b.own)-Number(a.own)||a.key.localeCompare(b.key)).slice(0,6);
    return shown.flatMap((item,i)=>{
      const a=positions.get(item.seller),b=positions.get(item.buyer);if(!a||!b)return [];
      const title=`${item.title} · ${item.kind[0].toUpperCase()+item.kind.slice(1)}`;
      const lines=item.lines,width=(Math.max(title.length,...lines.map(s=>s.length))*6.2+22)/scale,height=64/scale;
      const anchor={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      const location=placeLabel(anchor,width,height,i,placed,obstacles,bounds,scale,[item.seller,item.buyer],segments);if(!location)return [];
      const {x,y}=location;
      return [{...item,title,x,y,width,height,anchor}];
    });
  }
  const api={messages,visible,color,toDerived,fitView,stories,agreementLabels,comparisonLabels};
  if(typeof module==='object')module.exports=api;else root.EnergyReplay=api;
})(typeof window==='object'?window:globalThis);
