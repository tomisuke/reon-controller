import {publicReading} from '../dist/distance-core.js';
const hex = bytes => [...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');
const random = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))));
const json = (value,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
export async function api(request,env) {
  const url = new URL(request.url);
  if (!env.BUCKET) return json({error:'Storage unavailable'},503);
  // Writes are browser same-origin only. Reads use an unguessable per-session capability URL.
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({error:'Origin rejected'},403);
  if (url.pathname === '/api/distance/sessions' && request.method === 'POST') {
    if (!request.headers.get('oai-authenticated-user-id')) return json({error:'Sign in to create a sharing session'},401);
    const id=random(16), writeToken=random(32), createdAt=Date.now();
    await env.BUCKET.put('distance/'+id,JSON.stringify({writeHash:await digest(writeToken),createdAt,expiresAt:createdAt+7*86400000,reading:null}),{httpMetadata:{contentType:'application/json'}});
    return json({id,writeToken,readUrl:url.origin+'/api/distance/'+id,expiresAt:new Date(createdAt+7*86400000).toISOString()},201);
  }
  const match = /^\/api\/distance\/([a-f0-9]{32})$/.exec(url.pathname);
  if (!match) return json({error:'Not found'},404);
  const object=await env.BUCKET.get('distance/'+match[1]);
  if (!object) return json({error:'Session not found',...publicReading(null)},404);
  const session=await object.json();
  if (Date.now()>session.expiresAt) return json({error:'Session expired',...publicReading(null)},410);
  if (request.method === 'GET') return json(publicReading(session.reading));
  if (request.method !== 'PUT' && request.method !== 'DELETE') return json({error:'Method not allowed'},405);
  const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token || await digest(token)!==session.writeHash) return json({error:'Unauthorized'},401);
  if (request.method === 'DELETE') { await env.BUCKET.delete('distance/'+match[1]); return json({deleted:true}); }
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({error:'JSON required'},415);
  if (Number(request.headers.get('Content-Length'))>16000) return json({error:'Payload too large'},413);
  let text='',payload;
  const reader=request.body?.getReader();
  if (!reader) return json({error:'Body required'},400);
  while(true){const {done,value}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);if(text.length>16000){await reader.cancel();return json({error:'Payload too large'},413);}}
  try { payload=JSON.parse(text); if (typeof payload.active!=='boolean') throw Error('active is required');
    if(payload.active && (!Number.isFinite(payload.score)||payload.score<0||payload.score>100||!Number.isInteger(payload.personCount)||payload.personCount<0||payload.personCount>30||!Number.isFinite(payload.fullScale)||payload.fullScale<.05||payload.fullScale>1))throw Error('Invalid score, personCount, or fullScale');
    const result=payload.active ? {score:payload.personCount<2?100:Math.round(payload.score*10)/10,personCount:payload.personCount,status:payload.personCount<2?'insufficient_people':'tracking',fullScale:payload.fullScale} : {score:100,personCount:0,status:'stopped',fullScale:1};
    session.reading={score:result.score,personCount:result.personCount,status:result.status,fullScale:result.fullScale,active:payload.active,receivedAt:Date.now()};
  } catch(error) { return json({error:error.message},400); }
  // No frames, positions, or video are persisted; only the latest scalar reading.
  await env.BUCKET.put('distance/'+match[1],JSON.stringify(session),{httpMetadata:{contentType:'application/json'}});
  return json(publicReading(session.reading));
}
