import React, {useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from './generated/NandaTown';
const replay=(window as any).EnergyReplay;
function ComparisonLabels({items,positions,scale,bounds,names,onPlaced}:any){
  const labels=replay.comparisonLabels(items,positions,scale,bounds,names);
  const keys=labels.map((l:any)=>l.key).sort().join('\n');
  useEffect(()=>onPlaced(keys),[keys,onPlaced]);
  return <g className="comparison-labels" pointerEvents="none">{labels.map((l:any)=><g key={l.key} aria-label={l.description}>
    <path d={`M${l.anchor.x},${l.anchor.y} L${l.x},${l.y}`} stroke={l.color} strokeWidth={1/scale}/>
    <rect x={l.x-l.width/2} y={l.y-l.height/2} width={l.width} height={l.height} rx={6/scale} fill="#fffef9" stroke={l.color} strokeWidth={1.5/scale}/>
    {[l.title,...l.lines].map((line:string,i:number)=><text key={i} x={l.x} y={l.y+(i-1)*17/scale+4/scale} textAnchor="middle" fontSize={12/scale} fontWeight={i===0?700:500} fill={l.color}>{line}</text>)}
  </g>)}</g>;
}
const agreementKey=(t:any)=>t.id || `${t.seller_id}|${t.buyer_id}|${t.delivery_start||''}|${t.delivery_end||''}`;
function AgreementLabels({model,positions,scale,bounds,onPlaced}:any){
  const labels=replay.agreementLabels(model.trades,model.controlled,model.agents,positions,scale,bounds);
  const keys=labels.map((l:any)=>agreementKey(l.trade)).sort().join('\n');
  useEffect(()=>onPlaced(keys),[keys,onPlaced]);
  return <g className="own-agreement-labels" pointerEvents="none">{labels.map((l:any,i:number)=><g key={l.trade.id||i} aria-label={`${l.title}: ${l.terms}`}>
      <path d={`M${l.anchor.x},${l.anchor.y} L${l.x},${l.y}`} stroke="#315d49" strokeWidth={1/scale}/>
      <rect x={l.x-l.width/2} y={l.y-l.height/2} width={l.width} height={l.height} rx={6/scale} fill="#fffef9" stroke="#315d49" strokeWidth={1.5/scale}/>
      <text x={l.x} y={l.y-5/scale} textAnchor="middle" fontSize={12/scale} fontWeight={700} fill="#264b38">{l.title}</text>
      <text x={l.x} y={l.y+12/scale} textAnchor="middle" fontSize={12/scale} fill="#264b38">{l.terms}</text>
    </g>)}</g>;
}
function ConversationEdge({story,positions,trades}:any){
  if(!story)return null;
  // A dashed conversation is separate from any final energy agreement.
  const card=story.cards?.findLast((c:any)=>['offer_sent','counteroffer_sent','offer_accepted','offer_rejected'].includes(c.type)) || story.last;
  if(!card || (story.outcome==='Agreement recorded'&&trades.some((t:any)=>t.seller_id===story.seller&&t.buyer_id===story.buyer)))return null;
  const a=positions.get(card.actor),b=positions.get(card.counterparty);if(!a||!b)return null;
  return <line className="story-message-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#79548f" strokeWidth={4} strokeDasharray="8 6" vectorEffect="non-scaling-stroke" aria-label={`${card.actor} to ${card.counterparty}: ${story.outcome}, ${card.terms.quantity_kwh ?? 0} kWh`}><title>{`${story.outcome} conversation: ${card.terms.quantity_kwh ?? 0} kWh`}</title></line>;
}
function Town({model,callbacks}:any){
  const [time,setTime]=useState(model.index),[playing,setPlaying]=useState(model.playing);
  const [placedKeys,setPlacedKeys]=useState('');
  const lastReported=useRef(model.index);
  const [reducedMotion,setReducedMotion]=useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(()=>{const query=matchMedia('(prefers-reduced-motion: reduce)');const change=()=>setReducedMotion(query.matches);query.addEventListener('change',change);return()=>query.removeEventListener('change',change);},[]);
  const derived=useMemo(()=>replay.toDerived(model.events,model.agents),[model.events,model.agents]);
  useEffect(()=>{
    if(model.index!==lastReported.current){lastReported.current=model.index;setTime(model.index);}
    setPlaying(model.playing);
  },[model.events,model.index,model.playing]);
  useEffect(()=>{
    const index=Math.min(model.events.length-1,Math.floor(time));
    if(index!==lastReported.current){lastReported.current=index;callbacks.onIndex(index);}
    // Publish the final frame before changing the parent playback state.
    if(time>=derived.tMax && model.playing)callbacks.onStop();
  },[time,derived,callbacks]);
  const colors=useMemo(()=>Object.fromEntries(model.agents.map((a:any)=>[a.id,replay.color(a.id)])),[model.agents]);
  const labels=useMemo(()=>Object.fromEntries(model.agents.map((a:any)=>[a.id,`${a.name||a.role}, ${a.id}${a.id===model.controlled?', your home':''}`])),[model.agents,model.controlled]);
  const ownIds=new Set(model.trades.filter((t:any)=>[t.seller_id,t.buyer_id].includes(model.controlled)).flatMap((t:any)=>[t.seller_id,t.buyer_id]));
  for(const t of model.comparison||[])if(t.own||t.kind!=='unchanged'){ownIds.add(t.seller);ownIds.add(t.buyer);}
  for(const id of model.highlighted||[])ownIds.add(id);
  const agreementNames=Object.fromEntries(model.agents.filter((a:any)=>ownIds.has(a.id)||a.id===model.controlled).map((a:any)=>[a.id,`${(a.name||a.id).split(' (')[0]} · ${a.id}${a.id===model.controlled?' (you)':''}`]));
  const energy={agreementNames,fit:replay.fitView,colors,labels,reducedMotion,selected:model.selected,controlled:model.controlled,highlighted:model.highlighted||[],onSelect:callbacks.onSelect,
    agreementLabels:(positions:Map<string,any>,scale:number,bounds:any)=>{scale=Math.max(.25,scale);
      if(model.comparison)return <ComparisonLabels items={model.comparison} positions={positions} scale={scale} bounds={bounds} names={agreementNames} onPlaced={setPlacedKeys}/>;
      return <AgreementLabels model={model} positions={positions} scale={scale} bounds={bounds} onPlaced={setPlacedKeys}/>},
    overlay:(positions:Map<string,any>)=>model.comparison?<g className="town-comparison">{model.comparison.map((t:any)=>{
      const a=positions.get(t.seller),b=positions.get(t.buyer);if(!a||!b)return null;
      const changed=t.kind!=='unchanged',strong=changed||t.own||t.focused;
      const select=()=>callbacks.onPair(t.key);
      return <g key={t.key} role="button" tabIndex={0} aria-label={t.description} onClick={select} onKeyDown={e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();select();}}} style={{cursor:'pointer'}}>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={16}/>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={t.color} strokeWidth={t.focused?6:t.own?4.5:changed?3.5:1.1} strokeDasharray={t.kind==='removed'?'8 6':undefined} opacity={strong?1:.15}/>
        <title>{t.description}</title>
      </g>;
    })}</g>:<g className="town-agreements">{model.trades.map((t:any)=>{const a=positions.get(t.seller_id),b=positions.get(t.buyer_id);if(!a||!b)return null;
      const focused=[t.seller_id,t.buyer_id].includes(model.selected),highlighted=(model.highlighted||[]).includes(t.seller_id)&&(model.highlighted||[]).includes(t.buyer_id);
      const own=[t.seller_id,t.buyer_id].includes(model.controlled);
      return <line key={t.id||`${t.seller_id}-${t.buyer_id}`} data-own-agreement={own||undefined} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={highlighted?'#79548f':own?'#315d49':'#526d58'} strokeWidth={highlighted?6:own?4.5:focused?2:1.1} opacity={own?1:highlighted ? .85 : focused ? .5 : .18}><title>{`${t.seller_id} to ${t.buyer_id}: ${t.quantity_kwh} kWh at ₹${t.price}/kWh`}</title></line>;
    })}<ConversationEdge story={model.conversation} positions={positions} trades={model.trades}/></g>};
  // Upstream's clock is 18 seconds per trace. Scale playback to leave messages readable.
  const duration=Math.max(30,Math.min(180,model.events.length*.45));
  const overflow=replay.comparisonOverflow(model.comparison||[],placedKeys.split('\n'));
  const ownOverflow=model.comparison?[]:model.trades.filter((t:any)=>[t.seller_id,t.buyer_id].includes(model.controlled)&&!placedKeys.split('\n').includes(agreementKey(t)));
  const shortName=(id:string)=>(model.agents.find((a:any)=>a.id===id)?.name||id).split(' (')[0];
  return <><Player derived={derived} simTime={time} setSimTime={setTime} playing={playing} setPlaying={setPlaying} speed={model.speed*18/duration} setSpeed={()=>{}} energy={energy}/>
    {overflow.length>0&&<div className="comparison-overflow" aria-label="Trade labels below the map">{overflow.map((t:any)=><button key={t.key} type="button" aria-label={t.description} style={{borderColor:t.color,color:t.color}} onClick={()=>callbacks.onPair(t.key)}>
      <strong>{t.title} · {t.kind[0].toUpperCase()+t.kind.slice(1)}</strong>{t.lines.map((line:string,i:number)=><span key={i}>{line}</span>)}
    </button>)}</div>}
    {ownOverflow.length>0&&<div className="comparison-overflow own-trade-overflow" aria-label="Your agreements below the map">{ownOverflow.map((t:any)=><button key={agreementKey(t)} type="button" style={{borderColor:'#315d49',color:'#315d49'}} onClick={()=>callbacks.onPair(`${t.seller_id}|${t.buyer_id}`)}>
      <strong>{shortName(t.seller_id)} → {shortName(t.buyer_id)}</strong><span>{Number(t.quantity_kwh).toFixed(2)} kWh · ₹{Number(t.price).toFixed(2)}/kWh</span>
    </button>)}</div>}
  </>;
}
(window as any).EnergyTown={mount(element:HTMLElement,callbacks:any){
  const root=createRoot(element);let previousEvents:any=null,runKey=0;
  return {
    update(model:any){
      // A new run starts with its own cursor and force simulation.
      if(previousEvents!==model.events){previousEvents=model.events;runKey++;}
      root.render(<Town key={runKey} model={model} callbacks={callbacks}/>);
    },
    dispose(){root.unmount();}
  };
}};
