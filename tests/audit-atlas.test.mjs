import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assemble, districtRows, report, writeExport, mapSvg } from '../atlas/export.mjs';

function pages() {
  const meta = { schemaVersion: 1, snapshotId: 'fixture-snapshot', citySession: 'fixture-city',
    simulationFrame: 42, capturedUtc: '2026-10-10T00:00:00Z', cityName: 'Synthetic',
    paused: true, complete: true, errors: [], notes: [] };
  const polygon = [{x:0,z:0},{x:20,z:0},{x:20,z:20},{x:0,z:20}];
  const data = {
    districts: [{key:'10:1', name:'North', polygon, census:{residents:4, children:1, teens:1, adults:1, seniors:1}}],
    buildings: [{index:20,version:1,name:'School',districtKey:'10:1',polygon,serviceKinds:['school'],
      serviceDistricts:[],serviceCapacity:{school:{educationLevel:1,nominalCapacity:100,enrolled:60}}}],
    roads: [{index:30,version:1,name:'Road',curve:polygon}]
  };
  return Object.entries(data).map(([layer, items]) => ({...meta,layer,items,offset:0,limit:10,
    total:items.length,truncated:false,nextOffset:null}));
}

for (const layer of ['buildings','roads']) {
  for (const [name, edit] of [
    ['missing',r=>{delete r.index;}], ['null',r=>{r.index=null;}], ['string',r=>{r.index='20';}],
    ['fractional',r=>{r.index=1.5;}], ['negative',r=>{r.index=-1;}], ['zero',r=>{r.index=0;}],
    ['unsafe',r=>{r.index=Number.MAX_SAFE_INTEGER+1;}], ['missing version',r=>{delete r.version;}],
    ['string version',r=>{r.version='1';}], ['negative version',r=>{r.version=-1;}]
  ]) test(`reject ${layer} ${name} identity`,()=>{
    const p=pages();edit(p.find(p=>p.layer===layer).items[0]);
    assert.throws(()=>assemble(p),/ID/);
  });
}
for (const bad of [null,[],1,'x']) test(`reject non-object page ${JSON.stringify(bad)}`,()=>{
  assert.throws(()=>assemble([bad]),/Invalid atlas page/);
});
test('reject a successful envelope without an object result',()=>{
  assert.throws(()=>assemble([{ok:true,result:[]}]),/Invalid atlas response result/);
});
test('reject envelope city differing from snapshot origin',()=>{
  assert.throws(()=>assemble(pages().map(result=>({ok:true,citySession:'another-city',result}))),/citySession/);
});
test('metadata cannot overwrite any validated layer',()=>{
  const p=pages(); p[0].buildings=[];p[0].districts=[];p[0].roads=[];
  const a=assemble(p); for (const layer of ['buildings','districts','roads']) assert.equal(a[layer].length,1);
});
test('untrusted metadata cannot set output prototype or constructor',()=>{
  const p=pages();Object.defineProperty(p[0],'__proto__',{value:{polluted:true},enumerable:true});
  p[0].constructor={polluted:true};const a=assemble(p);
  assert.equal(Object.getPrototypeOf(a),Object.prototype);assert.equal(a.polluted,undefined);
  assert.equal(a.constructor,Object); assert.equal(Object.hasOwn(a,'__proto__'),false);
});
test('reject mismatched district key and numeric identity',()=>{
  const p=pages();Object.assign(p[0].items[0],{index:11,version:1});assert.throws(()=>assemble(p),/ID/);
});
test('accept reserved nonentity districts without invented identities',()=>{
  for(const key of ['unassigned','unlocated']) {const p=pages();p[0].items[0].key=key;assert.equal(assemble(p).districts[0].key,key);}
});
test('reject reserved district carrying entity identity',()=>{
  const p=pages();Object.assign(p[0].items[0],{key:'unassigned',index:10,version:1});assert.throws(()=>assemble(p),/ID/);
});
test('known school without capacity is not counted as zero schools',()=>{
  const a=assemble(pages());a.buildings[0].serviceCapacity={};const r=districtRows(a)[0];
  assert.equal(r.schoolSites,1);assert.equal(r.schoolsWithUnknownCapacity,1);
  assert.equal(r.schoolsWithUnknownEnrollment,1);assert.equal(r.nominalSchoolSeatsLocatedHere,null);
  assert.equal(r.enrollmentAtSchoolsLocatedHere,null);assert.equal(r.knownNominalSchoolSeatsLocatedHere,0);
  assert.match(report(a),/Unknown \/ Unknown \/ Unknown/);
});
test('partial school totals preserve known subtotal and unknown-site counts',()=>{
  const a=assemble(pages());a.buildings.push({...a.buildings[0],index:21,serviceCapacity:{}});
  const r=districtRows(a)[0];assert.equal(r.schoolSites,2);assert.equal(r.knownNominalSchoolSeatsLocatedHere,100);
  assert.equal(r.knownEnrollmentAtSchoolsLocatedHere,60);assert.equal(r.nominalSchoolSeatsLocatedHere,null);
  assert.equal(r.schoolsWithUnknownCapacity,1);assert.equal(r.schoolsWithUnknownEnrollment,1);
});
test('unknown education level makes per-level inventory incomplete',()=>{
  const a=assemble(pages());a.buildings[0].serviceCapacity={};
  for(const level of ['Elementary','High school','College','University'])
    assert.ok(report(a).includes(`| ${level} | Unknown | Incomplete | Incomplete |`));
});
test('known zero is distinct from missing school metrics',()=>{
  const a=assemble(pages());Object.assign(a.buildings[0].serviceCapacity.school,{nominalCapacity:0,enrolled:0});
  const r=districtRows(a)[0];assert.equal(r.nominalSchoolSeatsLocatedHere,0);assert.equal(r.enrollmentAtSchoolsLocatedHere,0);
  assert.equal(r.schoolsWithUnknownCapacity,0);assert.equal(r.schoolsWithUnknownEnrollment,0);
});
test('negative, fractional and nonnumeric school metrics remain unknown',()=>{
  for(const value of [-1,1.5,'100',NaN,Infinity]) {
    const a=assemble(pages());a.buildings[0].serviceCapacity.school.nominalCapacity=value;
    assert.equal(districtRows(a)[0].nominalSchoolSeatsLocatedHere,null);
  }
});
test('CSV carries unknown-site counts and separate known totals',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'audit-atlas-'));
  try {
    const a=assemble(pages());a.buildings[0].serviceCapacity={};writeExport(a,path.join(tmp,'output'));
    const csv=fs.readFileSync(path.join(tmp,'output','districts.csv'),'utf8');
    assert.match(csv,/schoolsWithUnknownCapacity/);assert.match(csv,/knownNominalSchoolSeatsLocatedHere/);
    assert.match(fs.readFileSync(path.join(tmp,'output','report.md'),'utf8'),/Incomplete/);
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
test('valid known inventory is unchanged',()=>{
  const a=assemble(pages());const r=districtRows(a)[0];assert.equal(r.schoolSites,1);
  assert.equal(r.nominalSchoolSeatsLocatedHere,100);assert.equal(r.enrollmentAtSchoolsLocatedHere,60);
  assert.match(mapSvg(a),/<svg/);assert.match(report(a),/1 \/ 100 \/ 60/);
});
