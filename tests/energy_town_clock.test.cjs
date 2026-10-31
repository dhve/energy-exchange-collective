const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function browser(){
  const dom=new JSDOM('<!doctype html><div id="town"></div>',{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost/'});
  dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  for(const file of ['energy-replay.js','energy-town.js'])dom.window.eval(fs.readFileSync(path.join(__dirname,'../src/energy_exchange/web',file),'utf8'));
  return dom;
}
const events=n=>Array.from({length:n},(_,i)=>({id:'event-'+i,type:i===n-1?'terminated':'offer_sent',actor_id:'A17',counterparty_id:'A22',price:5,quantity_kwh:1}));
const agents=[{id:'A17',role:'seller'},{id:'A22',role:'buyer'}];
function model(list,index=0,playing=true){return {events:list,agents,index,playing,speed:100000,selected:'A17',controlled:'A17',trades:[],highlighted:[]};}

test('the actual Player delivers the last cursor before announcing playback stopped',async()=>{
  const dom=browser();let current=model(events(18)),seen=[],stopped=false;
  const town=dom.window.EnergyTown.mount(dom.window.document.querySelector('#town'),{
    onIndex(index){if(current.playing){seen.push(index);current={...current,index};town.update(current);}},
    onStop(){stopped=true;current={...current,playing:false};town.update(current);},onSelect(){}
  });
  try{
    town.update(current);
    for(let i=0;i<50&&!stopped;i++)await sleep(20);
    assert.equal(stopped,true);
    assert.equal(current.index,17,'Stopping must not suppress the final index');
    assert.equal(seen.at(-1),17);
  }finally{town.dispose();dom.window.close();}
});

test('a new intervention starts at its own first event, without inheriting baseline time',async()=>{
  const dom=browser();let current=model(events(70),69,false),seen=[];
  const town=dom.window.EnergyTown.mount(dom.window.document.querySelector('#town'),{
    onIndex(index){if(current.playing){seen.push(index);current={...current,index};town.update(current);}},
    onStop(){current={...current,playing:false};town.update(current);},onSelect(){}
  });
  try{
    town.update(current);await sleep(100);
    current={...model(events(18)),speed:.01};town.update(current);
    await sleep(150);
    assert.equal(current.index,0,'Old baseline time must not appear in the intervention');
    assert.ok(seen.every(index=>index===0));
  }finally{town.dispose();dom.window.close();}
});
