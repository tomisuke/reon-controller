import {CHARACTERISTIC,DEVICE_INFO,SERVICE,manualFrame,THERMO,parseMode,stopFrame} from '../dist/protocol.js';
export function mockDevice(window,{failConnect=false,failWrite=false,features=216,levels=20,propertyOverrides={},missing=[],errors={},autoStart=false,autoStopAfterMs=null,ignoreAutoStartWrite=false}={}) {
 let deviceTime=0,autoStopAt=null;
 let busy=false;const writes=[],calls=[],callbacks=new Map();
 async function op(label,fn){
  if(busy)throw Error('Concurrent GATT operation');busy=true;calls.push(label);
  try{await Promise.resolve();if(errors[label])throw new DOMException(errors[label].message??'Unsupported operation',errors[label].name??'NotSupportedError');return fn()}finally{busy=false}
 }
 const values={mode:manualFrame(THERMO.cool,3),capability:Uint8Array.of(features,0,levels,0,2),battery:Uint8Array.of(82,1,0,0,90),temperature:Uint8Array.of(1,9,196,9,196,9,196,0,0,0,0,0,0,0,0),autoStart:Uint8Array.of(autoStart?1:0),quickLaunch:Uint8Array.of(0)};
 const chars={};
 for(const [name,id]of Object.entries(CHARACTERISTIC)) {
  const properties={read:true,write:true,writeWithoutResponse:false,notify:true,indicate:false,...propertyOverrides[name]};
  function write(frame,procedure) {return op(name+'.'+procedure,()=>{if(failWrite&&name==='mode')throw Error('rejected');if(procedure==='writeValueWithResponse'?!properties.write:!properties.writeWithoutResponse)throw new DOMException('GATT write not supported','NotSupportedError');writes.push({name,frame:[...frame]});if(!(name==='autoStart'&&ignoreAutoStartWrite))values[name]=new Uint8Array(frame);if(name==='mode')autoStopAt=parseMode(frame)?.running&&autoStopAfterMs!==null?deviceTime+autoStopAfterMs:null;})}
  chars[id]={properties,addEventListener(type,cb){callbacks.set(name,cb)},async readValue(){return op(name+'.read',()=>{if(!properties.read)throw new DOMException('GATT characteristic is not readable','NotSupportedError');return new DataView((values[name]??Uint8Array.of(0)).buffer)})},writeValueWithResponse(frame){return write(frame,'writeValueWithResponse')},writeValueWithoutResponse(frame){return write(frame,'writeValueWithoutResponse')},async startNotifications(){return op(name+'.startNotifications',()=>{})}};
 }
 const device=new window.EventTarget();device.name='RNP-P1';
 device.gatt={connected:false,async connect(){if(failConnect)throw Error('connect failed');this.connected=true;return this},disconnect(){if(this.connected){this.connected=false;device.dispatchEvent(new window.Event('gattserverdisconnected'))}},async getPrimaryService(id){return op(id===SERVICE.deviceInfo?'deviceInfo.getPrimaryService':'control.getPrimaryService',()=>{
  if(id===SERVICE.deviceInfo&&missing.includes('deviceInfo'))throw new DOMException('Service not found','NotFoundError');
  return id===SERVICE.deviceInfo?{async getCharacteristic(id){const name=id===DEVICE_INFO.model?'model':'firmware';return op(name+'.getCharacteristic',()=>({properties:{read:true,...propertyOverrides[name]},async readValue(){return op(name+'.read',()=>new DataView(new TextEncoder().encode(name==='model'?'RNP-P1':'2.2.1').buffer))}}))}}:{async getCharacteristic(id){const name=Object.entries(CHARACTERISTIC).find(([,uuid])=>uuid===id)?.[0];return op(name+'.getCharacteristic',()=>{if(missing.includes(name))throw new DOMException('Characteristic not found','NotFoundError');return chars[id]})}};
 })}};
 function notify(name,value){values[name]=value;callbacks.get(name)?.({target:{value:new DataView(value.buffer)}});}
 return {device,writes,calls,values,notify,advanceTime(ms){deviceTime+=ms;if(autoStopAt!==null&&deviceTime>=autoStopAt){autoStopAt=null;if(values.autoStart[0]===1){const mode=parseMode(values.mode);notify('mode',stopFrame(mode?.kind==='warm'?THERMO.warm:THERMO.cool));}}}};
}
