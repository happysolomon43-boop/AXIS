import {createElement} from "react";
import {render} from "@testing-library/react";
import {expect,test} from "vitest";
import * as glyphs from "../src/glyphs";
import css from "../src/styles/binder-menu.css?raw";
import tokens from "../src/styles/tokens.css?raw";
export const compact=(v:string)=>v.replace(/\s+/g,"");
export function ratio(a:number[],b:number[]) {
 const lum=(rgb:number[])=>rgb.map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
 const x=lum(a),y=lum(b);return Math.floor(100*(Math.max(x,y)+0.05)/(Math.min(x,y)+0.05))/100;
}
export const rgb=(hex:string)=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
export const mix=(ink:number[],fill:number[],p:number)=>ink.map((v,i)=>v*p+fill[i]*(1-p));
export const themes=[
 ["#ECEBE6","#FCFCFA","#7E8186","#1B1C1E","#4A4D52","#62656A","#DCE7F2"],
 ["#0B0C0E","#0E1012","#72757A","#D9D6CD","#A9A79F","#94938E","#1B2733"],
 ["#D8CAAD","#F6EEDD","#7A6D55","#2B2418","#4F4636","#594F3D","#C8D0D2"]
];
test("AXB-0135 AC1 exact overflow glyph and retained exports",()=>{
 expect(Object.keys(glyphs).sort()).toEqual(["AxisMark","AxisMotif","BinderGlyph","ChevronGlyph","OverflowGlyph"]);
 const ui=render(createElement(glyphs.OverflowGlyph));const svg=ui.container.querySelector("svg")!;
 for(const [k,v] of Object.entries({width:"16",height:"16",viewBox:"0 0 20 20",fill:"currentColor","aria-hidden":"true",focusable:"false"}))expect(svg).toHaveAttribute(k,v);
 expect(svg.children).toHaveLength(3);
 expect(Array.from(svg.children).map(r=>[r.tagName,r.getAttribute("x"),r.getAttribute("y"),r.getAttribute("width"),r.getAttribute("height")])).toEqual([["rect","3","9","2","2"],["rect","9","9","2","2"],["rect","15","9","2","2"]]);expect(svg.querySelector("[stroke]")).toBeNull();
});
test("AXB-0135 AC2 DV3-6 and DV8 declarations and existing token names",()=>{
 const expected=`
.ax-binder__selectable {position:relative;}
.ax-binder__selectable[data-selected="true"]{background-color:var(--ax-color-pencil-tint);}
.ax-binder__selected-rule{position:absolute;inset-inline:0;inset-block-end:0;block-size:2px;background-color:var(--ax-color-text-primary);pointer-events:none;}
.ax-binder__menu-trigger{flex:none;box-sizing:border-box;inline-size:var(--ax-size-hit-min);block-size:var(--ax-size-row);min-inline-size:0;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:var(--ax-radius-2);color:var(--ax-color-text-tertiary);}
.ax-binder__menu-trigger[aria-expanded="true"]{background-color:color-mix(in srgb,var(--ax-color-text-primary) 6%,transparent);}
@media(hover:hover) and (pointer:fine){.ax-binder__menu-trigger{opacity:0;}.ax-binder__selectable:hover .ax-binder__menu-trigger,.ax-binder__selectable:focus-within .ax-binder__menu-trigger,.ax-binder__selectable[data-selected="true"] .ax-binder__menu-trigger,.ax-binder__menu-trigger[aria-expanded="true"]{opacity:1;}}
.ax-binder__menu{position:absolute;inset-block-start:100%;inset-inline-end:var(--ax-space-3);z-index:var(--ax-z-popover);display:flex;flex-direction:column;box-sizing:border-box;padding:var(--ax-space-2);inline-size:max-content;min-inline-size:min(200px,calc(100% - 2 * var(--ax-space-3)));max-inline-size:min(var(--ax-size-popover),calc(100% - 2 * var(--ax-space-3)));background-color:var(--ax-color-surface-raised);border:1px solid var(--ax-color-border-control);border-radius:var(--ax-radius-3);box-shadow:var(--ax-shadow-popover);}
.ax-binder__menu-item{display:flex;align-items:center;box-sizing:border-box;inline-size:100%;min-block-size:var(--ax-size-row);padding:0 var(--ax-space-4);border:0;border-radius:var(--ax-radius-2);background-color:transparent;color:var(--ax-color-text-primary);font:inherit;font-size:0.875rem;line-height:1.25rem;font-weight:400;text-align:start;cursor:pointer;}
@media(hover:hover){.ax-binder__menu-item:not([aria-disabled="true"]):hover{background-color:color-mix(in srgb,var(--ax-color-text-primary) 6%,transparent);}}
.ax-binder__menu-item:not([aria-disabled="true"]):active{background-color:color-mix(in srgb,var(--ax-color-text-primary) 14%,transparent);}
.ax-binder__menu-item:focus{outline:2px solid var(--ax-color-focus);outline-offset:-2px;}
.ax-binder__menu-item[aria-disabled="true"]{color:color-mix(in srgb,var(--ax-color-text-primary) 40%,var(--ax-color-surface-raised));cursor:default;}
@media(pointer:coarse){.ax-binder__menu-trigger{inline-size:var(--ax-size-hit-touch);block-size:var(--ax-size-hit-touch);}.ax-binder__menu-item{min-block-size:var(--ax-size-hit-touch);}}
@media(max-width:767px){.ax-binder__menu-item{font-size:0.9375rem;line-height:1.375rem;}}
`;
 for(const [,name] of css.matchAll(/var\((--ax-[\w-]+)/g))expect(tokens).toContain(name+":");
 expect(compact(css)).toBe(compact(expected));
});
test("AXB-0135 AC3 DV11 contrast in all themes",()=>{
 for(const theme of themes){const [shell,raised,border,ink,secondary,tertiary,pencil]=theme.map(rgb);
  for(const bg of [shell,raised,pencil]){expect(ratio(ink,bg)).toBeGreaterThanOrEqual(7);expect(ratio(ink,bg)).toBeGreaterThanOrEqual(3);}
  for(const bg of [raised,shell])for(const p of [0.06,0.14])expect(ratio(ink,mix(ink,bg,p))).toBeGreaterThanOrEqual(4.5);
  expect(ratio(secondary,pencil)).toBeGreaterThanOrEqual(4.5);
  for(const bg of [pencil,shell])expect(ratio(tertiary,bg)).toBeGreaterThanOrEqual(4.5);
  expect(ratio(border,raised)).toBeGreaterThanOrEqual(3);
 }
});
test("AXB-0135 AC4 lint",()=>{
 expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|transition\s*:|animation\s*:|@keyframes|transform\s*:|filter\s*:|::(?:before|after)|!important|border-(?:left|right|top|bottom|inline|block)\s*:/i);
 expect([...css.matchAll(/box-shadow:\s*([^;]+);/g)].map(m=>m[1])).toEqual(["var(--ax-shadow-popover)"]);
});
