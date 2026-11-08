'use strict';

const $=id=>document.getElementById(id);
const state={items:[],mode:'p2p',direct:null,connecting:false,pairingCode:''};
const allowed=/\.(mp3|m4a|aac|wav|flac|ogg|opus|wma|aiff?|alac|zip|rar|7z)$/i;
const PARALLEL_TRANSFERS=4;
const MAX_VISIBLE_ITEMS=250;
const CHUNK_BYTES=64*1024;
const BATCH_BYTES=1024*1024;
let nextId=1,running=0,reconnectTimer;

function format(bytes){if(!bytes)return'0 B';const units=['B','KB','MB','GB','TB'];const index=Math.min(Math.floor(Math.log(bytes)/Math.log(1024)),4);return`${(bytes/1024**index).toFixed(index?1:0)} ${units[index]}`;}
function escapeHtml(value){const span=document.createElement('span');span.textContent=value;return span.innerHTML;}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function setConnection(text,className=''){$('connection').textContent=text;$('connection').className=`status ${className}`.trim();}
function pairingMessage(text,error=false){$('pairingMessage').textContent=text;$('pairingMessage').style.color=error?'#a52d15':'#4d5b24';}
function updateSummary(){const done=state.items.filter(item=>item.status==='on usb').length;$('summary').textContent=state.items.length?`${state.items.length} files · ${format(state.items.reduce((total,item)=>total+item.file.size,0))} · ${done} copied · up to ${PARALLEL_TRANSFERS} at once`:'No files yet';}
function render(){
  updateSummary();const list=$('queueList');
  if(!state.items.length){list.innerHTML='<p class="empty">Your selected music will appear here.</p>';return;}
  const active=state.items.filter(item=>item.active),waiting=state.items.filter(item=>!item.active&&item.status==='waiting').slice(0,Math.max(0,MAX_VISIBLE_ITEMS-active.length-20)),recent=state.items.filter(item=>item.status==='on usb'||item.status==='failed').slice(-20).reverse(),visible=[...new Map([...active,...waiting,...recent].map(item=>[item.id,item])).values()];
  list.innerHTML=visible.map(item=>`<div class="item" data-item-id="${item.id}"><div><div class="item-name">${escapeHtml(item.file.webkitRelativePath||item.file.name)}</div><small class="item-message">${escapeHtml(item.message||'Waiting')}</small><div class="bar"><i class="item-progress" style="width:${item.progress}%"></i></div></div><span class="badge item-status">${escapeHtml(item.status)}</span><span class="size">${format(item.file.size)}</span></div>`).join('')+(state.items.length>visible.length?`<p class="empty">Showing active, next, and recent files. All ${state.items.length} remain queued.</p>`:'');
}
function updateItem(item){const row=document.querySelector(`[data-item-id="${item.id}"]`);if(!row)return;row.querySelector('.item-message').textContent=item.message;row.querySelector('.item-status').textContent=item.status;row.querySelector('.item-progress').style.width=`${item.progress}%`;}
async function jsonFetch(url,options={}){const response=await fetch(url,options);let value={};try{value=await response.json();}catch{}if(!response.ok)throw new Error(value.error||`Request failed (${response.status})`);return value;}
function waitForIce(pc){if(pc.iceGatheringState==='complete')return Promise.resolve();return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pc.removeEventListener('icegatheringstatechange',check);reject(new Error('Could not discover a direct network route.'));},20_000);function check(){if(pc.iceGatheringState==='complete'){clearTimeout(timeout);pc.removeEventListener('icegatheringstatechange',check);resolve();}}pc.addEventListener('icegatheringstatechange',check);});}
function laneFor(channel){
  let pending=null,openResolve,openReject;const opened=new Promise((resolve,reject)=>{openResolve=resolve;openReject=reject;});
  const fail=message=>{const error=Object.assign(new Error(message),{connection:true});if(pending){clearTimeout(pending.timer);pending.reject(error);pending=null;}openReject(error);};
  channel.binaryType='arraybuffer';channel.bufferedAmountLowThreshold=512*1024;
  channel.onopen=()=>openResolve();channel.onclose=()=>fail('Direct P2P connection closed.');channel.onerror=()=>fail('Direct P2P channel failed.');
  channel.onmessage=event=>{let message;try{message=JSON.parse(event.data);}catch{return;}if(!pending||!pending.match(message))return;clearTimeout(pending.timer);const resolve=pending.resolve;pending=null;message.type==='file-error'?resolve(Promise.reject(new Error(message.error||'USB receiver rejected the file.'))):resolve(message);};
  async function request(value,match,timeoutMs=120_000){if(channel.readyState!=='open')throw Object.assign(new Error('Direct P2P connection is not open.'),{connection:true});if(pending)throw new Error('P2P lane is already waiting for a response.');return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending=null;reject(Object.assign(new Error('Direct receiver response timed out.'),{connection:true}));},timeoutMs);pending={resolve,reject,match,timer};channel.send(JSON.stringify(value));});}
  return{channel,opened,request,busy:false};
}
async function waitForBuffer(channel){if(channel.bufferedAmount<2*1024*1024)return;await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{cleanup();reject(Object.assign(new Error('Direct channel stopped draining.'),{connection:true}));},30_000);function cleanup(){clearTimeout(timeout);channel.removeEventListener('bufferedamountlow',ready);channel.removeEventListener('close',closed);}function ready(){cleanup();resolve();}function closed(){cleanup();reject(Object.assign(new Error('Direct P2P connection closed.'),{connection:true}));}channel.addEventListener('bufferedamountlow',ready,{once:true});channel.addEventListener('close',closed,{once:true});});}
async function p2pUpload(item,lane){
  const file=item.file,id=crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`,started=performance.now();
  item.status='sending';item.message='Direct P2P to your USB';updateItem(item);
  await lane.request({type:'file-start',id,name:file.name,relativePath:file.webkitRelativePath||file.name,size:file.size},message=>message.type==='file-ready'&&message.id===id);
  let offset=0,batch=0,lastPaint=0;
  while(offset<file.size){
    const batchEnd=Math.min(file.size,offset+BATCH_BYTES);
    while(offset<batchEnd){const end=Math.min(batchEnd,offset+CHUNK_BYTES),chunk=await file.slice(offset,end).arrayBuffer();await waitForBuffer(lane.channel);lane.channel.send(chunk);offset=end;const now=performance.now();if(now-lastPaint>150||offset===file.size){lastPaint=now;item.progress=file.size?Math.round(offset/file.size*100):100;const seconds=Math.max((now-started)/1000,.001),rate=offset/seconds;item.message=`Direct P2P · ${format(rate)}/s`;updateItem(item);}}
    batch++;await lane.request({type:'batch-end',id,batch},message=>message.type==='batch-ack'&&message.id===id&&message.batch===batch);
  }
  const result=await lane.request({type:'file-end',id},message=>(message.type==='file-complete'||message.type==='file-error')&&message.id===id);
  item.progress=100;item.status='on usb';item.message=`Direct P2P complete · ${String(result.sha256||'').slice(0,12)} verified`;updateItem(item);
}
async function relayUpload(item){
  let retryMs=1000;
  for(;;){
    item.status='sending';item.message='Relay fallback through Render';updateItem(item);let lastPaint=0;
    const result=await new Promise(resolve=>{const xhr=new XMLHttpRequest();xhr.open('PUT','/api/uploads');xhr.setRequestHeader('X-File-Name',encodeURIComponent(item.file.name));xhr.setRequestHeader('X-Relative-Path',encodeURIComponent(item.file.webkitRelativePath||item.file.name));xhr.setRequestHeader('X-File-Size',String(item.file.size));xhr.setRequestHeader('Content-Type',item.file.type||'application/octet-stream');xhr.upload.onprogress=event=>{if(!event.lengthComputable)return;item.progress=Math.round(event.loaded/event.total*100);const now=performance.now();if(now-lastPaint>150||item.progress===100){lastPaint=now;updateItem(item);}};xhr.onload=()=>resolve({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,error:(()=>{try{return JSON.parse(xhr.responseText||'{}').error;}catch{return'';}})()});xhr.onerror=()=>resolve({ok:false,status:0,error:'Network connection was lost.'});xhr.send(item.file);});
    if(result.ok){item.progress=100;item.status='on usb';item.message='Relay copy and checksum matched';updateItem(item);return;}
    if([0,409,502,503,504].includes(result.status)){item.progress=0;item.status='waiting';item.message=navigator.onLine?'Relay interrupted — retrying automatically':'Offline — queued until the network returns';updateItem(item);if(!navigator.onLine)await new Promise(resolve=>window.addEventListener('online',resolve,{once:true}));await sleep(retryMs);retryMs=Math.min(Math.round(retryMs*1.5),10_000);continue;}
    throw new Error(result.error||`Transfer failed (${result.status})`);
  }
}
function directLost(candidate,message){if(state.direct!==candidate)return;state.direct=null;setConnection('P2P reconnecting','connecting');pairingMessage(message||'Direct connection dropped. The queue is safe and will reconnect.',true);scheduleReconnect();}
function scheduleReconnect(){clearTimeout(reconnectTimer);if(state.mode!=='p2p'||state.connecting||!state.pairingCode||!state.items.some(item=>item.status==='waiting'||item.active))return;reconnectTimer=setTimeout(()=>connectDirect(true).catch(()=>scheduleReconnect()),3000);}
async function connectDirect(automatic=false){
  const code=String($('pairingCode').value||state.pairingCode).trim();if(!/^\d{6}$/.test(code))throw new Error('Enter the six-digit receiver code.');if(state.connecting)return;
  state.connecting=true;state.mode='p2p';state.pairingCode=code;clearTimeout(reconnectTimer);setConnection('P2P connecting','connecting');pairingMessage(automatic?'Reconnecting directly…':'Finding your receiver…');
  if(state.direct)state.direct.pc.close();
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]}),lanes=Array.from({length:PARALLEL_TRANSFERS},(_,index)=>laneFor(pc.createDataChannel(`usb-${index+1}`,{ordered:true}))),candidate={pc,lanes,ready:false,disconnectTimer:null};state.direct=candidate;
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='connected'){clearTimeout(candidate.disconnectTimer);}else if(pc.connectionState==='failed'||pc.connectionState==='closed'){directLost(candidate,'Direct connection ended. Retrying automatically.');}else if(pc.connectionState==='disconnected'){clearTimeout(candidate.disconnectTimer);candidate.disconnectTimer=setTimeout(()=>directLost(candidate,'Direct connection was interrupted. Retrying automatically.'),7000);}};
  let session;
  try{
    await pc.setLocalDescription(await pc.createOffer());await waitForIce(pc);
    session=await jsonFetch('/api/p2p/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairingCode:code,offer:pc.localDescription})});
    const deadline=Date.now()+90_000;let status;
    do{status=await jsonFetch(`/api/p2p/sessions/${session.id}?token=${encodeURIComponent(session.token)}`);if(status.answer)break;pairingMessage(status.state==='receiver-found'?'Receiver found. Creating the encrypted link…':'Waiting for the local receiver…');await sleep(1000);}while(Date.now()<deadline);
    if(!status?.answer)throw new Error('The receiver did not answer in time.');await pc.setRemoteDescription(status.answer);await Promise.race([Promise.all(lanes.map(lane=>lane.opened)),sleep(30_000).then(()=>{throw new Error('The direct data channels did not open.');})]);
    candidate.ready=true;setConnection('Direct P2P','live');pairingMessage('Direct connection established. Music bytes bypass Render.');jsonFetch(`/api/p2p/sessions/${session.id}?token=${encodeURIComponent(session.token)}`,{method:'DELETE'}).catch(()=>{});pump();
  }catch(error){if(state.direct===candidate){state.direct=null;pc.close();setConnection('P2P unavailable','connecting');pairingMessage(`${error.message} Retrying automatically; relay fallback remains available.`,true);}throw error;}finally{state.connecting=false;}
}
function pump(){
  while(running<PARALLEL_TRANSFERS){
    const item=state.items.find(candidate=>!candidate.active&&candidate.status==='waiting');if(!item)return;
    let lane=null;if(state.mode==='p2p'){if(!state.direct?.ready){scheduleReconnect();return;}lane=state.direct.lanes.find(candidate=>!candidate.busy);if(!lane)return;lane.busy=true;}
    item.active=true;running++;const directAtStart=state.direct;
    (state.mode==='p2p'?p2pUpload(item,lane):relayUpload(item)).catch(error=>{if(state.mode==='p2p'&&(error.connection||state.direct!==directAtStart)){item.status='waiting';item.progress=0;item.message='Queued for automatic P2P reconnect';scheduleReconnect();}else{item.status='failed';item.message=error.message;}updateItem(item);}).finally(()=>{item.active=false;if(lane)lane.busy=false;running--;render();pump();});
  }
}
function addFiles(fileList){const files=[...fileList].filter(file=>allowed.test(file.name)),rejected=fileList.length-files.length;if(rejected)alert(`${rejected} unsupported file(s) were skipped.`);state.items.push(...files.map(file=>({id:nextId++,file,status:'waiting',message:state.mode==='p2p'?'Queued for direct connection':'Ready for relay',progress:0,active:false})));render();pump();}

$('p2pForm').addEventListener('submit',event=>{event.preventDefault();connectDirect().catch(()=>scheduleReconnect());});
$('relayMode').addEventListener('click',()=>{clearTimeout(reconnectTimer);state.mode='relay';if(state.direct){state.direct.pc.close();state.direct=null;}setConnection('Render relay','relay');pairingMessage('Relay fallback enabled. File bytes will count against Render bandwidth.',true);pump();});
['dragenter','dragover'].forEach(type=>$('dropZone').addEventListener(type,event=>{event.preventDefault();$('dropZone').classList.add('drag');}));
['dragleave','drop'].forEach(type=>$('dropZone').addEventListener(type,event=>{event.preventDefault();$('dropZone').classList.remove('drag');}));
$('dropZone').addEventListener('drop',event=>addFiles(event.dataTransfer.files));
$('chooseFiles').addEventListener('click',()=>$('filePicker').click());
$('chooseFolder').addEventListener('click',()=>$('folderPicker').click());
$('filePicker').addEventListener('change',event=>addFiles(event.target.files));
$('folderPicker').addEventListener('change',event=>addFiles(event.target.files));
window.addEventListener('online',()=>{if(state.mode==='p2p')scheduleReconnect();});
window.addEventListener('beforeunload',event=>{if(state.items.some(item=>item.status==='waiting'||item.status==='sending')){event.preventDefault();event.returnValue='';}});
jsonFetch('/api/status').then(status=>{pairingMessage(status.p2pReceiverOnline?'Receiver is online. Enter its six-digit code.':'Start the local USB receiver, then enter its code.',!status.p2pReceiverOnline);}).catch(()=>pairingMessage('The signalling service is waking up. Try connecting in a moment.',true));
