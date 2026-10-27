const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const bridgePath = path.join(__dirname, '../src/energy_exchange/web/streamlit-bridge.js');

function fixture(embedded = true) {
  assert.ok(fs.existsSync(bridgePath), 'The Streamlit transport bridge must exist');
  const sent = [], handlers = {}, timers = new Map();
  const parent = {postMessage: (data, origin) => sent.push({data, origin})};
  const window = {location: {origin: 'http://localhost:8767'},
    addEventListener: (type, fn) => handlers[type] = fn};
  window.parent = embedded ? parent : window;
  const document = {referrer: 'http://localhost:8767/', body: {getBoundingClientRect: () => ({height: 1200})},
    documentElement: {}, addEventListener: (type, fn) => handlers[type] = fn};
  const context = vm.createContext({window, document, URL, console,
    crypto: {randomUUID: () => 'client-1'},
    setTimeout: (fn) => {const id=timers.size+1;timers.set(id,fn);return id;},
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => fn(), ResizeObserver: class {observe() {}}},
    {codeGeneration: {strings: false, wasm: false}});
  vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), context);
  const render = (response, source=parent, origin='http://localhost:8767') => handlers.message({
    source, origin, data:{type:'streamlit:render',args:{response}}});
  return {window, sent, render, timers};
}

test('standalone FastAPI page uses fetch, without Streamlit handshake', () => {
  const f=fixture(false);
  assert.equal(f.window.collectiveTransport, undefined);
  assert.equal(f.sent.length,0);
});

test('bridge waits for render, sends one JSON request and resolves matching response', async () => {
  const f=fixture();
  assert.equal(f.sent[0].data.type,'streamlit:componentReady');
  assert.equal(f.sent[0].data.apiVersion,1);
  const pending=f.window.collectiveTransport('/api/policy',{text:'hello'});
  assert.equal(f.sent.filter(x=>x.data.type==='streamlit:setComponentValue').length,0);
  f.render(null);
  const requests=f.sent.filter(x=>x.data.type==='streamlit:setComponentValue');
  assert.equal(requests.length,1);
  const request=requests[0].data;
  assert.equal(request.isStreamlitMessage,true);
  assert.equal(request.dataType,'json');
  assert.equal(request.value.path,'/api/policy');
  assert.equal(request.value.payload.text,'hello');
  f.render({id:request.value.id,status:200,body:{changes:{min_price:8}}});
  assert.equal((await pending).changes.min_price,8);
  f.render({id:request.value.id,status:200,body:{changes:{min_price:9}}});
  assert.equal(f.sent.filter(x=>x.data.type==='streamlit:setComponentValue').length,1);
});

test('bridge ignores foreign sources and rejects validated server errors', async () => {
  const f=fixture(); f.render(null);
  const pending=f.window.collectiveTransport('/api/experiment',{});
  const request=f.sent.find(x=>x.data.type==='streamlit:setComponentValue').data.value;
  f.render({id:request.id,status:200,body:{unexpected:true}}, {}, 'http://localhost:8767');
  f.render({id:request.id,status:200,body:{unexpected:true}}, undefined, 'https://other.example');
  f.render({id:request.id,status:422,body:{detail:'Explicit confirmation is required'}});
  await assert.rejects(pending,/Explicit confirmation/);
});

test('bridge has bounded pending requests and rejects unsupported routes', async () => {
  const f=fixture();f.render(null);
  await assert.rejects(f.window.collectiveTransport('/api/shell',{}),/Unsupported/);
  const pending=f.window.collectiveTransport('/api/experiment',{});
  for(const fn of [...f.timers.values()])fn();
  await assert.rejects(pending,/timed out/i);
});

test('bridge needs no eval or remote code/assets', () => {
  const f=fixture();f.render(null);
  assert.ok(f.sent.every(x=>x.origin==='http://localhost:8767'));
  // These missing globals deliberately make execution fail if the transport
  // tries dynamic evaluation, script loading, HTTP calls or a remote SDK.
  assert.equal(f.window.eval,undefined);
  assert.equal(f.window.fetch,undefined);
});
