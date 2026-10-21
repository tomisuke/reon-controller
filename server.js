import http from 'node:http';
import worker from './dist/server/index.js';
// Loopback-only preview uses memory storage and a local development identity.
// Neither is included in the deployed Worker, which uses Sites identity and R2.
const objects=new Map();
const env={BUCKET:{async get(key){const value=objects.get(key);return value===undefined?null:{async json(){return JSON.parse(value);}};},async put(key,value){objects.set(key,value);},async delete(key){objects.delete(key);}}};
http.createServer(async(req,res)=>{
  try{
    const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(','):v);
    headers.set('oai-authenticated-user-id','local-preview');
    const body=['GET','HEAD'].includes(req.method)?undefined:await Array.fromAsync(req).then(chunks=>Buffer.concat(chunks));
    const response=await worker.fetch(new Request('http://'+req.headers.host+req.url,{method:req.method,headers,body}),env);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500).end('Preview error');}
}).listen(4173,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:4173'));
