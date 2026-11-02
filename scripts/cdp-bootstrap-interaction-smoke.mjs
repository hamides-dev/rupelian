import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {connectPlayer} from './cdp-connection.mjs';

const executable=resolve(process.argv[2]);
process.env.LINGO_CDP_PORT ||= '9238';
const port=process.env.LINGO_CDP_PORT;
assert.equal(await fetch(`http://127.0.0.1:${port}/json`).then(()=>true,()=>false),false,'Use an unoccupied test port');
const directory=await mkdtemp(join(tmpdir(),'lingo-loader-interaction-'));
const bitmap=join(directory,'loading.bmp');
const child=spawn(executable,[],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`,WEBVIEW2_USER_DATA_FOLDER:join(directory,'webview'),
  LINGO_CINEMA_DATA_DIR:directory,LINGO_BOOTSTRAP_TRACE:'1',LINGO_BOOTSTRAP_TEST_DELAY_MS:'10000',LINGO_BOOTSTRAP_TEST_IMAGE:bitmap}});
const exited=new Promise(resolve=>child.once('exit',resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let log='',player;
child.stderr.on('data',data=>{log+=data;});
try {
  const deadline=Date.now()+40000;
  while(!log.includes('LINGO_BOOTSTRAP_PAINT')&&Date.now()<deadline) await delay(20);
  assert.ok(log.includes('LINGO_BOOTSTRAP_PAINT'),'The loading window never painted');
  const image=await readFile(bitmap);
  const width=image.readInt32LE(18),height=Math.abs(image.readInt32LE(22)),offset=image.readUInt32LE(10);
  // The former 60px title bar is now exactly the same surface as the body.
  for(let y=0;y<Math.floor(height*60/720);y++) for(let x=0;x<width;x++) {
    const pixel=offset+(y*width+x)*4;
    assert.equal(image.readUIntLE(pixel,3),0x0b0b0c,'The loading screen still has top-bar pixels');
  }
  const probe=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/bootstrap-window-probe.ps1','-ProcessId',String(child.pid)],{windowsHide:true,timeout:9000});
  const native=JSON.parse(probe.stdout);
  while(!player&&Date.now()<deadline){player=await connectPlayer().catch(()=>null);if(!player)await delay(50);}
  assert.ok(player,`Player failed to initialize while minimized: ${log.slice(-2000)}`);
  while(!await player.evaluate('Boolean(window.__LINGO_STARTUP__?.nativeWindowShownAt)').catch(()=>false)&&Date.now()<deadline)await delay(50);
  assert.equal(await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized',{label:'main'})`),true,'Handoff unexpectedly restored the player');
  const timeOrigin=await player.evaluate('performance.timeOrigin');
  const restoredAt=Date.now();
  const second=spawn(executable,[],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,LINGO_BOOTSTRAP_TRACE:'1'}});
  let secondLog='';second.stderr.on('data',data=>{secondLog+=data;});
  const secondExit=new Promise(resolve=>second.once('exit',resolve));
  while(await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized',{label:'main'})`)&&Date.now()<deadline)await delay(20);
  const restoreMs=Date.now()-restoredAt;
  assert.equal(await Promise.race([secondExit,delay(10000).then(()=>{second.kill();return 'timeout';})]),0);
  assert.ok(!secondLog.includes('LINGO_BOOTSTRAP_PAINT'),'Restore opened a fresh loading window');
  assert.equal(await player.evaluate('performance.timeOrigin'),timeOrigin,'Restoring reloaded the player');
  assert.equal(await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|is_minimized',{label:'main'})`),false);
  const size=await player.evaluate('({width:innerWidth,height:innerHeight})');
  assert.deepEqual(size,{width:1180,height:720});
  const position=await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|inner_position',{label:'main'})`);
  assert.ok(Math.abs(position.x-native.moved.Left)<=1&&Math.abs(position.y-native.moved.Top)<=1,
    `Restoring lost the moved loading-window position: ${JSON.stringify({position,expected:native.moved})}`);
  const report={passed:true,headerAbsent:true,native,stayedMinimizedDuringHandoff:true,restoredWithoutReload:true,restoreMs,size,position,bitmap};
  console.log(JSON.stringify(report,null,2));
  if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(report,null,2)+'\n');
} finally {
  if(player){await player.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})`).catch(()=>{});player.close();}
  await Promise.race([exited,delay(5000)]);
  if(child.exitCode===null)child.kill();
}
