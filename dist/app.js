import {ReonClient} from './reon-client.js';
import {THERMO,manualFrame,stopFrame,smartStopFrame,parseMode} from './protocol.js';
import {DEFAULT_RULES,evaluateRules,validateRules,parseReading} from './sensor.js';
import {bluetoothProblem} from './bluetooth-environment.js';
import {M5Client} from './m5-client.js';
import {DEFAULT_MOTION_CONFIG,MOTION_STALE_MS,validateMotionConfig,motionOutput} from './motion.js';
const $=id=>document.getElementById(id);
const client=new ReonClient();
const m5=new M5Client();
const storage={get(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}},set(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{}}};
let motionConfig=storage.get('reon-motion-config',DEFAULT_MOTION_CONFIG);try{validateMotionConfig(motionConfig)}catch{motionConfig={...DEFAULT_MOTION_CONFIG}}
let motionAuto=false,motionEpoch=0,motionReading=null,m5State=m5.state,motionDemoTimer=null;
let rules=storage.get('reon-glass-rules',DEFAULT_RULES);try{validateRules(rules)}catch{rules=structuredClone(DEFAULT_RULES)}
let demo=false,kind='cool',level=3,running=false,sensorAuto=false,source='tag',reading=null,pending=false;
let pollController=null,pollTimer=null,pollGeneration=0,demoTimer=null,lastTag=null,toastTimer,lastError=null;
let state=client.state;
const demoCaps={coolLevels:5,warmLevels:3,environmentalSensor:true};
const caps=()=>demo?demoCaps:state.capabilities;
const ready=()=>demo||state.connected;
const maxLevel=()=>kind==='warm'?(caps()?.warmLevels??3):(caps()?.coolLevels??5);
const clock=time=>new Date(time).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function log(message){$('last-action').textContent=message;}
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),4000)}
function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(d=>d.close())}
function openDialog(id){closeDialogs();if(id==='rules-dialog')renderRules();$(id).showModal()}
document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openDialog(b.dataset.open));
document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()}}));
function render(){
  const connected=ready(),c=caps();
  document.body.classList.toggle('warm',kind==='warm');
  $('connect-label').textContent=state.connecting?'キャンセル':demo?'実機を接続':state.connected?'接続を解除':'デバイスを接続';
  $('connect').disabled=false;
  $('demo').disabled=state.connecting;
  $('connection-feedback').hidden=demo||(!state.connecting&&!state.error);
  $('connection-spinner').hidden=!state.connecting;
  $('connection-feedback').classList.toggle('connection-failed',!!state.error);
  $('connection-message').textContent=state.connecting?({selecting:'ブラウザのデバイス選択待ち',connecting:'本体に接続中…',authenticating:'本体の認証中…',reading:'本体の情報を読み取り中…'}[state.connectionStage]??'接続中…'):state.error??'';
  $('connection-state').textContent=demo?'デモモード':state.connecting?'接続中':state.connected?'接続済み':'未接続';
  $('connection-dot').className='dot'+(connected?' connected':state.connecting?' pending':'');
  $('device-model').textContent=demo?'シミュレーション':state.device&&state.connected?`${state.device.model} · FW ${state.device.firmware}`:'Bluetooth';
  $('demo-label').hidden=!demo;$('demo').textContent=demo?'デモを終了':'デモを試す';
  $('run-status').classList.toggle('running',running&&connected);$('run-status').replaceChildren(Object.assign(document.createElement('span'),{className:'dot'}),document.createTextNode(running&&connected?'運転中':'停止中'));
  const actual=demo?{kind,level}:state.mode;
  $('output-status').textContent=running&&connected?(actual?.type==='smart'?'SMART · ':'')+(actual?.kind==='warm'?'温熱':'冷却')+' '+(actual?.level??actual?.preference??level):connected?'停止':'未接続';
  for(const outputKind of ['cool','warm']){
    const count=outputKind==='warm'?(c?.warmLevels??3):(c?.coolLevels??5);
    const bank=$(outputKind+'-levels');
    if(bank.children.length!==count)bank.innerHTML=Array.from({length:count},(_,i)=>'<button data-output="'+outputKind+'" data-level="'+(i+1)+'" aria-label="'+(outputKind==='warm'?'温熱':'冷却')+(i+1)+'">'+(i+1)+'</button>').join('');
    for(const button of bank.children){const selected=kind===outputKind&&Number(button.dataset.level)===level;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected&&running&&connected));button.disabled=state.connecting||pending;}
  }
  $('power').classList.toggle('running',running&&connected);$('power').disabled=pending||state.connecting;
  $('power-label').textContent=state.connecting?'接続待ち…':pending?'送信中…':running&&connected?'運転を停止':connected?'運転を開始':'接続して運転';
  $('battery').textContent=demo?'82%':state.battery&&state.connected?`${state.battery.level}%`: '—';
  $('surface').textContent=demo?`${(running?24.3:28.1).toFixed(1)} °C`:state.temperature&&state.connected?`${state.temperature.surface.toFixed(1)} °C`:'— °C';
  $('sensor-auto').checked=sensorAuto;
  $('link-tag').disabled=!connected||state.pairingTag||c?.tagLink===false;
  $('link-tag').textContent=state.pairingTag?'Tagを検索中…':state.tagLinked&&!demo?'Tagの接続を解除':'Tagを接続';
  $('device-info').textContent=demo?'DEMO · デバイスへの送信は行いません':state.connected?`${state.device?.name??'REON'} · ${state.device?.model??''} · Firmware ${state.device?.firmware??''}`:'デバイス未接続';
  if(state.manualControl)$('device-info').textContent+=' · 本体の自動開始/停止: '+(state.manualControl.readBackVerified?'無効を確認済み':'無効化を送信済み（読取非対応）');
  $('connection-details').hidden=!state.connectionDetail||demo;
  const diagnostic=state.connectionDetail?JSON.stringify(state.connectionDetail,null,2):'接続履歴はありません';
  $('connection-diagnostic').textContent=diagnostic;$('settings-connection-diagnostic').textContent=demo?'デモモード':diagnostic;
  $('rule-count').textContent=`${rules.length} ルール`;
  renderSensor();
  renderMotion();
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
}
function requireConnection(){if(ready())return true;toast('デバイスを接続してください');return false}
async function write(frame,message,guard){
  if(!ready())return false;
  if(guard&&!guard())return null;
  const success=demo?true:await client.writeMode(frame,guard);
  if(success===null)return null;
  if(demo){const m=parseMode(frame);running=m.running;}
  if(success){if(message)log(message);}else{toast('本体に反映できませんでした。再接続してください');sensorAuto=false;disableMotion();}
  render();return success;
}
function currentFrame(){return manualFrame(kind==='warm'?THERMO.warm:THERMO.cool,level,false)}
async function applyManual(start=false){if(!requireConnection())return false;sensorAuto=false;disableMotion();return write(currentFrame(),`${kind==='warm'?'温熱':'冷却'} レベル${level}${start?' 開始':''}`)}
async function stop(reason='運転停止'){sensorAuto=false;disableMotion();if(!ready()){running=false;render();return true;}const mode=demo?null:state.mode;const ok=await write(mode?.type==='smart'?smartStopFrame(mode):stopFrame((mode?.kind??kind)==='warm'?THERMO.warm:THERMO.cool),reason);return ok;}
async function connect(start=false){
  if(state.connecting)return false;
  const requested={kind,level};
  if(demo)endDemo();
  await client.connect();if(!state.connected)return false;if(start){kind=requested.kind;level=Math.min(requested.level,maxLevel());await applyManual(true);}return true;
}
$('connect').onclick=async()=>{if(state.connecting){client.cancelConnection();return;}if(state.connected){await stop('接続を解除');client.disconnect();}else await connect()};
$('app-url').value=window.location.origin+window.location.pathname;
document.querySelectorAll('[data-copy-diagnostics]').forEach(button=>button.onclick=async()=>{if(!state.connectionDetail){toast('接続履歴はありません');return;}try{await navigator.clipboard.writeText(JSON.stringify(state.connectionDetail,null,2));toast('接続の詳細をコピーしました')}catch{toast('接続の詳細を開き、テキストを選択してコピーしてください')}});
$('copy-url').onclick=async()=>{try{await navigator.clipboard.writeText($('app-url').value);toast('URLをコピーしました。Chrome / Edgeなどの対応ブラウザで開いてください。')}catch{$('app-url').focus();$('app-url').select();toast('URLを選択しました。コピーして対応ブラウザで開いてください。')}};
$('power').onclick=async()=>{if(pending)return;if(running&&ready())return stop();if(!ready())return connect(true);pending=true;render();try{await applyManual(true)}finally{pending=false;render()}};
async function chooseOutput(outputKind,outputLevel){
  if(state.connecting||pending)return;
  disableMotion();sensorAuto=false;kind=outputKind;level=Math.max(1,Math.min(maxLevel(),outputLevel));render();
  if(ready())await applyManual(true);else await connect(true);
}
for(const id of ['cool-levels','warm-levels'])$(id).onclick=e=>{const b=e.target.closest('[data-output]');if(b)chooseOutput(b.dataset.output,Number(b.dataset.level));};
$('reduce-motion').checked=storage.get('reon-glass-reduced-motion',false);document.body.classList.toggle('motion-reduced',$('reduce-motion').checked);
$('reduce-motion').onchange=()=>{document.body.classList.toggle('motion-reduced',$('reduce-motion').checked);storage.set('reon-glass-reduced-motion',$('reduce-motion').checked)};
function setSource(value){document.querySelectorAll('[data-source]').forEach(b=>b.classList.toggle('selected',b.dataset.source===value));$('tag-panel').hidden=value!=='tag';$('api-panel').hidden=value!=='api'}
document.querySelectorAll('[data-source]').forEach(b=>b.onclick=()=>setSource(b.dataset.source));
$('link-tag').onclick=async()=>{if(!requireConnection())return;if(demo){toast('デモではTagを接続しません');return;}if(!state.tagLinked&&!(typeof BluetoothDevice!=='undefined'&&'watchAdvertisements' in BluetoothDevice.prototype)){ $('sensor-message').textContent='このブラウザはTag広告の読み取りに対応していません。JSON APIを利用してください。';return;}stopPolling();source='tag';reading=null;lastTag=null;if(sensorAuto)await stop('Tag変更で停止');sensorAuto=false;await (state.tagLinked?client.unlinkTag():client.linkTag());$('sensor-message').textContent=state.error??(state.tagLinked?'接続済み · センサー値の受信待ち':'Tagの接続を解除しました');render()};
function stopPolling(){pollGeneration++;if(pollTimer!==null)clearTimeout(pollTimer);pollTimer=null;pollController?.abort();pollController=null;}
async function acceptReading(value){reading=value;renderSensor();if(sensorAuto&&ready())await applySensor(value)}
async function applySensor(value){
  const action=evaluateRules(value.temperature,rules,caps()??demoCaps);
  // No hysteresis, cooldown, smoothing or debounce: evaluate and send every reading.
  if(action.kind==='stop'){
    const mode=demo?{type:'manual',kind}:state.mode;
    await write(mode?.type==='smart'?smartStopFrame(mode):stopFrame(mode?.kind==='warm'?THERMO.warm:THERMO.cool),`センサー ${value.temperature.toFixed(1)}°C → 停止`);
  }else{kind=action.kind;level=action.level;await write(manualFrame(kind==='warm'?THERMO.warm:THERMO.cool,level,false),`センサー ${value.temperature.toFixed(1)}°C → ${kind==='warm'?'温熱':'冷却'} ${level}`);}
  render();
}
$('sensor-auto').onchange=async()=>{if(!$('sensor-auto').checked){sensorAuto=false;render();log('センサー連動オフ');return;}if(!requireConnection()){$('sensor-auto').checked=false;return;}if(!reading||Date.now()-reading.time>30000){$('sensor-auto').checked=false;toast('有効なセンサー値が必要です');openDialog('sensor-dialog');return;}disableMotion();sensorAuto=true;await applySensor(reading);render()};
$('sensor-url').value=storage.get('reon-glass-sensor-url','');$('poll-interval').value=storage.get('reon-glass-poll-interval','1000');
$('api-panel').onsubmit=async e=>{e.preventDefault();let url;try{url=new URL($('sensor-url').value);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error();if(url.username||url.password)throw Error();}catch{$('sensor-message').textContent='認証情報を含まないHTTPS URLを入力してください';return;}
  if(demo)endDemo();stopPolling();source='api';reading=null;sensorAuto=false;const generation=pollGeneration;const interval=Number($('poll-interval').value);storage.set('reon-glass-sensor-url',url.href);storage.set('reon-glass-poll-interval',String(interval));
  async function poll(){if(generation!==pollGeneration)return;pollController=new AbortController();const timeout=setTimeout(()=>pollController?.abort(),8000);try{const r=await fetch(url.href,{signal:pollController.signal,cache:'no-store',credentials:'omit'});if(!r.ok)throw Error(`HTTP ${r.status}`);const value=parseReading(await r.json());if(generation!==pollGeneration)return;await acceptReading(value);$('sensor-message').textContent=`${clock(Date.now())} · 接続済み`;lastError=null;}catch(error){if(generation!==pollGeneration)return;$('sensor-message').textContent='取得できません: '+error.message;if(lastError!==error.message){log('センサー取得エラー: '+error.message);lastError=error.message;}}finally{clearTimeout(timeout);if(generation===pollGeneration){pollTimer=setTimeout(poll,interval);renderSensor()}}}
  pollTimer=0;render();await poll();
};
$('stop-api').onclick=async()=>{stopPolling();reading=null;if(sensorAuto)await stop('センサー接続解除で停止');$('sensor-message').textContent='API接続を解除しました';render()};
function renderRules(){const container=$('rule-rows');container.replaceChildren();for(const r of rules)addRuleRow(r);$('rules-error').textContent=''}
function addRuleRow(r={temperature:35,kind:'cool',level:5}){const row=document.createElement('div');row.className='rule-row';row.innerHTML=`<input type="number" step="0.1" min="-40" max="80" required aria-label="温度以下"><select aria-label="運転"><option value="warm">温熱</option><option value="stop">停止</option><option value="cool">冷却</option></select><input type="number" min="1" max="5" step="1" required aria-label="レベル"><button type="button" aria-label="ルールを削除">×</button>`;const [temp,select,lev]=row.querySelectorAll('input,select');temp.value=r.temperature;select.value=r.kind;lev.value=r.kind==='stop'?1:r.level;lev.disabled=r.kind==='stop';select.onchange=()=>lev.disabled=select.value==='stop';row.querySelector('button').onclick=()=>row.remove();$('rule-rows').append(row)}
$('add-rule').onclick=()=>{const rows=$('rule-rows').children;const last=rows.length?Number(rows[rows.length-1].querySelector('input').value):30;addRuleRow({temperature:Math.min(80,last+3),kind:'cool',level:5})};
$('rules-form').onsubmit=async e=>{e.preventDefault();const next=[...$('rule-rows').children].map(row=>{const [t,k,l]=row.querySelectorAll('input,select');return{temperature:Number(t.value),kind:k.value,level:k.value==='stop'?0:Number(l.value)}});try{validateRules(next);rules=next;storage.set('reon-glass-rules',rules);closeDialogs();toast('ルールを保存しました');render();if(sensorAuto&&reading)await applySensor(reading)}catch(error){$('rules-error').textContent=error.message}};
function motionFresh(sample=motionReading){return !!sample&&Date.now()-sample.time>=0&&Date.now()-sample.time<=MOTION_STALE_MS}
function disableMotion(){motionAuto=false;motionEpoch++;if($('motion-auto'))$('motion-auto').checked=false;}
function renderMotion(){
  const fresh=motionFresh(),sample=fresh?motionReading:null;
  $('m5-connect-label').textContent=m5State.connecting?'キャンセル':m5State.connected?'接続を解除':'接続';
  $('m5-status').textContent=demo?'デモセンサー':m5State.connecting?'M5StickS3を選択・接続中…':m5State.connected?(fresh?'加速度を受信中':'加速度の更新待ち'):'未接続';
  $('m5-dot').className='dot'+(m5State.connecting?' pending':fresh?' live':'');
  $('motion-mode-label').textContent=motionAuto?'加速度に連動中':'連動オフ';
  $('motion-auto').checked=motionAuto;$('motion-auto').disabled=m5State.connecting;
  $('motion-value').textContent=sample?sample.motion.toFixed(3):'—';
  for(const axis of ['x','y','z'])$('motion-'+axis).textContent=sample?sample[axis].toFixed(3):'—';
  const output=sample?motionOutput(sample.motion,motionConfig,caps()??demoCaps):null;
  $('motion-output').textContent=output?output.kind==='stop'?'停止':`${output.kind==='warm'?'温熱':'冷却'} ${output.level}`:'—';
  $('motion-demo').hidden=!demo;
  if(m5State.error&&!demo)$('motion-error').textContent=m5State.error;
}
async function applyMotion(sample){
  const epoch=motionEpoch;
  const guard=()=>motionAuto&&motionEpoch===epoch&&motionFresh(sample)&&ready()&&(demo||m5State.connected);
  if(!guard())return;
  const output=motionOutput(sample.motion,motionConfig,caps()??demoCaps);
  if(output.kind==='stop'){
    const mode=demo?null:state.mode;
    await write(mode?.type==='smart'?smartStopFrame(mode):stopFrame((mode?.kind??kind)==='warm'?THERMO.warm:THERMO.cool),`加速度 ${sample.motion.toFixed(3)}G → 停止`,guard);
  }else{
    kind=output.kind;level=output.level;
    await write(manualFrame(kind==='warm'?THERMO.warm:THERMO.cool,level,false),`加速度 ${sample.motion.toFixed(3)}G → ${kind==='warm'?'温熱':'冷却'} ${level}`,guard);
  }
  renderMotion();
}
async function receiveMotion(sample){motionReading=sample;renderMotion();if(motionAuto)await applyMotion(sample)}
$('m5-connect').onclick=async()=>{if(m5State.connecting){m5.cancel();return;}if(m5State.connected){if(motionAuto)await stop('M5StickS3の接続解除で停止');m5.disconnect();return;}if(demo)endDemo();$('motion-error').textContent='';await m5.connect()};
$('motion-auto').onchange=async()=>{if(!$('motion-auto').checked){disableMotion();renderMotion();return;}if(!requireConnection()){disableMotion();return;}if(!motionFresh()||(!demo&&!m5State.connected)){disableMotion();toast('M5StickS3を接続し、加速度を受信してください');return;}sensorAuto=false;motionEpoch++;motionAuto=true;$('motion-error').textContent='';render();await applyMotion(motionReading)};
for(const [id,key] of [['motion-scale-input','fullScale'],['motion-cool-max','coolMax'],['motion-warm-max','warmMax']]){
  $(id).value=String(motionConfig[key]);
  $(id).onchange=async()=>{const next={...motionConfig,[key]:Number($(id).value)};try{validateMotionConfig(next);motionConfig=next;storage.set('reon-motion-config',motionConfig);motionEpoch++;renderMotion();if(motionAuto&&motionFresh())await applyMotion(motionReading)}catch(error){$(id).value=String(motionConfig[key]);toast(error.message)}};
}
function motionDemoSample(){const value=Number($('motion-demo-input').value);$('motion-demo-value').textContent=value.toFixed(2)+'G';return {x:0,y:0,z:1+value,motion:value,time:Date.now(),sequence:0,uptime:0}}
$('motion-demo-input').oninput=()=>{if(demo)receiveMotion(motionDemoSample())};
m5.onState(s=>{const previous=m5State;m5State=s;if(!demo){if(s.reading&&s.reading!==previous.reading){$('motion-error').textContent='';receiveMotion(s.reading);}if(previous.connected&&!s.connected){motionReading=null;if(motionAuto){stop('M5StickS3の接続が切れたため停止');$('motion-error').textContent='M5StickS3との接続が切れたため停止しました';}}renderMotion();}});
setInterval(()=>{if(motionAuto&&!motionFresh()){stop('加速度が1.5秒更新されないため停止');$('motion-error').textContent='加速度の更新が途絶えたため停止しました';}renderMotion();},250);
function endDemo(){clearInterval(demoTimer);clearInterval(motionDemoTimer);motionDemoTimer=null;demoTimer=null;demo=false;sensorAuto=false;disableMotion();motionReading=m5State.reading;running=false;reading=null;render();log('デモ終了')}
$('demo').onclick=async()=>{if(demo){endDemo();return;}if(state.connected){await stop('デモへ切り替え');client.disconnect();}stopPolling();disableMotion();demo=true;running=false;sensorAuto=false;source='tag';await acceptReading({temperature:28.4,humidity:62,time:Date.now()});demoTimer=setInterval(()=>{const temperature=+(28.5+Math.sin(Date.now()/15000)*1.9).toFixed(1);acceptReading({temperature,humidity:62,time:Date.now()})},2000);await receiveMotion(motionDemoSample());motionDemoTimer=setInterval(()=>receiveMotion(motionDemoSample()),200);log('デモ開始');render();toast('デモモード · 実機には送信しません')};
client.onState(s=>{const wasConnected=state.connected;const previousMode=state.mode;const previousStop=state.lastStop;state=s;if(!demo){running=!!s.connected&&!!s.mode?.running;if(s.connected&&s.mode&&(s.mode!==previousMode||!wasConnected)){if(s.mode.kind==='warm'||s.mode.kind==='cool'){kind=s.mode.kind;level=s.mode.level??s.mode.preference??level;}else if(s.mode.kind==='auto'){kind='cool';level=s.mode.coolPreference??3;}level=Math.min(level,maxLevel());}if(s.tag&&s.tag!==lastTag&&source==='tag'&&s.connected){lastTag=s.tag;acceptReading({temperature:s.tag.temperature,humidity:s.tag.humidity,time:Date.now()});}if(wasConnected&&!s.connected){disableMotion();sensorAuto=false;running=false;log('Bluetooth接続が切れました');toast('Bluetooth接続が切れました');}if(!wasConnected&&s.connected)log('Bluetooth接続完了');if(s.lastStop&&s.lastStop!==previousStop&&s.lastStop.source==='device_report'){log('本体から停止状態を受信（アプリからの停止指示なし）。接続診断を確認してください。');toast('本体が運転を停止しました。接続診断で停止元を確認できます。');}if(s.error&&s.error!==lastError){lastError=s.error;toast(s.error.includes('rejected')?'本体が変更を受け付けませんでした':s.error);}render();}});
setInterval(()=>{if(reading&&Date.now()-reading.time>30000&&sensorAuto){stop('センサー更新が30秒途絶えたため停止');toast('センサー更新が途絶えたため停止しました')}renderSensor()},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(reading&&Date.now()-reading.time>30000&&sensorAuto)stop('センサー値の期限切れで停止');if(motionAuto&&!motionFresh())stop('加速度の期限切れで停止')}});
window.addEventListener('pagehide',()=>{disableMotion();stopPolling();m5.disconnect();if(state.connected)client.disconnect()});
const browserProblem=bluetoothProblem();$('browser-notice').hidden=!browserProblem;if(browserProblem)$('browser-notice').textContent=browserProblem;
render();




