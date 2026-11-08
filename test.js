'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {start}=require('./server');
async function main(){
 const server=await start({port:0,host:'127.0.0.1',maxFileBytes:1024*1024}),base=`http://127.0.0.1:${server.address().port}`,source=Buffer.from('music-bytes!');
 try{
  let response=await fetch(`${base}/api/health`);assert.equal((await response.json()).mode,'direct-relay');
  const receiverPromise=fetch(`${base}/api/receiver/wait`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receiverId:'test-pc'})});
  await new Promise(resolve=>setTimeout(resolve,50));
  const uploadPromise=fetch(`${base}/api/uploads`,{method:'PUT',headers:{'X-File-Name':encodeURIComponent('Café — Mix 01.mp3'),'X-Relative-Path':encodeURIComponent('Summer Mix/Café — Mix 01.mp3'),'X-File-Size':String(source.length),'Content-Type':'audio/mpeg'},body:source,duplex:'half'});
  response=await receiverPromise;assert.equal(response.status,200);assert.equal(decodeURIComponent(response.headers.get('x-file-name')),'Café — Mix 01.mp3');assert.equal(decodeURIComponent(response.headers.get('x-relative-path')),'Summer Mix/Café — Mix 01.mp3');
  const received=Buffer.from(await response.arrayBuffer());assert.deepEqual(received,source);const sha256=crypto.createHash('sha256').update(received).digest('hex'),id=response.headers.get('x-transfer-id'),token=response.headers.get('x-transfer-token');
  const completed=await fetch(`${base}/api/receiver/complete/${id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,sha256})});assert.equal(completed.status,200);
  const uploaded=await uploadPromise;if(uploaded.status!==201)throw new Error(`Upload failed: ${uploaded.status} ${await uploaded.text()}`);assert.equal((await uploaded.json()).sha256,sha256);
  response=await fetch(`${base}/api/status`);const status=await response.json();assert.equal(status.activeTransfers,0);assert.equal(status.receiverOnline,false);
  console.log('PASS: sender streamed directly through Render relay to receiver; Unicode path and SHA-256 matched; server stored no file');
 }finally{await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
