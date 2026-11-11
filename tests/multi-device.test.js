import {test,expect,beforeEach,afterEach,describe} from 'bun:test';
import {Window} from 'happy-dom';
import {readFileSync} from 'node:fs';
import {mockDevice} from './mock-device.js';
import {mockM5} from './mock-m5.js';
import {MOTION_SERVICE} from '../dist/motion.js';
import {stopFrame,THERMO} from '../dist/protocol.js';
let w,a,b,m5Hardware,picks,tasks,now,serial=0;
const originals={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval,now:Date.now};
const $=id=>w.document.getElementById(id);
async function settle(){for(let i=0;i<150;i++)await Promise.resolve()}
async function click(id){$(id).click();await settle()}
async function output(kind,level){w.document.querySelector('[data-output="'+kind+'"][data-level="'+level+'"]').click();await settle()}
async function change(id,value){const n=$(id);n.checked=value;n.dispatchEvent(new w.Event('change'));await settle()}
async function distance(score,extra={}){window.dispatchEvent(new w.CustomEvent('reon-distance',{detail:{score,personCount:2,fresh:true,timestamp:new Date(Date.now()).toISOString(),...extra}}));await settle()}
async function advance(ms){now+=ms;for(const[id,t]of [...tasks]){if(t.time<=now){if(t.repeat)t.time=now+t.repeat;else tasks.delete(id);await t.fn();await settle()}}}
async function calibrate(near=20,far=60){for(const [id,score] of [['distance-calib-near',near],['distance-calib-far',far]]){await distance(score);await click(id);for(let i=0;i<3;i++){await distance(score);await advance(1000)}}}
// Thermo byte of each mode write: 1 cool, 2 warm, 5/6 stop.
const modes=hw=>hw.writes.filter(x=>x.name==='mode').map(x=>[x.frame[3],x.frame[4]+1]);
async function connectBoth(){picks=[a.device,b.device];await click('connect');await click('connect-b')}
async function setup(options={}){
 a=mockDevice(w,options.a);b=mockDevice(w,options.b);b.device.id='device-b';a.device.id='device-a';
}
beforeEach(async()=>{
 w=new Window({url:'http://localhost:4173',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true}});
 w.document.body.innerHTML=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8').split('<body>')[1].split('</body>')[0].replace(/<script[\s\S]*?<\/script>/g,'');
 globalThis.window=w;globalThis.document=w.document;globalThis.localStorage=w.localStorage;globalThis.CustomEvent=w.CustomEvent;
 await setup();m5Hardware=mockM5(w);picks=[];
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{bluetooth:{requestDevice:async options=>options.filters.some(f=>f.services?.includes(MOTION_SERVICE))?m5Hardware.device:picks.shift()??a.device}}});
 tasks=new Map();now=Date.parse('2026-11-01T00:00:00Z');Date.now=()=>now;let timer=0;
 globalThis.setTimeout=(fn,ms=0)=>{tasks.set(++timer,{fn,time:now+ms});return timer};globalThis.setInterval=(fn,ms)=>{tasks.set(++timer,{fn,time:now+ms,repeat:ms});return timer};globalThis.clearTimeout=globalThis.clearInterval=id=>tasks.delete(id);
 await import(`../dist/app.js?multi-test=${++serial}`);await settle();await advance(900);
});
afterEach(async()=>{globalThis.setTimeout=originals.setTimeout;globalThis.clearTimeout=originals.clearTimeout;globalThis.setInterval=originals.setInterval;globalThis.clearInterval=originals.clearInterval;Date.now=originals.now;await w.happyDOM.abort()});

