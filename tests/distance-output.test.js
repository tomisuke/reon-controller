import {test,expect} from 'bun:test';
import {distanceOutput,distanceSample} from '../dist/distance-output.js';
test('distance endpoints, midpoint and intermediate steps',()=>{
  expect([0,25,49.9,50,50.1,75,100].map(s=>distanceOutput(s))).toEqual([
    {kind:'cool',level:5},{kind:'cool',level:3},{kind:'cool',level:1},
    {kind:'stop',level:0},{kind:'warm',level:1},{kind:'warm',level:2},{kind:'warm',level:4}
  ]);
});
test('distance output is monotonic and respects device capabilities',()=>{
  let previous=-5;
  for(let score=0;score<=100;score+=.1){const action=distanceOutput(score);const signed=action.kind==='cool'?-action.level:action.level;expect(signed).toBeGreaterThanOrEqual(previous);previous=signed;}
  expect(distanceOutput(100,{coolLevels:4,warmLevels:3})).toEqual({kind:'warm',level:3});
  expect(distanceOutput(0,{coolLevels:4,warmLevels:3})).toEqual({kind:'cool',level:4});
});
test('invalid scores and expired or inactive readings never drive output',()=>{
  for(const s of [NaN,Infinity,-1,101,null,'50'])expect(distanceOutput(s)).toBeNull();
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
