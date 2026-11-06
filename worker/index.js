import {api} from './api.js';
export function createWorker(assets) {
  return {async fetch(request,env) {
    const pathname=new URL(request.url).pathname;
    try {
      if (pathname.startsWith('/api/distance/')) return await api(request,env);
      if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
      const route=pathname==='/'?'/index.html':pathname==='/distance'||pathname==='/distance/'?'/distance.html':pathname;
      const asset=assets[route];
      if(!asset) return new Response('Not found',{status:404});
      const data=Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0));
      return new Response(request.method==='HEAD'?null:data,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
    } catch {return Response.json({error:'Service temporarily unavailable',score:100,fresh:false},{status:503,headers:{'Cache-Control':'no-store'}});}
  }};
}
