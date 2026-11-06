import {measure,DetectionHold} from './distance-core.js';
import {LOCAL_KEY} from './distance-client.js';
export function mountDistance(root=document,{onReading=()=>{}}={}){
const $=id=>root.querySelector('#'+id), video=$('video'), canvas=$('overlay'), ctx=canvas.getContext('2d');
const hold=new DetectionHold();
const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('reon-distance'):null;
let detector,modelPromise,stream,objectUrl,active=false,generation=0,timer,latest=null,lastLocal=0,lastPublish=0,session=null,queue=Promise.resolve();
let sharing=false,loopGeneration=0,pendingPublish=0;
try{const saved=JSON.parse(localStorage.getItem('reon-distance-hold-v1'));if(saved&&[0,500,1000,1500,2000,3000].includes(saved.holdMs)){hold.holdMs=saved.holdMs;$('hold-enabled').checked=saved.holdMs>0;$('hold-duration').value=String(saved.holdMs||1000);}}catch{}
try{session=JSON.parse(localStorage.getItem('reon-distance-session-v1'));if(session&&Date.parse(session.expiresAt)<Date.now())session=null;}catch{}
function message(text){$('message').textContent=text;}
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
  loopGeneration++;hold.reset();
  const data={active:false,score:100,personCount:0,status:'stopped',receivedAt:Date.now(),fullScale:Number($('scale').value)/100};
  try{localStorage.setItem(LOCAL_KEY,JSON.stringify(data));}catch{}
  channel?.postMessage(data);display(null);latest=null;ctx.clearRect(0,0,canvas.width,canvas.height);
  onReading(data);
  publish({active:false},true);
}
function display(result){
  const score=result?.score??100;
  $('score').textContent=String(score);$('score-marker').style.left=score+'%';$('count').textContent=result?.personCount??0;
  $('score-state').textContent=result ? result.holding?'検出途切れを補正中 · 直前の値を保持':result.pair ? '最も近い2人を計測中' : '2人未満のため100を出力' : '計測停止 · 100を出力';
  $('calibrate').disabled=!result?.pair || result.distanceRatio<.05;
}
function stopInput(reason='計測を停止しました。出力は100です。'){
  generation++;active=false;clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;
  video.onpause=video.onended=video.onplaying=video.onseeking=null;
  video.pause();video.srcObject=null;video.removeAttribute('src');video.load();
  if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}
  video.hidden=true;$('empty').hidden=false;$('stop').disabled=true;$('camera').disabled=false;$('file').disabled=false;
  $('active-dot').classList.remove('live');$('runtime').textContent='待機中';$('fps').textContent='—';inactive();message(reason);
}
function publish(payload,force=false){
  if(!session)return;
  if(!force&&pendingPublish>0)return;
  const now=Date.now();if(!force&&now-lastPublish<1000)return;lastPublish=now;
  const target={...session}, epoch=generation;pendingPublish++;
  queue=queue.catch(()=>{}).then(async()=>{
    if(!force&&epoch!==generation)return;
    try{
      const r=await fetch('/api/distance/'+target.id,{method:'PUT',headers:{'Content-Type':'application/json','Authorization':'Bearer '+target.writeToken},body:JSON.stringify(payload),signal:AbortSignal.timeout(5000)});
      if(!r.ok)throw Error('HTTP '+r.status);
      $('share-message').textContent=payload.active?'共有中 · 数値のみ毎秒更新。停止・5秒更新切れで100。':'共有中 · 計測停止のため100。';
    }catch(error){$('share-message').textContent='共有APIの更新失敗: '+error.message+'。更新から5秒後にAPIの値は100になります。';}
  }).finally(()=>pendingPublish--);
}
function draw(result,people){
  canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.clearRect(0,0,canvas.width,canvas.height);
  const unit=Math.max(1,canvas.width/640);ctx.lineWidth=2*unit;ctx.font=`${12*unit}px sans-serif`;
  people.forEach((p,i)=>{const [x,y,w,h]=p.bbox;ctx.strokeStyle=result.pair?.includes(i)?'#c7edae':'#8ea7a0';ctx.strokeRect(x,y,w,h);ctx.fillStyle='#142c29';ctx.fillRect(x,Math.max(0,y-23*unit),100*unit,23*unit);ctx.fillStyle='#d9f3cb';ctx.fillText(`PERSON ${i+1} · ${Math.round(p.score*100)}%`,x+5*unit,Math.max(16*unit,y-7*unit));});
  if(result.pair){const [a,b]=result.pair.map(i=>result.centers[i]);ctx.strokeStyle='#c7edae';ctx.setLineDash([6*unit,5*unit]);ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);for(const p of [a,b]){ctx.beginPath();ctx.arc(p.x,p.y,4*unit,0,Math.PI*2);ctx.fillStyle='#c7edae';ctx.fill();}}
}
async function beginLoop(epoch){
  if(active || epoch!==generation)return;
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
      const result=hold.update(measure(people,width,height,Number($('scale').value)/100));latest=result;display(result);draw(result,people);
      const elapsed=performance.now()-start;$('fps').textContent=Math.min(5,1000/Math.max(1,elapsed)).toFixed(1);$('runtime').textContent=tf.getBackend().toUpperCase()+' / LIVE';$('active-dot').classList.add('live');
      const data={...result,centers:undefined,active:true,receivedAt:Date.now(),holdUntil:result.holding?Date.now()+result.holdRemainingMs:null};
      onReading(data);
      if(Date.now()-lastLocal>=200){try{localStorage.setItem(LOCAL_KEY,JSON.stringify(data));}catch{}channel?.postMessage(data);lastLocal=Date.now();}
      publish({active:true,score:result.score,personCount:result.personCount,fullScale:result.fullScale,holding:result.holding,holdRemainingMs:result.holdRemainingMs,holdEpoch:result.holdEpoch});
      message(result.holding?'人物の検出が一時的に途切れています。直前のスコアを短時間保持しています。':'計測中。映像は端末内で処理しています。画面を開いたまま使用してください。');
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
$('hold-enabled').onchange=$('hold-duration').onchange=()=>{hold.holdMs=$('hold-enabled').checked?Number($('hold-duration').value):0;hold.reset();$('hold-duration').disabled=!$('hold-enabled').checked;try{localStorage.setItem('reon-distance-hold-v1',JSON.stringify({holdMs:hold.holdMs}));}catch{}};
$('hold-duration').disabled=!$('hold-enabled').checked;
$('calibrate').onclick=()=>{if(!latest?.pair)return;$('scale').value=Math.max(5,Math.min(100,Math.round(latest.distanceRatio*100)));$('scale').oninput();message('現在の距離を最大距離に設定しました。次の解析から反映します。');};
function showSession(){
  $('share-result').hidden=!session;$('share').hidden=!!session;
  if(session){$('read-url').value=location.origin+'/api/distance/'+session.id;$('controller-link').href='/?distance='+encodeURIComponent($('read-url').value);}
}
$('share').onclick=async()=>{
  if(sharing)return;sharing=true;$('share').disabled=true;
  try{
    const response=await fetch('/api/distance/sessions',{method:'POST',signal:AbortSignal.timeout(8000)});
    if(response.status===401){$('signin').hidden=false;throw Error('共有APIの作成にはログインが必要です。端末内の計測はそのまま利用できます。');}
    if(!response.ok)throw Error('HTTP '+response.status);
    session=await response.json();try{localStorage.setItem('reon-distance-session-v1',JSON.stringify(session));}catch{}
    showSession();lastPublish=0;$('share-message').textContent='共有APIを作成しました。計測中は毎秒更新します。';if(!active)publish({active:false},true);
  }catch(error){$('share-message').textContent=error.message;}finally{sharing=false;$('share').disabled=false;}
};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('read-url').value);$('share-message').textContent='読み取り専用URLをコピーしました。';}catch{$('read-url').select();$('share-message').textContent='URLを選択しました。コピーしてください。';}};
$('revoke').onclick=async()=>{
  if(!session)return;const target=session;$('revoke').disabled=true;await queue.catch(()=>{});
  try{const r=await fetch('/api/distance/'+target.id,{method:'DELETE',headers:{Authorization:'Bearer '+target.writeToken},signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('HTTP '+r.status);session=null;try{localStorage.removeItem('reon-distance-session-v1');}catch{}showSession();$('share-message').textContent='共有を削除しました。以前のAPIは無効です。';}
  catch(error){$('share-message').textContent='削除できませんでした: '+error.message;}finally{$('revoke').disabled=false;}
};
const onVisibility=()=>{if(document.hidden)stopInput('画面が非表示になったため停止しました。再開には映像を選び直してください。');};
document.addEventListener('visibilitychange',onVisibility);
const onPageHide=()=>{generation++;active=false;stream?.getTracks().forEach(t=>t.stop());try{localStorage.setItem(LOCAL_KEY,JSON.stringify({active:false,receivedAt:Date.now()}));}catch{}channel?.postMessage({active:false,receivedAt:Date.now()});if(session)fetch('/api/distance/'+session.id,{method:'PUT',headers:{'Content-Type':'application/json','Authorization':'Bearer '+session.writeToken},body:JSON.stringify({active:false}),keepalive:true}).catch(()=>{});};
window.addEventListener('pagehide',onPageHide);
showSession();
return {stop:()=>stopInput(),destroy(){stopInput();document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('pagehide',onPageHide);channel?.close();detector?.dispose();}};
}
if(document.querySelector('body > .topbar'))mountDistance();
