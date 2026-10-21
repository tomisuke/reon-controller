// Two linear half-ranges, rounded up to the next available hardware level.
export function distanceOutput(score,capabilities={coolLevels:5,warmLevels:4}){
  if(!Number.isFinite(score)||score<0||score>100)return null;
  if(score===50)return {kind:'stop',level:0};
  const kind=score<50?'cool':'warm',requested=kind==='cool'?5:4;
  const limit=Math.min(requested,Math.max(1,Math.floor(capabilities?.[kind+'Levels']??requested)));
  return {kind,level:Math.max(1,Math.ceil(Math.abs(score-50)/50*limit-1e-12))};
}
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
