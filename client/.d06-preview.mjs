import { preview } from 'vite';
const server=await preview({preview:{port:4173,strictPort:true}});
let closing=false;
async function close() {
  if(closing)return; closing=true;
  await new Promise((resolve,reject)=>server.httpServer.close(err=>err?reject(err):resolve()));
  process.exitCode=0;
}
process.on('SIGTERM',()=>void close().catch(err=>{console.error(err);process.exitCode=1;}));
process.on('SIGINT',()=>void close().catch(err=>{console.error(err);process.exitCode=1;}));
