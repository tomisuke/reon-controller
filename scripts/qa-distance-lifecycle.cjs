const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>window.qaResolveCamera=resolve);});
 await page.goto('http://127.0.0.1:4173/');await page.check('#distance-enabled');await page.waitForFunction(()=>!!window.qaResolveCamera);
 await page.uncheck('#distance-enabled');await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;window.qaLateStream=canvas.captureStream();window.qaResolveCamera(window.qaLateStream);});
 await page.waitForFunction(()=>window.qaLateStream.getTracks().every(t=>t.readyState==='ended'));
 assert.equal(await page.textContent('#reon-distance-value'),'100');assert.equal(await page.locator('#distance-workspace').isVisible(),false);
 let release,requested;const waiting=new Promise(r=>requested=r),gate=new Promise(r=>release=r);
 await page.route('**/api/distance/00000000000000000000000000000000',async route=>{requested();await gate;await route.fulfill({json:{schemaVersion:1,score:8,personCount:2,status:'tracking',fresh:true,timestamp:new Date().toISOString()}}).catch(()=>{});});
 await page.selectOption('#distance-source','remote');await page.fill('#distance-api-url','http://127.0.0.1:4173/api/distance/00000000000000000000000000000000');await page.check('#distance-enabled');await waiting;
 await page.uncheck('#distance-enabled');release();await page.waitForFunction(()=>document.getElementById('reon-distance-status').textContent.includes('OFF'));
 assert.equal(await page.textContent('#reon-distance-value'),'100');assert.equal(errors.length,0,errors.join('\n'));
 console.log('Passed: OFF during pending permission releases late camera tracks; OFF ignores late remote readings; no page errors.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
