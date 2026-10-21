import fs from 'node:fs';
import path from 'node:path';
const assets={}, types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.zip':'application/zip','.md':'text/plain; charset=utf-8'};
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name==='server'||e.name==='.openai')continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else assets['/'+path.relative('dist',p).split(path.sep).join('/')]={type:types[path.extname(p)]??'application/octet-stream',body:fs.readFileSync(p).toString('base64')};}}
walk('dist');
fs.mkdirSync('dist/server',{recursive:true});fs.mkdirSync('dist/.openai',{recursive:true});
const core=fs.readFileSync('dist/distance-core.js','utf8').replace(/^export /gm,'');
const api=fs.readFileSync('worker/api.js','utf8').replace(/^import .*;\r?\n/,'').replace(/^export /gm,'');
const worker=fs.readFileSync('worker/index.js','utf8').replace(/^import .*;\r?\n/,'').replace(/^export /gm,'');
fs.writeFileSync('dist/server/index.js',`${core}\n${api}\n${worker}\nconst assets=${JSON.stringify(assets)};\nexport default createWorker(assets);\n`);
fs.copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
console.log(`Built Worker with ${Object.keys(assets).length} preserved assets`);
