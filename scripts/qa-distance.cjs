const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const output=process.env.QA_DIR||path.resolve('.sites-runtime/qa');fs.mkdirSync(output,{recursive:true});
 const fixture=process.env.QA_FIXTURE
  ?fs.readFileSync(process.env.QA_FIXTURE)
  :await fetch('https://raw.githubusercontent.com/ultralytics/assets/main/im/bus.jpg').then(async response=>{
   if(!response.ok)throw Error('Fixture fetch failed');return Buffer.from(await response.arrayBuffer());
  });
 const browser=await chromium.launch({...(process.env.QA_CHROMIUM?{executablePath:process.env.QA_CHROMIUM}:{channel:process.env.QA_CHANNEL??'chrome'}),headless:true,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
  const headers={'access-control-allow-origin':'*'};
  if(process.env.QA_POSE_MODEL)await context.route('**/pose_landmarker_lite.task',route=>route.fulfill({path:process.env.QA_POSE_MODEL,headers}));
  if(process.env.QA_COCO_DIR){
   await context.route('https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/**',route=>{
    const asset=path.basename(new URL(route.request().url()).pathname);
    return route.fulfill({path:path.join(process.env.QA_COCO_DIR,asset),headers});
   });
   for(const [url,file] of [
    ['https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js','@tensorflow/tfjs/dist/tf.min.js'],
    ['https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js','@tensorflow-models/coco-ssd/dist/coco-ssd.min.js'],
   ]){
    await context.route(url,route=>route.fulfill({path:require.resolve(file),headers,contentType:'text/javascript'}));
   }
  }
  if(process.env.QA_VISION_DIR)await context.route('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/**',route=>{
   const asset=new URL(route.request().url()).pathname.split('0.10.21/')[1];
   return route.fulfill({path:path.join(process.env.QA_VISION_DIR,asset),headers,
    contentType:asset.endsWith('.wasm')?'application/wasm':'text/javascript'});
  });
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
  const separatePages=[];page.on('request',r=>{if(['/distance','/distance.html'].includes(new URL(r.url()).pathname))separatePages.push(r.url());});
  await page.goto(new URL('#distance-section',process.env.QA_URL||'http://127.0.0.1:4173/').href,{waitUntil:'networkidle'});
  assert.equal(await page.locator('#distance-enabled').isChecked(),false);assert.equal(await page.locator('iframe').count(),0);
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.setViewportSize({width:1440,height:1100});
  await page.check('#distance-enabled');
  await page.waitForFunction(()=>window.reonDistance?.status==='tracking',{},{timeout:90000});
  const measured=await page.evaluate(()=>({score:window.reonDistance.score,people:window.reonDistance.personCount,metric:window.reonDistance.metric}));
  assert.ok(measured.score>=0&&measured.score<100);assert.equal(measured.metric,'selected_body_gap_2d');console.log('Real MediaPipe inference:',JSON.stringify(measured));
  await page.screenshot({path:path.join(output,'distance-detection.png'),fullPage:true});
  // Record the real fixture stream, then exercise the actual video-file input path.
  const recording=await page.evaluate(async()=>{const recorder=new MediaRecorder(window.qaStream,{mimeType:'video/webm'}),chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);const done=new Promise(resolve=>recorder.onstop=async()=>resolve([...new Uint8Array(await new Blob(chunks).arrayBuffer())]));recorder.start();await new Promise(r=>setTimeout(r,4000));recorder.stop();return done;});
  const videoPath=path.join(output,'people.webm');fs.writeFileSync(videoPath,Buffer.from(recording));
  await page.click('#stop');assert.equal(await page.textContent('#reon-distance-value'),'100');
  await page.setInputFiles('#file',videoPath);await page.waitForFunction(()=>window.reonDistance?.status==='tracking',{},{timeout:30000});
  await page.locator('#video').evaluate(v=>v.pause());await page.waitForFunction(()=>window.reonDistance?.score===100);
  await page.locator('#video').evaluate(v=>v.play());await page.waitForFunction(()=>window.reonDistance?.status==='tracking');
  await page.waitForFunction(()=>document.getElementById('video').ended&&window.reonDistance?.score===100,{},{timeout:15000});
  await page.click('#stop');
  await page.click('#camera');
  await page.waitForFunction(()=>Number(document.getElementById('reon-distance-value').textContent)<100,{},{timeout:90000});
  console.log('REON native integration score:',await page.textContent('#reon-distance-value'));
  const compact=await page.locator('#stage').boundingBox();await page.click('#distance-expand');const large=await page.locator('#stage').boundingBox();assert.ok(large.width>compact.width&&large.height>compact.height);
  await page.screenshot({path:path.join(output,'reon-distance-expanded.png'),fullPage:false});
  await page.click('#distance-fullscreen');assert.equal(await page.evaluate(()=>document.fullscreenElement?.id),'distance-section');await page.click('#distance-fullscreen');
  await page.selectOption('#hold-duration','3000');
  await page.evaluate(()=>window.qaBlank=true);
  await page.waitForFunction(()=>document.getElementById('reon-distance-count').textContent==='0 人'&&Number(document.getElementById('reon-distance-value').textContent)<100,{},{timeout:10000});
  assert.ok((await page.textContent('#reon-distance-status')).includes('補正中'));
  await page.evaluate(()=>window.qaBlank=false);await page.waitForFunction(()=>window.reonDistance?.status==='tracking',{},{timeout:10000});
  assert.ok(Number(await page.textContent('#reon-distance-value'))<100);
  await page.evaluate(()=>window.qaBlank=true);await page.waitForFunction(()=>window.reonDistance?.status==='target_lost',{},{timeout:10000});
  await page.evaluate(()=>window.qaBlank=false);await page.waitForFunction(()=>window.reonDistance?.personCount>=2);
  assert.equal(await page.evaluate(()=>window.reonDistance.status),'target_lost');
  await page.click('#auto-targets');await page.waitForFunction(()=>window.reonDistance?.status==='tracking');
  await page.uncheck('#hold-enabled');await page.evaluate(()=>window.qaBlank=true);await page.waitForFunction(()=>document.getElementById('reon-distance-count').textContent==='0 人');assert.equal(await page.textContent('#reon-distance-value'),'100');
  await page.evaluate(()=>window.qaBlank=false);await page.waitForFunction(()=>window.reonDistance?.personCount>=2);
  assert.equal(await page.evaluate(()=>window.reonDistance.status),'target_lost');
  await page.uncheck('#distance-enabled');assert.equal(await page.textContent('#reon-distance-value'),'100');assert.equal(await page.evaluate(()=>window.qaStream.getTracks().every(t=>t.readyState==='ended')),true);
  assert.equal(await page.locator('#distance-section').evaluate(el=>el.classList.contains('distance-expanded')),false);
  await page.setViewportSize({width:390,height:844});await page.check('#distance-enabled');await page.waitForFunction(()=>Number(document.getElementById('reon-distance-value').textContent)<100);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(output,'reon-distance-mobile.png'),fullPage:true});
  await page.click('#distance-expand');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(output,'reon-distance-mobile-expanded.png')});await page.uncheck('#distance-enabled');
  assert.deepEqual(separatePages,[]);
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('Passed: real inference/video, native REON ON/OFF, camera release, enlargement/fullscreen, short dropout hold/recovery/expiry/disabled protection, desktop/mobile layout; no page errors.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
