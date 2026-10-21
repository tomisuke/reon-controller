const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const output=process.env.QA_DIR||path.resolve('.sites-runtime/qa');fs.mkdirSync(output,{recursive:true});
 const fixtureResponse=await fetch('https://raw.githubusercontent.com/ultralytics/assets/main/im/bus.jpg');if(!fixtureResponse.ok)throw Error('Fixture fetch failed');const fixture=Buffer.from(await fixtureResponse.arrayBuffer());
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
  await context.route('**/qa-fixture.jpg',route=>route.fulfill({contentType:'image/jpeg',body:fixture}));
  await context.addInitScript(()=>{
   navigator.mediaDevices.getUserMedia=async()=>{
    const image=new Image();image.src='/qa-fixture.jpg';await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');
    ctx.drawImage(image,0,0);const stream=canvas.captureStream(10);window.qaCanvas=canvas;window.qaStream=stream;
    const timer=setInterval(()=>ctx.drawImage(image,0,0),100);stream.getTracks().forEach(track=>track.addEventListener('ended',()=>clearInterval(timer)));
    return stream;
   };
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const updates=[];page.on('request',r=>{if(r.method()==='PUT'&&r.url().includes('/api/distance/'))updates.push(JSON.parse(r.postData()));});
  await page.goto('http://127.0.0.1:4173/distance',{waitUntil:'networkidle'});
  await page.screenshot({path:path.join(output,'distance-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'distance-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1440,height:1100});
  await page.click('#camera');
  await page.waitForFunction(()=>Number(document.getElementById('count').textContent)>=2,{},{timeout:90000});
  const measured=await page.evaluate(()=>({score:Number(document.getElementById('score').textContent),people:Number(document.getElementById('count').textContent),backend:tf.getBackend()}));
  assert.ok(measured.score>=0&&measured.score<100);console.log('Real COCO-SSD inference:',JSON.stringify(measured));
  await page.click('#share');await page.waitForSelector('#share-result:not([hidden])');
  const readUrl=await page.inputValue('#read-url');await page.waitForFunction(()=>document.getElementById('share-message').textContent.includes('毎秒更新')||document.getElementById('share-message').textContent.includes('数値のみ'));
  await page.waitForFunction(async()=>{const url=document.getElementById('read-url').value;const r=await fetch(url);const d=await r.json();return d.fresh&&d.personCount>=2;});
  assert.ok(updates.some(d=>d.active&&d.personCount>=2));assert.ok(updates.every(d=>Object.keys(d).every(k=>['active','score','personCount','fullScale'].includes(k))));
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
  const stopped=await (await page.request.get(readUrl)).json();assert.equal(stopped.score,100);
  await page.goto('http://127.0.0.1:4173/');await page.click('#distance-inline summary');
  const frame=page.frameLocator('#distance-frame');await frame.locator('#camera').click();
  await page.waitForFunction(()=>Number(document.getElementById('reon-distance-value').textContent)<100,{},{timeout:90000});
  console.log('REON inline integration score:',await page.textContent('#reon-distance-value'));
  await page.click('#distance-inline summary');await page.waitForFunction(()=>document.getElementById('reon-distance-value').textContent==='100');
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Passed: desktop/mobile layout, real image inference, camera stream, scalar-only API updates, real video upload/pause/resume/end, stop=100, REON inline reference; no page errors.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
