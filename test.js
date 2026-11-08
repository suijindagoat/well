'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {start}=require('./server');
async function main(){
 const server=await start({port:0,host:'127.0.0.1'}),base=`http://127.0.0.1:${server.address().port}`;
 const sources=new Map(Array.from({length:4},(_,index)=>{const name=`Café — Mix ${index+1}.mp3`;return[name,Buffer.alloc(256*1024,index+1)];}));
 try{
  let response=await fetch(`${base}/api/health`);assert.equal((await response.json()).mode,'direct-relay');
  const receiverPromises=Array.from({length:4},(_,index)=>fetch(`${base}/api/receiver/wait`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receiverId:`test-pc-${index}`})}));
  await new Promise(resolve=>setTimeout(resolve,50));
  const uploadPromises=[...sources].map(([name,source])=>fetch(`${base}/api/uploads`,{method:'PUT',headers:{'X-File-Name':encodeURIComponent(name),'X-Relative-Path':encodeURIComponent(`Summer Mix/${name}`),'X-File-Size':String(source.length),'Content-Type':'audio/mpeg'},body:source,duplex:'half'}));
  const receiverResponses=await Promise.all(receiverPromises);
  await Promise.all(receiverResponses.map(async receivedResponse=>{assert.equal(receivedResponse.status,200);const name=decodeURIComponent(receivedResponse.headers.get('x-file-name')),expected=sources.get(name),received=Buffer.from(await receivedResponse.arrayBuffer());assert.deepEqual(received,expected);const sha256=crypto.createHash('sha256').update(received).digest('hex'),id=receivedResponse.headers.get('x-transfer-id'),token=receivedResponse.headers.get('x-transfer-token');const completed=await fetch(`${base}/api/receiver/complete/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,sha256})});assert.equal(completed.status,200);}));
  const uploaded=await Promise.all(uploadPromises);for(const result of uploaded){if(result.status!==201)throw new Error(`Upload failed: ${result.status} ${await result.text()}`);}
  response=await fetch(`${base}/api/status`);const status=await response.json();assert.equal(status.activeTransfers,0);assert.equal(status.receiverOnline,false);
  console.log('PASS: four parallel direct streams preserved Unicode paths and matched SHA-256 with no server file storage');
 }finally{await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
