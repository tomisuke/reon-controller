import {publicReading} from './distance-core.js';
import {mountDistance} from './distance-app.js';
const $=id=>document.getElementById(id),section=$('distance-section');
let enabled=false,timer,epoch=0,component,loading,localReading=null;
function show(reading){
  $('reon-distance-value').textContent=reading.score;$('reon-distance-count').textContent=reading.personCount+' 人';
  $('reon-distance-status').textContent=!enabled?'距離計測 OFF · 100':reading.holding?'検出途切れを補正中 · 直前の値を保持':reading.fresh?'計測中 · '+(reading.personCount<2?'2人未満のため100':'最も近い2人'):'映像入力待ち・計測停止 · 100';
  window.reonDistance=reading;window.dispatchEvent(new CustomEvent('reon-distance',{detail:reading}));
}
const stopped=()=>({score:100,personCount:0,fresh:false,status:'stopped',holding:false});
async function prepare(){
  if(component)return component;if(loading)return loading;
  loading=(async()=>{
    const response=await fetch('distance.html');if(!response.ok)throw Error('解析画面の読込に失敗しました');
    const doc=new DOMParser().parseFromString(await response.text(),'text/html'),workspace=doc.querySelector('.workspace');
    const root=$('distance-widget');root.replaceChildren(document.importNode(workspace,true));
    component=mountDistance(root,{onReading:data=>{if(enabled){localReading=data;show(publicReading(data));}}});
    return component;
  })();
  try{return await loading;}finally{loading=null;}
}
function poll(version){
  if(!enabled||version!==epoch)return;
  show(publicReading(localReading));
  timer=setTimeout(()=>poll(version),200);
}
async function setEnabled(value){
  enabled=value;const version=++epoch;clearTimeout(timer);
  $('distance-enabled').checked=enabled;$('distance-enabled-label').textContent=enabled?'ON':'OFF';
  $('distance-expand').disabled=$('distance-fullscreen').disabled=!enabled;
  $('distance-workspace').hidden=!enabled;$('distance-off-note').hidden=enabled;
  if(!enabled){component?.stop();localReading=null;expanded(false);if(document.fullscreenElement===section)document.exitFullscreen().catch(()=>{});show(stopped());return;}
  show(stopped());
  $('reon-distance-status').textContent='距離計測を準備しています…';
  try{await prepare();if(!enabled||version!==epoch)return;$('distance-widget').querySelector('#camera').click();}
  catch(error){if(version===epoch){await setEnabled(false);$('reon-distance-status').textContent=error.message;return;}}
  poll(version);
}
$('distance-enabled').onchange=()=>setEnabled($('distance-enabled').checked);
function expanded(value){section.classList.toggle('distance-expanded',value);document.body.classList.toggle('distance-expanded-open',value);$('distance-expand').textContent=value?'縮小する':'プレビューを拡大';$('distance-expand').setAttribute('aria-expanded',String(value));}
$('distance-expand').onclick=()=>expanded(!section.classList.contains('distance-expanded'));
$('distance-fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(section.requestFullscreen)await section.requestFullscreen();else expanded(true);}catch{expanded(true);}};
document.addEventListener('fullscreenchange',()=>{$('distance-fullscreen').textContent=document.fullscreenElement?'全画面を終了':'全画面';});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&section.classList.contains('distance-expanded')){expanded(false);$('distance-expand').focus();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&enabled)setEnabled(false);});
show(stopped());
