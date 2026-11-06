const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const mock=fs.readFileSync('tests/mock-device.js','utf8').replace('../dist/protocol.js','/protocol.js');
 await page.route('**/qa/mock-device.js',route=>route.fulfill({contentType:'text/javascript',body:mock}));
 await page.addInitScript(()=>{Object.defineProperty(navigator,'bluetooth',{configurable:true,value:{requestDevice:async()=>{if(!window.qaHardware){const {mockDevice}=await import('/qa/mock-device.js');window.qaHardware=mockDevice(window,{autoStart:true,autoStopAfterMs:3000});}return window.qaHardware.device;}}});});
 await page.goto('http://127.0.0.1:4173/');await page.getByRole('button',{name:'冷却3',exact:true}).click();
 await page.waitForFunction(()=>document.getElementById('output-status').textContent==='冷却 3');
 const writes=await page.evaluate(()=>qaHardware.writes.filter(x=>['autoStart','mode'].includes(x.name)));assert.deepEqual(writes.map(x=>x.name),['autoStart','mode']);assert.deepEqual(writes[0].frame,[0]);
 await page.evaluate(()=>qaHardware.advanceTime(30000));assert.equal(await page.textContent('#connection-state'),'接続済み');assert.equal(await page.textContent('#output-status'),'冷却 3');
 await page.getByRole('button',{name:'温熱2',exact:true}).click();await page.waitForFunction(()=>document.getElementById('output-status').textContent==='温熱 2');await page.evaluate(()=>qaHardware.advanceTime(30000));assert.equal(await page.textContent('#output-status'),'温熱 2');
 await page.getByRole('button',{name:'設定',exact:true}).click();assert.ok((await page.textContent('#device-info')).includes('無効を確認済み'));await page.locator('#settings-dialog .close-dialog').click();
 await page.evaluate(async()=>{const {stopFrame,THERMO}=await import('/protocol.js');qaHardware.notify('mode',stopFrame(THERMO.warm));});
 assert.equal(await page.textContent('#output-status'),'停止');assert.ok((await page.textContent('#last-action')).includes('本体から停止状態'));const count=await page.evaluate(()=>qaHardware.writes.length);await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>qaHardware.writes.length),count);
 await page.getByRole('button',{name:'設定',exact:true}).click();assert.ok((await page.textContent('#settings-connection-diagnostic')).includes('device_report'));
 assert.equal(errors.length,0,errors.join('\n'));console.log('Passed: browser manual-start disables saved wear auto-stop first, cool/warm survive 30s simulated device time, verified setting and stop-source diagnostics, no automatic restart.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
