import assert from 'node:assert/strict';
import { connectPlayer } from './cdp-connection.mjs';
const player = await connectPlayer();
const path = process.argv[2];
const videoUrl = process.env.LINGO_YOUTUBE_TEST_URL || 'https://www.youtube.com/watch?v=NHQH5Y_zW_E';
const allowAuthBlock = process.env.LINGO_ALLOW_YOUTUBE_AUTH_BLOCK === '1';
if (!path) throw new Error('Pass a local video fixture path');
try {
  const deadline=Date.now()+20000;
  while (!await player.evaluate('Boolean(window.__TAURI_INTERNALS__ && window.openModal)').catch(()=>false)) {
    if(Date.now()>deadline) throw new Error('Packaged app did not initialize');
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  const result = await player.evaluate(`(async (path, videoUrl, allowAuthBlock) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const prop = (name, format = 'double') => invoke('plugin:libmpv|get_property', {name, format, windowLabel:'main'});
    const sleep = ms => new Promise(r => setTimeout(r,ms));
    const wait = async (test, label, ms=60000) => {
      const deadline=Date.now()+ms;
      while (!await Promise.resolve().then(test).catch(()=>false)) { if(Date.now()>deadline) throw new Error(label); await sleep(200); }
    };
    if (!location.hostname.includes('tauri')) throw new Error('Expected packaged frontend');
    const previousProgress=localStorage.getItem('playback-progress-v1');
    const previousSettings=localStorage.getItem('player-settings');
    await invoke('plugin:event|emit', {event:'tauri://drag-drop',payload:{paths:[path],position:{x:400,y:300}}});
    await sleep(400);
    if(!document.querySelector('#resume-dialog').classList.contains('hidden')) document.querySelector('#resume-start-over').click();
    await wait(async()=> String(await prop('path','string')).replaceAll('\\\\','/')===path.replaceAll('\\\\','/') && await prop('time-pos') > .3, 'local playback');
    const localDuration=await prop('duration');
    await invoke('plugin:libmpv|command', {name:'seek',args:[40,'absolute+exact'],windowLabel:'main'});
    await wait(async()=>Math.abs(await prop('time-pos')-40)<2, 'local seek');
    const preview=await invoke('prepare_local_preview',{path,seconds:17.321});
    const localProbe=await invoke('discover_embedded_subtitles',{path});
    document.querySelector('#setting-youtube-quality').value='720';
    document.querySelector('#setting-youtube-quality').dispatchEvent(new Event('change',{bubbles:true}));
    window.openModal('youtube-modal');
    document.querySelector('#yt-url-field').value=videoUrl;
    document.querySelector('#yt-find-button').click();
    await wait(()=>!document.querySelector('#yt-find-button').disabled,'YouTube lookup',90000);
    if(document.querySelector('#yt-play-button').disabled) {
      const error = document.querySelector('#yt-status').textContent;
      if(allowAuthBlock && /signed-in session/.test(error)) return {packagedOrigin:location.origin,localDuration,localSeek:true,preview:Boolean(preview),probe:Array.isArray(localProbe),youtubeBlocked:error};
      throw new Error(error);
    }
    document.querySelector('#yt-play-button').click();
    await sleep(400);
    if(!document.querySelector('#resume-dialog').classList.contains('hidden')) document.querySelector('#resume-start-over').click();
    await wait(async()=>String(await prop('path','string')).startsWith('http://127.0.0.1') && await prop('time-pos')>.2,'YouTube playback');
    const start=await prop('time-pos');
    await sleep(5000);
    const progress=await prop('time-pos')-start;
    const drift=await prop('avsync');
    const audio=await prop('aid','string');
    await invoke('plugin:libmpv|set_property',{name:'pause',value:true,windowLabel:'main'});
    if(previousProgress==null) localStorage.removeItem('playback-progress-v1'); else localStorage.setItem('playback-progress-v1',previousProgress);
    if(previousSettings==null) localStorage.removeItem('player-settings'); else localStorage.setItem('player-settings',previousSettings);
    return {packagedOrigin:location.origin,localDuration,localSeek:true,preview:Boolean(preview),probe:Array.isArray(localProbe),youtubeProgress:progress,avSync:drift,audio};
  })(${JSON.stringify(path)}, ${JSON.stringify(videoUrl)}, ${allowAuthBlock})`,180000);
  assert(result.localDuration>40 && result.preview && result.probe);
  if(!result.youtubeBlocked) assert(result.youtubeProgress>3 && Math.abs(result.avSync)<.15 && result.audio!=='no');
  console.log(JSON.stringify({passedLocal:true,passedYouTube:!result.youtubeBlocked,...result},null,2));
} finally { player.close(); }
