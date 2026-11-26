import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import {request,withPreview} from "./preview-smoke.mjs";
const {chromium}=await import(pathToFileURL(process.env.AXIS_BROWSER_MODULE).href);
const part=(p,n)=>p.locator('[data-part="'+n+'"]');
const computed=(loc,prop)=>loc.evaluate((el,key)=>getComputedStyle(el).getPropertyValue(key),prop);
const rgb=s=>s.match(/\d+(?:\.\d+)?/g).slice(0,3).map(Number).map(n=>s.startsWith("color(srgb")?n*255:n);
const lum=s=>rgb(s).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((a,n,i)=>a+n*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
await withPreview(async()=>{
 const tree=await request(1,"POST","/series",201,{title:"D14 browser acceptance"});
 const first=await request(2,"POST","/books/"+tree.books[0].id+"/chapters",201,{content:"The gate shut."});
 const browser=await chromium.launch({headless:true,...(process.env.AXIS_BROWSER_EXECUTABLE?{executablePath:process.env.AXIS_BROWSER_EXECUTABLE}:{})});
 try{
  for(const coarse of [false,true]){
   const context=await browser.newContext({viewport:{width:1360,height:900},hasTouch:coarse});
   await context.addInitScript(id=>localStorage.setItem("axis.lastSeriesId",id),tree.series.id);
   const page=await context.newPage();await page.goto("http://localhost:4173/");
   await part(page,"chapter-open").first().click();await part(page,"editor").waitFor();
   const editor=await part(page,"editor").elementHandle();
   const trigger=part(page,"snapshot"),input=part(page,"snapshot-name"),form=part(page,"snapshot-form"),submit=part(page,"snapshot-submit");
   await trigger.focus();await page.keyboard.press("Enter");await input.waitFor();assert.equal(await input.evaluate(e=>document.activeElement===e),true);
   const long="א".repeat(199)+"😀";await input.fill(long);
   await part(page,"history-door").click();await part(page,"snapshot-filter").waitFor();
   for(const scale of [16,32]){
    await page.evaluate(px=>document.documentElement.style.fontSize=px+"px",scale);
    for(const width of [320,767,768,1024,1261,1262,1360]){
     await page.setViewportSize({width,height:900});
     assert.equal(await input.inputValue(),long);
     assert.ok(await form.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
     const box=await form.boundingBox();assert.ok(box.width<=20*scale+1);
     for(const el of [trigger,input,submit,part(page,"snapshot-cancel")]){
      const b=await el.boundingBox();assert.ok(b.height>=(coarse?44:32)-.5);assert.ok(b.width>=(coarse?44:32)-.5);
     }
     assert.equal(await computed(form.locator(".ax-draft__snapshot-actions"),"flex-direction"),width<768?"column":"row");
     assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
   }
   await page.evaluate(()=>document.documentElement.style.fontSize="16px");await page.setViewportSize({width:1360,height:900});
   const themes=[["light","rgb(236, 235, 230)",["rgb(248, 248, 246)","rgb(252, 252, 253)","rgb(251, 248, 242)"]],["dark","rgb(11, 12, 14)",["rgb(23, 24, 26)","rgb(15, 17, 19)","rgb(28, 25, 22)"]],["sepia","rgb(216, 202, 173)",["rgb(237, 227, 206)","rgb(240, 230, 214)","rgb(233, 220, 193)"]]];
   for(const [theme,room,papers] of themes){
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    for(const [i,profile] of ["literary","modern","warm"].entries()){
     await page.locator(".ax-leaf").evaluate((e,p)=>e.dataset.profile=p,profile);
     const paper=await computed(input,"background-color");assert.equal(paper,papers[i]);
     assert.equal(await computed(form,"background-color"),room);
     assert.ok(contrast(await computed(input,"color"),paper)>=7);
     const border=await computed(input,"border-top-color");assert.ok(contrast(border,room)>=3&&contrast(border,paper)>=3);
     assert.ok(contrast(await computed(input,"caret-color"),paper)>=3);
     await input.focus();assert.equal(await computed(input,"outline-width"),"2px");
     assert.ok(contrast(await computed(input,"outline-color"),room)>=3&&contrast(await computed(input,"outline-color"),paper)>=3);
     assert.ok(contrast(await computed(submit,"color"),room)>=7);
     if(!coarse){await submit.hover();await page.waitForTimeout(130);assert.equal(await computed(submit,"transition-property"),"background-color");assert.equal(await computed(submit,"transition-duration"),"0.12s");assert.ok(contrast(await computed(submit,"color"),await computed(submit,"background-color"))>=7);await page.mouse.down();await page.waitForTimeout(90);assert.equal(await computed(submit,"transition-duration"),"0.08s");await page.mouse.move(0,0);await page.mouse.up();}
    }
   }
   await page.emulateMedia({reducedMotion:"reduce"});assert.equal(await computed(submit,"transition-duration"),"0s");
   await page.emulateMedia({forcedColors:"active"});await input.focus();assert.equal(await computed(input,"outline-width"),"2px");assert.equal(await computed(input,"forced-color-adjust"),"auto");
   await page.emulateMedia({forcedColors:"none",reducedMotion:"no-preference"});
   await input.focus();await page.keyboard.press("Escape");await form.waitFor({state:"detached"});assert.equal(await trigger.evaluate(e=>document.activeElement===e),true);
   if(!coarse){
    await trigger.focus();await page.keyboard.press("Enter");await input.fill("Browser snapshot");await page.keyboard.press("Enter");
    await page.waitForFunction(()=>document.querySelector('[data-part="snapshot-status"]')?.textContent==="Snapshot saved.");
    await part(page,"snapshot-named").click();await page.getByText("Browser snapshot",{exact:true}).waitFor();
    assert.ok(await editor.evaluate(e=>e.isConnected));
    const h=await request(3,"GET","/chapters/"+first.chapter.id+"/history",200);assert.equal(h.versions[0].snapshot.name,"Browser snapshot");
   }
   await context.close();
  }
 }finally{await browser.close();}
});
console.log("D14 browser acceptance passed");
