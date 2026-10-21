import {describe,test,expect} from 'bun:test';
import {DEFAULT_RULES as rules,evaluateRules,validateRules,parseReading} from '../dist/sensor.js';
describe('external sensor policy',()=>{
 test.each([[-40,'warm',2],[18,'warm',2],[18.01,'stop',0],[22,'stop',0],[22.01,'cool',1],[26,'cool',1],[26.01,'cool',3],[29,'cool',3],[29.01,'cool',5],[80,'cool',5]])('%s°C maps exactly to %s %s',(t,kind,level)=>expect(evaluateRules(t,rules)).toEqual({kind,level}));
 test('alternating values cross the boundary on EVERY sample without hysteresis',()=>{expect([29.01,29,29.01,29].map(t=>evaluateRules(t,rules).level)).toEqual([5,3,5,3])});
 test('respects hardware output limits',()=>expect(evaluateRules(40,rules,{coolLevels:3,warmLevels:3}).level).toBe(3));
 test('supports decimal and negative custom boundaries',()=>expect(evaluateRules(-1.1,[{temperature:-1.1,kind:'warm',level:5}],{warmLevels:3,coolLevels:5})).toEqual({kind:'warm',level:3}));
 test.each([[],[{temperature:25,kind:'cool',level:3},{temperature:24,kind:'warm',level:2}],[{temperature:25,kind:'cool',level:3},{temperature:25,kind:'cool',level:4}],[{temperature:NaN,kind:'cool',level:1}],[{temperature:81,kind:'cool',level:1}],[{temperature:25,kind:'cool',level:6}],[{temperature:25,kind:'bad',level:1}],[{temperature:25,kind:'warm',level:1.5}]].map(r=>[r]))('rejects malformed rule set %#',r=>expect(()=>validateRules(r)).toThrow());
 test('missing humidity and timestamp are accepted',()=>expect(parseReading({temperature:0},1000)).toEqual({temperature:0,humidity:null,time:1000}));
 test('ISO timestamps and humidity work',()=>expect(parseReading({temperature:25,humidity:0,timestamp:'2026-10-20T00:00:00.000Z'},Date.parse('2026-10-20T00:00:01Z')).humidity).toBe(0));
 test.each([null,{}, {temperature:'28'},{temperature:NaN},{temperature:Infinity},{temperature:81},{temperature:25,humidity:-1},{temperature:25,humidity:101},{temperature:25,humidity:'50'},{temperature:25,timestamp:0},{temperature:25,timestamp:1000000},{temperature:25,timestamp:'bad'}])('rejects invalid or stale reading %#',v=>expect(()=>parseReading(v,100000)).toThrow());
 test('staleness boundary is exact',()=>{expect(parseReading({temperature:25,timestamp:70000},100000).time).toBe(70000);expect(()=>parseReading({temperature:25,timestamp:69999},100000)).toThrow()});
});

