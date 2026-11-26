import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import {request,withPreview} from "./preview-smoke.mjs";
const {chromium}=await import(pathToFileURL(process.env.AXIS_BROWSER_MODULE).href);
const part=(p,n)=>p.locator('[data-part="'+n+'"]');
const computed=(l,p)=>l.evaluate((e,k)=>getComputedStyle(e).getPropertyValue(k),p);
const rgb=s=>s.match(/\d+(?:\.\d+)?/g).slice(0,3).map(Number).map(n=>s.startsWith("color(srgb")?n*255:n);
const lum=s=>rgb(s).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((a,n,i)=>a+n*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
const equalFocus=async el=>assert.equal(await el.evaluate(e=>e===document.activeElement),true);
await withPreview(async()=>{
 const tree=await request(1,"POST","/series",201,{title:"D15 lifecycle acceptance"});
 const first=await request(2,"POST","/books/"+tree.books[0].id+"/chapters",201,{content:"The gate shut."});
 const path="/chapters/"+first.chapter.id;
 await request(3,"POST",path+"/send",201,{content:"The gate shut."});
 const b=await request(4,"POST",path+"/versions",201,{content:"The bell rang."});
 const long="W".repeat(199)+"😀";
 const saved=await request(5,"POST","/series/"+tree.series.id+"/named-cuts",201,{kind:"snapshot",chapter_id:first.chapter.id,version_id:b.version.id,name:long});
 const browser=await chromium.launch({headless:true,...(process.env.AXIS_BROWSER_EXECUTABLE?{executablePath:process.env.AXIS_BROWSER_EXECUTABLE}:{})});
 try{
  for(const coarse of [false,true]){
   const context=await browser.newContext({viewport:{width:1262,height:900},hasTouch:coarse});
   await context.addInitScript(id=>localStorage.setItem("axis.lastSeriesId",id),tree.series.id);
   const page=await context.newPage();await page.goto("http://localhost:4173/");
   assert.equal(await page.evaluate(()=>matchMedia("(pointer: coarse)").matches),coarse);
   const chapterOpen=part(page,"chapter-open").first();await chapterOpen.waitFor();await chapterOpen.focus();await page.keyboard.press("Enter");await part(page,"editor").waitFor();
   const editor=await part(page,"editor").elementHandle();
   await part(page,"history-door").click();await part(page,"snapshot-filter").waitFor();
   const row=page.locator('[data-version-id="'+b.version.id+'"]');
   const status=part(page,"snapshot-lifecycle-status"),remove=part(page,"snapshot-remove"),undo=part(page,"snapshot-remove-undo"),check=part(page,"snapshot-lifecycle-check"),failure=part(page,"snapshot-lifecycle-failure");
   const group=page.locator(".ax-history__snapshot-lifecycle");
   const body=part(page,"drawer-body");
   const activate=async el=>{await el.focus();await page.keyboard.press("Enter");};
   const reflow=async control=>{
    for(const scale of [16,32]){
     await page.evaluate(px=>document.documentElement.style.fontSize=px+"px",scale);
     for(const width of [320,767,768,1261,1262]){
      await page.setViewportSize({width,height:900});await control.scrollIntoViewIfNeeded();
      const box=await page.locator('[data-region="drawer"]').boundingBox();
      assert.ok(Math.abs(box.width-(width>=1262?380:width))<=1);
      assert.ok(Math.abs(box.height-(width>=1262?852:450))<=1);
      assert.ok(await body.evaluate(e=>e.scrollWidth<=e.clientWidth+1),"drawer overflow "+width+" "+scale);
      const rect=await control.boundingBox();assert.ok(rect.height>=(coarse?44:32)-.5&&(!coarse||rect.width>=43.5));
      assert.equal(await computed(control,"font-size"),(width<768?.9375:.875)*scale+"px");
      assert.equal(await computed(control,"transition-duration"),"0s");
      await page.keyboard.press("Tab");await control.focus();assert.ok(await control.evaluate(e=>e.matches(":focus-visible")));assert.equal(await computed(control,"outline-width"),"2px");
     }
    }
    await page.evaluate(()=>document.documentElement.style.fontSize="16px");await page.setViewportSize({width:1262,height:900});
   };
   await row.locator('[data-part="version-open"]').click();await remove.waitFor();
   await reflow(remove);
   for(const theme of ["light","dark","sepia"]){
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    const room=await computed(group,"background-color"),ink=await computed(remove,"color");
    assert.ok(contrast(ink,room)>=4.5);
    assert.ok(contrast(await computed(remove,"outline-color"),room)>=3);
    if(!coarse){await remove.hover();assert.ok(contrast(ink,await computed(remove,"background-color"))>=4.5);await page.mouse.down();assert.ok(contrast(ink,await computed(remove,"background-color"))>=4.5);await page.mouse.move(0,0);await page.mouse.up();}
   }
   // Fault only the exact mounted label POST and its first settlement GET.
   await page.evaluate(({post,read})=>{
    const original=window.fetch;let rejected=false,held=false;
    window.axisOriginalFetch=original;
    window.fetch=(input,init)=>{
     const url=String(input),method=init?.method??"GET";
     if(!rejected&&url===post&&method==="POST"){rejected=true;return Promise.reject(new TypeError("D15 browser probe"));}
     if(rejected&&!held&&url===read&&method==="GET"){held=true;return new Promise((_,reject)=>{window.axisRejectHistory=reject;});}
     return original(input,init);
    };
   },{post:"/api"+path+"/versions/"+b.version.id+"/snapshot-label",read:"/api"+path+"/history"});
   await activate(remove);
   await page.waitForFunction(()=>document.querySelector('[data-part="snapshot-lifecycle-status"]')?.textContent==="Checking snapshot name…");
   assert.equal(await remove.getAttribute("aria-disabled"),"true");assert.equal(await computed(remove,"opacity"),"1");assert.equal(await computed(remove.locator("span"),"opacity"),"0.4");
   const rule=page.locator(".ax-history__snapshot-check-rule");assert.equal(await computed(rule,"border-top-style"),"dashed");assert.equal(await rule.getAttribute("aria-hidden"),"true");
   await page.emulateMedia({forcedColors:"active",reducedMotion:"reduce"});assert.equal(await computed(remove,"forced-color-adjust"),"auto");assert.equal(await computed(remove.locator("span"),"opacity"),"1");assert.equal(await computed(rule,"border-top-style"),"dashed");
   await page.emulateMedia({forcedColors:"none",reducedMotion:"no-preference"});
   await page.waitForFunction(()=>typeof window.axisRejectHistory==="function");
   await page.evaluate(()=>{window.axisRejectHistory(new TypeError("D15 settle probe"));window.fetch=window.axisOriginalFetch;delete window.axisOriginalFetch;delete window.axisRejectHistory;});
   await check.waitFor();assert.equal(await failure.textContent(),"The snapshot name change could not be confirmed.");
   await reflow(check);await activate(check);await check.waitFor({state:"detached"});
   assert.equal(await failure.textContent(),"The snapshot name change could not be confirmed.");
   await part(page,"snapshot-named").click();await remove.waitFor();
   await activate(remove);
   await undo.waitFor();await equalFocus(undo);assert.equal(await status.textContent(),"Snapshot name removed. The saved version is still in History.");
   await part(page,"snapshot-empty").waitFor();assert.equal(await row.count(),0);await reflow(undo);
   await part(page,"snapshot-all").click();await row.waitFor();assert.equal(await row.locator('[data-part="snapshot-name"]').count(),0);
   await activate(undo);await undo.waitFor({state:"detached"});await equalFocus(row.locator('[data-part="version-open"]'));
   assert.equal(await status.textContent(),"Snapshot name restored.");assert.equal(await row.locator("bdi").textContent(),long);
   const h=await request(6,"GET",path+"/history",200);assert.deepEqual(h.versions.find(v=>v.id===b.version.id).snapshot,saved.snapshot);
   assert.ok(await editor.evaluate(e=>e.isConnected));
   await page.evaluate(()=>delete document.documentElement.dataset.theme);
   await part(page,"drawer-close").click();await equalFocus(part(page,"history-door"));
   await context.close();
  }
 }finally{await browser.close();}
});
console.log("D15 History lifecycle browser acceptance passed");
