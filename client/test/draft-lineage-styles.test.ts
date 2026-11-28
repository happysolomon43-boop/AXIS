import {expect,test} from "vitest";
import autosave from "../src/draft/autosave.css?raw";
import identity from "../src/styles/draft-identity.css?raw";
import tokens from "../src/styles/tokens.css?raw";
test("DL-3 and DL-5 retain the inherited dot, status line and absence of motion",()=>{
  const dot=autosave.match(/\.ax-autosave__dot\s*\{([^}]+)\}/)![1];
  for(const declaration of ["inline-size: 4px","block-size: 4px","border-radius: var(--ax-radius-1)","background-color: var(--ax-color-text-tertiary)"])expect(dot).toContain(declaration);
  expect(autosave).toMatch(/\[data-autosave="failed"\][\s\S]*\[data-autosave="stopped"\][\s\S]*background-color: var\(--ax-color-severity-break\)/);
  expect(tokens).toMatch(/--ax-radius-1:\s*3px/);
  expect(autosave+identity).not.toMatch(/(?:transition|animation|@keyframes|--[\w-]+\s*:)/);
  expect(identity).toContain("inline-size: 100%");expect(identity).toContain("overflow-wrap: anywhere");
  expect(identity).toContain("font-size: 0.9375rem");expect(identity).toContain("line-height: 1.375rem");
  expect(autosave+identity).not.toMatch(/lineage|alias|split|merge/i);
});
function luminance(hex:string){const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;}
test("DL-2 all six unrounded graphics contrast ratios meet 3:1",()=>{
  for(const [shell,tertiary,severity] of [["#ECEBE6","#62656A","#B42318"],["#0B0C0E","#94938E","#F2766B"],["#D8CAAD","#594F3D","#A31F14"]]){
    for(const [name,value] of [["surface-shell",shell],["text-tertiary",tertiary],["severity-break",severity]])expect(tokens).toContain("--ax-color-"+name+": "+value);
    for(const ink of [tertiary,severity]){const a=luminance(ink),b=luminance(shell);expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toBeGreaterThanOrEqual(3);}
  }
});
