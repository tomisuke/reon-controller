import {ReonClient} from './reon-client.js';
import {THERMO,manualFrame,stopFrame,smartFrame,smartStopFrame,automationFrame,parseMode} from './protocol.js';
import {DEFAULT_RULES,evaluateRules,validateRules,parseReading} from './sensor.js';
const $=id=>document.getElementById(id);
const client=new ReonClient();
const storage={get(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}},set(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{}}};
let rules=storage.get('reon-glass-rules',DEFAULT_RULES);try{validateRules(rules)}catch{rules=structuredClone(DEFAULT_RULES)}
let demo=false,kind='cool',level=3,running=false,smartKind='cool',sensorAuto=false,source='tag',reading=null,history=[],samples=[],pending=false;
let pollController=null,pollTimer=null,pollGeneration=0,demoTimer=null,timerDeadline=0,lastTag=null,toastTimer,lastError=null;
let state=client.state;
const demoCaps={coolLevels:5,warmLevels:3,smart:true,wave:true,autoStart:true,quickLaunch:true,environmentalSensor:true};
const caps=()=>demo?demoCaps:state.capabilities;
const ready=()=>demo||state.connected;
const maxLevel=()=>kind==='smart'?5:kind==='warm'?(caps()?.warmLevels??3):(caps()?.coolLevels??5);
const clock=time=>new Date(time).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function log(message){history.unshift({time:Date.now(),message});history=history.slice(0,100);renderHistory()}
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),4000)}
function skeleton(on){$('skeleton').classList.toggle('loaded',!on);$('main').setAttribute('aria-busy',String(on))}
function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(d=>d.close())}
function openDialog(id){closeDialogs();if(id==='rules-dialog')renderRules();if(id==='history-dialog')renderHistory();$(id).showModal()}
document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openDialog(b.dataset.open));
document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()}}));
document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>{if(b.dataset.nav==='history')return openDialog('history-dialog');document.querySelectorAll('[data-nav]').forEach(n=>n.classList.toggle('active',n.dataset.nav===b.dataset.nav));(b.dataset.nav==='sensors'?$('sensor-section'):$('main')).scrollIntoView({behavior:'smooth',block:'start'});if(b.dataset.nav==='sensors'&&!reading)openDialog('sensor-dialog')});
function animateNumber(){const n=$('level-number');n.classList.remove('bump');void n.offsetWidth;n.classList.add('bump')}
function render(){
  const connected=ready(),c=caps(),m=demo?null:state.mode;
  document.body.classList.toggle('warm',kind==='warm');
  $('connect-label').textContent=demo?'実機を接続':state.connecting?'接続中…':state.connected?'接続を解除':'デバイスを接続';
  $('connect').disabled=state.connecting;
  $('connection-state').textContent=demo?'デモモード':state.connecting?'接続中':state.connected?'接続済み':'未接続';
  $('connection-dot').className='dot'+(connected?' connected':state.connecting?' pending':'');
  $('device-model').textContent=demo?'シミュレーション':state.device&&state.connected?`${state.device.model} · FW ${state.device.firmware}`:'Bluetooth';
  $('demo-label').hidden=!demo;$('demo').textContent=demo?'デモを終了':'デモを試す';
  $('run-status').classList.toggle('running',running&&connected);$('run-status').replaceChildren(Object.assign(document.createElement('span'),{className:'dot'}),document.createTextNode(running&&connected?'運転中':'停止中'));
  document.querySelectorAll('[data-kind]').forEach(b=>{const selected=b.dataset.kind===kind;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected));b.disabled=!!c&&!c.smart&&b.dataset.kind==='smart'});
  const activeKind=kind==='smart'?smartKind:kind;
  $('dial-mode').innerHTML=`<svg><use href="#i-${kind==='smart'?'sensor':activeKind==='warm'?'warm':'cool'}"/></svg>${kind==='smart'?'SMART':activeKind==='warm'?'WARM':'COOL'}`;
  $('level-number').textContent=String(level);$('dial-caption').textContent=kind==='smart'?'温度の好み':kind==='warm'?'温熱レベル':'冷却レベル';
  $('dial-arc').style.strokeDasharray=`${674*level/maxLevel()} 899`;
  $('dial-dots').innerHTML=Array.from({length:maxLevel()},(_,i)=>`<i class="${i<level?'on':''}"></i>`).join('');
  $('level-buttons').innerHTML=Array.from({length:maxLevel()},(_,i)=>`<button data-level="${i+1}" class="${i+1===level?'selected':''}" aria-label="レベル${i+1}" aria-pressed="${i+1===level}">${i+1}</button>`).join('');
  $('decrease').disabled=level<=1;$('increase').disabled=level>=maxLevel();
  $('power').classList.toggle('running',running&&connected);$('power').disabled=pending;
  $('power-label').textContent=pending?'送信中…':running&&connected?'運転を停止':connected?'運転を開始':'接続して運転';
  $('battery').textContent=demo?'82%':state.battery&&state.connected?`${state.battery.level}%`: '—';
  $('surface').textContent=demo?`${(running?24.3:28.1).toFixed(1)} °C`:state.temperature&&state.connected?`${state.temperature.surface.toFixed(1)} °C`:'— °C';
  $('wave').disabled=!connected||!c?.wave||kind==='smart';
  $('wave-caption').textContent=c&&!c.wave?'この機種は非対応':kind==='smart'?'マニュアル運転で使用':'強弱をつけて運転';
  $('auto-start').disabled=!connected||!c?.autoStart;$('quick-launch').disabled=!connected||!c?.quickLaunch;
  if(!demo){$('auto-start').checked=state.autoStart??false;$('quick-launch').checked=state.quickLaunch??false;$('wave').checked=state.mode?.type==='manual'&&!!state.mode.wave;}
  $('sensor-auto').checked=sensorAuto;
  $('link-tag').disabled=!connected||state.pairingTag;
  $('link-tag').textContent=state.pairingTag?'Tagを検索中…':state.tagLinked&&!demo?'Tagの接続を解除':'Tagを接続';
  $('device-info').textContent=demo?'DEMO · デバイスへの送信は行いません':state.connected?`${state.device?.name??'REON'} · ${state.device?.model??''} · Firmware ${state.device?.firmware??''}`:'デバイス未接続';
  $('rule-count').textContent=`${rules.length} ルール`;
  renderSensor();
}
function renderSensor(){
  const valid=reading&&Date.now()-reading.time<=30000;
  $('sensor-name').textContent=demo?'デモセンサー':source==='api'&&pollTimer!==null?'JSON API':state.tagLinked?'REON Pocket Tag':'センサー未接続';
  $('sensor-dot').className='dot'+(valid?' live':'');$('sensor-live').textContent=valid?'LIVE':reading?'STALE':'NO DATA';
  $('ambient-temp').textContent=valid?reading.temperature.toFixed(1):'—';$('humidity').textContent=valid&&reading.humidity!==null?Math.round(reading.humidity):'—';
  $('sensor-updated').textContent=reading?`${clock(reading.time)} 更新`:'—';
  $('automation-status').textContent=sensorAuto?(valid?'連動中':'センサー更新待ち'):'オフ';
  $('rule-temp').replaceChildren(document.createTextNode(valid?reading.temperature.toFixed(1):'—'),Object.assign(document.createElement('small'),{textContent:'°C'}));
  const output=valid?evaluateRules(reading.temperature,rules,caps()??demoCaps):null;
  $('rule-output').textContent=output?output.kind==='stop'?'停止':`${output.kind==='warm'?'温熱':'冷却'} ${output.level}`:'—';
  renderChart();
}
function renderChart(){
  $('chart-empty').hidden=samples.length>0;
  if(!samples.length){$('chart-line').setAttribute('d','');$('chart-fill').setAttribute('d','');$('chart-start').textContent='接続待ち';return;}
  const min=Math.floor(Math.min(...samples.map(s=>s.temperature))-1),max=Math.ceil(Math.max(...samples.map(s=>s.temperature))+1);
  $('chart-high').textContent=max+'°';$('chart-low').textContent=min+'°';
  const points=samples.map((s,i)=>[samples.length===1?440:i/(samples.length-1)*440,85-(s.temperature-min)/(max-min)*70]);
  const d=points.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  $('chart-line').setAttribute('d',d);$('chart-fill').setAttribute('d',`${d} L440,100 L${points[0][0]},100 Z`);$('chart-start').textContent=clock(samples[0].time);
}
function renderHistory(){const list=$('history-list');list.replaceChildren();if(!history.length){list.append(Object.assign(document.createElement('div'),{className:'history-empty',textContent:'操作履歴はまだありません'}));return;}for(const h of history){const row=Object.assign(document.createElement('div'),{className:'history-item'});row.append(Object.assign(document.createElement('time'),{textContent:clock(h.time)}),Object.assign(document.createElement('span'),{textContent:h.message}));list.append(row)}}
function requireConnection(){if(ready())return true;toast('デバイスを接続してください');return false}
async function write(frame,message){
  if(!ready())return false;
  const success=demo?true:await client.writeMode(frame);
  if(demo){const m=parseMode(frame);running=m.running;}
  if(success){if(message)log(message);}else{toast('本体に反映できませんでした。再接続してください');sensorAuto=false;}
  render();return success;
}
function currentFrame(){return kind==='smart'?smartFrame(smartKind,level):manualFrame(kind==='warm'?THERMO.warm:THERMO.cool,level,$('wave').checked)}
async function applyManual(start=false){if(!requireConnection())return false;sensorAuto=false;return write(currentFrame(),`${kind==='smart'?'SMART':kind==='warm'?'温熱':'冷却'} レベル${level}${start?' 開始':''}`)}
async function stop(reason='運転停止'){sensorAuto=false;timerDeadline=0;$('timer').value='0';updateTimer();if(!ready()){running=false;render();return true;}const mode=demo?(kind==='smart'?{type:'smart',kind:smartKind}:null):state.mode;const ok=await write(mode?.type==='smart'?smartStopFrame(mode):stopFrame((mode?.kind??kind)==='warm'?THERMO.warm:THERMO.cool),reason);return ok;}
async function connect(start=false){
  const requested={kind,level,smartKind,wave:$('wave').checked};
  if(!navigator.bluetooth){toast('対応するBluetoothブラウザで開いてください');return false;}
  if(demo)endDemo();
  skeleton(true);try{await client.connect();if(!state.connected)return false;if(start){kind=requested.kind;smartKind=requested.smartKind;if(kind==='smart'&&!caps()?.smart)kind=smartKind;level=Math.min(requested.level,maxLevel());$('wave').checked=requested.wave&&!!caps()?.wave;await applyManual(true);}return true;}finally{skeleton(false)}
}
$('connect').onclick=async()=>{if(state.connected){await stop('接続を解除');client.disconnect();}else await connect()};
$('power').onclick=async()=>{if(pending)return;if(running&&ready())return stop();if(!ready())return connect(true);pending=true;render();try{await applyManual(true)}finally{pending=false;render()}};
document.querySelectorAll('[data-kind]').forEach(b=>b.onclick=async()=>{smartKind=kind==='warm'?'warm':'cool';kind=b.dataset.kind;level=Math.min(level,maxLevel());sensorAuto=false;render();animateNumber();if(running&&ready())await applyManual()});
async function chooseLevel(n){level=Math.max(1,Math.min(maxLevel(),n));sensorAuto=false;render();animateNumber();if(ready())await applyManual(true);else toast('接続後、このレベルで運転します')}
$('level-buttons').onclick=e=>{const b=e.target.closest('[data-level]');if(b)chooseLevel(Number(b.dataset.level))};
$('decrease').onclick=()=>chooseLevel(level-1);$('increase').onclick=()=>chooseLevel(level+1);
document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=async()=>{kind='cool';level=b.dataset.preset==='quiet'?1:b.dataset.preset==='strong'?(caps()?.coolLevels??5):Math.min(3,caps()?.coolLevels??5);sensorAuto=false;render();animateNumber();if(ready())await applyManual(true);else await connect(true);document.querySelectorAll('[data-preset]').forEach(p=>p.classList.toggle('selected',p===b));$('preset-label').textContent=b.textContent+' · 冷却レベル'+level});
$('wave').onchange=()=>{if(running&&ready())applyManual()};
for(const [id,name] of [['auto-start','autoStart'],['quick-launch','quickLaunch']])$(id).onchange=async()=>{if(!requireConnection())return;const value=$(id).checked;if(demo){log(`${id==='auto-start'?'オートスタート':'クイック起動'} ${value?'オン':'オフ'}`);return;}if(await client.writeAutomation(name,automationFrame(value)))toast('設定を反映しました');else toast('設定を反映できませんでした');render()};
$('reduce-motion').checked=storage.get('reon-glass-reduced-motion',false);document.body.classList.toggle('motion-reduced',$('reduce-motion').checked);
$('reduce-motion').onchange=()=>{document.body.classList.toggle('motion-reduced',$('reduce-motion').checked);storage.set('reon-glass-reduced-motion',$('reduce-motion').checked)};
$('reload-skeleton').onclick=()=>{closeDialogs();skeleton(true);setTimeout(()=>skeleton(false),1200)};
$('clear-history').onclick=()=>{history=[];renderHistory()};
function updateTimer(){if(timerDeadline){const remaining=Math.max(0,Math.ceil((timerDeadline-Date.now())/1000));$('timer-label').textContent=`残り ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;if(!remaining){timerDeadline=0;stop('オフタイマーで停止');toast('タイマーで停止しました')}}else $('timer-label').textContent='未設定'}
$('timer').onchange=()=>{const minutes=Number($('timer').value);if(minutes&&!running){$('timer').value='0';toast('運転を開始してから設定してください');return;}timerDeadline=minutes?Date.now()+minutes*60000:0;log(minutes?`オフタイマー ${minutes}分`:'オフタイマー解除');updateTimer()};
function setSource(value){document.querySelectorAll('[data-source]').forEach(b=>b.classList.toggle('selected',b.dataset.source===value));$('tag-panel').hidden=value!=='tag';$('api-panel').hidden=value!=='api'}
document.querySelectorAll('[data-source]').forEach(b=>b.onclick=()=>setSource(b.dataset.source));
$('link-tag').onclick=async()=>{if(!requireConnection())return;if(demo){toast('デモではTagを接続しません');return;}if(!state.tagLinked&&!(typeof BluetoothDevice!=='undefined'&&'watchAdvertisements' in BluetoothDevice.prototype)){ $('sensor-message').textContent='このブラウザはTag広告の読み取りに対応していません。JSON APIを利用してください。';return;}stopPolling();source='tag';reading=null;samples=[];lastTag=null;if(sensorAuto)await stop('Tag変更で停止');sensorAuto=false;await (state.tagLinked?client.unlinkTag():client.linkTag());$('sensor-message').textContent=state.error??(state.tagLinked?'接続済み · センサー値の受信待ち':'Tagの接続を解除しました');render()};
function stopPolling(){pollGeneration++;if(pollTimer!==null)clearTimeout(pollTimer);pollTimer=null;pollController?.abort();pollController=null;}
async function acceptReading(value){reading=value;samples.push(value);samples=samples.slice(-90);renderSensor();if(sensorAuto&&ready())await applySensor(value)}
async function applySensor(value){
  const action=evaluateRules(value.temperature,rules,caps()??demoCaps);
  // No hysteresis, cooldown, smoothing or debounce: evaluate and send every reading.
  if(action.kind==='stop'){
    const mode=demo?{type:kind==='smart'?'smart':'manual',kind:kind==='smart'?smartKind:kind}:state.mode;
    await write(mode?.type==='smart'?smartStopFrame(mode):stopFrame(mode?.kind==='warm'?THERMO.warm:THERMO.cool),`センサー ${value.temperature.toFixed(1)}°C → 停止`);
  }else{kind=action.kind;level=action.level;await write(manualFrame(kind==='warm'?THERMO.warm:THERMO.cool,level,false),`センサー ${value.temperature.toFixed(1)}°C → ${kind==='warm'?'温熱':'冷却'} ${level}`);}
  render();
}
$('sensor-auto').onchange=async()=>{if(!$('sensor-auto').checked){sensorAuto=false;render();log('センサー連動オフ');return;}if(!requireConnection()){$('sensor-auto').checked=false;return;}if(!reading||Date.now()-reading.time>30000){$('sensor-auto').checked=false;toast('有効なセンサー値が必要です');openDialog('sensor-dialog');return;}sensorAuto=true;await applySensor(reading);render()};
$('sensor-url').value=storage.get('reon-glass-sensor-url','');$('poll-interval').value=storage.get('reon-glass-poll-interval','1000');
$('api-panel').onsubmit=async e=>{e.preventDefault();let url;try{url=new URL($('sensor-url').value);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error();if(url.username||url.password)throw Error();}catch{$('sensor-message').textContent='認証情報を含まないHTTPS URLを入力してください';return;}
  if(demo)endDemo();stopPolling();source='api';reading=null;samples=[];sensorAuto=false;const generation=pollGeneration;const interval=Number($('poll-interval').value);storage.set('reon-glass-sensor-url',url.href);storage.set('reon-glass-poll-interval',String(interval));
  async function poll(){if(generation!==pollGeneration)return;pollController=new AbortController();const timeout=setTimeout(()=>pollController?.abort(),8000);try{const r=await fetch(url.href,{signal:pollController.signal,cache:'no-store',credentials:'omit'});if(!r.ok)throw Error(`HTTP ${r.status}`);const value=parseReading(await r.json());if(generation!==pollGeneration)return;await acceptReading(value);$('sensor-message').textContent=`${clock(Date.now())} · 接続済み`;lastError=null;}catch(error){if(generation!==pollGeneration)return;$('sensor-message').textContent='取得できません: '+error.message;if(lastError!==error.message){log('センサー取得エラー: '+error.message);lastError=error.message;}}finally{clearTimeout(timeout);if(generation===pollGeneration){pollTimer=setTimeout(poll,interval);renderSensor()}}}
  pollTimer=0;render();await poll();
};
$('stop-api').onclick=async()=>{stopPolling();reading=null;samples=[];if(sensorAuto)await stop('センサー接続解除で停止');$('sensor-message').textContent='API接続を解除しました';render()};
function renderRules(){const container=$('rule-rows');container.replaceChildren();for(const r of rules)addRuleRow(r);$('rules-error').textContent=''}
function addRuleRow(r={temperature:35,kind:'cool',level:5}){const row=document.createElement('div');row.className='rule-row';row.innerHTML=`<input type="number" step="0.1" min="-40" max="80" required aria-label="温度以下"><select aria-label="運転"><option value="warm">温熱</option><option value="stop">停止</option><option value="cool">冷却</option></select><input type="number" min="1" max="5" step="1" required aria-label="レベル"><button type="button" aria-label="ルールを削除">×</button>`;const [temp,select,lev]=row.querySelectorAll('input,select');temp.value=r.temperature;select.value=r.kind;lev.value=r.kind==='stop'?1:r.level;lev.disabled=r.kind==='stop';select.onchange=()=>lev.disabled=select.value==='stop';row.querySelector('button').onclick=()=>row.remove();$('rule-rows').append(row)}
$('add-rule').onclick=()=>{const rows=$('rule-rows').children;const last=rows.length?Number(rows[rows.length-1].querySelector('input').value):30;addRuleRow({temperature:Math.min(80,last+3),kind:'cool',level:5})};
$('rules-form').onsubmit=async e=>{e.preventDefault();const next=[...$('rule-rows').children].map(row=>{const [t,k,l]=row.querySelectorAll('input,select');return{temperature:Number(t.value),kind:k.value,level:k.value==='stop'?0:Number(l.value)}});try{validateRules(next);rules=next;storage.set('reon-glass-rules',rules);closeDialogs();toast('ルールを保存しました');render();if(sensorAuto&&reading)await applySensor(reading)}catch(error){$('rules-error').textContent=error.message}};
function endDemo(){clearInterval(demoTimer);demoTimer=null;demo=false;sensorAuto=false;running=false;reading=null;samples=[];timerDeadline=0;$('timer').value='0';$('wave').checked=false;render();updateTimer();log('デモ終了')}
$('demo').onclick=async()=>{if(demo){endDemo();return;}if(state.connected){await stop('デモへ切り替え');client.disconnect();}stopPolling();demo=true;running=false;sensorAuto=false;timerDeadline=0;$('timer').value='0';samples=[];source='tag';await acceptReading({temperature:28.4,humidity:62,time:Date.now()});demoTimer=setInterval(()=>{const temperature=+(28.5+Math.sin(Date.now()/15000)*1.9).toFixed(1);acceptReading({temperature,humidity:62,time:Date.now()})},2000);log('デモ開始');render();toast('デモモード · 実機には送信しません')};
client.onState(s=>{const wasConnected=state.connected;const previousMode=state.mode;state=s;if(!demo){running=!!s.connected&&!!s.mode?.running;if(s.connected&&s.mode&&(s.mode!==previousMode||!wasConnected)){if(s.mode.kind==='warm'||s.mode.kind==='cool'){smartKind=s.mode.kind;kind=s.mode.type==='smart'?'smart':s.mode.kind;level=s.mode.level??s.mode.preference??level;}else if(s.mode.kind==='auto'){kind='smart';level=s.mode.coolPreference??3;}level=Math.min(level,maxLevel());}if(s.tag&&s.tag!==lastTag&&source==='tag'&&s.connected){lastTag=s.tag;acceptReading({temperature:s.tag.temperature,humidity:s.tag.humidity,time:Date.now()});}if(wasConnected&&!s.connected){sensorAuto=false;running=false;timerDeadline=0;$('timer').value='0';log('Bluetooth接続が切れました');toast('Bluetooth接続が切れました');}if(!wasConnected&&s.connected)log('Bluetooth接続完了');if(s.error&&s.error!==lastError){lastError=s.error;toast(s.error.includes('selected')?'デバイスが選択されませんでした':s.error.includes('rejected')?'本体が変更を受け付けませんでした':'接続できません。本体ボタンを2秒押して再試行してください');}render();}});
setInterval(()=>{updateTimer();if(reading&&Date.now()-reading.time>30000&&sensorAuto){stop('センサー更新が30秒途絶えたため停止');toast('センサー更新が途絶えたため停止しました')}renderSensor()},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){updateTimer();if(reading&&Date.now()-reading.time>30000&&sensorAuto)stop('センサー値の期限切れで停止')}});
window.addEventListener('pagehide',()=>{stopPolling();if(state.connected)client.disconnect()});
$('browser-notice').hidden=!!navigator.bluetooth;
for(let i=0;i<41;i++){const angle=(135+i*6.75)*Math.PI/180;const line=document.createElementNS('http://www.w3.org/2000/svg','line');line.setAttribute('x1',170+130*Math.cos(angle));line.setAttribute('y1',170+130*Math.sin(angle));line.setAttribute('x2',170+133*Math.cos(angle));line.setAttribute('y2',170+133*Math.sin(angle));line.setAttribute('stroke','#b7cbe1');line.setAttribute('stroke-width','1');$('dial-ticks').append(line)}
render();setTimeout(()=>skeleton(false),850);


