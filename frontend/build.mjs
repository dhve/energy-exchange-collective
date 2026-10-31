import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
const base='frontend/vendor/nandatown',out='src/energy_exchange/web';
const manifest=JSON.parse(await readFile(`${base}/provenance.json`,'utf8'));
for(const [path,hash] of Object.entries(manifest.files)){
  const actual=createHash('sha256').update(await readFile(`${base}/${path}`)).digest('hex');
  if(actual!==hash)throw Error(`Upstream source changed: ${path}`);
}
await mkdir('frontend/generated',{recursive:true});
const original=await readFile(`${base}/page.tsx`,'utf8');
let source="import React, {useCallback,useEffect,useMemo,useRef,useState} from 'react';\nimport * as d3 from 'd3';\n"+original.split('\n').slice(12,1758).join('\n');
function patch(before,after){
  if(source.split(before).length!==2)throw Error(`Adaptation must match exactly once: ${before.slice(0,70)}`);
  source=source.replace(before,after);
}
// These are integration hooks. The force, flight, ripple, drag, zoom and clock algorithms remain upstream.
source=source.replaceAll('/brand/nodes/','./town-assets/');
patch('interface PlayerProps {','interface PlayerProps {\n  energy?: any;');
patch('function Player({\n  derived,','function Player({\n  energy,\n  derived,');
patch('  const [view, setView] = useState({ k: 1, x: 0, y: 0 });', '  const [view, setView] = useState(energy ? {k:0.68,x:144,y:92.8} : {k:1,x:0,y:0});');
patch('  const resetView = () => setView({ k: 1, x: 0, y: 0 });', '  const resetView = () => setView(energy ? energy.fit(positionsRef.current) : { k: 1, x: 0, y: 0 });');
patch('                      fontSize={9}', '                      fontSize={energy ? 13 : 9}');
patch('    simRef.current = sim;',`    if (energy?.reducedMotion) {
      sim.stop(); sim.tick(300);
      for (const node of nodes) positionsRef.current.set(node.id, {x: node.x ?? 0, y: node.y ?? 0});
    }
    if (energy) {
      sim.on('end', () => setView(energy.fit(positionsRef.current)));
      if (energy.reducedMotion) setView(energy.fit(positionsRef.current));
    }
    simRef.current = sim;`);
patch('      sim.stop();\n    };\n  }, [derived]);','      sim.stop();\n    };\n  }, [derived, energy?.reducedMotion]);');
patch('    <div className="space-y-4">','    <div className={energy ? "nanda-player" : "space-y-4"}>');
patch('          ref={svgRef}','          ref={svgRef}\n          role="group" aria-label="Animated energy marketplace"');
patch('            {/* Static edges', '            {energy?.overlay?.(positions)}\n            {/* Static edges');
patch('              {ripples.map(', '              {(energy?.reducedMotion ? [] : ripples).map(');
patch('              {inFlight.map(', '              {(energy?.reducedMotion ? [] : inFlight).map(');
patch('              const isFocus = focused === a.id;', '              const isFocus = energy ? energy.highlighted.includes(a.id) || energy.selected === a.id : focused === a.id;');
patch('              const dimmed =\n', '              const dimmed = energy ? energy.highlighted.length > 0 && !energy.highlighted.includes(a.id) :\n');
patch('              const color = roleColor(a.role);','              const color = energy?.colors[a.id] ?? roleColor(a.role);');
patch('                derived.agents.length <= 24 || isHover || isFocus;', '                !!energy || derived.agents.length <= 24 || isHover || isFocus;');
patch('                  data-agent={a.id}',`                  data-agent={a.id}
                  data-highlighted={energy?.highlighted.includes(a.id) || undefined}
                  tabIndex={energy ? 0 : undefined} role={energy ? 'button' : undefined}
                  aria-label={energy?.labels[a.id]}
                  onKeyDown={(e) => {if (energy && ['Enter',' '].includes(e.key)) {e.preventDefault();energy.onSelect(a.id);}}}
                  onClick={() => energy?.onSelect(a.id)}`);
patch('                  {(active || isHover || isFocus) && (',`                  {energy && <circle cx={pos.x} cy={pos.y} r={size * 0.85} fill={color} fillOpacity={0.08} stroke={color} strokeWidth={energy.controlled === a.id ? 3 : 1.5} />}
                  {(active || isHover || isFocus) && (`);
patch('                      {a.id}\n', '                      {energy?.controlled === a.id ? `${a.id} (you)` : a.id}\n');
patch('        {tooltipTarget && tooltipPos && tooltipStats && (','        {!energy && tooltipTarget && tooltipPos && tooltipStats && (');
patch('className="absolute left-4 top-4', 'className="nanda-clock absolute left-4 top-4');
patch('className="absolute right-4 top-4', 'className="nanda-counters absolute right-4 top-4');
patch('        {focused && (', '        {!energy && focused && (');
await writeFile('frontend/generated/NandaTown.tsx','/* Generated from the pinned Apache-2.0 source. See frontend/build.mjs for adaptations. */\n'+source+'\nexport {Player};\n');
const globals=await readFile(`${base}/globals.css`,'utf8');
const theme=globals.slice(globals.indexOf('@theme inline'),globals.indexOf('\nhtml {'));
await writeFile('frontend/generated/town.css','@import "tailwindcss/theme.css";\n@import "tailwindcss/utilities.css" source(none);\n@source "./NandaTown.tsx";\n'+theme);
await build({entryPoints:['frontend/energy-town.tsx'],bundle:true,minify:true,format:'iife',target:'es2020',jsx:'automatic',outfile:`${out}/energy-town.js`,legalComments:'linked',define:{'process.env.NODE_ENV':'"production"'}});
execFileSync('node',['node_modules/@tailwindcss/cli/dist/index.mjs','-i','frontend/generated/town.css','-o',`${out}/energy-town.css`,'--minify'],{stdio:'inherit'});
await cp(`${base}/nodes`,`${out}/town-assets`,{recursive:true});
await cp(`${base}/LICENSE`,`${out}/town-assets/LICENSE.txt`);
console.log(`Built actual NandaTown Player from ${manifest.commit}. Verified ${Object.keys(manifest.files).length} source files.`);
