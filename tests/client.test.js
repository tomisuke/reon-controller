import {describe,test,expect,beforeEach,afterEach} from 'bun:test';
import {Window} from 'happy-dom';
import {ReonClient} from '../dist/reon-client.js';
import {mockDevice} from './mock-device.js';
import {manualFrame,THERMO} from '../dist/protocol.js';
let w,hardware;
beforeEach(()=>{w=new Window({url:'http://localhost'});globalThis.window=w;globalThis.document=w.document;globalThis.localStorage=w.localStorage;globalThis.CustomEvent=w.CustomEvent;hardware=mockDevice(w);Object.defineProperty(globalThis,'navigator',{configurable:true,value:{bluetooth:{requestDevice:async()=>hardware.device}}})});
afterEach(()=>w.happyDOM.abort());
describe('Bluetooth client with strict serial mock GATT',()=>{
 test('connects without concurrent GATT operations, authenticates and reads capabilities',async()=>{const c=new ReonClient();await c.connect();expect(c.state.connected).toBe(true);expect(c.state.device.model).toBe('RNP-P1');expect(c.state.capabilities.coolLevels).toBe(5);expect(c.state.battery.level).toBe(82);expect(hardware.writes[0].name).toBe('owner');expect(hardware.writes[0].frame.length).toBe(17)});
 test('roundtrips commands and writes every alternating sample in order',async()=>{const c=new ReonClient();await c.connect();expect(await Promise.all([5,3,5,3].map(n=>c.writeMode(manualFrame(THERMO.cool,n))))).toEqual([true,true,true,true]);expect(hardware.writes.filter(w=>w.name==='mode').map(w=>w.frame[4]+1)).toEqual([5,3,5,3]);expect(c.state.mode.level).toBe(3)});
 test('disconnect prevents queued commands from being sent',async()=>{const c=new ReonClient();await c.connect();const pending=c.writeMode(manualFrame(THERMO.cool,5));c.disconnect();expect(await pending).toBe(false);expect(c.state.connected).toBe(false);expect(hardware.writes.filter(w=>w.name==='mode')).toHaveLength(0)});
 test('reuses valid owner key across sessions',async()=>{const c=new ReonClient();await c.connect();const key=localStorage.getItem('reon-owner-key');c.disconnect();await c.connect();expect(c.state.connected).toBe(true);expect(localStorage.getItem('reon-owner-key')).toBe(key)});
 test('repairs corrupt owner key',async()=>{localStorage.setItem('reon-owner-key','invalid');const c=new ReonClient();await c.connect();expect(c.state.connected).toBe(true);expect(localStorage.getItem('reon-owner-key')).toMatch(/^[a-f0-9]{32}$/)});
 test('connection failure reports error and leaves controls disconnected',async()=>{hardware=mockDevice(w,{failConnect:true});const c=new ReonClient();await c.connect();expect(c.state.connected).toBe(false);expect(c.state.connecting).toBe(false);expect(c.state.error).toBeTruthy()});
 test('write failure returns false and remains recoverable',async()=>{hardware=mockDevice(w,{failWrite:true});const c=new ReonClient();await c.connect();expect(await c.writeMode(manualFrame(THERMO.cool,4))).toBe(false);expect(c.state.error).toContain('rejected')});
 test('notifications update real state',async()=>{const c=new ReonClient();await c.connect();hardware.notify('mode',manualFrame(THERMO.warm,2));expect(c.state.mode.kind).toBe('warm');expect(c.state.mode.level).toBe(2)});
});
