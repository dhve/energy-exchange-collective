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
  const api={messages,visible,color,toDerived,fitView,stories};
  if(typeof module==='object')module.exports=api;else root.EnergyReplay=api;
})(typeof window==='object'?window:globalThis);
