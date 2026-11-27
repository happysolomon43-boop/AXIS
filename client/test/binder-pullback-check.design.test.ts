import {expect,test} from "vitest";
import css from "../src/styles/binder-pullback-check.css?raw";
import tokens from "../src/styles/tokens.css?raw";
const compact=(v:string)=>v.replace(/\s+/g,"");
test("AXB-0136 AC1 DV7-8 values with approved existing 56px Binder rail token",()=>{
 expect(tokens).toMatch(/--ax-size-binder-rail:\s*56px/);
 expect(css).not.toContain("--ax-size-hang");
 const expected=`
.ax-binder__pullback-failure--unsettled{inset-block-end:var(--ax-size-row);}
.ax-binder__pullback-check{position:sticky;inset-block-end:0;display:flex;align-items:center;box-sizing:border-box;inline-size:100%;block-size:var(--ax-size-row);padding-block:0;padding-inline-start:var(--ax-size-binder-rail);padding-inline-end:var(--ax-space-4);border:0;border-radius:0;background-color:var(--ax-color-surface-shell);color:var(--ax-color-text-primary);font:inherit;font-size:0.875rem;line-height:1.25rem;font-weight:600;text-align:start;cursor:pointer;}
@media(hover:hover){.ax-binder__pullback-check:not([aria-disabled="true"]):hover{background-color:color-mix(in srgb,var(--ax-color-text-primary) 6%,var(--ax-color-surface-shell));}}
.ax-binder__pullback-check:not([aria-disabled="true"]):active{background-color:color-mix(in srgb,var(--ax-color-text-primary) 14%,var(--ax-color-surface-shell));}
.ax-binder__pullback-check:focus{outline:2px solid var(--ax-color-focus);outline-offset:-2px;}
.ax-binder__pullback-check[aria-disabled="true"]{color:color-mix(in srgb,var(--ax-color-text-primary) 40%,var(--ax-color-surface-shell));cursor:default;}
@media(pointer:coarse){.ax-binder__pullback-check{block-size:var(--ax-size-hit-touch);}.ax-binder__pullback-failure--unsettled{inset-block-end:var(--ax-size-hit-touch);}}
@media(max-width:767px){.ax-binder__pullback-check{font-size:0.9375rem;line-height:1.375rem;}}
`;
 expect(compact(css)).toBe(compact(expected));
 for(const [,name] of css.matchAll(/var\((--ax-[\w-]+)/g))expect(tokens).toContain(name+":");
});
test("AXB-0136 AC2 contrast and lint",()=>{
 const rgb=(h:string)=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
 const lum=(v:number[])=>v.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
 for(const [fg,bg] of [["#1B1C1E","#ECEBE6"],["#D9D6CD","#0B0C0E"],["#2B2418","#D8CAAD"]]){
  const ink=rgb(fg),fill=rgb(bg);
  for(const p of [0,.06,.14]){const a=lum(ink),b=lum(fill.map((x,i)=>x*(1-p)+ink[i]*p));expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(p===0?7:4.5);}
 }
 expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|transition\s*:|animation\s*:|@keyframes|transform\s*:|filter\s*:|::(?:before|after)|!important|box-shadow\s*:/i);
});
