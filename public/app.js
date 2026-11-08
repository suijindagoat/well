'use strict';
const $=id=>document.getElementById(id);
const state={items:[]};
const allowed=/\.(mp3|m4a|aac|wav|flac|ogg|opus|wma|aiff?|alac|zip|rar|7z)$/i;
const PARALLEL_TRANSFERS=4;
const MAX_VISIBLE_ITEMS=250;
let nextId=1;
let running=0;
function format(bytes){if(!bytes)return'0 B';const units=['B','KB','MB','GB','TB'];const i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),4);return`${(bytes/1024**i).toFixed(i?1:0)} ${units[i]}`;}
function escapeHtml(value){const span=document.createElement('span');span.textContent=value;return span.innerHTML;}
function updateSummary(){const done=state.items.filter(item=>item.status==='on usb').length;$('summary').textContent=state.items.length?`${state.items.length} files · ${format(state.items.reduce((total,item)=>total+item.file.size,0))} · ${done} copied · up to ${PARALLEL_TRANSFERS} at once`:'No files yet';}
function render(){
  updateSummary();const list=$('queueList');
  if(!state.items.length){list.innerHTML='<p class="empty">Your selected music will appear here.</p>';return;}
  const active=state.items.filter(item=>item.active),waiting=state.items.filter(item=>!item.active&&item.status==='waiting').slice(0,Math.max(0,MAX_VISIBLE_ITEMS-active.length-20)),recent=state.items.filter(item=>item.status==='on usb'||item.status==='failed').slice(-20).reverse(),visible=[...new Map([...active,...waiting,...recent].map(item=>[item.id,item])).values()];
  list.innerHTML=visible.map(item=>`<div class="item" data-item-id="${item.id}"><div><div class="item-name">${escapeHtml(item.file.webkitRelativePath||item.file.name)}</div><small class="item-message">${escapeHtml(item.message||'Waiting')}</small><div class="bar"><i class="item-progress" style="width:${item.progress}%"></i></div></div><span class="badge item-status">${escapeHtml(item.status)}</span><span class="size">${format(item.file.size)}</span></div>`).join('')+(state.items.length>visible.length?`<p class="empty">Showing active, next, and recent files. All ${state.items.length} remain queued.</p>`:'');
}
function updateItem(item){const row=document.querySelector(`[data-item-id="${item.id}"]`);if(!row)return;row.querySelector('.item-message').textContent=item.message;row.querySelector('.item-status').textContent=item.status;row.querySelector('.item-progress').style.width=`${item.progress}%`;}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function waitForNetwork(){if(navigator.onLine)return;await new Promise(resolve=>window.addEventListener('online',resolve,{once:true}));}
async function upload(item){
  let retryMs=1000;
  for(;;){
    item.status='sending';item.message='Streaming through Render to the USB';updateItem(item);
    let lastPaint=0;
    const result=await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('PUT','/api/uploads');xhr.setRequestHeader('X-File-Name',encodeURIComponent(item.file.name));xhr.setRequestHeader('X-Relative-Path',encodeURIComponent(item.file.webkitRelativePath||item.file.name));xhr.setRequestHeader('X-File-Size',String(item.file.size));xhr.setRequestHeader('Content-Type',item.file.type||'application/octet-stream');xhr.upload.onprogress=event=>{if(!event.lengthComputable)return;item.progress=Math.round(event.loaded/event.total*100);const now=performance.now();if(now-lastPaint>150||item.progress===100){lastPaint=now;updateItem(item);}};xhr.onload=()=>resolve({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,error:(()=>{try{return JSON.parse(xhr.responseText||'{}').error;}catch{return'';}})()});xhr.onerror=()=>resolve({ok:false,status:0,error:'Network connection was lost.'});xhr.send(item.file);});
    if(result.ok){item.progress=100;item.status='on usb';item.message='Copied and checksum matched';updateItem(item);return;}
    if(result.status===409||result.status===502||result.status===503||result.status===504||result.status===0){item.progress=0;item.status='waiting';item.message=navigator.onLine?'Connection interrupted — retrying automatically':'Offline — queued until the network returns';updateItem(item);await waitForNetwork();await sleep(retryMs);retryMs=Math.min(Math.round(retryMs*1.5),10000);continue;}
    throw new Error(result.error||`Transfer failed (${result.status})`);
  }
}
function pump(){
  while(running<PARALLEL_TRANSFERS){
    const item=state.items.find(candidate=>!candidate.active&&candidate.status==='waiting');if(!item)return;
    item.active=true;running++;upload(item).catch(error=>{item.status='failed';item.message=error.message;updateItem(item);}).finally(()=>{item.active=false;running--;render();pump();});
  }
}
async function addFiles(fileList){
  const files=[...fileList].filter(file=>allowed.test(file.name)),rejected=fileList.length-files.length;
  if(rejected)alert(`${rejected} unsupported file(s) were skipped.`);
  const additions=files.map(file=>({id:nextId++,file,status:'waiting',message:'Ready to upload',progress:0,active:false}));state.items.push(...additions);render();
  pump();
}
['dragenter','dragover'].forEach(type=>$('dropZone').addEventListener(type,event=>{event.preventDefault();$('dropZone').classList.add('drag');}));
['dragleave','drop'].forEach(type=>$('dropZone').addEventListener(type,event=>{event.preventDefault();$('dropZone').classList.remove('drag');}));
$('dropZone').addEventListener('drop',event=>addFiles(event.dataTransfer.files));
$('chooseFiles').addEventListener('click',()=>$('filePicker').click());
$('chooseFolder').addEventListener('click',()=>$('folderPicker').click());
$('filePicker').addEventListener('change',event=>addFiles(event.target.files));
$('folderPicker').addEventListener('change',event=>addFiles(event.target.files));
window.addEventListener('beforeunload',event=>{if(state.items.some(item=>item.status==='waiting'||item.status==='sending')){event.preventDefault();event.returnValue='';}});
