const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const output=process.env.QA_DIR||path.resolve('.sites-runtime/qa');fs.mkdirSync(output,{recursive:true});
 const fixtureResponse=await fetch('https://raw.githubusercontent.com/ultralytics/assets/main/im/bus.jpg');if(!fixtureResponse.ok)throw Error('Fixture fetch failed');const fixture=Buffer.from(await fixtureResponse.arrayBuffer());
 const browser=await chromium.launch({channel:process.env.QA_CHANNEL??'chrome',headless:true,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
  await context.route('**/qa-fixture.jpg',route=>route.fulfill({contentType:'image/jpeg',body:fixture}));
  await context.addInitScript(()=>{
   navigator.mediaDevices.getUserMedia=async()=>{
    const image=new Image();image.src='/qa-fixture.jpg';await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');window.qaBlank=false;
    ctx.drawImage(image,0,0);const stream=canvas.captureStream(10);window.qaCanvas=canvas;window.qaStream=stream;
    const timer=setInterval(()=>{if(window.qaBlank){ctx.fillStyle='black';ctx.fillRect(0,0,canvas.width,canvas.height);}else ctx.drawImage(image,0,0);},100);stream.getTracks().forEach(track=>track.addEventListener('ended',()=>clearInterval(timer)));
    return stream;
   };
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto((process.env.QA_URL||'http://127.0.0.1:4173/')+'distance.html',{waitUntil:'networkidle'});
  await page.screenshot({path:path.join(output,'distance-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'distance-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1440,height:1100});
  await page.click('#camera');
  await page.waitForFunction(()=>Number(document.getElementById('count').textContent)>=2,{},{timeout:90000});
  const measured=await page.evaluate(()=>({score:Number(document.getElementById('score').textContent),people:Number(document.getElementById('count').textContent),backend:tf.getBackend()}));
  assert.ok(measured.score>=0&&measured.score<100);console.log('Real COCO-SSD inference:',JSON.stringify(measured));
  await page.screenshot({path:path.join(output,'distance-detection.png'),fullPage:true});
  // Record the real fixture stream, then exercise the actual video-file input path.
  const recording=await page.evaluate(async()=>{const recorder=new MediaRecorder(window.qaStream,{mimeType:'video/webm'}),chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);const done=new Promise(resolve=>recorder.onstop=async()=>resolve([...new Uint8Array(await new Blob(chunks).arrayBuffer())]));recorder.start();await new Promise(r=>setTimeout(r,4000));recorder.stop();return done;});
  const videoPath=path.join(output,'people.webm');fs.writeFileSync(videoPath,Buffer.from(recording));
  await page.click('#stop');assert.equal(await page.textContent('#score'),'100');
  await page.setInputFiles('#file',videoPath);await page.waitForFunction(()=>Number(document.getElementById('count').textContent)>=2,{},{timeout:30000});
  await page.locator('#video').evaluate(v=>v.pause());assert.equal(await page.textContent('#score'),'100');
  await page.locator('#video').evaluate(v=>v.play());await page.waitForFunction(()=>Number(document.getElementById('count').textContent)>=2);
  await page.waitForFunction(()=>document.getElementById('video').ended,{},{timeout:15000});assert.equal(await page.textContent('#score'),'100');
  await page.click('#stop');
    await page.goto(process.env.QA_URL||'http://127.0.0.1:4173/');assert.equal(await page.locator('#distance-enabled').isChecked(),false);assert.equal(await page.locator('iframe').count(),0);
  await page.check('#distance-enabled');
  await page.waitForFunction(()=>Number(document.getElementById('reon-distance-value').textContent)<100,{},{timeout:90000});
  console.log('REON native integration score:',await page.textContent('#reon-distance-value'));
  const compact=await page.locator('#stage').boundingBox();await page.click('#distance-expand');const large=await page.locator('#stage').boundingBox();assert.ok(large.width>compact.width&&large.height>compact.height);
  await page.screenshot({path:path.join(output,'reon-distance-expanded.png'),fullPage:false});
  await page.click('#distance-fullscreen');assert.equal(await page.evaluate(()=>document.fullscreenElement?.id),'distance-section');await page.click('#distance-fullscreen');
  await page.selectOption('#hold-duration','3000');
  await page.evaluate(()=>window.qaBlank=true);
  await page.waitForFunction(()=>document.getElementById('reon-distance-count').textContent==='0 人'&&Number(document.getElementById('reon-distance-value').textContent)<100,{},{timeout:10000});
  assert.ok((await page.textContent('#reon-distance-status')).includes('補正中'));
  await page.evaluate(()=>window.qaBlank=false);await page.waitForFunction(()=>document.getElementById('reon-distance-count').textContent==='2 人',{},{timeout:10000});
  assert.ok(Number(await page.textContent('#reon-distance-value'))<100);
  await page.evaluate(()=>window.qaBlank=true);await page.waitForFunction(()=>document.getElementById('reon-distance-value').textContent==='100',{},{timeout:10000});
  await page.evaluate(()=>window.qaBlank=false);await page.waitForFunction(()=>Number(document.getElementById('reon-distance-value').textContent)<100);
  await page.uncheck('#hold-enabled');await page.evaluate(()=>window.qaBlank=true);await page.waitForFunction(()=>document.getElementById('reon-distance-count').textContent==='0 人');assert.equal(await page.textContent('#reon-distance-value'),'100');
  await page.evaluate(()=>window.qaBlank=false);await page.waitForFunction(()=>Number(document.getElementById('reon-distance-value').textContent)<100);
  await page.uncheck('#distance-enabled');assert.equal(await page.textContent('#reon-distance-value'),'100');assert.equal(await page.evaluate(()=>window.qaStream.getTracks().every(t=>t.readyState==='ended')),true);
  assert.equal(await page.locator('#distance-section').evaluate(el=>el.classList.contains('distance-expanded')),false);
  await page.setViewportSize({width:390,height:844});await page.check('#distance-enabled');await page.waitForFunction(()=>Number(document.getElementById('reon-distance-value').textContent)<100);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(output,'reon-distance-mobile.png'),fullPage:true});
  await page.click('#distance-expand');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(output,'reon-distance-mobile-expanded.png')});await page.uncheck('#distance-enabled');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Passed: real inference/video, native REON ON/OFF, camera release, enlargement/fullscreen, short dropout hold/recovery/expiry/disabled protection, desktop/mobile layout; no page errors.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
