'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os');
const {RTCPeerConnection}=require('werift');
const {p2pFileChannel}=require('./receiver');
const {start}=require('./server');
async function testP2PFile(){
 const usbRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'usb-music-p2p-')),offerer=new RTCPeerConnection(),answerer=new RTCPeerConnection(),source=Buffer.alloc(384*1024,73),id=crypto.randomUUID();
 let resolveMessage,rejectMessage;const messages=[];
 try{
  answerer.ondatachannel=({channel})=>p2pFileChannel({destinationFolder:'Incoming Music'},usbRoot,channel);
  const channel=offerer.createDataChannel('usb-test');channel.onmessage=({data})=>{const message=JSON.parse(String(data));if(resolveMessage){const resolve=resolveMessage;resolveMessage=null;rejectMessage=null;resolve(message);}else messages.push(message);};channel.onerror=error=>rejectMessage?.(error);
  await offerer.setLocalDescription(await offerer.createOffer());await answerer.setRemoteDescription(offerer.localDescription);await answerer.setLocalDescription(await answerer.createAnswer());await offerer.setRemoteDescription(answerer.localDescription);
  if(channel.readyState!=='open')await new Promise((resolve,reject)=>{channel.onopen=resolve;channel.onerror=reject;});
  const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>{resolveMessage=resolve;rejectMessage=reject;});
  channel.send(JSON.stringify({type:'file-start',id,name:'Café Mix.mp3',relativePath:'Album One/Disc 1/Café Mix.mp3',size:source.length}));assert.equal((await next()).type,'file-ready');
  for(let offset=0;offset<source.length;offset+=32*1024)channel.send(source.subarray(offset,Math.min(source.length,offset+32*1024)));
  channel.send(JSON.stringify({type:'batch-end',id,batch:1}));assert.equal((await next()).type,'batch-ack');channel.send(JSON.stringify({type:'file-end',id}));const completed=await next();assert.equal(completed.type,'file-complete');
  const saved=await fsp.readFile(path.join(usbRoot,'Incoming Music','Album One','Disc 1','Café Mix.mp3'));assert.deepEqual(saved,source);assert.equal(completed.sha256,crypto.createHash('sha256').update(source).digest('hex'));
 }finally{await offerer.close().catch(()=>{});await answerer.close().catch(()=>{});await fsp.rm(usbRoot,{recursive:true,force:true});}
}
async function main(){
 const server=await start({port:0,host:'127.0.0.1'}),base=`http://127.0.0.1:${server.address().port}`;
 const sources=new Map(Array.from({length:4},(_,index)=>{const name=`Café — Mix ${index+1}.mp3`;return[name,Buffer.alloc(256*1024,index+1)];}));
 try{
  let response=await fetch(`${base}/api/health`);assert.equal((await response.json()).mode,'p2p-with-relay-fallback');
  const p2pWait=fetch(`${base}/api/p2p/receiver/wait`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receiverId:'test-p2p',pairingCode:'123456'})});
  await new Promise(resolve=>setTimeout(resolve,25));
  response=await fetch(`${base}/api/p2p/sessions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairingCode:'123456',offer:{type:'offer',sdp:'test-offer'}})});assert.equal(response.status,201);const created=await response.json();
  const offered=await p2pWait;assert.equal(offered.status,200);const invitation=await offered.json();assert.equal(invitation.sessionId,created.id);assert.deepEqual(invitation.offer,{type:'offer',sdp:'test-offer'});
  response=await fetch(`${base}/api/p2p/sessions/${created.id}/answer`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairingCode:'123456',answer:{type:'answer',sdp:'test-answer'}})});assert.equal(response.status,200);
  response=await fetch(`${base}/api/p2p/sessions/${created.id}?token=${created.token}`);const answered=await response.json();assert.equal(answered.state,'answered');assert.deepEqual(answered.answer,{type:'answer',sdp:'test-answer'});
  response=await fetch(`${base}/api/p2p/sessions/${created.id}?token=${created.token}`,{method:'DELETE'});assert.equal(response.status,200);
  const receiverPromises=Array.from({length:4},(_,index)=>fetch(`${base}/api/receiver/wait`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receiverId:`test-pc-${index}`})}));
  await new Promise(resolve=>setTimeout(resolve,50));
  const uploadPromises=[...sources].map(([name,source])=>fetch(`${base}/api/uploads`,{method:'PUT',headers:{'X-File-Name':encodeURIComponent(name),'X-Relative-Path':encodeURIComponent(`Summer Mix/${name}`),'X-File-Size':String(source.length),'Content-Type':'audio/mpeg'},body:source,duplex:'half'}));
  const receiverResponses=await Promise.all(receiverPromises);
  await Promise.all(receiverResponses.map(async receivedResponse=>{assert.equal(receivedResponse.status,200);const name=decodeURIComponent(receivedResponse.headers.get('x-file-name')),expected=sources.get(name),received=Buffer.from(await receivedResponse.arrayBuffer());assert.deepEqual(received,expected);const sha256=crypto.createHash('sha256').update(received).digest('hex'),id=receivedResponse.headers.get('x-transfer-id'),token=receivedResponse.headers.get('x-transfer-token');const completed=await fetch(`${base}/api/receiver/complete/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,sha256})});assert.equal(completed.status,200);}));
  const uploaded=await Promise.all(uploadPromises);for(const result of uploaded){if(result.status!==201)throw new Error(`Upload failed: ${result.status} ${await result.text()}`);}
  response=await fetch(`${base}/api/status`);const status=await response.json();assert.equal(status.activeTransfers,0);assert.equal(status.receiverOnline,false);
  await testP2PFile();
  console.log('PASS: P2P signalling and direct Unicode folder transfer worked; relay fallback kept four parallel SHA-256 streams');
 }finally{await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
