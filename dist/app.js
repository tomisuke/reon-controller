import {ReonClient,sameBluetoothDevice} from './reon-client.js';
import {parseMode} from './protocol.js';
import {actionFrame,outputKey,outputLabel,combinedOutputLabel,commonCapabilities,STOP,TARGETS} from './reon-fleet.js';
import {DEFAULT_RULES,evaluateRules,validateRules,parseReading} from './sensor.js';
import {bluetoothProblem} from './bluetooth-environment.js';
import {M5Client} from './m5-client.js';
import {DEFAULT_MOTION_CONFIG,MOTION_STALE_MS,validateMotionConfig,motionOutput} from './motion.js';
import {distanceSample,scoreToRatio,calibratedOutput,calibrationSample,validCalibration,estimateCm,median,CALIBRATION} from './distance-output.js';
const $=id=>document.getElementById(id);
// Two REON units (A/B). Automations drive every connected unit; manual control drives the selected target.
const slots=['a','b'].map(id=>({id,label:id.toUpperCase(),client:null,state:null,distanceApplied:null,excluded:false}));
for(const slot of slots){slot.client=new ReonClient({slot:slot.id,isTaken:device=>slots.some(other=>other!==slot&&(other.state.connected||other.state.connecting)&&sameBluetoothDevice(other.client.bluetoothDevice,device))});slot.state=slot.client.state;}
const idOf=(base,slot)=>slot.id==='a'?base:base+'-'+slot.id;
const m5=new M5Client();
const storage={get(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}},set(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{}}};
let motionConfig=storage.get('reon-motion-config',DEFAULT_MOTION_CONFIG);try{validateMotionConfig(motionConfig)}catch{motionConfig={...DEFAULT_MOTION_CONFIG}}
let motionAuto=false,motionEpoch=0,motionReading=null,m5State=m5.state,motionDemoTimer=null;
let distanceAuto=false,distanceEpoch=0,distanceReading=null,distanceReceivedAt=0,distanceDirty=false,distanceSending=false;
const CALIBRATION_KEY='reon-distance-calibration-v1',emptyCalibration=()=>({near:null,far:null,nearAt:null,farAt:null});
let distanceCalibration=(()=>{const c=storage.get(CALIBRATION_KEY,null),point=v=>Number.isFinite(v)&&v>=0&&v<=1?v:null;return c?{near:point(c.near),far:point(c.far),nearAt:c.nearAt??null,farAt:c.farAt??null}:emptyCalibration()})(),calibrating=null;
let rules=storage.get('reon-glass-rules',DEFAULT_RULES);try{validateRules(rules)}catch{rules=structuredClone(DEFAULT_RULES)}
let demo=false,kind='cool',level=3,sensorAuto=false,source='tag',reading=null,pending=false;
let pollController=null,pollTimer=null,pollGeneration=0,demoTimer=null,lastTag=null,toastTimer,lastError=null;
let target=storage.get('reon-target','both');if(!TARGETS.includes(target))target='both';
const demoCaps={coolLevels:5,warmLevels:4,environmentalSensor:true};
const demoSlot={id:'demo',label:'DEMO',distanceApplied:null,excluded:false,state:{connected:true,capabilities:demoCaps,mode:null},client:{async writeMode(frame,guard){if(guard&&!guard())return null;demoSlot.state={...demoSlot.state,mode:parseMode(frame)};return true}}};
const connectedSlots=()=>demo?[demoSlot]:slots.filter(s=>s.state.connected);
// Units that follow the active automation: connected, and not dropped after a failure or a self-reported stop.
const linkedSlots=()=>connectedSlots().filter(s=>!s.excluded);
// The target selection only matters while both units are connected; otherwise manual control drives every connected unit.
const bothConnected=()=>!demo&&slots.every(s=>s.state.connected);
const inTarget=slot=>!bothConnected()||target==='both'||target===slot.id;
const targetSlots=()=>connectedSlots().filter(inTarget);
const isRunning=list=>list.some(s=>s.state.mode?.running);
const slotPrefix=slot=>slots.some(other=>other!==slot&&(other.state.connected||other.state.connecting))?`本体${slot.label}: `:'';
const caps=()=>commonCapabilities((targetSlots().length?targetSlots():connectedSlots()).map(s=>s.state.capabilities));
const automationActive=()=>sensorAuto||motionAuto||distanceAuto;
function armSlots(){for(const s of [...slots,demoSlot]){s.excluded=false;s.distanceApplied=null;}}
const ready=()=>connectedSlots().length>0;
const maxLevel=()=>kind==='warm'?(caps()?.warmLevels??3):(caps()?.coolLevels??5);
const clock=time=>new Date(time).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function log(message){$('last-action').textContent=message;}
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),4000)}
function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(d=>d.close())}
function openDialog(id){closeDialogs();if(id==='rules-dialog')renderRules();$(id).showModal()}
document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>openDialog(b.dataset.open));
document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()}}));
function renderSlot(slot){
  const s=slot.state,id=base=>idOf(base,slot),simulated=demo&&slot.id==='a',connected=simulated||s.connected;
  $(id('connect-label')).textContent=s.connecting?'キャンセル':simulated?'実機を接続':s.connected?'接続を解除':'デバイスを接続';
  $(id('connection-state')).textContent=simulated?'デモモード':s.connecting?'接続中':s.connected?'接続済み':'未接続';
  $(id('connection-dot')).className='dot'+(connected?' connected':s.connecting?' pending':'');
  $(id('device-model')).textContent=simulated?'シミュレーション':s.device&&s.connected?`${s.device.model} · FW ${s.device.firmware}`:'';
  const mode=simulated?demoSlot.state.mode:s.mode;
  $(id('battery')).textContent=simulated?'82%':s.battery&&s.connected?`${s.battery.level}%`:'—';
  $(id('surface')).textContent=simulated?`${(mode?.running?24.3:28.1).toFixed(1)} °C`:s.temperature&&s.connected?`${s.temperature.surface.toFixed(1)} °C`:'— °C';
  $(id('device-row')).classList.toggle('connected',connected);
  $(id('device-row')).classList.toggle('targeted',connected&&(simulated||inTarget(slot)));
}
function slotDiagnostics(){
  const entries=slots.filter(s=>s.state.connectionDetail);
  if(!entries.length)return null;
  if(entries.length===1&&!slots.some(s=>s!==entries[0]&&s.state.connected))return JSON.stringify(entries[0].state.connectionDetail,null,2);
  return entries.map(s=>`本体${s.label}\n`+JSON.stringify(s.state.connectionDetail,null,2)).join('\n\n');
}
function render(){
  const connected=ready(),c=caps(),targets=targetSlots(),running=isRunning(targets);
  document.body.classList.toggle('warm',kind==='warm');
  for(const slot of slots)renderSlot(slot);
  const busy=slots.some(s=>s.state.connecting);
  $('demo').disabled=busy;
  // Connection progress/errors: the unit being connected, otherwise the latest failure.
  const focus=slots.find(s=>s.state.connecting)??slots.find(s=>s.state.error&&!s.state.connected)??slots.find(s=>s.state.error);
  const fs=focus?.state;
  $('connection-feedback').hidden=demo||!focus;
  $('connection-spinner').hidden=!fs?.connecting;
  $('connection-feedback').classList.toggle('connection-failed',!!fs?.error);
  $('connection-message').textContent=!focus?'':(slotPrefix(focus)+(fs.connecting?({selecting:'ブラウザのデバイス選択待ち',connecting:'本体に接続中…',authenticating:'本体の認証中…',reading:'本体の情報を読み取り中…'}[fs.connectionStage]??'接続中…'):fs.error??''));
  $('demo-label').hidden=!demo;$('demo').textContent=demo?'デモを終了':'デモを試す';
  const anyRunning=isRunning(connectedSlots());
  $('run-status').classList.toggle('running',anyRunning);$('run-status').replaceChildren(Object.assign(document.createElement('span'),{className:'dot'}),document.createTextNode(anyRunning?'運転中':'停止中'));
  $('output-status').textContent=combinedOutputLabel(connectedSlots().map(s=>({label:s.label,mode:s.state.mode})),level);
  const both=bothConnected();
  $('target-tabs').classList.toggle('inactive',!both);
  for(const button of document.querySelectorAll('[data-target]')){const selected=both?button.dataset.target===target:button.dataset.target==='both';button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));button.disabled=!both;}
  $('target-note').textContent=both?'':demo?'デモ':connected?'接続中の本体':'未接続';
  for(const outputKind of ['cool','warm']){
    const count=outputKind==='warm'?(c?.warmLevels??3):(c?.coolLevels??5);
    const bank=$(outputKind+'-levels');
    if(bank.children.length!==count)bank.innerHTML=Array.from({length:count},(_,i)=>'<button data-output="'+outputKind+'" data-level="'+(i+1)+'" aria-label="'+(outputKind==='warm'?'温熱':'冷却')+(i+1)+'">'+(i+1)+'</button>').join('');
    for(const button of bank.children){const selected=kind===outputKind&&Number(button.dataset.level)===level;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected&&running));button.disabled=busy||pending;}
  }
  $('power').classList.toggle('running',running);$('power').disabled=pending||busy;
  $('power-label').textContent=busy?'接続待ち…':pending?'送信中…':running?'運転を停止':targets.length?'運転を開始':'接続して運転';
  $('sensor-auto').checked=sensorAuto;
  const tag=tagSlot(),ts=tag?.state;
  $('link-tag').disabled=!connected||!!ts?.pairingTag||ts?.capabilities?.tagLink===false;
  $('link-tag').textContent=ts?.pairingTag?'Tagを検索中…':ts?.tagLinked&&!demo?'Tagの接続を解除':'Tagを接続';
  const info=slots.filter(s=>s.state.connected).map(s=>{const st=s.state;let text=`${slotPrefix(s)}${st.device?.name??'REON'} · ${st.device?.model??''} · Firmware ${st.device?.firmware??''}`;if(st.manualControl)text+=' · 本体の自動開始/停止: '+(st.manualControl.readBackVerified?'無効を確認済み':'無効化を送信済み（読取非対応）');return text});
  $('device-info').textContent=demo?'DEMO · デバイスへの送信は行いません':info.length?info.join('\n'):'デバイス未接続';
  const diagnostic=slotDiagnostics();
  $('connection-details').hidden=!diagnostic||demo;
  $('connection-diagnostic').textContent=diagnostic??'接続履歴はありません';$('settings-connection-diagnostic').textContent=demo?'デモモード':diagnostic??'接続履歴はありません';
  $('rule-count').textContent=`${rules.length} ルール`;
  renderSensor();
  renderMotion();
  renderDistanceLink();
}
function tagSlot(){return targetSlots()[0]??connectedSlots()[0]??null}
function renderSensor(){
  const valid=reading&&Date.now()-reading.time<=30000;
  $('sensor-name').textContent=demo?'デモセンサー':source==='api'&&pollTimer!==null?'JSON API':slots.some(s=>s.state.tagLinked)?'REON Pocket Tag':'センサー未接続';
  $('sensor-dot').className='dot'+(valid?' live':'');$('sensor-live').textContent=valid?'LIVE':reading?'STALE':'NO DATA';
  $('ambient-temp').textContent=valid?reading.temperature.toFixed(1):'—';$('humidity').textContent=valid&&reading.humidity!==null?Math.round(reading.humidity):'—';
  $('sensor-updated').textContent=reading?`${clock(reading.time)} 更新`:'—';
  $('automation-status').textContent=sensorAuto?(valid?'連動中':'センサー更新待ち'):'オフ';
  $('rule-temp').replaceChildren(document.createTextNode(valid?reading.temperature.toFixed(1):'—'),Object.assign(document.createElement('small'),{textContent:'°C'}));
  const output=valid?evaluateRules(reading.temperature,rules,caps()??demoCaps):null;
  $('rule-output').textContent=output?output.kind==='stop'?'停止':`${output.kind==='warm'?'温熱':'冷却'} ${output.level}`:'—';
}
function requireConnection(){if(ready())return true;toast('デバイスを接続してください');return false}
// Sends one abstract action to each unit. actionFor(slot) lets every unit use its own level limits.
async function send(list,actionFor,message,guardFor){
  const jobs=list.map(slot=>{const action=actionFor(slot);return {slot,action,guard:guardFor?()=>guardFor(slot,action):undefined}});
  const results=await Promise.all(jobs.map(async job=>{
    if(job.guard&&!job.guard())return {...job,result:null};
    return {...job,result:await job.slot.client.writeMode(actionFrame(job.action,job.slot.state.mode,kind),job.guard)};
  }));
  const ok=results.filter(r=>r.result===true),failed=results.filter(r=>r.result===false);
  if(ok.length&&message)log(message(ok[0].action)+(connectedSlots().length>1||failed.length?`（本体${ok.map(r=>r.slot.label).join('・')}）`:''));
  if(failed.length)writeFailed(failed.map(r=>r.slot));
  render();return results;
}
function writeFailed(failed){
  const automated=automationActive();
  for(const slot of failed)slot.excluded=true;
  const names=failed.map(s=>s.label).join('・');
  if(automated&&linkedSlots().length){toast(`本体${names}に反映できませんでした。本体${linkedSlots().map(s=>s.label).join('・')}で連動を続けます`);return;}
  toast(slots.filter(s=>s.state.connected).length>1?`本体${names}に反映できませんでした。再接続してください`:'本体に反映できませんでした。再接続してください');
  sensorAuto=false;disableMotion();disableDistance();
}
const manualAction=()=>({kind,level});
async function applyManual(start=false){if(!requireConnection())return false;sensorAuto=false;disableMotion();disableDistance();const list=targetSlots();if(!list.length){toast('操作対象の本体が接続されていません');return false;}const results=await send(list,manualAction,a=>`${a.kind==='warm'?'温熱':'冷却'} レベル${a.level}${start?' 開始':''}`);return results.every(r=>r.result===true)}
// Manual and automation-ending stops. keepAutomation is used when one unit is disconnected on purpose.
async function stop(reason='運転停止',list=connectedSlots(),{keepAutomation=false}={}){
  if(!keepAutomation){sensorAuto=false;disableMotion();disableDistance();}
  if(!list.length){render();return true;}
  const results=await send(list,()=>STOP,()=>reason);return results.every(r=>r.result===true);
}
async function connect(slot,start=false){
  if(slot.state.connecting)return false;
  const requested={kind,level};
  if(demo)endDemo();
  await slot.client.connect();if(!slot.state.connected)return false;if(start){kind=requested.kind;level=Math.min(requested.level,maxLevel());await applyManual(true);}return true;
}
const slotToConnect=()=>slots.find(s=>!s.state.connected&&(target==='both'||target===s.id))??slots.find(s=>!s.state.connected)??slots[0];
for(const slot of slots)$(idOf('connect',slot)).onclick=async()=>{
  if(slot.state.connecting){slot.client.cancelConnection();return;}
  if(slot.state.connected){slot.excluded=true;await stop(`本体${slot.label}の接続を解除`,[slot],{keepAutomation:true});slot.client.disconnect();}
  else await connect(slot);
};
document.querySelectorAll('[data-target]').forEach(button=>button.onclick=()=>{if(!TARGETS.includes(button.dataset.target))return;target=button.dataset.target;storage.set('reon-target',target);const c=caps();if(c)level=Math.min(level,maxLevel());render();});
$('app-url').value=window.location.origin+window.location.pathname;
document.querySelectorAll('[data-copy-diagnostics]').forEach(button=>button.onclick=async()=>{const text=slotDiagnostics();if(!text){toast('接続履歴はありません');return;}try{await navigator.clipboard.writeText(text);toast('接続の詳細をコピーしました')}catch{toast('接続の詳細を開き、テキストを選択してコピーしてください')}});
$('copy-url').onclick=async()=>{try{await navigator.clipboard.writeText($('app-url').value);toast('URLをコピーしました。Chrome / Edgeなどの対応ブラウザで開いてください。')}catch{$('app-url').focus();$('app-url').select();toast('URLを選択しました。コピーして対応ブラウザで開いてください。')}};
$('power').onclick=async()=>{if(pending)return;const targets=targetSlots();if(isRunning(targets))return stop('運転停止',targets);if(!targets.length)return connect(slotToConnect(),true);pending=true;render();try{await applyManual(true)}finally{pending=false;render()}};
async function chooseOutput(outputKind,outputLevel){
  if(slots.some(s=>s.state.connecting)||pending)return;
  disableMotion();disableDistance();sensorAuto=false;kind=outputKind;level=Math.max(1,Math.min(maxLevel(),outputLevel));render();
  if(targetSlots().length)await applyManual(true);else await connect(slotToConnect(),true);
}
for(const id of ['cool-levels','warm-levels'])$(id).onclick=e=>{const b=e.target.closest('[data-output]');if(b)chooseOutput(b.dataset.output,Number(b.dataset.level));};
$('reduce-motion').checked=storage.get('reon-glass-reduced-motion',false);document.body.classList.toggle('motion-reduced',$('reduce-motion').checked);
$('reduce-motion').onchange=()=>{document.body.classList.toggle('motion-reduced',$('reduce-motion').checked);storage.set('reon-glass-reduced-motion',$('reduce-motion').checked)};
function setSource(value){document.querySelectorAll('[data-source]').forEach(b=>b.classList.toggle('selected',b.dataset.source===value));$('tag-panel').hidden=value!=='tag';$('api-panel').hidden=value!=='api'}
document.querySelectorAll('[data-source]').forEach(b=>b.onclick=()=>setSource(b.dataset.source));
$('link-tag').onclick=async()=>{if(!requireConnection())return;if(demo){toast('デモではTagを接続しません');return;}const slot=tagSlot();if(!slot)return;if(!slot.state.tagLinked&&!(typeof BluetoothDevice!=='undefined'&&'watchAdvertisements' in BluetoothDevice.prototype)){ $('sensor-message').textContent='このブラウザはTag広告の読み取りに対応していません。JSON APIを利用してください。';return;}stopPolling();source='tag';reading=null;lastTag=null;if(sensorAuto)await stop('Tag変更で停止');sensorAuto=false;await (slot.state.tagLinked?slot.client.unlinkTag():slot.client.linkTag());$('sensor-message').textContent=slot.state.error??(slot.state.tagLinked?`${slotPrefix(slot)}接続済み · センサー値の受信待ち`:'Tagの接続を解除しました');render()};
function stopPolling(){pollGeneration++;if(pollTimer!==null)clearTimeout(pollTimer);pollTimer=null;pollController?.abort();pollController=null;}
async function acceptReading(value){reading=value;renderSensor();if(sensorAuto&&ready())await applySensor(value)}
async function applySensor(value){
  const list=linkedSlots();if(!list.length)return;
  const actionFor=slot=>{const action=evaluateRules(value.temperature,rules,slot.state.capabilities??demoCaps);return action.kind==='stop'?STOP:{kind:action.kind,level:action.level}};
  // No hysteresis, cooldown, smoothing or debounce: evaluate and send every reading.
  const first=actionFor(list[0]);if(first.kind!=='stop'){kind=first.kind;level=first.level;}
  await send(list,actionFor,a=>`センサー ${value.temperature.toFixed(1)}°C → ${outputLabel(a)}`);
  render();
}
$('sensor-auto').onchange=async()=>{if(!$('sensor-auto').checked){sensorAuto=false;render();log('センサー連動オフ');return;}if(!requireConnection()){$('sensor-auto').checked=false;return;}if(!reading||Date.now()-reading.time>30000){$('sensor-auto').checked=false;toast('有効なセンサー値が必要です');openDialog('sensor-dialog');return;}disableMotion();disableDistance();armSlots();sensorAuto=true;await applySensor(reading);render()};
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
function distanceRatioNow(){const score=distanceSample(distanceReading,distanceReceivedAt);return score===null?null:scoreToRatio(score,distanceReading?.fullScale??1)}
function activeCalibration(){return validCalibration(distanceCalibration)?distanceCalibration:null}
function distanceActionFor(capabilities){const ratio=distanceRatioNow(),c=activeCalibration();return ratio===null||!c?null:calibratedOutput(ratio,c,capabilities??demoCaps)}
function distanceAction(){return distanceActionFor(caps()??demoCaps)}
function disableDistance(){distanceAuto=false;distanceEpoch++;distanceDirty=false;for(const s of [...slots,demoSlot])s.distanceApplied=null;$('distance-auto').checked=false;}
function renderDistanceLink(){
  $('distance-auto').checked=distanceAuto;
  $('distance-output').textContent=outputLabel(distanceAction());
  $('distance-link-status').textContent=distanceAuto?'距離に連動中':'連動OFF';
  const c=caps();$('distance-link-note').textContent=c&&(c.coolLevels<CALIBRATION.far.level||c.warmLevels<CALIBRATION.near.level)?`本体の上限に調整：冷却${Math.min(CALIBRATION.far.level,c.coolLevels)} / 温熱${Math.min(CALIBRATION.near.level,c.warmLevels)}`:'';
  renderCalibration();
}
function renderCalibration(){
  const c=activeCalibration(),ratio=distanceRatioNow(),cm=c?estimateCm(ratio,c):null;
  $('distance-estimate').textContent=!c?'未キャリブレーション':ratio===null?'—':ratio===Infinity?'2人未満 · 160cm以上として扱う':`約 ${Math.max(0,Math.round(cm))} cm`;
  for(const point of ['near','far']){const value=distanceCalibration[point];$('distance-calib-'+point+'-value').textContent=calibrating?.point===point?'計測中…':Number.isFinite(value)?`記録済み · 対角線の${(value*100).toFixed(1)}%`:'未記録';$('distance-calib-'+point).disabled=!!calibrating;$('distance-calib-'+point).textContent=Number.isFinite(value)?'記録し直す':'記録する';}
  $('distance-calib-reset').disabled=!!calibrating||(distanceCalibration.near===null&&distanceCalibration.far===null);
  $('distance-calib-state').textContent=calibrating?'計測中':c?'完了':distanceCalibration.near!==null?'160cmが未記録':distanceCalibration.far!==null?'80cmが未記録':'未設定';
  $('distance-calibration').classList.toggle('done',!!c);
}
function startCalibration(point){
  if(calibrating)return;
  if(calibrationSample(distanceReading)===null){$('distance-calib-message').textContent='距離計測をONにし、2人だけを映した状態で記録してください。';return;}
  calibrating={point,samples:[],received:0};$('distance-calib-message').textContent=`${CALIBRATION[point].cm}cmを計測中です。3秒間そのまま静止してください。`;
  setTimeout(finishCalibration,CALIBRATION.windowMs);renderCalibration();
}
function finishCalibration(){
  const job=calibrating;calibrating=null;if(!job)return;
  const cm=CALIBRATION[job.point].cm;
  if(job.samples.length<CALIBRATION.minSamples||job.samples.length*2<job.received){$('distance-calib-message').textContent=`${cm}cmを記録できませんでした。2人だけを映し、検出が途切れない状態で再試行してください。`;updateDistanceOutput();return;}
  const value=median(job.samples),other=job.point==='near'?'far':'near',next={...distanceCalibration,[job.point]:value,[job.point+'At']:new Date(Date.now()).toISOString()};
  let note='';
  if(next[other]!==null&&!validCalibration({near:next.near,far:next.far})){next[other]=null;next[other+'At']=null;note=` 80cmと160cmの値が近すぎるか逆転しているため、${CALIBRATION[other].cm}cmの記録を消去しました。立ち位置を確認して記録し直してください。`;}
  distanceCalibration=next;storage.set(CALIBRATION_KEY,next);
  $('distance-calib-message').textContent=`${cm}cmを記録しました（${job.samples.length}フレームの中央値）。`+note+(validCalibration(next)?' キャリブレーション完了。':'');
  updateDistanceOutput();
}
$('distance-calib-near').onclick=()=>startCalibration('near');
$('distance-calib-far').onclick=()=>startCalibration('far');
$('distance-calib-reset').onclick=()=>{if(calibrating)return;distanceCalibration=emptyCalibration();storage.set(CALIBRATION_KEY,distanceCalibration);$('distance-calib-message').textContent='キャリブレーションを消去しました。';updateDistanceOutput();};
// Latest-wins pump: each pass sends the current distance output to every linked unit whose last applied output differs.
async function pumpDistance(){
  if(distanceSending)return;distanceSending=true;
  try{while(distanceDirty){
    distanceDirty=false;
    const epoch=distanceEpoch,actionFor=slot=>distanceActionFor(slot.state.capabilities);
    const guard=(slot,action)=>distanceAuto&&distanceEpoch===epoch&&slot.state.connected&&!slot.excluded&&outputKey(actionFor(slot))===outputKey(action);
    const list=distanceAuto?linkedSlots().filter(slot=>{const action=actionFor(slot);return action&&slot.distanceApplied!==outputKey(action)}):[];
    if(!list.length)continue;
    for(const slot of list)slot.distanceApplied=null;
    const results=await send(list,actionFor,action=>`距離連動 → ${outputLabel(action)}`,guard);
    for(const r of results)if(r.result===true&&guard(r.slot,r.action)){r.slot.distanceApplied=outputKey(r.action);if(r.action.kind!=='stop'&&inTarget(r.slot)){kind=r.action.kind;level=r.action.level;}}
    render();
  }}finally{distanceSending=false;}
}
function updateDistanceOutput(){
  const action=distanceAction();renderDistanceLink();if(!distanceAuto)return;
  if(!action){stop(activeCalibration()?'距離計測の停止・更新切れで停止':'キャリブレーション未完了で停止');return;}
  distanceDirty=true;void pumpDistance();
}
window.addEventListener('reon-distance',({detail})=>{distanceReading=detail;distanceReceivedAt=Date.now();if(calibrating){calibrating.received++;const sample=calibrationSample(detail);if(sample!==null)calibrating.samples.push(sample);}updateDistanceOutput()});
$('distance-auto').onchange=()=>{
  if(!$('distance-auto').checked){if(distanceAuto)void stop('距離連動OFFで停止');return;}
  if(!requireConnection()||!distanceAction()){disableDistance();renderDistanceLink();if(ready())toast(activeCalibration()?'距離計測をONにし、有効な値を受信してください':'先に80cm・160cmのキャリブレーションを完了してください');return;}
  sensorAuto=false;disableMotion();distanceEpoch++;armSlots();distanceAuto=true;render();updateDistanceOutput();
};
setInterval(updateDistanceOutput,250);
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
  const guard=slot=>motionAuto&&motionEpoch===epoch&&motionFresh(sample)&&slot.state.connected&&!slot.excluded&&(demo||m5State.connected);
  const list=linkedSlots().filter(guard);
  if(!list.length)return;
  const actionFor=slot=>{const output=motionOutput(sample.motion,motionConfig,slot.state.capabilities??demoCaps);return output.kind==='stop'?STOP:{kind:output.kind,level:output.level}};
  const first=actionFor(list[0]);if(first.kind!=='stop'){kind=first.kind;level=first.level;}
  await send(list,actionFor,a=>`加速度 ${sample.motion.toFixed(3)}G → ${outputLabel(a)}`,guard);
  renderMotion();
}
async function receiveMotion(sample){motionReading=sample;renderMotion();if(motionAuto)await applyMotion(sample)}
$('m5-connect').onclick=async()=>{if(m5State.connecting){m5.cancel();return;}if(m5State.connected){if(motionAuto)await stop('M5StickS3の接続解除で停止');m5.disconnect();return;}if(demo)endDemo();$('motion-error').textContent='';await m5.connect()};
$('motion-auto').onchange=async()=>{if(!$('motion-auto').checked){disableMotion();renderMotion();return;}if(!requireConnection()){disableMotion();return;}if(!motionFresh()||(!demo&&!m5State.connected)){disableMotion();toast('M5StickS3を接続し、加速度を受信してください');return;}disableDistance();sensorAuto=false;motionEpoch++;armSlots();motionAuto=true;$('motion-error').textContent='';render();await applyMotion(motionReading)};
for(const [id,key] of [['motion-scale-input','fullScale'],['motion-cool-max','coolMax'],['motion-warm-max','warmMax']]){
  $(id).value=String(motionConfig[key]);
  $(id).onchange=async()=>{const next={...motionConfig,[key]:Number($(id).value)};try{validateMotionConfig(next);motionConfig=next;storage.set('reon-motion-config',motionConfig);motionEpoch++;renderMotion();if(motionAuto&&motionFresh())await applyMotion(motionReading)}catch(error){$(id).value=String(motionConfig[key]);toast(error.message)}};
}
function motionDemoSample(){const value=Number($('motion-demo-input').value);$('motion-demo-value').textContent=value.toFixed(2)+'G';return {x:0,y:0,z:1+value,motion:value,time:Date.now(),sequence:0,uptime:0}}
$('motion-demo-input').oninput=()=>{if(demo)receiveMotion(motionDemoSample())};
m5.onState(s=>{const previous=m5State;m5State=s;if(!demo){if(s.reading&&s.reading!==previous.reading){$('motion-error').textContent='';receiveMotion(s.reading);}if(previous.connected&&!s.connected){motionReading=null;if(motionAuto){stop('M5StickS3の接続が切れたため停止');$('motion-error').textContent='M5StickS3との接続が切れたため停止しました';}}renderMotion();}});
setInterval(()=>{if(motionAuto&&!motionFresh()){stop('加速度が1.5秒更新されないため停止');$('motion-error').textContent='加速度の更新が途絶えたため停止しました';}renderMotion();},250);
function endDemo(){clearInterval(demoTimer);clearInterval(motionDemoTimer);motionDemoTimer=null;demoTimer=null;demo=false;sensorAuto=false;disableMotion();disableDistance();motionReading=m5State.reading;demoSlot.state={...demoSlot.state,mode:null};reading=null;render();log('デモ終了')}
$('demo').onclick=async()=>{if(demo){endDemo();return;}if(slots.some(x=>x.state.connected)){await stop('デモへ切り替え');for(const slot of slots)if(slot.state.connected)slot.client.disconnect();}stopPolling();disableMotion();disableDistance();demo=true;armSlots();demoSlot.state={...demoSlot.state,mode:null};sensorAuto=false;source='tag';await acceptReading({temperature:28.4,humidity:62,time:Date.now()});demoTimer=setInterval(()=>{const temperature=+(28.5+Math.sin(Date.now()/15000)*1.9).toFixed(1);acceptReading({temperature,humidity:62,time:Date.now()})},2000);await receiveMotion(motionDemoSample());motionDemoTimer=setInterval(()=>receiveMotion(motionDemoSample()),200);log('デモ開始');render();toast('デモモード · 実機には送信しません')};
for(const slot of slots)slot.client.onState(s=>{
  const previous=slot.state;slot.state=s;if(demo)return;
  const prefix=slotPrefix(slot);
  if(s.connected&&s.mode&&(s.mode!==previous.mode||!previous.connected)&&inTarget(slot)){if(s.mode.kind==='warm'||s.mode.kind==='cool'){kind=s.mode.kind;level=s.mode.level??s.mode.preference??level;}else if(s.mode.kind==='auto'){kind='cool';level=s.mode.coolPreference??3;}level=Math.min(level,maxLevel());}
  if(s.tag&&s.tag!==lastTag&&source==='tag'&&s.connected){lastTag=s.tag;acceptReading({temperature:s.tag.temperature,humidity:s.tag.humidity,time:Date.now()});}
  if(previous.connected&&!s.connected){
    slot.distanceApplied=null;
    const remaining=linkedSlots();
    // A remaining unit keeps following the automation; with none left, every automation is cancelled.
    if(automationActive()&&remaining.length){const names=remaining.map(r=>r.label).join('・');log(`本体${slot.label}の接続が切れました。本体${names}で連動を継続します`);toast(`本体${slot.label}の接続が切れました。本体${names}で連動を継続します`);}
    else{disableDistance();disableMotion();sensorAuto=false;log(prefix+'Bluetooth接続が切れました');toast(prefix+'Bluetooth接続が切れました');}
  }
  if(!previous.connected&&s.connected){slot.excluded=false;slot.distanceApplied=null;log(prefix+'Bluetooth接続完了');if(distanceAuto){distanceDirty=true;void pumpDistance();}}
  if(s.lastStop&&s.lastStop!==previous.lastStop&&s.lastStop.source==='device_report'){
    // Never restart a unit that stopped by itself; the other unit may keep following the distance.
    if(distanceAuto){slot.excluded=true;slot.distanceApplied=null;if(!linkedSlots().length)disableDistance();}
    log(prefix+'本体から停止状態を受信（アプリからの停止指示なし）。接続診断を確認してください。');toast(prefix+'本体が運転を停止しました。接続診断で停止元を確認できます。');
  }
  if(s.error&&s.error!==lastError){lastError=s.error;toast(prefix+(s.error.includes('rejected')?'本体が変更を受け付けませんでした':s.error));}
  render();
});
setInterval(()=>{if(reading&&Date.now()-reading.time>30000&&sensorAuto){stop('センサー更新が30秒途絶えたため停止');toast('センサー更新が途絶えたため停止しました')}renderSensor()},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(reading&&Date.now()-reading.time>30000&&sensorAuto)stop('センサー値の期限切れで停止');if(motionAuto&&!motionFresh())stop('加速度の期限切れで停止')}});
window.addEventListener('pagehide',()=>{disableDistance();disableMotion();stopPolling();m5.disconnect();for(const slot of slots)if(slot.state.connected)slot.client.disconnect()});
const browserProblem=bluetoothProblem();$('browser-notice').hidden=!browserProblem;if(browserProblem)$('browser-notice').textContent=browserProblem;
render();




