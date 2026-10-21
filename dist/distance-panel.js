import {localDistance,fetchDistance} from './distance-client.js';
const $=id=>document.getElementById(id);
let enabled=false,timer,controller;
const param=new URL(location.href).searchParams.get('distance');
if(param)$('distance-api-url').value=param;
function show(reading){$('reon-distance-value').textContent=reading.score;$('reon-distance-count').textContent=reading.personCount+' 人';$('reon-distance-status').textContent=reading.fresh?'計測中 · '+(reading.personCount<2?'2人未満のため100':'最も近い2人'):'計測なし・更新切れ · 100';window.reonDistance=reading;window.dispatchEvent(new CustomEvent('reon-distance',{detail:reading}));}
async function poll(){
  if(!enabled)return;
  try{const raw=$('distance-api-url').value.trim();if(!raw)show(localDistance());else{
    const url=new URL(raw,location.origin);if(url.origin!==location.origin || !/^\/api\/distance\/[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash || url.username || url.password)throw Error('このサイトの距離API URLを入力してください');
    controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),3000);try{show(await fetchDistance(url.href,controller.signal));}finally{clearTimeout(timeout);}
  }}catch(error){show({score:100,personCount:0,fresh:false,status:'error'});$('reon-distance-status').textContent='取得失敗 · 100 / '+error.message;}
  finally{if(enabled)timer=setTimeout(poll,1000);}
}
$('distance-monitor').onclick=()=>{enabled=!enabled;clearTimeout(timer);controller?.abort();$('distance-monitor').textContent=enabled?'参照を停止':'スコアを参照';$('distance-api-url').disabled=enabled;if(enabled)poll();else show({score:100,personCount:0,fresh:false,status:'stopped'});};
show({score:100,personCount:0,fresh:false,status:'stopped'});
$('distance-inline').addEventListener('toggle',()=>{if($('distance-inline').open){$('distance-frame').src='/distance?embed=1';if(!enabled)$('distance-monitor').click();}else $('distance-frame').removeAttribute('src');});
