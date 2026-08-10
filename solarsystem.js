#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const SYSTEMS_DIR = path.join(__dirname, "systems");
const FPS = 20;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const VIEW_TOP = 7;
const VIEW_BOTTOM = 4;
const MIN_ZOOM = 0.005;
const MAX_ZOOM = 100000;
const ZOOM_FACTOR = 1.25;
const TERMINAL_ASPECT = 0.50;
const TIME_WARPS = [1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000, 10000000, 50000000];

let systemFiles = [];
let currentSystemIndex = 0;
let currentSystem = null;
let bodies = {};
let cameraTarget = null;
let simTime = 0;
let zoom = 1;
let timewarpIndex = 0;
let timewarp = TIME_WARPS[0];
let paused = false;
let running = true;
let showOrbits = true;
let showDataTable = false;
let lastUpdate = Date.now();

function getTerminalWidth() { return Math.max(20, process.stdout.columns || 80); }
function getTerminalHeight() { return Math.max(12, process.stdout.rows || 24); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function normalizeAngle(a) { a %= TAU; return a < 0 ? a + TAU : a; }
function add(a,b){return {x:a.x+b.x,y:a.y+b.y,z:a.z+b.z};}
function rotateX(v,a){const c=Math.cos(a),s=Math.sin(a);return {x:v.x,y:v.y*c-v.z*s,z:v.y*s+v.z*c};}
function rotateZ(v,a){const c=Math.cos(a),s=Math.sin(a);return {x:v.x*c-v.y*s,y:v.x*s+v.y*c,z:v.z};}

function discoverSystems() {
    if (!fs.existsSync(SYSTEMS_DIR)) throw new Error(`Missing systems directory: ${SYSTEMS_DIR}`);
    systemFiles = fs.readdirSync(SYSTEMS_DIR)
        .filter(f => f.toLowerCase().endsWith(".json"))
        .sort((a,b) => {
            const aa=a.toLowerCase(), bb=b.toLowerCase();
            if (aa === "sol.json" && bb !== "sol.json") return -1;
            if (aa !== "sol.json" && bb === "sol.json") return 1;
            return aa.localeCompare(bb);
        });
    if (systemFiles.length === 0) throw new Error(`No JSON systems found in ${SYSTEMS_DIR}`);
}

function normalizeBody(name, raw) {
    const o = raw.orbit || {};
    return {
        name,
        symbol: String(raw.symbol || "?").charAt(0),
        parent: raw.parent ?? null,
        description: String(raw.description || ""),
        physical: raw.physical && typeof raw.physical === "object" ? raw.physical : {},
        orbitType: String(o.type || (Number(o.e) > 1 ? "hyperbolic" : "elliptic")).toLowerCase(),
        a: Number(o.a ?? 0),
        e: Number(o.e ?? 0),
        period: Number(o.period ?? 1),
        inclination: Number(o.inclination ?? 0) * DEG,
        node: Number(o.node ?? 0) * DEG,
        argPeriapsis: Number(o.argPeriapsis ?? 0) * DEG,
        meanAnomaly: Number(o.meanAnomaly ?? 0) * DEG
    };
}

function normalizeSystem(raw) {
    const result = {name:String(raw.name||"Unnamed System"),description:String(raw.description||""),bodies:{}};
    for (const [name, body] of Object.entries(raw.bodies || {})) result.bodies[name] = normalizeBody(name, body);
    return result;
}

function validateBodies() {
    const names=Object.keys(bodies);
    if (!names.length) throw new Error(`System "${currentSystem?.name || "unknown"}" contains no bodies.`);
    for (const [name,b] of Object.entries(bodies)) {
        if (b.parent !== null) {
            if (typeof b.parent !== "string") throw new Error(`${name}: parent must be a string or null.`);
            if (!bodies[b.parent]) throw new Error(`${name}: parent "${b.parent}" does not exist.`);
            if (!Number.isFinite(b.a) || b.a === 0) throw new Error(`${name}: a cannot be 0.`);
            if (!Number.isFinite(b.e) || b.e < 0) throw new Error(`${name}: e must be >= 0.`);
            if (b.e === 1) throw new Error(`${name}: parabolic trajectories are not supported; use e < 1 or e > 1.`);
            if (b.e < 1 && b.a <= 0) throw new Error(`${name}: elliptical orbits require a > 0.`);
            if (b.e > 1 && b.a >= 0) throw new Error(`${name}: hyperbolic orbits require a < 0.`);
            if (!Number.isFinite(b.period) || b.period <= 0) throw new Error(`${name}: period must be > 0.`);
        }
        if (!b.symbol) throw new Error(`${name}: missing symbol.`);
    }
    for (const name of names) {
        const seen=new Set(); let cur=name;
        while (cur !== null && bodies[cur]) {
            if (seen.has(cur)) throw new Error(`Circular parent relationship involving "${name}".`);
            seen.add(cur); cur=bodies[cur].parent;
        }
    }
}

function loadSystem(index) {
    if (!systemFiles.length) throw new Error("No system files are available.");
    index=((index%systemFiles.length)+systemFiles.length)%systemFiles.length;
    const filename=systemFiles[index], filepath=path.join(SYSTEMS_DIR,filename);
    let raw;
    try { raw=JSON.parse(fs.readFileSync(filepath,"utf8")); }
    catch(e){ throw new Error(`Could not load ${filename}: ${e.message}`); }
    currentSystem=normalizeSystem(raw);
    bodies=currentSystem.bodies;
    validateBodies();
    currentSystemIndex=index;
    const roots=Object.keys(bodies).filter(n=>bodies[n].parent===null);
    cameraTarget=roots[0] || Object.keys(bodies)[0] || null;
    if (!cameraTarget) throw new Error(`System "${filename}" has no focusable bodies.`);
    simTime=0; paused=false; showDataTable=false; autoFit();
}

function switchSystem(){ if(systemFiles.length>1) loadSystem(currentSystemIndex+1); }
function getChildren(parent){return Object.keys(bodies).filter(n=>bodies[n].parent===parent);}
function getFocusList(){return Object.keys(bodies);}
function cycleFocus(){const l=getFocusList();if(!l.length)return;let i=l.indexOf(cameraTarget);if(i<0)i=0;cameraTarget=l[(i+1)%l.length];autoFit();}
function focusByIndex(i){const l=getFocusList();if(i>=0&&i<l.length){cameraTarget=l[i];autoFit();}}

function solveEllipticKepler(M,e){
    M=normalizeAngle(M); let E=e<0.8?M:Math.PI;
    for(let i=0;i<30;i++){const f=E-e*Math.sin(E)-M,fp=1-e*Math.cos(E),d=f/fp;E-=d;if(Math.abs(d)<1e-12)break;}
    return E;
}
function solveHyperbolicKepler(M,e){
    let H=Math.asinh(M/e);
    for(let i=0;i<40;i++){const sh=Math.sinh(H),ch=Math.cosh(H),f=e*sh-H-M,fp=e*ch-1,d=f/fp;H-=d;if(Math.abs(d)<1e-12)break;}
    return H;
}
function orbitalPlaneTo3D(x,y,b){let p={x,y,z:0};p=rotateZ(p,b.argPeriapsis);p=rotateX(p,b.inclination);p=rotateZ(p,b.node);return p;}
function localOrbitPosition(b,time){
    if(b.parent===null)return{x:0,y:0,z:0};
    if(b.orbitType==="hyperbolic"||b.e>1){
        const a=Math.abs(b.a),M=b.meanAnomaly+(TAU/b.period)*time,H=solveHyperbolicKepler(M,b.e);
        return orbitalPlaneTo3D(a*(b.e-Math.cosh(H)),a*Math.sqrt(b.e*b.e-1)*Math.sinh(H),b);
    }
    const M=b.meanAnomaly+(TAU/b.period)*time,E=solveEllipticKepler(M,b.e),c=Math.cos(E),s=Math.sin(E),den=1-b.e*c;
    const r=b.a*den,cosNu=(c-b.e)/den,sinNu=Math.sqrt(1-b.e*b.e)*s/den,nu=Math.atan2(sinNu,cosNu);
    return orbitalPlaneTo3D(r*Math.cos(nu),r*Math.sin(nu),b);
}
function orbitPosition(b,time){
    if(!b||b.parent===null)return{x:0,y:0,z:0};
    const p=bodies[b.parent]; if(!p)throw new Error(`Missing parent "${b.parent}".`);
    return add(orbitPosition(p,time),localOrbitPosition(b,time));
}
function getBodyPosition(name){const b=bodies[name];return b?orbitPosition(b,simTime):{x:0,y:0,z:0};}

function createCanvas(){const w=Math.max(1,getTerminalWidth()-1),h=Math.max(1,getTerminalHeight()-1);return Array.from({length:h},()=>new Array(w).fill(" "));}
function getViewport(canvas){const h=canvas.length,w=canvas[0]?.length||0,top=Math.min(VIEW_TOP,h-1),bottom=Math.max(top,h-VIEW_BOTTOM-1);return{width:w,height:Math.max(1,bottom-top+1),top,bottom,centerX:(w-1)/2,centerY:(top+bottom)/2};}
function inViewport(canvas,x,y){if(!Array.isArray(canvas)||!canvas.length)return false;const v=getViewport(canvas);return x>=0&&x<v.width&&y>=v.top&&y<=v.bottom;}
function put(canvas,x,y,ch){x=Math.floor(x);y=Math.floor(y);if(!inViewport(canvas,x,y))return;const row=canvas[y];if(!Array.isArray(row)||x<0||x>=row.length)return;row[x]=String(ch??" ").charAt(0)||" ";}
function overlay(canvas,x,y,ch){x=Math.floor(x);y=Math.floor(y);if(y<0||y>=canvas.length)return;const row=canvas[y];if(!Array.isArray(row)||x<0||x>=row.length)return;row[x]=String(ch??" ").charAt(0)||" ";}
function text(canvas,x,y,s){s=String(s??"");for(let i=0;i<s.length;i++)overlay(canvas,x+i,y,s[i]);}

function getFitRadius(b){
    if(!b||b.parent===null)return 0;
    if(b.orbitType==="hyperbolic"||b.e>1){
        const a=Math.abs(b.a),limit=Math.acos(-1/b.e)*0.72;let max=0;
        for(let i=0;i<=40;i++){const nu=-limit+2*limit*i/40,d=1+b.e*Math.cos(nu);if(d<=0)continue;const r=a*(b.e*b.e-1)/d;if(Number.isFinite(r))max=Math.max(max,r);}
        return Math.max(max,a*(b.e-1));
    }
    return b.a*(1+b.e);
}
function largestChildOrbit(){let m=0;for(const n of getChildren(cameraTarget)){const b=bodies[n];if(b)m=Math.max(m,getFitRadius(b));}return m;}
function getScreenScale(canvas){const v=getViewport(canvas),r=largestChildOrbit();if(r<=0)return Math.min(v.width,v.height)*0.35*zoom;return Math.min(v.width,v.height)*0.35/r*zoom;}
function autoFit(){const w=getTerminalWidth()-1,h=getTerminalHeight()-1,vh=Math.max(1,h-VIEW_TOP-VIEW_BOTTOM),r=largestChildOrbit();if(r<=0){zoom=1;return;}zoom=clamp(Math.min(w,vh)*0.035/r,MIN_ZOOM,MAX_ZOOM);}
function childOrbitVisible(canvas,name){const b=bodies[name];return !!b&&b.parent===cameraTarget&&getFitRadius(b)*getScreenScale(canvas)>=2;}
function worldToScreen(p,cam,canvas){const v=getViewport(canvas),s=getScreenScale(canvas);return{x:v.centerX+(p.x-cam.x)*s,y:v.centerY-(p.y-cam.y)*s*TERMINAL_ASPECT};}

function drawEllipticOrbit(canvas,b,cx,cy,scale){for(let i=0;i<360;i++){const E=TAU*i/360,x=b.a*(Math.cos(E)-b.e),y=b.a*Math.sqrt(1-b.e*b.e)*Math.sin(E),p=orbitalPlaneTo3D(x,y,b);put(canvas,cx+p.x*scale,cy-p.y*scale*TERMINAL_ASPECT,".");}}
function drawHyperbolicOrbit(canvas,b,cx,cy,scale){const e=b.e,a=Math.abs(b.a),limit=Math.acos(-1/e)*0.92,samples=320;for(let i=0;i<=samples;i++){const nu=-limit+2*limit*i/samples,d=1+e*Math.cos(nu);if(d<=0)continue;const r=a*(e*e-1)/d;if(!Number.isFinite(r))continue;const p=orbitalPlaneTo3D(r*Math.cos(nu),r*Math.sin(nu),b);put(canvas,cx+p.x*scale,cy-p.y*scale*TERMINAL_ASPECT,".");}}
function drawChildOrbit(canvas,name,cx,cy){const b=bodies[name];if(!b||!childOrbitVisible(canvas,name))return;const s=getScreenScale(canvas);if(b.orbitType==="hyperbolic"||b.e>1)drawHyperbolicOrbit(canvas,b,cx,cy,s);else drawEllipticOrbit(canvas,b,cx,cy,s);}
function drawIcon(canvas,name,x,y){const b=bodies[name];if(b)put(canvas,x,y,b.symbol);}
function drawChild(canvas,name,cx,cy){const b=bodies[name];if(!b||!childOrbitVisible(canvas,name))return;if(showOrbits)drawChildOrbit(canvas,name,cx,cy);const s=getScreenScale(canvas),p=localOrbitPosition(b,simTime);drawIcon(canvas,name,cx+p.x*s,cy-p.y*s*TERMINAL_ASPECT);}
function drawFocusedSystem(canvas){if(!cameraTarget||!bodies[cameraTarget])return;const v=getViewport(canvas),cx=v.centerX,cy=v.centerY;drawIcon(canvas,cameraTarget,cx,cy);for(const child of getChildren(cameraTarget))drawChild(canvas,child,cx,cy);}

function drawBox(canvas,x,y,w,h){if(w<4||h<3)return;const r=x+w-1,b=y+h-1;for(let px=x;px<=r;px++){overlay(canvas,px,y,px===x||px===r?"":"");overlay(canvas,px,b,px===x||px===r?"":"");}for(let py=y+1;py<b;py++){overlay(canvas,x,py,"|");overlay(canvas,r,py,"|");}}
function wrapText(s,w){const words=String(s).split(/\s+/),lines=[];let line="";for(const word of words){if(!line)line=word;else if(line.length+1+word.length<=w)line+=" "+word;else{lines.push(line);line=word;}}if(line)lines.push(line);return lines;}
function drawDataTable(canvas){if(!showDataTable||!cameraTarget)return;const b=bodies[cameraTarget];if(!b)return;const v=getViewport(canvas),tw=Math.min(38,Math.max(24,Math.floor(v.width*0.34))),x=Math.max(0,v.width-tw),y=v.top,h=v.height;drawBox(canvas,x,y,tw,h);let row=y+1;const w=tw-4;text(canvas,x+2,row++,b.name);row++;text(canvas,x+2,row++,"ORBITAL");for(const [k,val] of [["Type",b.orbitType],["a",b.a],["e",b.e],["Period",b.period],["Inclination",`${(b.inclination/DEG).toFixed(3)} deg`],["Node",`${(b.node/DEG).toFixed(3)} deg`],["Arg periapsis",`${(b.argPeriapsis/DEG).toFixed(3)} deg`]]){if(row>=v.bottom-2)break;text(canvas,x+2,row++,`${k}: ${val}`);}if(row<v.bottom-3){row++;text(canvas,x+2,row++,"PHYSICAL");for(const[k,val]of Object.entries(b.physical)){if(row>=v.bottom-2)break;for(const line of wrapText(`${k}: ${val}`,w)){if(row>=v.bottom-2)break;text(canvas,x+2,row++,line);}}}if(b.description&&row<v.bottom-2){row++;text(canvas,x+2,row++,"DESCRIPTION");for(const line of wrapText(b.description,w)){if(row>=v.bottom-1)break;text(canvas,x+2,row++,line);}}}
function formatWarp(v){return Number(v).toLocaleString();}
function formatDays(days){if(!Number.isFinite(days)) return "0 days"; const abs = Math.abs(days); if (abs < 365.25){ return `${days.toFixed(2)}d`;} const years = Math.floor(days / 365.25); return String(years) + "y, " + String((days % 365.25).toFixed(2)) + "d"}
function drawHUD(canvas){const h=canvas.length;const lines=[currentSystem?.name||"UNKNOWN SYSTEM",paused?"PAUSED":"RUNNING",`T+ ` + formatDays(simTime),`WARP ${formatWarp(timewarp)} day/s`,`ZOOM ${zoom.toFixed(3)}x`,`FOCUS ${cameraTarget||"NO FOCUS"}`,`SYSTEM ${currentSystemIndex+1}/${systemFiles.length}${showDataTable?" | DATA":""}`];for(let i=0;i<Math.min(VIEW_TOP,lines.length);i++)text(canvas,1,i,lines[i]);text(canvas,1,h-2,"UP/DOWN Zoom | LEFT/RIGHT Warp | SPACE Pause | F Focus");text(canvas,1,h-1,"S System | T Data | R Orbits | F Focus | BACKSPACE Exit");}
function drawScale(canvas){const v=getViewport(canvas);if(v.width<25||v.height<5)return;const bar=Math.min(12,v.width-4),y=v.bottom-1,x=2;text(canvas,x,y-1,"");for(let i=0;i<=bar;i++)overlay(canvas,x+i,y,i===0||i===bar?"":"");}
function outputCanvas(canvas){let out="\x1b[H",max=getTerminalWidth()-1;for(const row of canvas){out+="\x1b[2K"+row.join("").slice(0,max)+"\r\n";}out+="\x1b[J";process.stdout.write(out);}
function render(){const canvas=createCanvas();drawFocusedSystem(canvas);drawDataTable(canvas);drawHUD(canvas);drawScale(canvas);outputCanvas(canvas);}

function increaseZoom(){zoom=clamp(zoom*ZOOM_FACTOR,MIN_ZOOM,MAX_ZOOM);}
function decreaseZoom(){zoom=clamp(zoom/ZOOM_FACTOR,MIN_ZOOM,MAX_ZOOM);}
function increaseTimewarp(){if(timewarpIndex<TIME_WARPS.length-1)timewarpIndex++;timewarp=TIME_WARPS[timewarpIndex];}
function decreaseTimewarp(){if(timewarpIndex>0)timewarpIndex--;timewarp=TIME_WARPS[timewarpIndex];}

function handleKey(str,key){
    if(!key)return;
    if(key.ctrl&&key.name==="c")return quit();
    if(key.name==="backspace"||str==="\x7f")return quit();
    if(key.name==="escape")return quit();
    if(key.name==="space"){paused=!paused;return;}
    if(key.name==="up"){increaseZoom();return;}
    if(key.name==="down"){decreaseZoom();return;}
    if(key.name==="right"){increaseTimewarp();return;}
    if(key.name==="left"){decreaseTimewarp();return;}
    const s=(str||"").toLowerCase();
    if(s==="f"){cycleFocus();return;}
    if(s==="s"){switchSystem();return;}
    if(s==="t"){showDataTable=!showDataTable;return;}
    if(s==="r"){showOrbits=!showOrbits;return;}
}
function update(){if(!running)return;const now=Date.now(),dt=Math.min((now-lastUpdate)/1000,0.25);lastUpdate=now;if(!paused)simTime+=dt*timewarp;render();setTimeout(update,1000/FPS);}
function quit(){if(!running)return;running=false;if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdout.write("\x1b[?25h\x1b[?7h\x1b[2J\x1b[H");process.exit(0);}

readline.emitKeypressEvents(process.stdin);
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdin.on("keypress",handleKey);
process.on("SIGINT",quit);
process.on("exit",()=>{if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdout.write("\x1b[?25h\x1b[?7h");});

discoverSystems();
loadSystem(0);
process.stdout.write("\x1b[2J\x1b[H\x1b[?25l\x1b[?7l");
update();
