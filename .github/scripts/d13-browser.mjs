import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { request, withPreview, writeGuard } from "./preview-smoke.mjs";

const { chromium } = await import(pathToFileURL(process.env.AXIS_BROWSER_MODULE).href);
const part = (page, name) => page.locator('[data-part="' + name + '"]');
const computed = (locator, property) => locator.evaluate((element, prop) => getComputedStyle(element).getPropertyValue(prop), property);
const wait = (page, name) => part(page,name).first().waitFor({state:"visible"});
const rgb = value => value.match(/\d+(?:\.\d+)?/g).slice(0,3).map(Number).map(n=>value.startsWith("color(srgb")?n*255:n);
const luminance = color => rgb(color).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((s,n,i)=>s+n*[.2126,.7152,.0722][i],0);
const contrast = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);

await withPreview(async () => {
  const tree=await request(1,"POST","/series",201,{title:"D13 responsive acceptance"});
  const first=await request(2,"POST","/books/"+tree.books[0].id+"/chapters",201,{content:"The gate shut."});
  const chapter=first.chapter.id, path="/chapters/"+chapter;
  const saved=await request(3,"POST",path+"/versions",201,{content:"The bell rang.",parent_version:first.version.id,...writeGuard(first.version.id)});
  const longName="W".repeat(199)+"😀";
  const named=await request(4,"POST","/series/"+tree.series.id+"/named-cuts",201,{kind:"snapshot",chapter_id:chapter,version_id:saved.version.id,name:longName});
  assert.equal(named.snapshot.name,longName);
  const newest=await request(5,"POST",path+"/versions",201,{content:"The gate opened.",parent_version:saved.version.id,...writeGuard(saved.version.id)});
  const browser=await chromium.launch({headless:true,...(process.env.AXIS_BROWSER_EXECUTABLE?{executablePath:process.env.AXIS_BROWSER_EXECUTABLE}:{})});
  try {
    for(const coarse of [false,true]) {
      const context=await browser.newContext({viewport:{width:1262,height:900},hasTouch:coarse});
      await context.addInitScript(id=>localStorage.setItem("axis.lastSeriesId",id),tree.series.id);
      const page=await context.newPage();
      await page.goto("http://localhost:4173/");
      assert.equal(await page.evaluate(()=>matchMedia("(pointer: coarse)").matches),coarse);
      await wait(page,"chapter-open");
      await part(page,"chapter-open").first().click();
      await wait(page,"editor");
      const editor=await part(page,"editor").elementHandle();
      await part(page,"history-door").click();await wait(page,"snapshot-filter");
      assert.equal(await part(page,"snapshot-all").getAttribute("aria-pressed"),"true");
      await part(page,"snapshot-name-action").first().focus();
      await page.keyboard.press("Enter");
      await wait(page,"snapshot-name-input");
      assert.equal(await part(page,"snapshot-name-input").evaluate(e=>document.activeElement===e),true);
      const label=page.locator(".ax-history__snapshot-name bdi");
      assert.equal(await label.textContent(),longName);
      assert.ok((await computed(label,"font-family")).includes("system-ui"));
      for(const scale of [16,32]) {
        await page.evaluate(px=>document.documentElement.style.fontSize=px+"px",scale);
        for(const width of [320,768,1024,1261,1262]) {
          await page.setViewportSize({width,height:900});
          const drawer=page.locator('[data-region="drawer"]'),body=part(page,"drawer-body");
          const box=await drawer.boundingBox();
          assert.ok(box);
          assert.ok(Math.abs(box.width-(width>=1262?380:width))<=1,`drawer width ${width}: ${box.width}`);
          assert.ok(Math.abs(box.height-(width>=1262?852:450))<=1,`drawer height ${width}: ${box.height}`);
          assert.equal(await computed(body,"overflow-y"),"auto");
          assert.ok(await body.evaluate(el=>el.scrollWidth<=el.clientWidth+1),`Drawer overflow ${width} ${scale} coarse ${coarse}`);
          assert.ok(await label.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
          for(const name of ["snapshot-named","snapshot-all","snapshot-name-input","snapshot-name-submit","snapshot-name-cancel"]) {
            const control=part(page,name);
            assert.equal(await control.isVisible(),true);
            const rect=await control.boundingBox();
            assert.ok(rect && rect.height >= (coarse?44:32)-.5 && (!coarse || rect.width>=43.5),`target ${name} ${width} ${scale} ${coarse}`);
          }
          assert.ok(await page.locator(".ax-history__snapshot-form").evaluate(el=>el.scrollWidth<=el.clientWidth+1));
          assert.equal(await computed(label,"overflow-wrap"),"anywhere");
        }
      }
      await page.evaluate(()=>document.documentElement.style.fontSize="16px");
      await page.setViewportSize({width:1262,height:900});
      for(const [theme,room,pencil,field] of [
        ["light","rgb(236, 235, 230)","rgb(220, 231, 242)","rgb(248, 248, 246)"],
        ["dark","rgb(11, 12, 14)","rgb(27, 39, 51)","rgb(23, 24, 26)"],
        ["sepia","rgb(216, 202, 173)","rgb(200, 208, 210)","rgb(237, 227, 206)"]
      ]) {
        await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        const active=part(page,"snapshot-all"),inactive=part(page,"snapshot-named"),input=part(page,"snapshot-name-input");
        await page.mouse.move(0,0);
        await page.waitForTimeout(150);
        assert.equal(await computed(active,"background-color"),pencil);
        assert.equal(await computed(inactive,"background-color"),room);
        assert.equal(await computed(input,"background-color"),field);
        assert.ok(contrast(await computed(input,"color"),field)>=7);
        const border=await computed(input,"border-top-color");
        assert.ok(contrast(border,field)>=3 && contrast(border,room)>=3);
        await input.focus();
        assert.equal(await computed(input,"outline-width"),"2px");
        assert.ok(contrast(await computed(input,"outline-color"),field)>=3 && contrast(await computed(input,"outline-color"),room)>=3);
        if(!coarse) {
          await active.hover();await page.waitForTimeout(150);
          assert.equal(await computed(active,"transition-duration"),"0.12s");
          assert.ok(contrast(await computed(active,"color"),await computed(active,"background-color"))>=7);
          await page.mouse.down();
          await page.waitForTimeout(100);
          assert.equal(await computed(active,"transition-duration"),"0.08s");
          assert.ok(contrast(await computed(active,"color"),await computed(active,"background-color"))>=7);
          await page.mouse.up();
          await page.mouse.move(0,0);
        }
        assert.equal(await computed(active.locator(".ax-history__snapshot-underline"),"border-bottom-width"),"2px");
      }
      await page.emulateMedia({reducedMotion:"reduce"});
      assert.equal(await computed(part(page,"snapshot-all"),"transition-duration"),"0s");
      await page.emulateMedia({forcedColors:"active"});
      const selected=part(page,"snapshot-all");
      assert.equal(await computed(selected.locator(".ax-history__snapshot-underline"),"border-bottom-style"),"solid");
      await part(page,"snapshot-named").focus();
      await page.keyboard.press("Tab");
      assert.equal(await selected.evaluate(e=>document.activeElement===e),true);
      assert.equal(await computed(selected,"outline-width"),"2px");
      await page.emulateMedia({forcedColors:"none",reducedMotion:"no-preference"});
      await part(page,"snapshot-name-input").focus();
      await page.keyboard.press("Escape");
      await page.locator('[data-region="drawer"]').waitFor({state:"detached"});
      assert.equal(await part(page,"history-door").evaluate(e=>document.activeElement===e),true);
      assert.ok(await editor.evaluate(e=>e.isConnected));
      // Exercise native Enter submission in the live app once; the other pointer context already saw the same state.
      if(coarse) {
        await part(page,"history-door").click();await wait(page,"snapshot-name-action");
        await part(page,"snapshot-name-action").first().focus();await page.keyboard.press("Enter");
        await part(page,"snapshot-name-input").fill("Browser verified");
        await page.keyboard.press("Enter");
        await page.waitForFunction(()=>document.querySelector('[data-part="snapshot-name-status"]')?.textContent==="Snapshot named.");
        const history=await request(6,"GET",path+"/history",200);
        assert.equal(history.versions.find(v=>v.id===newest.version.id).snapshot.name,"Browser verified");
        assert.ok(await editor.evaluate(e=>e.isConnected));
      }
      await context.close();
    }
  } finally { await browser.close(); }
});
console.log("D13 browser responsive and keyboard acceptance passed");
