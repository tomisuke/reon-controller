import {measure,DetectionHold} from './distance-core.js';
import {LOCAL_KEY} from './distance-client.js';
import {PairTracker,personAt} from './distance-tracker.js';
export function mountDistance(root,{onReading=()=>{}}={}){
const $=id=>root.querySelector('#'+id), video=$('video'), canvas=$('overlay'), stage=$('stage'), ctx=canvas.getContext('2d');
const hold=new DetectionHold();
const tracker=new PairTracker();
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('reon-distance'):null;
let detector,modelPromise,stream,objectUrl,active=false,generation=0,timer,latest=null,lastLocal=0;
let loopGeneration=0;
let frame=null,inputId=null,lastFrameState=null;
try{const saved=JSON.parse(localStorage.getItem('reon-distance-hold-v1'));if(saved&&[0,500,1000,1500,2000,3000].includes(saved.holdMs)){hold.holdMs=saved.holdMs;$('hold-enabled').checked=saved.holdMs>0;$('hold-duration').value=String(saved.holdMs||1000);}}catch{}
function message(text){if($('message').textContent!==text)$('message').textContent=text;}
function script(src){return new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=src;el.onload=resolve;el.onerror=()=>{el.remove();reject(Error('AIライブラリを取得できません。ネット接続を確認して再試行してください。'));};document.head.append(el);});}
async function model(){
  if(detector)return detector;
  if(modelPromise)return modelPromise;
  modelPromise=(async()=>{
    message('人物検出モデルを読み込んでいます。初回は少し時間がかかります。');
    if(!window.tf)await script('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
    if(!window.cocoSsd)await script('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
    try{await tf.setBackend('webgl');await tf.ready();}catch{await tf.setBackend('cpu');await tf.ready();}
    detector=await cocoSsd.load({base:'lite_mobilenet_v2'});
    return detector;
  })();
  try{return await modelPromise;}finally{modelPromise=null;}
}
function inactive(){
  loopGeneration++;hold.reset();tracker.reset();
  frame=null;inputId=null;lastFrameState=null;
  const data={active:false,score:100,personCount:0,status:'stopped',receivedAt:Date.now(),fullScale:Number($('scale').value)/100};
  try{localStorage.setItem(LOCAL_KEY,JSON.stringify(data));}catch{}
  channel?.postMessage(data);updateControls(null);latest=null;ctx.clearRect(0,0,canvas.width,canvas.height);
  onReading(data);
}
function updateControls(result){
  const selectingManually=result?.targetState==='selecting'&&tracker.mode==='manual';
  $('calibrate').disabled=!result?.pair || result.distanceRatio<.05;
  $('select-targets').disabled=$('auto-targets').disabled=!result;
  stage.classList.toggle('selecting-targets',selectingManually);
}
function stopInput(reason='計測を停止しました。出力は100です。'){
  generation++;active=false;clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;
  video.onpause=video.onended=video.onplaying=video.onseeking=null;
  video.pause();video.srcObject=null;video.removeAttribute('src');video.load();
  if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
  video.hidden=true;$('empty').hidden=false;$('stop').disabled=true;$('camera').disabled=false;$('file').disabled=false;
  $('active-dot').classList.remove('live');$('runtime').textContent='待機中';inactive();message(reason);
}
function draw(result,people,selected){
  canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.clearRect(0,0,canvas.width,canvas.height);
  const unit=Math.max(1,canvas.width/640);ctx.lineWidth=2*unit;ctx.font=`${12*unit}px sans-serif`;
  people.forEach((p,i)=>{
    const [x,y,w,h]=p.bbox, target=selected.indexOf(i);
    ctx.strokeStyle=target>=0?'#c7edae':'#8ea7a0';ctx.strokeRect(x,y,w,h);
    ctx.fillStyle='#142c29';ctx.fillRect(x,Math.max(0,y-23*unit),100*unit,23*unit);
    ctx.fillStyle='#d9f3cb';
    const name=target>=0?'対象 '+(target===0?'A':'B'):'人物 '+(i+1);
    ctx.fillText(`${name} · ${Math.round(p.score*100)}%`,x+5*unit,Math.max(16*unit,y-7*unit));
  });
  if(result.pair){const [a,b]=result.pair.map(i=>result.centers[i]);ctx.strokeStyle='#c7edae';ctx.setLineDash([6*unit,5*unit]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);for(const p of [a,b]){ctx.beginPath();ctx.arc(p.x,p.y,4*unit,0,Math.PI*2);ctx.fillStyle='#c7edae';ctx.fill();}}
}
function reportFrame(){
  const {people,width,height,time}=frame;
  const {targetState,pair,selected}=tracker.current();
  const result=hold.update(measure(people,width,height,Number($('scale').value)/100,pair),time);
  if(targetState==='selecting')result.status='selecting_targets';
  if(targetState==='lost')result.status='target_lost';
  result.targetState=targetState;
  latest=result;updateControls(result);draw(result,people,targetState==='lost'?[]:selected);

  const {score,distanceRatio,personCount,fullScale,holding,holdRemainingMs,holdEpoch,status}=result;
  const receivedAt=Date.now();
  const data={active:true,score,distanceRatio,inputId,personCount,fullScale,targetState,holding,holdRemainingMs,holdEpoch,status,receivedAt,holdUntil:holding?receivedAt+holdRemainingMs:null};
  const changed=status!==lastFrameState;
  lastFrameState=status;
  onReading(data);
  if(changed||receivedAt-lastLocal>=200){
    try{localStorage.setItem(LOCAL_KEY,JSON.stringify(data));}catch{}
    channel?.postMessage(data);lastLocal=receivedAt;
  }

  if(holding)message('対象の検出が一時的に途切れています。直前のスコアを短時間保持しています。');
  else if(targetState==='lost')message('対象を見失いました。「手動で選ぶ」か「自動で選び直す」で再開できます。');
  else if(pair)message((tracker.mode==='auto'?'自動で選んだ2人':'手動で選んだ2人')+'を計測中。');
  else if(tracker.mode==='auto')message('画面の中央に近く、大きく映る2人を探しています。手動でも指定できます。');
  else message(selected.some(index=>index>=0)?'もう1人の人物枠をタップしてください。':'計測したい2人の人物枠を順にタップしてください。');
}
function resetTargets(mode){
  if(!active||!frame)return;
  inputId=crypto.randomUUID();lastFrameState=null;
  hold.reset();tracker.reset(mode);
  tracker.update(frame.people,frame.width,frame.height,frame.time,hold.holdMs);
  reportFrame();
}
$('select-targets').onclick=()=>resetTargets('manual');
$('auto-targets').onclick=()=>resetTargets('auto');
stage.onclick=event=>{
  if(!active||!frame||tracker.mode!=='manual'||tracker.targetState!=='selecting')return;
  const {width,height,people,time}=frame;
  const rect=canvas.getBoundingClientRect();
  const scale=Math.min(rect.width/width,rect.height/height);
  if(!(scale>0))return;
  const x=(event.clientX-rect.left-(rect.width-width*scale)/2)/scale;
  const y=(event.clientY-rect.top-(rect.height-height*scale)/2)/scale;
  if(tracker.select(personAt(people,x,y),time))reportFrame();
};
async function beginLoop(epoch){
  if(active || epoch!==generation)return;
  inputId=crypto.randomUUID();
  active=true;const cycle=++loopGeneration;
  async function tick(){
    if(epoch!==generation || !active || cycle!==loopGeneration)return;
    if(video.paused||video.ended||video.seeking){active=false;inactive();return;}
    const start=performance.now();
    try{
      const predictions=await detector.detect(video,30,Number($('confidence').value)/100);
      if(epoch!==generation||!active||cycle!==loopGeneration)return;
      if(video.paused||video.ended||video.seeking){active=false;inactive();return;}
      const width=video.videoWidth,height=video.videoHeight;
      const people=predictions.filter(p=>p.class==='person'&&p.score>=Number($('confidence').value)/100).map(p=>{const [x,y,w,h]=p.bbox;const bx=Math.max(0,x),by=Math.max(0,y);return {...p,bbox:[bx,by,Math.max(0,Math.min(width,x+w)-bx),Math.max(0,Math.min(height,y+h)-by)]};}).filter(p=>p.bbox[2]>0&&p.bbox[3]>0);
      const time=performance.now();
      frame={people,width,height,time};
      tracker.update(people,width,height,time,hold.holdMs);
      reportFrame();
      const elapsed=performance.now()-start;$('runtime').textContent=tf.getBackend().toUpperCase()+' / LIVE';$('active-dot').classList.add('live');
      timer=setTimeout(tick,Math.max(0,200-elapsed));
    }catch(error){if(epoch===generation&&cycle===loopGeneration)stopInput('解析に失敗しました: '+error.message);}
  }
  tick();
}
async function ready(epoch){
  if(epoch!==generation)return;
  video.hidden=false;$('empty').hidden=true;$('stage').style.aspectRatio=video.videoWidth+'/'+video.videoHeight;
  video.onpause=video.onseeking=()=>{active=false;clearTimeout(timer);inactive();$('runtime').textContent='一時停止';$('active-dot').classList.remove('live');};
  video.onended=()=>{active=false;clearTimeout(timer);inactive();$('runtime').textContent='動画終了';$('active-dot').classList.remove('live');};
  video.onplaying=()=>beginLoop(epoch);
  await video.play();beginLoop(epoch);
}
function metadata(){return new Promise((resolve,reject)=>{video.onloadedmetadata=()=>{video.onloadedmetadata=null;resolve();};video.onerror=()=>reject(Error('この動画を再生できません。MP4 / WebMなどブラウザ対応形式を使用してください。'));});}
$('camera').onclick=async()=>{
  stopInput();const epoch=generation;$('camera').disabled=true;$('stop').disabled=false;
  let acquired;
  try{
    if(!navigator.mediaDevices?.getUserMedia)throw Error('この環境ではカメラを利用できません。URLをChrome / Edgeで直接開いてください。');
    message('カメラの利用許可を待っています…');
    acquired=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:960},height:{ideal:540},facingMode:'environment'},audio:false});
    if(epoch!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;for(const track of stream.getVideoTracks())track.onended=()=>{if(epoch===generation)stopInput('カメラが切断されました。出力は100です。');};
    const loaded=metadata();video.srcObject=stream;video.controls=false;await Promise.all([loaded,model()]);
    if(epoch!==generation)return;$('source-label').textContent='カメラ映像';await ready(epoch);
  }catch(error){if(epoch===generation)stopInput(error.name==='NotAllowedError'?'カメラが許可されませんでした。ブラウザの権限を確認するか、動画ファイルを選んでください。':error.message);else acquired?.getTracks().forEach(t=>t.stop());}
};
$('file').onchange=async()=>{
  const file=$('file').files[0];if(!file)return;
  stopInput();const epoch=generation;$('stop').disabled=false;
  try{objectUrl=URL.createObjectURL(file);const loaded=metadata();video.src=objectUrl;video.controls=true;video.load();await Promise.all([loaded,model()]);if(epoch!==generation)return;$('source-label').textContent=file.name;await ready(epoch);}
  catch(error){if(epoch===generation)stopInput(error.message);}
  finally{$('file').value='';}
};
$('stop').onclick=()=>stopInput();
$('confidence').oninput=()=>{$('confidence-label').textContent=$('confidence').value+'%';};
$('scale').oninput=()=>{$('scale-label').textContent='映像の対角線の'+$('scale').value+'%';};
$('hold-enabled').onchange=$('hold-duration').onchange=()=>{hold.holdMs=$('hold-enabled').checked?Number($('hold-duration').value):0;$('hold-duration').disabled=!$('hold-enabled').checked;try{localStorage.setItem('reon-distance-hold-v1',JSON.stringify({holdMs:hold.holdMs}));}catch{}};
$('hold-duration').disabled=!$('hold-enabled').checked;
$('calibrate').onclick=()=>{if(!latest?.pair)return;$('scale').value=Math.max(5,Math.min(100,Math.round(latest.distanceRatio*100)));$('scale').oninput();message('現在の距離を最大距離に設定しました。次の解析から反映します。');};
const onVisibility=()=>{if(document.hidden)stopInput('画面が非表示になったため停止しました。再開には映像を選び直してください。');};
document.addEventListener('visibilitychange',onVisibility);
const onPageHide=()=>{generation++;active=false;stream?.getTracks().forEach(t=>t.stop());try{localStorage.setItem(LOCAL_KEY,JSON.stringify({active:false,receivedAt:Date.now()}));}catch{}channel?.postMessage({active:false,receivedAt:Date.now()});};
window.addEventListener('pagehide',onPageHide);
return {stop:()=>stopInput(),destroy(){stopInput();document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('pagehide',onPageHide);channel?.close();detector?.dispose();}};
}
