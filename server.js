'use strict';

const http=require('node:http');
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const crypto=require('node:crypto');

const PUBLIC=path.join(__dirname,'public');
const WAIT_MS=25_000;
const P2P_SESSION_MS=10*60_000;
const EXTENSIONS=new Set(['.mp3','.m4a','.aac','.wav','.flac','.ogg','.opus','.wma','.aiff','.aif','.alac','.zip','.rar','.7z']);

function send(res,status,value,headers={}){const body=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store',...headers});res.end(body);}
function decode(value){try{return decodeURIComponent(value||'');}catch{return'';}}
function segment(value){const out=String(value||'').normalize('NFC').replace(/[\u0000-\u001f<>:"/\\|?*]/g,'_').replace(/[. ]+$/g,'').trim();return out&&out!=='.'&&out!=='..'?out.slice(0,180):'untitled';}
function relative(value){return decode(value).split(/[\\/]+/).filter(Boolean).map(segment).slice(-12).join('/');}
function pairingCode(value){const code=String(value||'').trim();return /^\d{6}$/.test(code)?code:'';}
function description(value,type){return value&&value.type===type&&typeof value.sdp==='string'&&value.sdp.length<300_000?{type,sdp:value.sdp}:null;}
async function bodyJson(req){const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>512*1024)throw Object.assign(new Error('Body too large'),{status:413});parts.push(part);}try{return parts.length?JSON.parse(Buffer.concat(parts)):{};}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}}

function createApp(){
  const waiters=[],transfers=new Map(),p2pWaiters=[],p2pSessions=new Map();
  function removeWaiter(waiter,list=waiters){const index=list.indexOf(waiter);if(index>=0)list.splice(index,1);clearTimeout(waiter.timer);}
  function takeWaiter(){while(waiters.length){const waiter=waiters.shift();clearTimeout(waiter.timer);if(!waiter.res.destroyed&&!waiter.res.writableEnded)return waiter;}return null;}
  function cleanP2P(){const cutoff=Date.now()-P2P_SESSION_MS;for(const [id,session] of p2pSessions){if(session.createdAt<cutoff)p2pSessions.delete(id);}}
  function takeP2PWaiter(code){for(let index=0;index<p2pWaiters.length;index++){const waiter=p2pWaiters[index];if(waiter.code!==code)continue;p2pWaiters.splice(index,1);clearTimeout(waiter.timer);if(!waiter.res.destroyed&&!waiter.res.writableEnded)return waiter;index--;}return null;}
  function deliverP2P(session){const waiter=takeP2PWaiter(session.code);if(!waiter)return false;session.assigned=true;send(waiter.res,200,{sessionId:session.id,offer:session.offer});return true;}
  function pendingP2P(code){cleanP2P();for(const session of p2pSessions.values()){if(session.code===code&&!session.assigned&&!session.answer)return session;}return null;}
  async function staticFile(res,pathname){const names={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css'},name=names[pathname];if(!name)return false;const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'},content=await fsp.readFile(path.join(PUBLIC,name));res.writeHead(200,{'Content-Type':types[path.extname(name)],'Content-Length':content.length,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'"});res.end(content);return true;}

  return async(req,res)=>{const url=new URL(req.url,'http://localhost');try{
    if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,mode:'p2p-with-relay-fallback'});
    if(req.method==='GET'&&!url.pathname.startsWith('/api/')&&await staticFile(res,url.pathname))return;
    if(req.method==='GET'&&url.pathname==='/api/status')return send(res,200,{receiverOnline:waiters.length>0,p2pReceiverOnline:p2pWaiters.length>0,waitingReceivers:waiters.length,activeTransfers:transfers.size,p2pSessions:p2pSessions.size});
    if(req.method==='POST'&&url.pathname==='/api/p2p/sessions'){
      cleanP2P();const input=await bodyJson(req),code=pairingCode(input.pairingCode),offer=description(input.offer,'offer');
      if(!code||!offer)return send(res,400,{error:'A valid six-digit receiver code and WebRTC offer are required.'});
      const session={id:crypto.randomUUID(),token:crypto.randomBytes(24).toString('hex'),code,offer,answer:null,assigned:false,createdAt:Date.now()};
      p2pSessions.set(session.id,session);deliverP2P(session);return send(res,201,{id:session.id,token:session.token});
    }
    if(req.method==='POST'&&url.pathname==='/api/p2p/receiver/wait'){
      cleanP2P();const input=await bodyJson(req),code=pairingCode(input.pairingCode);if(!code)return send(res,400,{error:'A valid six-digit receiver code is required.'});
      const pending=pendingP2P(code);if(pending){pending.assigned=true;return send(res,200,{sessionId:pending.id,offer:pending.offer});}
      const waiter={res,code};waiter.timer=setTimeout(()=>{removeWaiter(waiter,p2pWaiters);if(!res.writableEnded){res.writeHead(204,{'Cache-Control':'no-store'});res.end();}},WAIT_MS);
      p2pWaiters.push(waiter);res.on('close',()=>removeWaiter(waiter,p2pWaiters));return;
    }
    const p2pStatus=url.pathname.match(/^\/api\/p2p\/sessions\/([a-f0-9-]{36})$/i);
    if(req.method==='GET'&&p2pStatus){cleanP2P();const session=p2pSessions.get(p2pStatus[1]);if(!session||url.searchParams.get('token')!==session.token)return send(res,404,{error:'P2P session not found.'});return send(res,200,{state:session.answer?'answered':session.assigned?'receiver-found':'waiting',answer:session.answer});}
    if(req.method==='DELETE'&&p2pStatus){const session=p2pSessions.get(p2pStatus[1]);if(!session||url.searchParams.get('token')!==session.token)return send(res,404,{error:'P2P session not found.'});p2pSessions.delete(session.id);return send(res,200,{ok:true});}
    const p2pAnswer=url.pathname.match(/^\/api\/p2p\/sessions\/([a-f0-9-]{36})\/answer$/i);
    if(req.method==='POST'&&p2pAnswer){const input=await bodyJson(req),session=p2pSessions.get(p2pAnswer[1]),answer=description(input.answer,'answer');if(!session||pairingCode(input.pairingCode)!==session.code)return send(res,404,{error:'P2P session not found.'});if(!answer)return send(res,400,{error:'A valid WebRTC answer is required.'});session.answer=answer;return send(res,200,{ok:true});}
    if(req.method==='POST'&&url.pathname==='/api/receiver/wait'){
      const input=await bodyJson(req),waiter={res,receiverId:segment(input.receiverId||'usb-receiver')};waiter.timer=setTimeout(()=>{removeWaiter(waiter);if(!res.writableEnded){res.writeHead(204,{'Cache-Control':'no-store'});res.end();}},WAIT_MS);waiters.push(waiter);res.on('close',()=>removeWaiter(waiter));return;
    }
    if(req.method==='PUT'&&url.pathname==='/api/uploads'){
      const originalName=segment(decode(req.headers['x-file-name'])||'untitled'),ext=path.extname(originalName).toLowerCase();if(!EXTENSIONS.has(ext))return send(res,415,{error:`Unsupported file type: ${ext||'none'}`});
      const size=Number(req.headers['x-file-size']||0);if(!Number.isFinite(size)||size<0)return send(res,400,{error:'Invalid file size.'});
      const waiter=takeWaiter();if(!waiter)return send(res,409,{error:'USB receiver is offline. Keep this page open; it will retry automatically.'},{'Retry-After':'3'});
      const id=crypto.randomUUID(),token=crypto.randomBytes(24).toString('hex'),hash=crypto.createHash('sha256');let received=0;
      const completion=new Promise((resolve,reject)=>{transfers.set(id,{id,token,resolve,reject,sha256:null});});
      waiter.res.writeHead(200,{'Content-Type':String(req.headers['content-type']||'application/octet-stream'),'Content-Length':size,'X-Transfer-Id':id,'X-Transfer-Token':token,'X-File-Name':encodeURIComponent(originalName),'X-Relative-Path':encodeURIComponent(relative(req.headers['x-relative-path'])||originalName),'Cache-Control':'no-store'});
      try{for await(const chunk of req){received+=chunk.length;hash.update(chunk);if(!waiter.res.write(chunk))await new Promise(resolve=>waiter.res.once('drain',resolve));}waiter.res.end();if(size&&received!==size)throw Object.assign(new Error('Upload was incomplete.'),{status:400});const transfer=transfers.get(id);if(!transfer)throw Object.assign(new Error('Transfer expired.'),{status:504});transfer.sha256=hash.digest('hex');transfer.size=received;const result=await completion;return send(res,201,{ok:true,id,sha256:result.sha256,receiverId:waiter.receiverId});}catch(error){if(!waiter.res.writableEnded)waiter.res.destroy(error);if(transfers.has(id))transfers.delete(id);throw error;}
    }
    const complete=url.pathname.match(/^\/api\/receiver\/complete\/([a-f0-9-]{36})$/i);
    if(req.method==='POST'&&complete){const input=await bodyJson(req),transfer=transfers.get(complete[1]);if(!transfer||input.token!==transfer.token)return send(res,404,{error:'Transfer is no longer active.'});if(!transfer.sha256)return send(res,409,{error:'Upload has not finished.'});transfers.delete(transfer.id);if(input.sha256!==transfer.sha256){transfer.reject(Object.assign(new Error('USB checksum did not match.'),{status:409}));return send(res,409,{error:'USB checksum did not match.'});}transfer.resolve({sha256:transfer.sha256});return send(res,200,{ok:true});}
    const failed=url.pathname.match(/^\/api\/receiver\/fail\/([a-f0-9-]{36})$/i);
    if(req.method==='POST'&&failed){const input=await bodyJson(req),transfer=transfers.get(failed[1]);if(!transfer||input.token!==transfer.token)return send(res,404,{error:'Transfer is no longer active.'});transfers.delete(transfer.id);transfer.reject(Object.assign(new Error(String(input.error||'USB copy failed.').slice(0,500)),{status:502}));return send(res,200,{ok:true});}
    return send(res,404,{error:'Not found.'});
  }catch(error){console.error(error);if(!res.headersSent)send(res,error.status||500,{error:error.status?error.message:'Unexpected server error.'});else res.destroy();}};
}

function start(options={}){const server=http.createServer(createApp()),port=Number(options.port??process.env.PORT??3000);return new Promise(resolve=>server.listen(port,options.host??'0.0.0.0',()=>resolve(server)));}
if(require.main===module)start().then(server=>console.log(`USB Music Drop P2P signaling and relay fallback listening on http://0.0.0.0:${server.address().port}`));
module.exports={createApp,start};
