import {MOTION_SERVICE,MOTION_CHARACTERISTIC,parseMotionPacket,isNewSequence} from './motion.js';
import {bluetoothProblem} from './bluetooth-environment.js';
export class M5Client {
  state={connected:false,connecting:false,reading:null,error:null,name:null};
  #listeners=new Set();#device;#characteristic;#controller;#attempt=0;#sequence=null;
  onState(listener){this.#listeners.add(listener);listener(this.state);return()=>this.#listeners.delete(listener)}
  #update(patch){this.state={...this.state,...patch};for(const listener of this.#listeners)listener(this.state)}
  #accept(value){try{const reading=parseMotionPacket(value);if(!isNewSequence(reading.sequence,this.#sequence))return;this.#sequence=reading.sequence;this.#update({reading,error:null})}catch(error){this.#update({error:error.message})}}
  #notify=event=>{if(event.target!==this.#characteristic||(!this.state.connected&&!this.state.connecting))return;this.#accept(event.target.value)};
  #disconnected=event=>{if(event.target!==this.#device)return;this.#controller?.abort(new DOMException('M5 disconnected','NetworkError'));this.#characteristic?.removeEventListener('characteristicvaluechanged',this.#notify);this.#sequence=null;this.#update({connected:false,connecting:false,reading:null})};
  async connect(){
    if(this.state.connecting||this.state.connected)return;
    const problem=bluetoothProblem();if(problem){this.#update({error:problem});return;}
    const attempt=++this.#attempt,controller=new AbortController();this.#controller=controller;this.#sequence=null;
    let device,timer=setTimeout(()=>controller.abort(new DOMException('Device selection timed out','TimeoutError')),45000);
    const wait=(operation,discard)=>new Promise((resolve,reject)=>{
      if(controller.signal.aborted){reject(controller.signal.reason);return;}
      const abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});
      try{Promise.resolve(operation()).then(value=>{controller.signal.removeEventListener('abort',abort);if(controller.signal.aborted||attempt!==this.#attempt){discard?.(value);reject(controller.signal.reason??new DOMException('Cancelled','AbortError'))}else resolve(value)},error=>{controller.signal.removeEventListener('abort',abort);reject(error)})}catch(error){controller.signal.removeEventListener('abort',abort);reject(error)}
    });
    this.#update({connecting:true,error:null,reading:null});
    try{
      device=await wait(()=>navigator.bluetooth.requestDevice({filters:[{namePrefix:'M5StickS3',services:[MOTION_SERVICE]}]}));
      this.#device=device;device.removeEventListener('gattserverdisconnected',this.#disconnected);device.addEventListener('gattserverdisconnected',this.#disconnected);
      clearTimeout(timer);timer=setTimeout(()=>controller.abort(new DOMException('M5 initialization timed out','TimeoutError')),15000);
      const server=await wait(()=>device.gatt.connect(),late=>{if(attempt===this.#attempt||this.#device!==device)late.disconnect()});
      const service=await wait(()=>server.getPrimaryService(MOTION_SERVICE));
      const characteristic=await wait(()=>service.getCharacteristic(MOTION_CHARACTERISTIC));this.#characteristic=characteristic;
      if(!characteristic.properties.notify&&!characteristic.properties.indicate)throw new DOMException('IMU notifications unavailable','NotSupportedError');
      characteristic.addEventListener('characteristicvaluechanged',this.#notify);
      await wait(()=>characteristic.startNotifications());
      if(characteristic.properties.read){const value=await wait(()=>characteristic.readValue());this.#accept(value)}
      this.#update({connected:true,connecting:false,name:device.name});
    }catch(error){if(attempt!==this.#attempt)return;this.#characteristic?.removeEventListener('characteristicvaluechanged',this.#notify);device?.gatt?.disconnect();this.#update({connected:false,connecting:false,reading:null,error:error.name==='AbortError'?null:error.name==='NotFoundError'?'M5StickS3が選択されませんでした。専用ファームウェアを起動してください。':error.name==='TimeoutError'?'M5StickS3の接続が時間切れになりました。':`M5StickS3に接続できません: ${error.name} · ${error.message}`})}
    finally{clearTimeout(timer);if(attempt===this.#attempt)this.#controller=null}
  }
  cancel(){this.#controller?.abort(new DOMException('Cancelled','AbortError'));this.#update({connecting:false})}
  disconnect(){this.cancel();this.#characteristic?.removeEventListener('characteristicvaluechanged',this.#notify);this.#device?.gatt?.disconnect();this.#sequence=null;this.#update({connected:false,connecting:false,reading:null})}
}
