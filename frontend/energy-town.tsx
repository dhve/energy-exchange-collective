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
  const energy={fit:replay.fitView,colors,labels,reducedMotion,selected:model.selected,controlled:model.controlled,highlighted:model.highlighted||[],onSelect:callbacks.onSelect,
    overlay:(positions:Map<string,any>)=><g className="town-agreements">{model.trades.map((t:any)=>{const a=positions.get(t.seller_id),b=positions.get(t.buyer_id);if(!a||!b)return null;
      const focused=[t.seller_id,t.buyer_id].includes(model.selected),highlighted=(model.highlighted||[]).includes(t.seller_id)&&(model.highlighted||[]).includes(t.buyer_id);
      return <line key={t.id||`${t.seller_id}-${t.buyer_id}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={highlighted?'#C45A3C':'#526d58'} strokeWidth={highlighted?3:focused?2:1.1} opacity={highlighted ? .85 : focused ? .5 : .18}><title>{`${t.seller_id} to ${t.buyer_id}: ${t.quantity_kwh} kWh at ₹${t.price}/kWh`}</title></line>;
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
