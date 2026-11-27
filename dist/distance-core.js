export const STALE_MS = 5000;
export const BODY_GAP_METRIC = 'selected_body_gap_2d';
export const validDistanceRatio = value => Number.isFinite(value) && value >= 0 && value <= 1;
export class DetectionHold {
  constructor(holdMs=1000){this.holdMs=holdMs;this.reset();}
  reset(){this.last=null;this.lastAt=-Infinity;}
  update(result,now=performance.now()){
    if(result.pair){this.last=result;this.lastAt=now;return {...result,holding:false,holdRemainingMs:0};}
    const remaining=this.holdMs-(now-this.lastAt);
    if(this.last&&this.holdMs>0&&remaining>0)return {...result,score:this.last.score,distanceRatio:this.last.distanceRatio,fullScale:this.last.fullScale,status:'holding',holdReason:result.status,holding:true,holdRemainingMs:Math.ceil(remaining),holdEpoch:this.lastAt};
    this.reset();return {...result,holding:false,holdRemainingMs:0};
  }
}
export function measure(people, width, height, fullScale = 1, selectedPair, gap) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw Error('映像サイズが不正です');
  if (!Number.isFinite(fullScale) || fullScale < 0.05 || fullScale > 1) throw Error('最大距離は対角線の5〜100%です');
  if (!Array.isArray(people) || people.length > 30) throw Error('人物数が不正です');
  const centers = people.map(({bbox}) => {
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some(v => !Number.isFinite(v)) || bbox[2] <= 0 || bbox[3] <= 0) throw Error('検出枠が不正です');
    const [x,y,w,h] = bbox;
    if (x < 0 || y < 0 || x+w > width+1 || y+h > height+1) throw Error('検出枠が映像の範囲外です');
    return {x: Math.min(width,x+w/2), y: Math.min(height,y+h/2)};
  });
  const distanceBetween = (i, j) => gap
    ? gap(people[i],people[j])
    : {distance:Math.hypot(centers[i].x-centers[j].x, centers[i].y-centers[j].y), points:[centers[i],centers[j]]};
  let measurement = null, pair = selectedPair ?? null;
  if (selectedPair === undefined) {
    for (let i=0;i<centers.length;i++) for (let j=i+1;j<centers.length;j++) {
      const candidate = distanceBetween(i, j);
      if (candidate && (!measurement || candidate.distance < measurement.distance)) { measurement=candidate; pair=[i,j]; }
    }
  } else if (pair) {
    const [a, b] = pair;
    if (!centers[a] || !centers[b] || a === b) throw Error('計測対象の組が不正です');
    measurement = distanceBetween(a, b);
  }
  const distanceRatio = measurement ? measurement.distance/Math.hypot(width,height) : null;
  return {score: measurement ? Math.round(Math.min(100,100*distanceRatio/fullScale)*10)/10 : 100,
    personCount: people.length, pair:measurement ? pair : null, distanceRatio,
    status:measurement ? 'tracking' : pair ? 'geometry_unavailable' : 'insufficient_people',
    fullScale, centers, points:measurement?.points};
}
export function publicReading(data, now = Date.now()) {
  const age = data?.receivedAt ? now-data.receivedAt : Infinity;
  const fresh = Number.isFinite(age) && age >= 0 && age <= STALE_MS && data?.active === true;
  const holding=fresh&&data.status==='holding'&&Number.isFinite(data.holdUntil)&&now<data.holdUntil;
  const expiredHold=fresh&&data.status==='holding'&&!holding;
  const geometryExpired = expiredHold && data.holdReason === 'geometry_unavailable';
  const targetState = fresh && expiredHold && !geometryExpired && data.targetState === 'locked' ? 'lost' : fresh ? data.targetState : undefined;
  const unavailable = targetState === 'selecting' || targetState === 'lost';
  return {schemaVersion:1, score:fresh&&!expiredHold&&!unavailable ? data.score : 100, personCount:fresh ? data.personCount : 0,
    status:fresh ? expiredHold ? geometryExpired?'geometry_unavailable':targetState==='lost'?'target_lost':'insufficient_people' : data.status : 'stale', fresh,
    ...(targetState && {targetState}),
    holding,holdRemainingMs:holding?Math.max(0,data.holdUntil-now):0,
    distanceRatio:fresh&&!unavailable&&(holding||(!expiredHold&&data.personCount>=2))&&validDistanceRatio(data.distanceRatio)?data.distanceRatio:null,
    inputId:fresh?data.inputId??null:null,
    timestamp:data?.receivedAt ? new Date(data.receivedAt).toISOString() : null,
    ageMs:Number.isFinite(age) ? Math.max(0,age) : null, staleAfterMs:STALE_MS,
    ...(data?.metric===BODY_GAP_METRIC && {floorDistanceCm:fresh&&Number.isFinite(data.floorDistanceCm)?data.floorDistanceCm:null}),
    metric:data?.metric??(targetState?'selected_centers_2d':'nearest_centers_2d'), fullScale:data?.fullScale ?? 1};
}
