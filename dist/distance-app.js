import {BODY_GAP_METRIC,measure,DetectionHold} from './distance-core.js';
import {LOCAL_KEY} from './distance-client.js';
import {PairTracker,personAt} from './distance-tracker.js';
import {bodyGap,loadPoseDetector,poseInBox} from './distance-pose.js';
import {floorCalibration,floorDistance} from './distance-floor.js';
export function mountDistance(root,{onReading=()=>{}}={}){
const $=id=>root.querySelector('#'+id), video=$('video'), canvas=$('overlay'), stage=$('stage'), ctx=canvas.getContext('2d');
const hold=new DetectionHold();
const tracker=new PairTracker();
const poseInput=document.createElement('canvas').getContext('2d');
let capture=document.createElement('canvas').getContext('2d');
let lastCapture=document.createElement('canvas').getContext('2d');
let detecting=false;
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('reon-distance'):null;
let detector,poseDetector,modelPromise,stream,objectUrl,active=false,generation=0,timer,latest=null,lastLocal=0;
let loopGeneration=0;
let frame=null,inputId=null,lastFrameState=null;
let floor=null,floorCorners=null,floorDimensions=null,destroyed=false;
const cornerNames=['手前左','手前右','奥右','奥左'];
try{const saved=JSON.parse(localStorage.getItem('reon-distance-hold-v1'));if(saved&&[0,500,1000,1500,2000,3000].includes(saved.holdMs)){hold.holdMs=saved.holdMs;$('hold-enabled').checked=saved.holdMs>0;$('hold-duration').value=String(saved.holdMs||1000);}}catch{}
function message(text){if($('message').textContent!==text)$('message').textContent=text;}
function script(src){
  return new Promise((resolve,reject)=>{
    const el=document.createElement('script');el.src=src;el.onload=resolve;
    el.onerror=()=>{el.remove();reject(Error('人物検出ライブラリを取得できません。'));};
    document.head.append(el);
  });
}
async function loadPersonDetector(){
  if(!window.tf)await script('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
  if(!window.cocoSsd)await script('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
  try{await tf.setBackend('webgl');await tf.ready();}catch{await tf.setBackend('cpu');await tf.ready();}
  return cocoSsd.load({base:'lite_mobilenet_v2'});
}
async function model(){
  if(detector&&poseDetector)return;
  if(modelPromise)return modelPromise;
  modelPromise=(async()=>{
    message('人物検出と姿勢推定のモデルを読み込んでいます。');
    const [persons,poses]=await Promise.allSettled([
      detector||loadPersonDetector(),poseDetector||loadPoseDetector(),
    ]);
    if(persons.status==='fulfilled'){
      if(destroyed)persons.value.dispose();else detector=persons.value;
    }
    if(poses.status==='fulfilled'){
      if(destroyed)poses.value.close();else poseDetector=poses.value;
    }
    if(!detector||!poseDetector)throw Error('計測モデルを読み込めません。通信環境を確認して再試行してください。');
  })();
  try{await modelPromise;}finally{modelPromise=null;}
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
  $('select-targets').disabled=$('auto-targets').disabled=!result||floorCorners!==null;
  $('floor-start').disabled=!result;
  stage.classList.toggle('selecting-targets',selectingManually||floorCorners!==null);
}
function stopInput(reason='計測を停止しました。出力は100です。'){
  generation++;active=false;clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;
  video.onpause=video.onended=video.onplaying=video.onseeking=null;
  video.pause();video.srcObject=null;video.removeAttribute('src');video.load();
  if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
  video.hidden=true;$('empty').hidden=false;$('stop').disabled=true;$('camera').disabled=false;$('file').disabled=false;
  resetFloor();$('active-dot').classList.remove('live');$('runtime').textContent='待機中';inactive();message(reason);
}
function draw(result,people,selected){
  canvas.width=frame.width;canvas.height=frame.height;ctx.clearRect(0,0,canvas.width,canvas.height);
  const unit=Math.max(1,canvas.width/640);ctx.lineWidth=2*unit;ctx.font=`${12*unit}px sans-serif`;
  people.forEach((p,i)=>{
    const [x,y,w,h]=p.bbox, target=selected.indexOf(i);
    ctx.strokeStyle=target>=0?'#c7edae':'#8ea7a0';ctx.strokeRect(x,y,w,h);
    ctx.fillStyle='#142c29';ctx.fillRect(x,Math.max(0,y-23*unit),100*unit,23*unit);
    ctx.fillStyle='#d9f3cb';
    const name=target>=0?'対象 '+(target===0?'A':'B'):'人物 '+(i+1);
    ctx.fillText(`${name} · ${Math.round(p.score*100)}%`,x+5*unit,Math.max(16*unit,y-7*unit));
  });
  if(result.points){const [a,b]=result.points;ctx.strokeStyle='#c7edae';ctx.setLineDash([6*unit,5*unit]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);for(const p of [a,b]){ctx.beginPath();ctx.arc(p.x,p.y,4*unit,0,Math.PI*2);ctx.fillStyle='#c7edae';ctx.fill();}}
  const corners=floorCorners??floor?.corners??[];
  ctx.fillStyle=ctx.strokeStyle='#84daff';
  if(corners.length){
    ctx.beginPath();
    corners.forEach(({x,y},i)=>ctx[i===0?'moveTo':'lineTo'](x*canvas.width,y*canvas.height));
    if(corners.length===4)ctx.closePath();
    ctx.stroke();
    corners.forEach(({x,y},i)=>ctx.fillText(String(i+1),x*canvas.width+4*unit,y*canvas.height-4*unit));
  }
}
function reportFrame(){
  const {people,width,height,time}=frame;
  const {targetState,pair,selected}=tracker.current();
  for(const index of pair??[]){
    const person=people[index];
    if(person.points===undefined)person.points=poseInBox(poseDetector,lastCapture.canvas,poseInput,person.bbox);
  }
  const result=hold.update(measure(people,width,height,Number($('scale').value)/100,pair,bodyGap),time);
  if(targetState==='selecting')result.status='selecting_targets';
  if(targetState==='lost')result.status='target_lost';
  result.targetState=targetState;
  latest=result;updateControls(result);draw(result,people,targetState==='lost'?[]:selected);

  const {score,distanceRatio,personCount,fullScale,holding,holdRemainingMs,holdEpoch,holdReason,status}=result;
  const floorDistanceCm=pair?floorDistance(floor,people[pair[0]],people[pair[1]],width,height):null;
  $('floor-distance').textContent=floorDistanceCm===null?'—':`約 ${Math.round(floorDistanceCm)} cm`;
  const receivedAt=Date.now();
  const data={active:true,metric:BODY_GAP_METRIC,score,distanceRatio,floorDistanceCm,inputId,personCount,fullScale,targetState,holding,holdRemainingMs,holdEpoch,holdReason,status,receivedAt,holdUntil:holding?receivedAt+holdRemainingMs:null};
  const changed=status!==lastFrameState;
  lastFrameState=status;
  onReading(data);
  if(changed||receivedAt-lastLocal>=200){
    try{localStorage.setItem(LOCAL_KEY,JSON.stringify(data));}catch{}
    channel?.postMessage(data);lastLocal=receivedAt;
  }

  if(holding)message('対象の検出が一時的に途切れています。直前のスコアを短時間保持しています。');
  else if(targetState==='lost')message('対象を見失いました。「手動で選ぶ」か「自動で選び直す」で再開できます。');
  else if(status==='geometry_unavailable')message('身体が重なっているか、測定に必要な部位が見えません。');
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
function resetFloor(text='未設定'){
  floor=null;floorCorners=null;floorDimensions=null;
  $('floor-status').textContent=text;$('floor-distance').textContent='—';
  $('floor-reset').disabled=true;$('floor-start').textContent='四隅を指定';
  updateControls(latest);
}
$('floor-start').onclick=()=>{
  if(!active||!frame)return;
  if(floorCorners){resetFloor();reportFrame();return;}
  const fields=[$('floor-width'),$('floor-depth')];
  if(!fields.every(field=>field.reportValidity()))return;
  const dimensions=fields.map(field=>field.valueAsNumber);
  if(!dimensions.every(Number.isFinite))return;
  resetFloor();floorDimensions=dimensions;floorCorners=[];
  $('floor-reset').disabled=false;$('floor-start').textContent='指定をキャンセル';
  $('floor-status').textContent='映像上の手前左をタップしてください。';
  reportFrame();
};
$('floor-reset').onclick=()=>{resetFloor();if(frame)reportFrame();};
stage.onclick=event=>{
  if(!active||!frame||(!floorCorners&&(tracker.mode!=='manual'||tracker.targetState!=='selecting')))return;
  const {width,height,people,time}=frame;
  const rect=canvas.getBoundingClientRect();
  const scale=Math.min(rect.width/width,rect.height/height);
  if(!(scale>0))return;
  const x=(event.clientX-rect.left-(rect.width-width*scale)/2)/scale;
  const y=(event.clientY-rect.top-(rect.height-height*scale)/2)/scale;
  if(floorCorners){
    if(x<0||x>width||y<0||y>height)return;
    floorCorners.push({x:x/width,y:y/height});
    if(floorCorners.length===4){
      floor=floorCalibration(floorCorners,...floorDimensions);
      if(floor){
        floorCorners=null;$('floor-start').textContent='四隅を指定';
        $('floor-status').textContent='校正済み · 長方形の中で足元が見える2人を計測';
      }else resetFloor('四隅を指定順にタップしてください。判別できる大きさの長方形が必要です。');
    }else $('floor-status').textContent=`映像上の${cornerNames[floorCorners.length]}をタップしてください。`;
    reportFrame();return;
  }
  if(tracker.select(personAt(people,x,y),time))reportFrame();
};
async function beginLoop(epoch){
  if(active || epoch!==generation)return;
  inputId=crypto.randomUUID();
  active=true;const cycle=++loopGeneration;
  async function tick(){
    if(epoch!==generation || !active || cycle!==loopGeneration)return;
    if(video.paused||video.ended||video.seeking){active=false;inactive();return;}
    if(detecting){timer=setTimeout(tick,50);return;}
    const start=performance.now();
    try{
      const sourceWidth=video.videoWidth,sourceHeight=video.videoHeight;
      if(!sourceWidth||!sourceHeight){timer=setTimeout(tick,50);return;}
      const scale=Math.min(1,1280/Math.max(sourceWidth,sourceHeight));
      const width=Math.round(sourceWidth*scale),height=Math.round(sourceHeight*scale);
      if(frame&&(frame.sourceWidth!==sourceWidth||frame.sourceHeight!==sourceHeight)){
        resetFloor();tracker.reset();hold.reset();inputId=crypto.randomUUID();
      }
      capture.canvas.width=width;capture.canvas.height=height;
      capture.drawImage(video,0,0,width,height);
      const confidence=Number($('confidence').value)/100;
      let predictions;
      detecting=true;
      try{predictions=await detector.detect(capture.canvas,30,confidence);}
      finally{detecting=false;}
      if(epoch!==generation||!active||cycle!==loopGeneration)return;
      if(video.paused||video.ended||video.seeking){active=false;inactive();return;}
      if(video.videoWidth!==sourceWidth||video.videoHeight!==sourceHeight){timer=setTimeout(tick,0);return;}
      const people=predictions.filter(person=>person.class==='person'&&person.score>=confidence)
        .flatMap(person=>{
          const [x,y,w,h]=person.bbox;
          const left=Math.max(0,x),top=Math.max(0,y);
          const right=Math.min(width,x+w),bottom=Math.min(height,y+h);
          return right>left&&bottom>top?[{bbox:[left,top,right-left,bottom-top],score:person.score}]:[];
        });
      const time=performance.now();
      [capture,lastCapture]=[lastCapture,capture];
      frame={people,width,height,time,sourceWidth,sourceHeight};
      tracker.update(people,width,height,time,hold.holdMs);
      reportFrame();
      const elapsed=performance.now()-start;$('runtime').textContent='姿勢推定 / LIVE';$('active-dot').classList.add('live');
      timer=setTimeout(tick,Math.max(0,200-elapsed));
    }catch(error){if(epoch===generation&&cycle===loopGeneration)stopInput('解析に失敗しました: '+error.message);}
  }
  tick();
}
async function ready(epoch){
  if(epoch!==generation)return;
  video.hidden=false;$('empty').hidden=true;$('stage').style.aspectRatio=video.videoWidth+'/'+video.videoHeight;
  video.onpause=video.onseeking=()=>{active=false;clearTimeout(timer);inactive();$('floor-distance').textContent='—';$('runtime').textContent='一時停止';$('active-dot').classList.remove('live');};
  video.onended=()=>{active=false;clearTimeout(timer);inactive();$('floor-distance').textContent='—';$('runtime').textContent='動画終了';$('active-dot').classList.remove('live');};
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
return {stop:()=>stopInput(),destroy(){destroyed=true;stopInput();document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('pagehide',onPageHide);channel?.close();detector?.dispose();poseDetector?.close();}};
}
