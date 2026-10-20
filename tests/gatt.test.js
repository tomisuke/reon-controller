import {test,expect} from 'bun:test';
import {writeCharacteristic,optionalUnsupported,readable} from '../dist/gatt.js';
import {connectionError} from '../dist/bluetooth-environment.js';
test('write-with-response is preferred when both are supported',async()=>{const calls=[];await writeCharacteristic({properties:{write:true,writeWithoutResponse:true},writeValueWithResponse:()=>calls.push('response'),writeValueWithoutResponse:()=>calls.push('no-response')},Uint8Array.of(1));expect(calls).toEqual(['response'])});
test('unsupported writes fail without issuing a command',()=>expect(()=>writeCharacteristic({properties:{write:false,writeWithoutResponse:false}},Uint8Array.of(1))).toThrow());
test('network and permission errors never trigger optional fallback',()=>{expect(optionalUnsupported({name:'NetworkError'})).toBe(false);expect(optionalUnsupported({name:'SecurityError'})).toBe(false)});
test('unreadable state is not treated as readable',()=>{expect(readable({properties:{read:false}})).toBe(false);expect(readable(undefined)).toBe(false)});
test('NotSupported after device selection does not blame the browser',()=>{const message=connectionError({name:'NotSupportedError'},'authenticating','owner.write');expect(message).toContain('owner.write');expect(message).not.toContain('対応ブラウザで開いて')});
