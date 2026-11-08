'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');const execFileAsync=promisify(execFile);
const {RTCPeerConnection}=require('werift');
function generatedPairingCode(){const value=parseInt(crypto.createHash('sha256').update(`${os.hostname()}|${__dirname}`).digest('hex').slice(0,8),16);return String(100000+(value%900000));}
function loadConfig(){let file={};try{file=JSON.parse(fs.readFileSync(path.join(__dirname,'.receiver-config.json'),'utf8').replace(/^\uFEFF/,''));}catch(e){if(e.code!=='ENOENT')throw e;}const code=String(process.env.PAIRING_CODE||file.pairingCode||generatedPairingCode());return{serverUrl:String(process.env.SERVER_URL||file.serverUrl||'').replace(/\/$/,''),usbPath:String(process.env.USB_PATH||file.usbPath||''),destinationFolder:String(process.env.DESTINATION_FOLDER||file.destinationFolder||'Incoming Music'),retryMs:Number(process.env.RETRY_MS||file.retryMs||1000),parallelTransfers:Math.max(1,Number(process.env.PARALLEL_TRANSFERS||file.parallelTransfers||4)),pairingCode:/^\d{6}$/.test(code)?code:generatedPairingCode()};}
function headers(config,extra={}){return{...extra};}
function decode(value){try{return decodeURIComponent(value||'');}catch{return'';}}
function safeSegment(value){const out=String(value||'').normalize('NFC').replace(/[\u0000-\u001f<>:"/\\|?*]/g,'_').replace(/[. ]+$/g,'').trim(),reserved=/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;return out&&out!=='.'&&out!=='..'?(reserved.test(out)?`_${out}`:out).slice(0,180):'untitled';}
function safeRelative(value,fallback){const parts=String(value||fallback).split(/[\\/]+/).filter(Boolean).map(safeSegment).slice(-12);return parts.length?path.join(...parts):safeSegment(fallback);}
async function detectUsb(){if(process.platform!=='win32')return'';const script="Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Select-Object -ExpandProperty DeviceID | Select-Object -First 1";try{const{stdout}=await execFileAsync('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true});return stdout.trim()?`${stdout.trim()}\\`:'';}catch{return'';}}
async function digest(file){const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function availableName(target,expectedHash){try{if(await digest(target)===expectedHash)return{path:target,alreadyThere:true};}catch(e){if(e.code==='ENOENT')return{path:target,alreadyThere:false};throw e;}const dir=path.dirname(target),ext=path.extname(target),stem=path.basename(target,ext);for(let n=2;;n++){const candidate=path.join(dir,`${stem} (${n})${ext}`);try{await fsp.access(candidate);}catch(e){if(e.code==='ENOENT')return{path:candidate,alreadyThere:false};throw e;}}}
const reservations=new Set();let reservationLock=Promise.resolve();
async function reserveName(target){let unlock;const previous=reservationLock;reservationLock=new Promise(resolve=>{unlock=resolve;});await previous;try{const dir=path.dirname(target),ext=path.extname(target),stem=path.basename(target,ext);for(let n=1;;n++){const candidate=n===1?target:path.join(dir,`${stem} (${n})${ext}`),key=candidate.toLowerCase();if(reservations.has(key))continue;try{await fsp.access(candidate);}catch(error){if(error.code==='ENOENT'){reservations.add(key);return candidate;}throw error;}}}finally{unlock();}}
function releaseName(target){reservations.delete(target.toLowerCase());}
async function api(config,pathname,options={}){const response=await fetch(`${config.serverUrl}${pathname}`,{...options,headers:headers(config,options.headers)});if(!response.ok&&response.status!==204)throw new Error(`${response.status} ${await response.text()}`);return response;}
async function report(config,kind,id,token,data={}){return api(config,`/api/receiver/${kind}/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,...data})});}
async function waitForTransfer(config,receiverId){return api(config,'/api/receiver/wait',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receiverId})});}
async function receive(config,usbRoot,response){
 const id=response.headers.get('x-transfer-id'),token=response.headers.get('x-transfer-token'),name=decode(response.headers.get('x-file-name'))||'untitled',rel=decode(response.headers.get('x-relative-path'))||name,expectedSize=Number(response.headers.get('content-length')||0);
 const base=path.resolve(usbRoot,safeSegment(config.destinationFolder)),destination=path.resolve(base,safeRelative(rel,name));if(!destination.startsWith(`${base}${path.sep}`))throw new Error('Unsafe destination path.');
 await fsp.mkdir(path.dirname(destination),{recursive:true});const selectedPath=await reserveName(destination),partial=`${selectedPath}.${id}.part`,hash=crypto.createHash('sha256');let size=0;const output=fs.createWriteStream(partial,{flags:'wx'});
 try{for await(const chunk of response.body){size+=chunk.length;hash.update(chunk);if(!output.write(chunk))await new Promise(resolve=>output.once('drain',resolve));}await new Promise((resolve,reject)=>output.end(e=>e?reject(e):resolve()));if(expectedSize&&size!==expectedSize)throw new Error(`Incomplete transfer: received ${size} of ${expectedSize} bytes.`);const sha256=hash.digest('hex');await fsp.rename(partial,selectedPath);await report(config,'complete',id,token,{sha256});console.log(`Saved to USB: ${selectedPath}`);}
 catch(error){output.destroy();await fsp.rm(partial,{force:true});if(id&&token)try{await report(config,'fail',id,token,{error:String(error.message||error)});}catch{}throw error;}finally{releaseName(selectedPath);}
}
async function closeP2PFile(state){
 if(!state)return;
 state.output.destroy();
 await fsp.rm(state.partial,{force:true}).catch(()=>{});
 releaseName(state.selectedPath);
}
function p2pFileChannel(config,usbRoot,channel){
 let current=null,chain=Promise.resolve();
 const reply=value=>{if(channel.readyState==='open')channel.send(JSON.stringify(value));};
 async function command(message){
  if(message.type==='file-start'){
   if(current)throw new Error('Another file is already active on this channel.');
   const name=safeSegment(message.name||'untitled'),rel=safeRelative(message.relativePath||name,name),expectedSize=Number(message.size);
   if(!Number.isFinite(expectedSize)||expectedSize<0)throw new Error('Invalid P2P file size.');
   const base=path.resolve(usbRoot,safeSegment(config.destinationFolder)),destination=path.resolve(base,rel);if(!destination.startsWith(`${base}${path.sep}`))throw new Error('Unsafe P2P destination path.');
   await fsp.mkdir(path.dirname(destination),{recursive:true});const selectedPath=await reserveName(destination),id=String(message.id||crypto.randomUUID()),partial=`${selectedPath}.${id}.part`,output=fs.createWriteStream(partial,{flags:'wx'});
   current={id,expectedSize,received:0,selectedPath,partial,output,hash:crypto.createHash('sha256')};reply({type:'file-ready',id});return;
  }
  if(message.type==='batch-end'){
   if(!current||message.id!==current.id)throw new Error('P2P batch does not match the active file.');
   if(current.output.writableNeedDrain)await new Promise(resolve=>current.output.once('drain',resolve));reply({type:'batch-ack',id:current.id,batch:message.batch});return;
  }
  if(message.type==='file-end'){
   if(!current||message.id!==current.id)throw new Error('P2P completion does not match the active file.');
   const finished=current;await new Promise((resolve,reject)=>finished.output.end(error=>error?reject(error):resolve()));
   if(finished.received!==finished.expectedSize)throw new Error(`Incomplete P2P transfer: received ${finished.received} of ${finished.expectedSize} bytes.`);
   const sha256=finished.hash.digest('hex');await fsp.rename(finished.partial,finished.selectedPath);releaseName(finished.selectedPath);current=null;reply({type:'file-complete',id:finished.id,sha256,size:finished.received});console.log(`Saved P2P to USB: ${finished.selectedPath}`);return;
  }
  throw new Error('Unknown P2P command.');
 }
 async function handle(data){
  if(typeof data==='string')return command(JSON.parse(data));
  if(!current)throw new Error('P2P data arrived before file metadata.');
  const chunk=Buffer.from(data);current.received+=chunk.length;if(current.received>current.expectedSize)throw new Error('P2P file exceeded its declared size.');current.hash.update(chunk);if(!current.output.write(chunk))await new Promise(resolve=>current.output.once('drain',resolve));
 }
 channel.onmessage=({data})=>{chain=chain.then(()=>handle(data)).catch(async error=>{console.error(`P2P channel error: ${error.message}`);const id=current?.id;await closeP2PFile(current);current=null;reply({type:'file-error',id,error:String(error.message||error)});});};
 channel.onclose=()=>{chain=chain.then(async()=>{await closeP2PFile(current);current=null;});};
}
async function waitForP2PSession(config,receiverId){return api(config,'/api/p2p/receiver/wait',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receiverId,pairingCode:config.pairingCode})});}
async function answerP2PSession(config,sessionId,answer){return api(config,`/api/p2p/sessions/${sessionId}/answer`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairingCode:config.pairingCode,answer})});}
async function serveP2PSession(config,usbRoot,session){
 const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});let opened=0;
 pc.ondatachannel=({channel})=>{opened++;p2pFileChannel(config,usbRoot,channel);};
 try{
  await pc.setRemoteDescription(session.offer);await pc.setLocalDescription(await pc.createAnswer());
  const local=pc.localDescription;await answerP2PSession(config,session.sessionId,{type:local.type,sdp:local.sdp});console.log('P2P offer answered. Waiting for the direct connection...');
  await new Promise((resolve,reject)=>{let disconnectedTimer;pc.onconnectionstatechange=()=>{const state=pc.connectionState;if(state==='connected'){clearTimeout(disconnectedTimer);console.log(`Direct P2P connected with ${opened||4} data channels.`);}else if(state==='failed'){clearTimeout(disconnectedTimer);reject(new Error('Direct P2P connection failed.'));}else if(state==='closed'){clearTimeout(disconnectedTimer);resolve();}else if(state==='disconnected'){clearTimeout(disconnectedTimer);disconnectedTimer=setTimeout(resolve,15_000);}};});
 }finally{await pc.close().catch(()=>{});}
}
async function p2pWorker(config,receiverId){for(;;){try{const usbRoot=config.usbPath||await detectUsb();if(!usbRoot){await new Promise(resolve=>setTimeout(resolve,config.retryMs));continue;}const response=await waitForP2PSession(config,receiverId);if(response.status===204)continue;const session=await response.json();await serveP2PSession(config,usbRoot,session);}catch(error){console.error(`P2P retry: ${error.message}`);await new Promise(resolve=>setTimeout(resolve,config.retryMs));}}}
async function worker(config,receiverId,index){for(;;){try{const usbRoot=config.usbPath||await detectUsb();if(!usbRoot){if(index===0)console.log('Waiting for a removable USB drive...');await new Promise(resolve=>setTimeout(resolve,config.retryMs));continue;}const response=await waitForTransfer(config,`${receiverId}-${index+1}`);if(response.status===204)continue;console.log(`Receiving: ${decode(response.headers.get('x-file-name'))}`);await receive(config,usbRoot,response);}catch(error){console.error(`Receiver retry: ${error.message}`);await new Promise(resolve=>setTimeout(resolve,config.retryMs));}}}
async function run(){const config=loadConfig();if(!config.serverUrl){console.error('Run configure-usb-receiver.cmd first.');process.exitCode=1;return;}const receiverId=`${os.hostname()}-${crypto.createHash('sha256').update(__dirname).digest('hex').slice(0,8)}`,usbRoot=config.usbPath||await detectUsb();console.log('USB receiver is running. Keep this window open.');console.log(`P2P pairing code: ${config.pairingCode}`);console.log(`Relay fallback: ${config.parallelTransfers} parallel transfers.`);if(usbRoot)console.log(`USB ready: ${usbRoot}`);await Promise.all([p2pWorker(config,receiverId),...Array.from({length:config.parallelTransfers},(_,index)=>worker(config,receiverId,index))]);}
if(require.main===module)run();module.exports={safeSegment,safeRelative,availableName,digest,receive,p2pFileChannel};
