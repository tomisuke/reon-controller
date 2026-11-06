import {test,expect} from 'bun:test';
import {distanceSample,scoreToRatio,calibratedOutput,calibrationSample,validCalibration,estimateCm,median,CALIBRATION} from '../dist/distance-output.js';
const cal={near:.2,far:.6},at=cm=>cal.near+(cm-80)/80*(cal.far-cal.near);
const label=a=>a.kind==='stop'?'stop':a.kind+a.level;
test('calibration points are 80cm warm 2 and 160cm cool 3',()=>{
  expect(CALIBRATION.near).toEqual({cm:80,kind:'warm',level:2});
  expect(CALIBRATION.far).toEqual({cm:160,kind:'cool',level:3});
});
test('80cm is warm 2, 160cm is cool 3 and levels change linearly in between',()=>{
  expect([80,84,96,112,128,144,156,160].map(cm=>label(calibratedOutput(at(cm),cal)))).toEqual(['warm2','warm2','warm1','stop','cool1','cool2','cool3','cool3']);
  expect(estimateCm(at(112),cal)).toBeCloseTo(112);
  expect(estimateCm(at(160),cal)).toBeCloseTo(160);
});
test('outside the calibrated range the endpoint output is kept',()=>{
  for(const r of [0,at(40),at(79)])expect(calibratedOutput(r,cal)).toEqual({kind:'warm',level:2});
  for(const r of [at(161),at(300),1,Infinity])expect(calibratedOutput(r,cal)).toEqual({kind:'cool',level:3});
});
test('calibrated output is monotonic from warm to cool and respects device capabilities',()=>{
  let previous=Infinity;
  for(let r=0;r<=1;r+=.002){const a=calibratedOutput(r,cal),signed=a.kind==='warm'?a.level:a.kind==='cool'?-a.level:0;expect(signed).toBeLessThanOrEqual(previous);previous=signed;}
  expect(calibratedOutput(at(160),cal,{coolLevels:2,warmLevels:1})).toEqual({kind:'cool',level:2});
  expect(calibratedOutput(at(80),cal,{coolLevels:2,warmLevels:1})).toEqual({kind:'warm',level:1});
});
test('missing, reversed or too-close calibration never drives output',()=>{
  for(const c of [null,{},{near:.2,far:null},{near:.6,far:.2},{near:.2,far:.21},{near:-.1,far:.5},{near:.2,far:1.2}]){expect(validCalibration(c)).toBe(false);expect(calibratedOutput(.3,c)).toBeNull();}
  for(const r of [NaN,-1,null,'0.3',undefined])expect(calibratedOutput(r,cal)).toBeNull();
});
test('scores convert to the diagonal ratio independent of the 100-distance setting',()=>{
  expect(scoreToRatio(30,1)).toBeCloseTo(.3);expect(scoreToRatio(60,.5)).toBeCloseTo(.3);
  expect(scoreToRatio(100,.4)).toBe(Infinity);expect(scoreToRatio(0)).toBe(0);
  for(const [s,f] of [[NaN,1],[-1,1],[101,1],[50,0],[50,1.5],[50,NaN]])expect(scoreToRatio(s,f)).toBeNull();
});
test('calibration samples need a fresh, non-held frame with exactly two people',()=>{
  const now=Date.now(),r={fresh:true,score:30,personCount:2,fullScale:.5,timestamp:new Date(now).toISOString()};
  expect(calibrationSample(r,now)).toBeCloseTo(.15);
  for(const bad of [{personCount:1},{personCount:3},{holding:true},{fresh:false},{score:100},{score:NaN},{timestamp:'x'}])expect(calibrationSample({...r,...bad},now)).toBeNull();
  expect(calibrationSample(r,now+5001)).toBeNull();
  expect(median([.3,.1,.2])).toBe(.2);expect(median([.1,.2,.3,.9])).toBeCloseTo(.25);
});
test('invalid scores and expired or inactive readings never drive output',()=>{
  const now=Date.now(),r={fresh:true,score:20,timestamp:new Date(now).toISOString()};
  expect(distanceSample(r,now,now)).toBe(20);
  expect(distanceSample(r,now,now+5001)).toBeNull();
  expect(distanceSample({...r,fresh:false},now,now)).toBeNull();
  expect(distanceSample({...r,timestamp:'invalid'},now,now)).toBeNull();
  expect(distanceSample(r,now,now-1001)).toBeNull();
});
test('held detections preserve the score only until the explicit hold deadline',()=>{
  const now=Date.now(),r={fresh:true,score:20,holding:true,holdRemainingMs:1000,timestamp:new Date(now).toISOString()};
  expect(distanceSample(r,now,now+999)).toBe(20);
  expect(distanceSample(r,now,now+1000)).toBe(100);
});
