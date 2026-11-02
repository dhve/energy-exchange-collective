import React, {useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from './generated/NandaTown';
const replay=(window as any).EnergyReplay;
function Town({model,callbacks}:any){
  const [time,setTime]=useState(model.index),[playing,setPlaying]=useState(model.playing);
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
  const agreementNames=Object.fromEntries(model.agents.filter((a:any)=>ownIds.has(a.id)||a.id===model.controlled).map((a:any)=>[a.id,`${(a.name||a.id).split(' (')[0]} · ${a.id}${a.id===model.controlled?' (you)':''}`]));
  const energy={agreementNames,fit:replay.fitView,colors,labels,reducedMotion,selected:model.selected,controlled:model.controlled,highlighted:model.highlighted||[],onSelect:callbacks.onSelect,
    agreementLabels:(positions:Map<string,any>,scale:number,bounds:any)=>{scale=Math.max(.25,scale);return <g className="own-agreement-labels" pointerEvents="none">{replay.agreementLabels(model.trades,model.controlled,model.agents,positions,scale,bounds).map((l:any,i:number)=><g key={l.trade.id||i} aria-label={`${l.title}: ${l.terms}`}>
      <path d={`M${l.anchor.x},${l.anchor.y} L${l.x},${l.y}`} stroke="#315d49" strokeWidth={1/scale}/>
      <rect x={l.x-l.width/2} y={l.y-l.height/2} width={l.width} height={l.height} rx={6/scale} fill="#fffef9" stroke="#315d49" strokeWidth={1.5/scale}/>
      <text x={l.x} y={l.y-5/scale} textAnchor="middle" fontSize={12/scale} fontWeight={700} fill="#264b38">{l.title}</text>
      <text x={l.x} y={l.y+12/scale} textAnchor="middle" fontSize={12/scale} fill="#264b38">{l.terms}</text>
    </g>)}</g>;},
    overlay:(positions:Map<string,any>)=><g className="town-agreements">{model.trades.map((t:any)=>{const a=positions.get(t.seller_id),b=positions.get(t.buyer_id);if(!a||!b)return null;
      const focused=[t.seller_id,t.buyer_id].includes(model.selected),highlighted=(model.highlighted||[]).includes(t.seller_id)&&(model.highlighted||[]).includes(t.buyer_id);
      const own=[t.seller_id,t.buyer_id].includes(model.controlled);
      return <line key={t.id||`${t.seller_id}-${t.buyer_id}`} data-own-agreement={own||undefined} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={own?'#315d49':highlighted?'#C45A3C':'#526d58'} strokeWidth={own?4.5:highlighted?3:focused?2:1.1} opacity={own?1:highlighted ? .85 : focused ? .5 : .18}><title>{`${t.seller_id} to ${t.buyer_id}: ${t.quantity_kwh} kWh at ₹${t.price}/kWh`}</title></line>;
    })}</g>};
  // Upstream's clock is 18 seconds per trace. Scale playback to leave messages readable.
  const duration=Math.max(30,Math.min(180,model.events.length*.45));
  return <Player derived={derived} simTime={time} setSimTime={setTime} playing={playing} setPlaying={setPlaying} speed={model.speed*18/duration} setSpeed={()=>{}} energy={energy}/>;
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
