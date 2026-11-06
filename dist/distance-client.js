import {publicReading} from './distance-core.js';
export const LOCAL_KEY='reon-distance-reading-v1';
export function localDistance() {
  try {return publicReading(JSON.parse(localStorage.getItem(LOCAL_KEY)));}catch{return publicReading(null);}
}
