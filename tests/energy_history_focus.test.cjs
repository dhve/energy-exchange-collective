const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const web=path.join(__dirname,'../src/energy_exchange/web');
const pause=()=>new Promise(resolve=>setTimeout(resolve,25));

test('keyboard focus on recorded history highlights both homes in the actual Player',async()=>{
  const dom=new JSDOM(fs.readFileSync(path.join(web,'index.html'),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost/'});
  const w=dom.window,d=w.document,context=dom.getInternalVMContext();
  w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
  for(const file of ['energy-replay.js','energy-town.js'])vm.runInContext(fs.readFileSync(path.join(web,file),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(web,'collective.js'),'utf8').replace(/\brun\(\);\s*$/,''),context);
  try{
    vm.runInContext(`
      state.config={population:3};
      state.result={world:{agents:[{id:'A17',role:'seller',min_price:6},{id:'A02',role:'buyer'},{id:'A03',role:'buyer'}]},baseline:{events:[
        {id:'one',type:'offer_sent',actor_id:'A17',counterparty_id:'A02',quantity_kwh:1,price:6},
        {id:'two',type:'offer_sent',actor_id:'A17',counterparty_id:'A03',quantity_kwh:1,price:7},
        {id:'end',type:'terminated'}],trades:[]}};
      state.index=2;rebuildFrames();renderConversation();updateTown();
    `,context);
    for(let i=0;i<40&&!d.querySelector('#energy-town [data-agent]');i++)await pause();
    d.querySelector('.conversation-entry').focus();
    const highlighted=()=>Array.from(d.querySelectorAll('#energy-town [data-highlighted="true"]'),el=>el.dataset.agent).sort();
    for(let i=0;i<40&&highlighted().length!==2;i++)await pause();
    assert.deepEqual(highlighted(),['A02','A17']);
    d.querySelectorAll('.conversation-entry')[1].focus();
    for(let i=0;i<40&&!highlighted().includes('A03');i++)await pause();
    assert.deepEqual(highlighted(),['A03','A17']);
    d.querySelector('#play').focus();
    for(let i=0;i<40&&highlighted().length;i++)await pause();
    assert.deepEqual(highlighted(),[],'Leaving the history restores the final-event view');
  }finally{
    vm.runInContext('state.town?.dispose()',context);
    w.close();
  }
});
