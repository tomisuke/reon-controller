// Helpers for driving several REON units with one abstract action ({kind:'cool'|'warm'|'stop', level}).
// Each unit gets its own frame: stop frames follow that unit's current mode (SMART or manual) and levels
// are computed with that unit's own capabilities by the caller.
import {THERMO,manualFrame,stopFrame,smartStopFrame} from './protocol.js';

export const SLOT_IDS=['a','b'];
export const TARGETS=['a','b','both'];
export const STOP={kind:'stop',level:0};

export function actionFrame(action,mode,fallbackKind='cool'){
  if(action.kind==='stop')return mode?.type==='smart'?smartStopFrame(mode):stopFrame((mode?.kind??fallbackKind)==='warm'?THERMO.warm:THERMO.cool);
  return manualFrame(action.kind==='warm'?THERMO.warm:THERMO.cool,action.level,false);
}

export const outputKey=action=>action?`${action.kind}:${action.level}`:null;
export const outputLabel=action=>!action?'—':action.kind==='stop'?'停止':`${action.kind==='warm'?'温熱':'冷却'} ${action.level}`;

export function modeLabel(mode,fallbackLevel){
  if(!mode?.running)return '停止';
  return (mode.type==='smart'?'SMART · ':'')+(mode.kind==='warm'?'温熱':'冷却')+' '+(mode.level??mode.preference??fallbackLevel);
}

// entries: [{label, mode}] for connected units. One unit or identical outputs show a single label.
export function combinedOutputLabel(entries,fallbackLevel){
  if(!entries.length)return '未接続';
  const labels=entries.map(e=>modeLabel(e.mode,fallbackLevel));
  if(labels.every(l=>l===labels[0]))return labels[0];
  return entries.map((e,i)=>`${e.label} ${labels[i]}`).join(' / ');
}

// Level buttons must be valid for every unit they drive.
export function commonCapabilities(list){
  const caps=list.filter(Boolean);
  if(!caps.length)return null;
  return {...caps[0],coolLevels:Math.min(...caps.map(c=>c.coolLevels)),warmLevels:Math.min(...caps.map(c=>c.warmLevels))};
}
