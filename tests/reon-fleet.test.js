import {test,expect} from 'bun:test';
import {actionFrame,combinedOutputLabel,commonCapabilities,modeLabel,outputKey,STOP} from '../dist/reon-fleet.js';
import {THERMO,manualFrame,stopFrame,smartStopFrame,parseMode} from '../dist/protocol.js';
import {connectionError} from '../dist/bluetooth-environment.js';
import {sameBluetoothDevice} from '../dist/reon-client.js';

test('stop frames follow each unit mode, outputs use manual frames',()=>{
 expect(actionFrame(STOP,{type:'manual',kind:'warm'})).toEqual(stopFrame(THERMO.warm));
 expect(actionFrame(STOP,null,'cool')).toEqual(stopFrame(THERMO.cool));
 const smart={type:'smart',kind:'auto'};expect(actionFrame(STOP,smart)).toEqual(smartStopFrame(smart));
 expect(actionFrame({kind:'warm',level:2},null)).toEqual(manualFrame(THERMO.warm,2,false));
 expect(outputKey({kind:'cool',level:3})).toBe('cool:3');expect(outputKey(null)).toBe(null);
});
test('combined label collapses identical outputs and names units otherwise',()=>{
 const cool3=parseMode(manualFrame(THERMO.cool,3)),stopped=parseMode(stopFrame(THERMO.cool));
 expect(modeLabel(cool3)).toBe('冷却 3');expect(modeLabel(stopped)).toBe('停止');
 expect(combinedOutputLabel([],3)).toBe('未接続');
 expect(combinedOutputLabel([{label:'A',mode:cool3},{label:'B',mode:cool3}])).toBe('冷却 3');
 expect(combinedOutputLabel([{label:'A',mode:cool3},{label:'B',mode:stopped}])).toBe('A 冷却 3 / B 停止');
});
test('common capabilities take the smaller level range',()=>{
 expect(commonCapabilities([])).toBe(null);
 expect(commonCapabilities([{coolLevels:5,warmLevels:4},null,{coolLevels:3,warmLevels:3}])).toMatchObject({coolLevels:3,warmLevels:3});
});
test('duplicate device detection and message',()=>{
 const d={id:'x'};expect(sameBluetoothDevice(d,d)).toBe(true);expect(sameBluetoothDevice(d,{id:'x'})).toBe(true);
 expect(sameBluetoothDevice({},{})).toBe(false);expect(sameBluetoothDevice(null,d)).toBe(false);
 expect(connectionError(new DOMException('dup','DuplicateDeviceError'))).toContain('もう一方の枠');
});
