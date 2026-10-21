export const DEFAULT_RULES = [{temperature:18,kind:'warm',level:2},{temperature:22,kind:'stop',level:0},{temperature:26,kind:'cool',level:1},{temperature:29,kind:'cool',level:3},{temperature:32,kind:'cool',level:5}];
export function validateRules(rules) {
  if (!Array.isArray(rules)||!rules.length) throw Error('ルールを1つ以上設定してください');
  let prev=-Infinity;
  for(const r of rules){
    if(!Number.isFinite(r.temperature)||r.temperature < -40||r.temperature>80||r.temperature<=prev) throw Error('温度は−40〜80°Cの範囲で昇順に設定してください');
    if(!['cool','warm','stop'].includes(r.kind)||!Number.isInteger(r.level)|| (r.kind!=='stop'&&(r.level<1||r.level>5))) throw Error('出力レベルを確認してください');
    prev=r.temperature;
  }
  return rules;
}
// Each row applies up to its boundary; the last row also covers higher values.
export function evaluateRules(temperature,rules,caps={coolLevels:5,warmLevels:3}) {
  validateRules(rules);
  if(!Number.isFinite(temperature)) throw Error('温度が無効です');
  const r=rules.find(r=>temperature<=r.temperature)??rules.at(-1);
  return {kind:r.kind,level:r.kind==='stop'?0:Math.min(r.level,r.kind==='cool'?caps.coolLevels:caps.warmLevels)};
}
export function parseReading(data,now=Date.now()) {
  if(typeof data!=='object'||data===null||typeof data.temperature!=='number'||!Number.isFinite(data.temperature)||data.temperature < -40||data.temperature>80) throw Error('temperature は−40〜80の数値で指定してください');
  const time=data.timestamp===undefined?now:typeof data.timestamp==='number'?data.timestamp:Date.parse(data.timestamp);
  if(!Number.isFinite(time)||now-time>30000||time-now>5000) throw Error('センサー値が古いか、時刻が不正です');
  let humidity=data.humidity;
  if(humidity!==undefined&&(typeof humidity!=='number'||!Number.isFinite(humidity)||humidity<0||humidity>100)) throw Error('humidity は0〜100の数値で指定してください');
  return {temperature:data.temperature,humidity:humidity??null,time};
}
