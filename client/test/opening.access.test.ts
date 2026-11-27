import { expect, test } from "vitest";
import opening from "../src/styles/opening.css?raw";
import tokens from "../src/styles/tokens.css?raw";
import base from "../src/styles/base.css?raw";

function luminance(hex:string):number{
  const [r,g,b]=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);
  return 0.2126*r+0.7152*g+0.0722*b;
}
function contrast(a:string,b:string):number{
  const x=luminance(a),y=luminance(b);
  return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);
}
test("AXB-0128 AC1 all nine contrast fixtures and actual token values",()=>{
  for(const [theme,room,ink,border,inkFloor,borderFloor] of [
    ["Light","#ECEBE6","#1B1C1E","#7E8186",14,3.2],
    ["Dark","#0B0C0E","#D9D6CD","#72757A",13,4.2],
    ["Sepia","#D8CAAD","#2B2418","#7A6D55",9,3.1],
  ] as const){
    for(const value of [room,ink,border])expect(tokens.toLowerCase(),theme+" "+value).toContain(value.toLowerCase());
    const inkRatio=contrast(ink,room),borderRatio=contrast(border,room),focusRatio=contrast(ink,room);
    expect(inkRatio,theme+" ink").toBeGreaterThanOrEqual(7);
    expect(Math.floor(inkRatio),theme+" ink integer").toBe(inkFloor);
    expect(borderRatio,theme+" border").toBeGreaterThanOrEqual(3);
    expect(Math.floor(borderRatio*10)/10,theme+" border truncated").toBe(borderFloor);
    expect(focusRatio,theme+" focus").toBeGreaterThanOrEqual(3);
    expect(focusRatio,theme+" focus equality").toBe(inkRatio);
  }
});
test("AXB-0128 AC2 every var resolves and no forbidden declarations",()=>{
  expect(tokens).toContain("--ax-color-focus: var(--ax-color-text-primary)");
  expect(base).toContain("outline: 2px solid var(--ax-color-focus)");
  expect(base).toContain('.ax-button.ax-opening__retry[aria-disabled="true"] { opacity: 1; }');
  expect(base).toContain(".ax-button.ax-opening__retry { block-size: auto; }");
  expect(base).toContain('.ax-button.ax-opening__retry:active:not([aria-disabled="true"]) { transition-duration: var(--ax-dur-press); }');
  const declared=new Set([... (tokens+base).matchAll(/(--[\w-]+)\s*:/g)].map(m=>m[1]));
  for(const m of opening.matchAll(/var\(\s*(--[\w-]+)/g))expect(declared.has(m[1]),m[1]).toBe(true);
  expect(opening).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(|@keyframes/i);
  for(const match of opening.matchAll(/(?:^|(?<=[;{]))\s*([a-z-]+)\s*:\s*([^;{}]+);/gm)){
    const [,property,value]=match;
    expect(property).not.toMatch(/^(?:(?:min-|max-)?height|(?:max-)?block-size|outline(?:-.+)?|animation(?:-.+)?|opacity|pointer-events|transform(?:-.+)?)$/);
    if(property==="font-size"){expect(value.trim()).toMatch(/^\d+(?:\.\d+)?rem$/);expect(Number.parseFloat(value)).toBeGreaterThanOrEqual(0.75);}
    if(property.startsWith("transition"))expect([property,value.trim()]).toEqual(["transition","none"]);
  }
});
