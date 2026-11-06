// Calibrated mapping: the score measured with 2 people 80cm apart drives warm 2, 160cm drives cool 3.
// Between the two recorded points the signed level (warm +, cool -) changes linearly and is rounded to the
// nearest hardware level; outside the range the endpoint output is kept. Scores are converted to the raw
// center distance / video diagonal ratio so that changing the "100 distance" setting keeps the calibration.
export const CALIBRATION={near:{cm:80,kind:'warm',level:2},far:{cm:160,kind:'cool',level:3},windowMs:3000,minSamples:2,minGap:.02};
const signedLevel=p=>p.kind==='warm'?p.level:-p.level;
export function scoreToRatio(score,fullScale=1){
  if(!Number.isFinite(score)||score<0||score>100)return null;
  const scale=fullScale??1;if(!Number.isFinite(scale)||scale<.05||scale>1)return null;
  return score>=100?Infinity:score*scale/100;
}
export function validCalibration(c){return !!c&&Number.isFinite(c.near)&&Number.isFinite(c.far)&&c.near>=0&&c.far<=1&&c.far-c.near>=CALIBRATION.minGap;}
export function estimateCm(ratio,c){
  if(!validCalibration(c)||!Number.isFinite(ratio))return null;
  const {near,far}=CALIBRATION;return near.cm+(ratio-c.near)/(c.far-c.near)*(far.cm-near.cm);
}
export function calibratedOutput(ratio,c,capabilities={coolLevels:5,warmLevels:4}){
  if(!validCalibration(c)||typeof ratio!=='number'||Number.isNaN(ratio)||ratio<0)return null;
  const t=Math.min(1,Math.max(0,(ratio-c.near)/(c.far-c.near)));
  const a=signedLevel(CALIBRATION.near),b=signedLevel(CALIBRATION.far),n=Math.round(a+(b-a)*t);
  if(n===0)return {kind:'stop',level:0};
  const kind=n>0?'warm':'cool',limit=Math.max(1,Math.floor(capabilities?.[kind+'Levels']??5));
  return {kind,level:Math.min(Math.abs(n),limit)};
}
// One calibration sample: a fresh, non-held frame with exactly 2 people below the score ceiling.
export function calibrationSample(reading,now=Date.now()){
  if(!reading?.fresh||reading.holding||reading.personCount!==2||!Number.isFinite(reading.score)||reading.score>=100)return null;
  const age=now-Date.parse(reading.timestamp);
  if(!Number.isFinite(age)||age< -1000||age>5000)return null;
  const ratio=scoreToRatio(reading.score,reading.fullScale??1);
  return Number.isFinite(ratio)?ratio:null;
}
export function median(values){const s=[...values].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;}
export function distanceSample(reading,receivedAt,now=Date.now()){
  if(!reading?.fresh||!Number.isFinite(reading.score)||reading.score<0||reading.score>100)return null;
  const age=now-Date.parse(reading.timestamp);
  if(!Number.isFinite(age)||age< -1000||age>5000)return null;
  if(reading.holding){
    if(!Number.isFinite(reading.holdRemainingMs)||reading.holdRemainingMs<=0||reading.holdRemainingMs>3000)return null;
    if(now-receivedAt>=reading.holdRemainingMs)return 100;
  }
  return reading.score;
}
