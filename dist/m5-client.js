import {MOTION_SERVICE,MOTION_CHARACTERISTIC,parseMotionPacket,isNewSequence} from './motion.js';
import {bluetoothProblem} from './bluetooth-environment.js';
import {RETRY_DELAYS,bluetoothDelay,bluetoothStep,bluetoothTimeout,selectBluetoothDevice,transientBluetoothError} from './bluetooth-retry.js';

export class M5Client {
  state={connected:false,connecting:false,reconnecting:false,retryPending:false,reading:null,error:null,name:null};
  #listeners=new Set();
  #device;
  #characteristic;
  #controller;
  #handshake;
  #sequence=null;

  onState(listener){this.#listeners.add(listener);listener(this.state);return()=>this.#listeners.delete(listener)}
  #update(patch){this.state={...this.state,...patch};for(const listener of this.#listeners)listener(this.state)}

  #accept(value) {
    try {
      const reading=parseMotionPacket(value);
      if(!isNewSequence(reading.sequence,this.#sequence))return;
      this.#sequence=reading.sequence;
      this.#update({reading,error:null});
    } catch(error) {this.#update({error:error.message});}
  }

  #notify=event=>{
    if(event.target===this.#characteristic&&(this.state.connected||this.state.connecting))this.#accept(event.target.value);
  };

  #dropLink() {
    this.#characteristic?.removeEventListener('characteristicvaluechanged',this.#notify);
    this.#characteristic=null;
    this.#sequence=null;
    this.#device?.removeEventListener('gattserverdisconnected',this.#disconnected);
    this.#device?.gatt.disconnect();
  }

  #recover() {
    if(!this.state.connected)return;
    this.#dropLink();
    this.#update({connected:false,reading:null});
    void this.connect({automatic:true});
  }

  #disconnected=event=>{
    if(event.target!==this.#device||event.target.gatt.connected)return;
    if(this.#handshake)this.#handshake.abort(new DOMException('M5 disconnected','NetworkError'));
    else this.#recover();
  };

  async connect({automatic=false}={}) {
    if(this.#controller||this.state.connected||(automatic&&!this.#device))return;
    const problem=bluetoothProblem();
    if(problem){this.#update({error:problem});return;}
    const controller=new AbortController(), {signal}=controller;
    this.#controller=controller;
    this.#update({connecting:true,reconnecting:automatic,retryPending:false,error:null,reading:null});
    const delays=automatic?RETRY_DELAYS:[0,...RETRY_DELAYS];
    let device=this.#device;
    try {
      device??=await selectBluetoothDevice({
        filters:[{namePrefix:'M5StickS3',services:[MOTION_SERVICE]}],
      },signal);
      this.#device=device;
      for(const [index,delay] of delays.entries()) {
        if(delay){
          this.#update({retryPending:true,reading:null});
          await bluetoothDelay(delay,signal);
          this.#update({retryPending:false});
        }
        const handshake=new AbortController();
        this.#handshake=handshake;
        const timeout=bluetoothTimeout(AbortSignal.any([signal,handshake.signal]),15000);
        const deadline=timeout.signal;
        const step=(run,discard)=>bluetoothStep(run,deadline,discard);
        try {
          device.addEventListener('gattserverdisconnected',this.#disconnected);
          const server=await step(()=>device.gatt.connect(),late=>{
            if((!this.#controller||this.#controller===controller)&&!this.state.connected&&!this.#handshake)late.disconnect();
          });
          const service=await step(()=>server.getPrimaryService(MOTION_SERVICE));
          const characteristic=await step(()=>service.getCharacteristic(MOTION_CHARACTERISTIC));
          if(!characteristic.properties.notify&&!characteristic.properties.indicate)throw new DOMException('IMU notifications unavailable','NotSupportedError');
          this.#characteristic=characteristic;
          characteristic.addEventListener('characteristicvaluechanged',this.#notify);
          await step(()=>characteristic.startNotifications());
          if(characteristic.properties.read){
            try{this.#accept(await step(()=>characteristic.readValue()));}
            catch(error){if(error.name!=='NotSupportedError')throw error;}
          }
          if(deadline.aborted)throw deadline.reason;
          this.#handshake=this.#controller=null;
          this.#update({connected:true,connecting:false,reconnecting:false,name:device.name});
          return;
        } catch(error) {
          if(this.#controller!==controller)return;
          this.#handshake=null;
          this.#dropLink();
          if(signal.aborted||index===delays.length-1||!transientBluetoothError(error))throw error;
        } finally {timeout.clear();}
      }
    } catch(error) {
      if(this.#controller!==controller)return;
      this.#device=undefined;
      const message=error.name==='ChooserBusyError'?'先に開いたBluetooth選択画面を閉じてから、もう一度接続してください。':
        error.name==='NotFoundError'?'M5StickS3のサービスが見つかりません。専用ファームウェアとデバイスの選択を確認してください。':
        error.name==='TimeoutError'?'M5StickS3の接続が時間切れになりました。':
        `M5StickS3に接続できません（${error.name} · ${error.message}）`;
      this.#update({connected:false,connecting:false,reconnecting:false,retryPending:false,reading:null,error:message});
    } finally {if(this.#controller===controller)this.#controller=null;}
  }

  cancel() {
    if(!this.#controller)return;
    this.#controller.abort();
    this.#controller=this.#handshake=null;
    this.#dropLink();
    this.#update({connecting:false,reconnecting:false,retryPending:false,reading:null});
  }

  disconnect() {
    if(this.#controller){this.cancel();return;}
    if(!this.state.connected)return;
    this.#dropLink();
    this.#update({connected:false,reading:null});
  }
}
