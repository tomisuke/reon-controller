import {test,expect} from 'bun:test';
import {bluetoothProblem,connectionError} from '../dist/bluetooth-environment.js';
test('HTTPS is required',()=>expect(bluetoothProblem({isSecureContext:false})).toContain('HTTPS'));
test('presence of bluetooth object alone is insufficient',()=>expect(bluetoothProblem({navigator:{bluetooth:{}}})).toContain('対応していません'));
test('permissions policy denial is detected before device selection',()=>expect(bluetoothProblem({navigator:{bluetooth:{requestDevice(){}}},document:{permissionsPolicy:{allowsFeature:()=>false}}})).toContain('制限されています'));
test('allowed Bluetooth environment passes',()=>expect(bluetoothProblem({navigator:{bluetooth:{requestDevice(){}}},document:{permissionsPolicy:{allowsFeature:()=>true}}})).toBeNull());
test('selection cancellation is distinct from GATT failure',()=>{expect(connectionError({name:'NotFoundError'})).toContain('選択されませんでした');expect(connectionError({name:'NetworkError'})).toContain('接続に失敗')});
test('manual cancellation produces no failure',()=>expect(connectionError({name:'AbortError'})).toBeNull());