describe('two REON units',()=>{
 test('both units connect independently and the same unit cannot occupy both slots',async()=>{
  await click('connect');expect($('connection-state').textContent).toBe('接続済み');
  picks=[a.device];await click('connect-b');
  expect($('connection-state-b').textContent).toBe('未接続');expect($('connection-message').textContent).toContain('もう一方の枠で接続中');
  expect($('connection-state').textContent).toBe('接続済み');expect(a.device.gatt.connected).toBe(true);
  picks=[b.device];await click('connect-b');
  expect($('connection-state-b').textContent).toBe('接続済み');expect($('connection-feedback').hidden).toBe(true);
  expect($('connect-label').textContent).toBe('接続を解除');expect($('connect-label-b').textContent).toBe('接続を解除');
 });
 test('manual output follows the target selection',async()=>{
  await connectBoth();
  await output('warm',2);expect(modes(a).at(-1)).toEqual([2,2]);expect(modes(b).at(-1)).toEqual([2,2]);expect($('output-status').textContent).toBe('温熱 2');
  w.document.querySelector('[data-target="a"]').click();await settle();
  const before=b.writes.length;
  await output('cool',4);expect(modes(a).at(-1)).toEqual([1,4]);expect(b.writes.length).toBe(before);
  expect($('output-status').textContent).toBe('A 冷却 4 / B 温熱 2');
  await click('power');expect(modes(a).at(-1)[0]).toBe(THERMO.offCool);expect(b.writes.length).toBe(before);
  expect($('output-status').textContent).toBe('A 停止 / B 温熱 2');
  w.document.querySelector('[data-target="b"]').click();await settle();await click('power');expect(modes(b).at(-1)[0]).toBe(THERMO.offWarm);
 });
 test('target selection is inactive until both units are connected',async()=>{
  w.document.querySelector('[data-target="a"]').click();await settle();
  picks=[b.device];await click('connect-b');expect(w.document.querySelector('[data-target="a"]').disabled).toBe(true);
  await output('warm',1);expect(modes(b).at(-1)).toEqual([2,1]);
 });
 test('level buttons only offer levels every targeted unit supports',async()=>{
  await setup({b:{levels:0}});await connectBoth();
  expect($('cool-levels').children.length).toBe(3);
  w.document.querySelector('[data-target="a"]').click();await settle();expect($('cool-levels').children.length).toBe(5);
 });
 test('distance link drives every connected unit and continues on the remaining unit after a disconnect',async()=>{
  await connectBoth();await calibrate();await distance(20);await change('distance-auto',true);
  expect(modes(a).at(-1)).toEqual([2,2]);expect(modes(b).at(-1)).toEqual([2,2]);
  a.device.gatt.disconnect();await settle();
  expect($('distance-auto').checked).toBe(true);expect($('toast').textContent).toContain('本体Bで連動を継続');
  const countA=a.writes.length;await distance(60);
  expect(modes(b).at(-1)).toEqual([1,3]);expect(a.writes.length).toBe(countA);expect($('output-status').textContent).toBe('冷却 3');
  b.device.gatt.disconnect();await settle();expect($('distance-auto').checked).toBe(false);
 });
 test('a unit connected during the link joins it',async()=>{
  await click('connect');await calibrate();await distance(20);await change('distance-auto',true);
  picks=[b.device];await click('connect-b');await advance(300);
  expect(modes(b).at(-1)).toEqual([2,2]);expect($('distance-auto').checked).toBe(true);
 });
 test('a self-reported stop drops only that unit from the link and it is never restarted',async()=>{
  await connectBoth();await calibrate();await distance(20);await change('distance-auto',true);
  a.notify('mode',stopFrame(THERMO.warm));await settle();
  expect($('distance-auto').checked).toBe(true);
  const countA=a.writes.length;await distance(60);await advance(1000);
  expect(a.writes.length).toBe(countA);expect(modes(b).at(-1)).toEqual([1,3]);
  b.notify('mode',stopFrame(THERMO.cool));await settle();expect($('distance-auto').checked).toBe(false);
 });
 test('a write failure on one unit keeps the link on the other unit',async()=>{
  await setup({b:{failWrite:true}});await connectBoth();await calibrate();await distance(20);await change('distance-auto',true);
  expect($('distance-auto').checked).toBe(true);expect($('toast').textContent).toContain('本体Bに反映できませんでした');
  await distance(60);expect(modes(a).at(-1)).toEqual([1,3]);
 });
 test('disconnecting one unit by hand stops it and keeps the link on the other',async()=>{
  await connectBoth();await calibrate();await distance(20);await change('distance-auto',true);
  await click('connect');expect(modes(a).at(-1)[0]).toBe(THERMO.offWarm);expect(a.device.gatt.connected).toBe(false);
  expect($('distance-auto').checked).toBe(true);await distance(60);expect(modes(b).at(-1)).toEqual([1,3]);
 });
 test('manual operation on one target cancels the link for all units',async()=>{
  await connectBoth();await calibrate();await distance(20);await change('distance-auto',true);
  w.document.querySelector('[data-target="a"]').click();await settle();await click('power');
  expect($('distance-auto').checked).toBe(false);const countB=b.writes.length;await distance(60);await advance(1000);expect(b.writes.length).toBe(countB);
 });
 test('distance expiry stops every unit',async()=>{
  await connectBoth();await calibrate();await distance(20);await change('distance-auto',true);await advance(5001);
  expect($('distance-auto').checked).toBe(false);expect(modes(a).at(-1)[0]).toBe(THERMO.offWarm);expect(modes(b).at(-1)[0]).toBe(THERMO.offWarm);expect($('output-status').textContent).toBe('停止');
 });
 test('motion link drives both units',async()=>{
  await connectBoth();await click('m5-connect');m5Hardware.emit({x:0,y:0,z:2});await settle();
  await change('motion-auto',true);expect($('motion-auto').checked).toBe(true);
  expect(modes(a).at(-1)).toEqual([2,2]);expect(modes(b).at(-1)).toEqual([2,2]);
 });
});
