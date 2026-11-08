'use strict';
const $=id=>document.getElementById(id);
const state={items:[]};
const allowed=/\.(mp3|m4a|aac|wav|flac|ogg|opus|wma|aiff?|alac|zip|rar|7z)$/i;
const PARALLEL_TRANSFERS=4;
let nextId=1;
function format(bytes){if(!bytes)return'0 B';const units=['B','KB','MB','GB','TB'];const i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),4);return`${(bytes/1024**i).toFixed(i?1:0)} ${units[i]}`;}
function escapeHtml(value){const span=document.createElement('span');span.textContent=value;return span.innerHTML;}
function updateSummary(){$('summary').textContent=state.items.length?`${state.items.length} files · ${format(state.items.reduce((total,item)=>total+item.file.size,0))} · up to ${PARALLEL_TRANSFERS} at once`:'No files yet';}
function render(){
  updateSummary();const list=$('queueList');
  if(!state.items.length){list.innerHTML='<p class="empty">Your selected music will appear here.</p>';return;}
  list.innerHTML=state.items.map(item=>`<div class="item" data-item-id="${item.id}"><div><div class="item-name">${escapeHtml(item.file.webkitRelativePath||item.file.name)}</div><small class="item-message">${escapeHtml(item.message||'Waiting')}</small><div class="bar"><i class="item-progress" style="width:${item.progress}%"></i></div></div><span class="badge item-status">${escapeHtml(item.status)}</span><span class="size">${format(item.file.size)}</span></div>`).join('');
}
function updateItem(item){const row=document.querySelector(`[data-item-id="${item.id}"]`);if(!row)return;row.querySelector('.item-message').textContent=item.message;row.querySelector('.item-status').textContent=item.status;row.querySelector('.item-progress').style.width=`${item.progress}%`;}
async function upload(item){
  for(;;){
    item.status='sending';item.message='Streaming through Render to the USB';updateItem(item);
    let lastPaint=0;
    const result=await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('PUT','/api/uploads');xhr.setRequestHeader('X-File-Name',encodeURIComponent(item.file.name));xhr.setRequestHeader('X-Relative-Path',encodeURIComponent(item.file.webkitRelativePath||item.file.name));xhr.setRequestHeader('X-File-Size',String(item.file.size));xhr.setRequestHeader('Content-Type',item.file.type||'application/octet-stream');xhr.upload.onprogress=event=>{if(!event.lengthComputable)return;item.progress=Math.round(event.loaded/event.total*100);const now=performance.now();if(now-lastPaint>150||item.progress===100){lastPaint=now;updateItem(item);}};xhr.onload=()=>resolve({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,error:(()=>{try{return JSON.parse(xhr.responseText||'{}').error;}catch{return'';}})()});xhr.onerror=()=>resolve({ok:false,status:0,error:'Network connection was lost.'});xhr.send(item.file);});
    if(result.ok){item.progress=100;item.status='on usb';item.message='Copied and checksum matched';updateItem(item);return;}
    if(result.status===409||result.status===502||result.status===503||result.status===504||result.status===0){item.progress=0;item.status='waiting';item.message='Waiting for your PC receiver and USB';updateItem(item);await new Promise(resolve=>setTimeout(resolve,1000));continue;}
    throw new Error(result.error||`Transfer failed (${result.status})`);
  }
}
async function addFiles(fileList){
  const files=[...fileList].filter(file=>allowed.test(file.name)),rejected=fileList.length-files.length;
  if(rejected)alert(`${rejected} unsupported file(s) were skipped.`);
  const additions=files.map(file=>({id:nextId++,file,status:'waiting',message:'Ready to upload',progress:0,active:false}));state.items.push(...additions);render();
  const workers=Array.from({length:Math.min(PARALLEL_TRANSFERS,additions.length)},async()=>{for(;;){const item=additions.find(candidate=>!candidate.active&&candidate.status==='waiting');if(!item)return;item.active=true;try{await upload(item);}catch(error){item.status='failed';item.message=error.message;updateItem(item);}}});
  await Promise.all(workers);
}
['dragenter','dragover'].forEach(type=>$('dropZone').addEventListener(type,event=>{event.preventDefault();$('dropZone').classList.add('drag');}));
['dragleave','drop'].forEach(type=>$('dropZone').addEventListener(type,event=>{event.preventDefault();$('dropZone').classList.remove('drag');}));
$('dropZone').addEventListener('drop',event=>addFiles(event.dataTransfer.files));
$('chooseFiles').addEventListener('click',()=>$('filePicker').click());
$('chooseFolder').addEventListener('click',()=>$('folderPicker').click());
$('filePicker').addEventListener('change',event=>addFiles(event.target.files));
$('folderPicker').addEventListener('change',event=>addFiles(event.target.files));
