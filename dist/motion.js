export const MOTION_SERVICE='51b92800-d766-4aa7-b64d-3f1ab08b1260';
export const MOTION_CHARACTERISTIC='51b92801-d766-4aa7-b64d-3f1ab08b1260';
export const MOTION_STALE_MS=1500;
export const DEFAULT_MOTION_CONFIG={fullScale:1,coolMax:3,warmMax:2};
export function validateMotionConfig(config) {
  if(!config||!Number.isFinite(config.fullScale)||config.fullScale<0.1||config.fullScale>8)throw Error('感度は0.1〜8Gで設定してください');
  for(const name of ['coolMax','warmMax'])if(!Number.isInteger(config[name])||config[name]<1||config[name]>5)throw Error('上限レベルは1〜5で設定してください');
  return config;
}
export function motionMagnitude({x,y,z}) {
  if(![x,y,z].every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=32))throw Error('加速度の値が不正です');
  return Math.abs(Math.hypot(x,y,z)-1);
}
export function motionOutput(value,config=DEFAULT_MOTION_CONFIG,caps={coolLevels:5,warmLevels:3}) {
  validateMotionConfig(config);
  if(!Number.isFinite(value)||value<0)throw Error('動きの値が不正です');
  const position=Math.min(1,value/config.fullScale);
  const signed=position*2-1;
  if(Math.abs(signed)<1e-12)return {kind:'stop',level:0,position};
  const kind=signed<0?'cool':'warm';
  const max=Math.min(kind==='cool'?config.coolMax:config.warmMax,kind==='cool'?caps.coolLevels:caps.warmLevels);
  return {kind,level:Math.max(1,Math.ceil(Math.abs(signed)*max-1e-12)),position};
}
// 20 bytes, little endian; fits the default BLE notification payload.
export function parseMotionPacket(value,time=Date.now()) {
  const view=value instanceof DataView?value:new DataView(value.buffer??value,value.byteOffset??0,value.byteLength);
  if(view.byteLength!==20||view.getUint8(0)!==1)throw Error('M5StickS3のデータ形式が一致しません');
  if((view.getUint8(1)&1)===0)throw Error('M5StickS3のIMUデータが無効です');
  const x=view.getFloat32(4,true),y=view.getFloat32(8,true),z=view.getFloat32(12,true);
  return {x,y,z,motion:motionMagnitude({x,y,z}),sequence:view.getUint16(2,true),uptime:view.getUint32(16,true),time};
}
export function isNewSequence(next,previous) {
  if(previous===null)return true;
  const delta=(next-previous+65536)%65536;
  return delta>0&&delta<32768;
}
