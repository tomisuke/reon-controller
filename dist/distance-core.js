export const STALE_MS = 5000;
export function measure(people, width, height, fullScale = 1) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw Error('映像サイズが不正です');
  if (!Number.isFinite(fullScale) || fullScale < 0.05 || fullScale > 1) throw Error('最大距離は対角線の5〜100%です');
  if (!Array.isArray(people) || people.length > 30) throw Error('人物数が不正です');
  const centers = people.map(({bbox}) => {
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some(v => !Number.isFinite(v)) || bbox[2] <= 0 || bbox[3] <= 0) throw Error('検出枠が不正です');
    const [x,y,w,h] = bbox;
    if (x < 0 || y < 0 || x+w > width+1 || y+h > height+1) throw Error('検出枠が映像の範囲外です');
    return {x: Math.min(width,x+w/2), y: Math.min(height,y+h/2)};
  });
  let distance = Infinity, pair = null;
  for (let i=0;i<centers.length;i++) for (let j=i+1;j<centers.length;j++) {
    const d = Math.hypot(centers[i].x-centers[j].x, centers[i].y-centers[j].y);
    if (d < distance) { distance=d; pair=[i,j]; }
  }
  return {score: pair ? Math.round(Math.min(100,100*distance/(Math.hypot(width,height)*fullScale))*10)/10 : 100,
    personCount: people.length, pair, distanceRatio: pair ? distance/Math.hypot(width,height) : null,
    status: pair ? 'tracking' : 'insufficient_people', fullScale, centers};
}
export function publicReading(data, now = Date.now()) {
  const age = data?.receivedAt ? now-data.receivedAt : Infinity;
  const fresh = Number.isFinite(age) && age >= 0 && age <= STALE_MS && data?.active === true;
  return {schemaVersion:1, score:fresh ? data.score : 100, personCount:fresh ? data.personCount : 0,
    status:fresh ? data.status : 'stale', fresh,
    timestamp:data?.receivedAt ? new Date(data.receivedAt).toISOString() : null,
    ageMs:Number.isFinite(age) ? Math.max(0,age) : null, staleAfterMs:STALE_MS,
    metric:'nearest_centers_2d', fullScale:data?.fullScale ?? 1};
}
