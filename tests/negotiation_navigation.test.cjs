const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const web=path.join(__dirname,'../src/energy_exchange/web');

function workspace(t) {
  const dom=new JSDOM(fs.readFileSync(path.join(web,'index.html'),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'http://localhost/'});
  t.after(()=>dom.window.close());
  const context=dom.getInternalVMContext(),evaluate=source=>vm.runInContext(source,context);
  evaluate(fs.readFileSync(path.join(web,'energy-replay.js'),'utf8'));
  evaluate(fs.readFileSync(path.join(web,'collective.js'),'utf8').replace(/\brun\(\);\s*$/,''));
  dom.window.experiment=JSON.parse(fs.readFileSync(path.join(__dirname,'../docs/evidence/sample-experiment.json'),'utf8'));
  evaluate("state.result=experiment;state.config=experiment.world.config;state.view='intervention';state.index=experiment.intervention.events.length-1;initializeAgents();rebuildFrames();renderFrame();");
  return {document:dom.window.document,window:dom.window,evaluate};
}

test('returning to the final step restores recorded conversation details after rewinding',t=>{
  const {document:d,window:w}=workspace(t);
  assert.equal(d.querySelectorAll('#story-detail .conversation-entry').length,1);
  const timeline=d.querySelector('#timeline');
  timeline.value='0';timeline.dispatchEvent(new w.Event('input'));
  assert.equal(d.querySelectorAll('#story-detail .conversation-entry').length,0);
  d.querySelector('#end').click();
  assert.equal(d.querySelectorAll('#story-detail .conversation-entry').length,1);
  assert.ok(d.querySelector('#story-detail details.story-messages'));
});

test('selecting an agreement after a conversation updates the graph to that agreement',t=>{
  const {document:d}=workspace(t);
  d.querySelector('[data-story-kind="other"]').click();
  d.querySelector('[data-story].selected').click();
  assert.match(d.querySelector('.story-message-edge').getAttribute('aria-label'),/A17.*A16|A16.*A17/);
  d.querySelector('[data-pair="A17|A18"]').click();
  assert.equal(d.querySelector('.story-message-edge'),null);
  assert.match(d.querySelector('#graph').textContent,/A17 → A18: 4\.00 → 3\.00 kWh/);
});

test('inspecting a different home clears the conversation emphasis from the graph',t=>{
  const {document:d}=workspace(t);
  d.querySelector('[data-story-kind="other"]').click();
  d.querySelector('[data-story].selected').click();
  d.querySelector('#graph [data-agent="A03"]').dispatchEvent(new d.defaultView.MouseEvent('click',{bubbles:true}));
  assert.equal(d.querySelector('.story-message-edge'),null);
  assert.equal(d.querySelector('#graph [data-agent="A03"]').getAttribute('opacity'),'1');
});

test('activating a purpose keeps keyboard focus on that purpose',t=>{
  const {document:d}=workspace(t);
  const purpose=d.querySelector('[data-story-kind="other"]');
  purpose.focus();purpose.click();
  assert.equal(d.activeElement.dataset.storyKind,'other');
  assert.equal(d.activeElement.getAttribute('aria-pressed'),'true');
});
