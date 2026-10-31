const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const base=path.join(__dirname,'../frontend/vendor/nandatown');
test('vendored source and shipped node artwork exactly match the pinned NandaTown source',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(base,'provenance.json')));
  assert.equal(manifest.commit,'b7adc6121868742cf0f00cfebbf2d38bdb349057');
  for(const [file,hash] of Object.entries(manifest.files)){
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(base,file))).digest('hex'),hash,file);
    if(file.startsWith('nodes/'))assert.deepEqual(fs.readFileSync(path.join(base,file)),fs.readFileSync(path.join(__dirname,'../src/energy_exchange/web/town-assets',path.basename(file))));
  }
});
