const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));const output=path.resolve('.sites-runtime/qa');fs.mkdirSync(output,{recursive:true});
 await page.goto('http://127.0.0.1:4173/');
 for(const width of [1440,1024,768,720,390,320]){
  await page.setViewportSize({width,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'overflow at '+width);
  for(const id of ['cool-levels','warm-levels']){const box=await page.locator('#'+id).boundingBox();assert.ok(box&&box.y+box.height<900,'both modes in view at '+width);}
  if([1440,390,320].includes(width))await page.screenshot({path:path.join(output,'reon-compact-'+width+'.png'),fullPage:true});
 }
 assert.equal(await page.locator('#climate-panel').getAttribute('open'),null);
 for(const id of ['timer','wave','auto-start','quick-launch','skeleton','history-dialog'])assert.equal(await page.locator('#'+id).count(),0);
 await page.getByRole('button',{name:'設定',exact:true}).click();await page.click('#demo');await page.locator('#settings-dialog .close-dialog').click();
 await page.getByRole('button',{name:'温熱2',exact:true}).click();assert.equal(await page.textContent('#output-status'),'温熱 2');
 await page.getByRole('button',{name:'冷却5',exact:true}).click();assert.equal(await page.textContent('#output-status'),'冷却 5');
 await page.click('#power');assert.equal(await page.textContent('#output-status'),'停止');
 await page.getByRole('button',{name:'温熱1',exact:true}).click();assert.equal(await page.textContent('#output-status'),'温熱 1');
 await page.locator('#climate-panel > summary').click();await page.check('#sensor-auto');assert.equal(await page.locator('#sensor-auto').isChecked(),true);
 await page.getByRole('button',{name:'冷却2',exact:true}).click();assert.equal(await page.locator('#sensor-auto').isChecked(),false);
 await page.locator('#climate-panel > summary').click();
 await page.setViewportSize({width:1440,height:900});await page.screenshot({path:path.join(output,'reon-compact-running.png'),fullPage:true});
 assert.equal(errors.length,0,errors.join('\n'));console.log('Passed: six widths including 320px, cold/warm one-tap switching and stop, sensor override, removed features absent, no page errors.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
