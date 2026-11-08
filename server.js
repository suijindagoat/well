'use strict';
const http=require('node:http'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const PUBLIC=path.join(__dirname,'public'),MAX_DEFAULT=8*1024**3,WAIT_MS=25_000,ACK_MS=5*60_000;
const EXTENSIONS=new Set(['.mp3','.m4a','.aac','.wav','.flac','.ogg','.opus','.wma','.aiff','.aif','.alac','.zip','.rar','.7z']);
function send(res,status,value,headers={}){const body=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store',...headers});res.end(body);}
function decode(value){try{return decodeURIComponent(value||'');}catch{return'';}}
function segment(value){const out=String(value||'').normalize('NFC').replace(/[\u0000-\u001f<>:"/\\|?*]/g,'_').replace(/[. ]+$/g,'').trim();return out&&out!=='.'&&out!=='..'?out.slice(0,180):'untitled';}
function relative(value){return decode(value).split(/[\\/]+/).filter(Boolean).map(segment).slice(-12).join('/');}
async function bodyJson(req){const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>65536)throw Object.assign(new Error('Body too large'),{status:413});parts.push(part);}try{return parts.length?JSON.parse(Buffer.concat(parts)):{};}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}}
function createApp(options={}){
 const max=Number(options.maxFileBytes||process.env.MAX_FILE_BYTES||MAX_DEFAULT),waiters=[],transfers=new Map();
 function removeWaiter(waiter){const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);clearTimeout(waiter.timer);}
 function takeWaiter(){while(waiters.length){const waiter=waiters.shift();clearTimeout(waiter.timer);if(!waiter.res.destroyed&&!waiter.res.writableEnded)return waiter;}return null;}
 async function staticFile(res,pathname){const names={'/':'index.html','/app.js':'app.js','/styles.css':'styles.css'},name=names[pathname];if(!name)return false;const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'},content=await fsp.readFile(path.join(PUBLIC,name));res.writeHead(200,{'Content-Type':types[path.extname(name)],'Content-Length':content.length,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'"});res.end(content);return true;}
 return async(req,res)=>{const url=new URL(req.url,'http://localhost');try{
  if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,mode:'direct-relay'});
  if(req.method==='GET'&&!url.pathname.startsWith('/api/')&&await staticFile(res,url.pathname))return;
  if(req.method==='GET'&&url.pathname==='/api/status')return send(res,200,{receiverOnline:waiters.length>0,activeTransfers:transfers.size});
  if(req.method==='POST'&&url.pathname==='/api/receiver/wait'){
   const input=await bodyJson(req),waiter={res,receiverId:segment(input.receiverId||'usb-receiver')};
   waiter.timer=setTimeout(()=>{removeWaiter(waiter);if(!res.writableEnded){res.writeHead(204,{'Cache-Control':'no-store'});res.end();}},WAIT_MS);
   waiters.push(waiter);res.on('close',()=>removeWaiter(waiter));return;
  }
  if(req.method==='PUT'&&url.pathname==='/api/uploads'){
   const originalName=segment(decode(req.headers['x-file-name'])||'untitled'),ext=path.extname(originalName).toLowerCase();
   if(!EXTENSIONS.has(ext))return send(res,415,{error:`Unsupported file type: ${ext||'none'}`});
   const size=Number(req.headers['x-file-size']||0);if(!Number.isFinite(size)||size<0||size>max)return send(res,413,{error:'File exceeds the configured limit.'});
   const waiter=takeWaiter();if(!waiter)return send(res,409,{error:'USB receiver is offline. Keep this page open; it will retry automatically.'},{'Retry-After':'3'});
   const id=crypto.randomUUID(),token=crypto.randomBytes(24).toString('hex'),hash=crypto.createHash('sha256');let received=0;
   const completion=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{transfers.delete(id);reject(Object.assign(new Error('USB confirmation timed out.'),{status:504}));},ACK_MS);transfers.set(id,{id,token,resolve,reject,timer,sha256:null});});
   waiter.res.writeHead(200,{'Content-Type':String(req.headers['content-type']||'application/octet-stream'),'Content-Length':size,'X-Transfer-Id':id,'X-Transfer-Token':token,'X-File-Name':encodeURIComponent(originalName),'X-Relative-Path':encodeURIComponent(relative(req.headers['x-relative-path'])||originalName),'Cache-Control':'no-store'});
   try{
    for await(const chunk of req){received+=chunk.length;if(received>max)throw Object.assign(new Error('File too large'),{status:413});hash.update(chunk);if(!waiter.res.write(chunk))await new Promise(resolve=>waiter.res.once('drain',resolve));}
    waiter.res.end();if(size&&received!==size)throw Object.assign(new Error('Upload was incomplete.'),{status:400});
    const transfer=transfers.get(id);if(!transfer)throw Object.assign(new Error('Transfer expired.'),{status:504});transfer.sha256=hash.digest('hex');transfer.size=received;
    const result=await completion;return send(res,201,{ok:true,id,sha256:result.sha256,receiverId:waiter.receiverId});
   }catch(error){if(!waiter.res.writableEnded)waiter.res.destroy(error);const transfer=transfers.get(id);if(transfer){clearTimeout(transfer.timer);transfers.delete(id);}throw error;}
  }
  const complete=url.pathname.match(/^\/api\/receiver\/complete\/([a-f0-9-]{36})$/i);
  if(req.method==='POST'&&complete){const input=await bodyJson(req),transfer=transfers.get(complete[1]);if(!transfer||input.token!==transfer.token)return send(res,404,{error:'Transfer is no longer active.'});if(!transfer.sha256)return send(res,409,{error:'Upload has not finished.'});clearTimeout(transfer.timer);transfers.delete(transfer.id);if(input.sha256!==transfer.sha256){transfer.reject(Object.assign(new Error('USB checksum did not match.'),{status:409}));return send(res,409,{error:'USB checksum did not match.'});}transfer.resolve({sha256:transfer.sha256});return send(res,200,{ok:true});}
  const failed=url.pathname.match(/^\/api\/receiver\/fail\/([a-f0-9-]{36})$/i);
  if(req.method==='POST'&&failed){const input=await bodyJson(req),transfer=transfers.get(failed[1]);if(!transfer||input.token!==transfer.token)return send(res,404,{error:'Transfer is no longer active.'});clearTimeout(transfer.timer);transfers.delete(transfer.id);transfer.reject(Object.assign(new Error(String(input.error||'USB copy failed.').slice(0,500)),{status:502}));return send(res,200,{ok:true});}
  return send(res,404,{error:'Not found.'});
 }catch(error){console.error(error);if(!res.headersSent)send(res,error.status||500,{error:error.status?error.message:'Unexpected server error.'});else res.destroy();}};
}
function start(options={}){const server=http.createServer(createApp(options)),port=Number(options.port??process.env.PORT??3000);return new Promise(resolve=>server.listen(port,options.host??'0.0.0.0',()=>resolve(server)));}
if(require.main===module)start().then(server=>console.log(`USB Music Drop direct relay listening on http://0.0.0.0:${server.address().port}`));
module.exports={createApp,start};
