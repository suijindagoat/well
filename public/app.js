'use strict';
const $=id=>document.getElementById(id);
const state={items:[]};
const allowed=/\.(mp3|m4a|aac|wav|flac|ogg|opus|wma|aiff?|alac|zip|rar|7z)$/i;
function format(bytes){if(!bytes)return'0 B';const units=['B','KB','MB','GB','TB'];const i=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),4);return`${(bytes/1024**i).toFixed(i?1:0)} ${units[i]}`;}
function escapeHtml(value){const span=document.createElement('span');span.textContent=value;return span.innerHTML;}
function render(){
  const list=$('queueList');$('summary').textContent=state.items.length?`${state.items.length} file${state.items.length===1?'':'s'} · ${format(state.items.reduce((n,x)=>n+x.file.size,0))}`:'No files yet';
  if(!state.items.length){list.innerHTML='<p class="empty">Your selected music will appear here.</p>';return;}
  list.innerHTML=state.items.map((x,i)=>`<div class="item"><div><div class="item-name">${escapeHtml(x.file.webkitRelativePath||x.file.name)}</div><small>${escapeHtml(x.message||'Waiting')}</small><div class="bar"><i style="width:${x.progress}%"></i></div></div><span class="badge">${escapeHtml(x.status)}</span><span class="size">${format(x.file.size)}</span></div>`).join('');
}
async function upload(item){
  for(;;){
    item.status='sending';item.message='Streaming through Render to the USB';render();
    const result=await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('PUT','/api/uploads');xhr.setRequestHeader('X-File-Name',encodeURIComponent(item.file.name));xhr.setRequestHeader('X-Relative-Path',encodeURIComponent(item.file.webkitRelativePath||item.file.name));xhr.setRequestHeader('X-File-Size',String(item.file.size));xhr.setRequestHeader('Content-Type',item.file.type||'application/octet-stream');xhr.upload.onprogress=e=>{if(e.lengthComputable){item.progress=Math.round(e.loaded/e.total*100);render();}};xhr.onload=()=>resolve({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,error:(()=>{try{return JSON.parse(xhr.responseText||'{}').error;}catch{return'';}})()});xhr.onerror=()=>resolve({ok:false,status:0,error:'Network connection was lost.'});xhr.send(item.file);});
    if(result.ok){item.progress=100;item.status='on usb';item.message='Copied and checksum verified';render();return;}
    if(result.status===409||result.status===502||result.status===503||result.status===504||result.status===0){item.progress=0;item.status='waiting';item.message='Waiting for your PC receiver and USB';render();await new Promise(r=>setTimeout(r,3000));continue;}
    throw new Error(result.error||`Transfer failed (${result.status})`);
  }
}
async function addFiles(fileList){
  const files=[...fileList].filter(file=>allowed.test(file.name));const rejected=fileList.length-files.length;if(rejected)alert(`${rejected} unsupported file(s) were skipped.`);
  const additions=files.map(file=>({file,status:'waiting',message:'Ready to upload',progress:0}));state.items.push(...additions);render();
  const workers=Array.from({length:Math.min(1,additions.length)},async()=>{while(true){const item=additions.find(x=>x.status==='waiting'&&!x.active);if(!item)return;item.active=true;try{await upload(item);}catch(error){item.status='failed';item.message=error.message;render();}}});await Promise.all(workers);
}
['dragenter','dragover'].forEach(type=>$('dropZone').addEventListener(type,e=>{e.preventDefault();$('dropZone').classList.add('drag');}));
['dragleave','drop'].forEach(type=>$('dropZone').addEventListener(type,e=>{e.preventDefault();$('dropZone').classList.remove('drag');}));
$('dropZone').addEventListener('drop',e=>addFiles(e.dataTransfer.files));$('chooseFiles').addEventListener('click',()=> $('filePicker').click());$('chooseFolder').addEventListener('click',()=> $('folderPicker').click());$('filePicker').addEventListener('change',e=>addFiles(e.target.files));$('folderPicker').addEventListener('change',e=>addFiles(e.target.files));
