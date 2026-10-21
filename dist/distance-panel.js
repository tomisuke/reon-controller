import {fetchDistance} from './distance-client.js';
import {publicReading} from './distance-core.js';
import {mountDistance} from './distance-app.js';
const $=id=>document.getElementById(id),section=$('distance-section');
let enabled=false,timer,controller,epoch=0,component,loading,localReading=null;
const param=new URL(location.href).searchParams.get('distance');
if(param){$('distance-api-url').value=param;$('distance-source').value='remote';}
$('distance-api-url').placeholder=location.origin+'/api/distance/…';
function show(reading){
  $('reon-distance-value').textContent=reading.score;$('reon-distance-count').textContent=reading.personCount+' 人';
  $('reon-distance-status').textContent=!enabled?'距離計測 OFF · 100':reading.holding?'検出途切れを補正中 · 直前の値を保持':reading.fresh?'計測中 · '+(reading.personCount<2?'2人未満のため100':'最も近い2人'):'映像入力待ち・計測停止 · 100';
  window.reonDistance=reading;window.dispatchEvent(new CustomEvent('reon-distance',{detail:reading}));
}
const stopped=()=>({score:100,personCount:0,fresh:false,status:'stopped',holding:false});
async function prepare(){
  if(component)return component;if(loading)return loading;
  loading=(async()=>{
    const response=await fetch('/distance.html');if(!response.ok)throw Error('解析画面の読込に失敗しました');
    const doc=new DOMParser().parseFromString(await response.text(),'text/html'),workspace=doc.querySelector('.workspace');
    const root=$('distance-widget');root.replaceChildren(document.importNode(workspace,true));
    const aside=root.querySelector('aside'),share=aside.querySelector('.share-panel');
    const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='別端末にスコアを共有';details.append(summary,share);aside.append(details);
    component=mountDistance(root,{onReading:data=>{if(enabled&&$('distance-source').value==='local'){localReading=data;show(publicReading(data));}}});
    return component;
  })();
  try{return await loading;}finally{loading=null;}
}
async function poll(version){
  if(!enabled||version!==epoch)return;
  try{
    if($('distance-source').value==='local')show(publicReading(localReading));
    else{
      const url=new URL($('distance-api-url').value.trim(),location.origin);
      if(url.origin!==location.origin||!/^\/api\/distance\/[a-f0-9]{32}$/.test(url.pathname)||url.search||url.hash||url.username||url.password)throw Error('このサイトの距離API URLを入力してください');
      controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),3000);
      try{const reading=await fetchDistance(url.href,controller.signal);if(enabled&&version===epoch)show(reading);}finally{clearTimeout(timeout);}
    }
  }catch(error){if(enabled&&version===epoch){show(stopped());$('reon-distance-status').textContent='取得失敗 · 100 / '+error.message;}}
  finally{if(enabled&&version===epoch)timer=setTimeout(()=>poll(version),$('distance-source').value==='local'?200:1000);}
}
async function setEnabled(value){
  enabled=value;const version=++epoch;clearTimeout(timer);controller?.abort();
  $('distance-enabled').checked=enabled;$('distance-enabled-label').textContent=enabled?'ON':'OFF';
  $('distance-source').disabled=enabled;$('distance-api-url').disabled=enabled;
  $('distance-expand').disabled=$('distance-fullscreen').disabled=!enabled||$('distance-source').value!=='local';
  $('distance-workspace').hidden=!enabled||$('distance-source').value!=='local';$('distance-off-note').hidden=enabled;
  if(!enabled){component?.stop();localReading=null;expanded(false);if(document.fullscreenElement===section)document.exitFullscreen().catch(()=>{});show(stopped());return;}
  show(stopped());
  if($('distance-source').value==='local'){
    $('reon-distance-status').textContent='距離計測を準備しています…';
    try{await prepare();if(!enabled||version!==epoch)return;$('distance-widget').querySelector('#camera').click();}
    catch(error){if(version===epoch){await setEnabled(false);$('reon-distance-status').textContent=error.message;return;}}
  }
  poll(version);
}
$('distance-enabled').onchange=()=>setEnabled($('distance-enabled').checked);
$('distance-source').onchange=()=>{$('distance-remote').hidden=$('distance-source').value!=='remote';};$('distance-source').onchange();
function expanded(value){section.classList.toggle('distance-expanded',value);document.body.classList.toggle('distance-expanded-open',value);$('distance-expand').textContent=value?'縮小する':'プレビューを拡大';$('distance-expand').setAttribute('aria-expanded',String(value));}
$('distance-expand').onclick=()=>expanded(!section.classList.contains('distance-expanded'));
$('distance-fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(section.requestFullscreen)await section.requestFullscreen();else expanded(true);}catch{expanded(true);}};
document.addEventListener('fullscreenchange',()=>{$('distance-fullscreen').textContent=document.fullscreenElement?'全画面を終了':'全画面';});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&section.classList.contains('distance-expanded')){expanded(false);$('distance-expand').focus();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&enabled&&$('distance-source').value==='local')setEnabled(false);});
show(stopped());
