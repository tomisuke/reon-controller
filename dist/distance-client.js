import {publicReading} from './distance-core.js';
export const LOCAL_KEY='reon-distance-reading-v1';
export function localDistance() {
  try {return publicReading(JSON.parse(localStorage.getItem(LOCAL_KEY)));}catch{return publicReading(null);}
}
export async function fetchDistance(url,signal) {
  const response=await fetch(url,{cache:'no-store',credentials:'same-origin',signal});
  if(!response.ok)throw Error('HTTP '+response.status);
  const data=await response.json(), age=Date.now()-Date.parse(data.timestamp);
  if(data.schemaVersion!==1 || !Number.isFinite(data.score) || data.score<0 || data.score>100 || !Number.isInteger(data.personCount) || data.personCount<0)throw Error('距離APIの応答が不正です');
  if(!data.fresh || age< -1000 || age>5000 || !Number.isFinite(age))return {...data,score:100,personCount:0,fresh:false,status:'stale'};
  return data;
}
