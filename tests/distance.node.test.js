import {test} from 'node:test';
import assert from 'node:assert/strict';
import {measure,publicReading,DetectionHold} from '../dist/distance-core.js';
const person=(cx,cy)=>({bbox:[cx-1,cy-1,2,2]});
test('brief zero/one-person dropouts hold the prior score, then return to 100',()=>{
 const hold=new DetectionHold(1000),valid=measure([person(10,10),person(30,10)],100,100),missing=measure([],100,100);
 assert.equal(hold.update(missing,0).score,100);hold.update(valid,100);
 assert.equal(hold.update(missing,300).score,valid.score);assert.equal(hold.update(measure([person(10,10)],100,100),1099).holding,true);
 assert.equal(hold.update(missing,1100).score,100);assert.equal(hold.update(missing,1200).holding,false);
});
test('re-detection refreshes hold, disabled protection is immediate, and reset bypasses holding',()=>{
 const hold=new DetectionHold(1000),a=measure([person(10,10),person(30,10)],100,100),b=measure([person(10,10),person(60,10)],100,100),missing=measure([],100,100);
 hold.update(a,0);hold.update(missing,300);assert.equal(hold.update(b,400).score,b.score);assert.equal(hold.update(missing,1200).score,b.score);
 hold.reset();assert.equal(hold.update(missing,1300).score,100);hold.update(a,1400);hold.holdMs=0;assert.equal(hold.update(missing,1401).score,100);
});
test('held readings expire independently of the five-second freshness timeout',()=>{
 const data={active:true,receivedAt:10000,score:12,personCount:0,status:'holding',holdUntil:11000};
 assert.equal(publicReading(data,10999).score,12);assert.equal(publicReading(data,11000).score,100);assert.equal(publicReading(data,11000).status,'insufficient_people');
});
test('0/1 people always produce 100',()=>{assert.equal(measure([],100,100).score,100);assert.equal(measure([person(20,20)],100,100).score,100);});
test('overlapping centers produce 0; diagonal and calibrated distances cap at 100',()=>{assert.equal(measure([person(20,20),person(20,20)],100,100).score,0);assert.equal(measure([{bbox:[0,0,0.001,0.001]},{bbox:[99.999,99.999,.001,.001]}],100,100).score,100);assert.equal(measure([person(10,10),person(90,90)],100,100,.5).score,100);});
test('distance increases monotonically and three people select the nearest pair',()=>{assert.ok(measure([person(10,10),person(40,10)],100,100).score<measure([person(10,10),person(80,10)],100,100).score);const m=measure([person(10,10),person(80,80),person(82,80)],100,100);assert.deepEqual(m.pair,[1,2]);assert.equal(m.score,1.4);});
test('aspect ratio uses pixel distances and invalid inputs are rejected',()=>{assert.equal(measure([person(10,10),person(110,10)],200,100).score,44.7);assert.throws(()=>measure([],0,100));assert.throws(()=>measure([{bbox:[NaN,0,2,2]}],100,100));assert.throws(()=>measure([],100,100,0));});
test('stale, inactive, future-dated, and missing readings become 100',()=>{const d={active:true,receivedAt:10000,score:12,personCount:2,status:'tracking'};assert.equal(publicReading(d,15000).score,12);for(const n of [15001,9999])assert.equal(publicReading(d,n).score,100);assert.equal(publicReading({...d,active:false},10000).score,100);assert.equal(publicReading(null).score,100);});
