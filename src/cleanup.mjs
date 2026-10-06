// Cancel locally owned readers/bodies without waiting on transport cleanup.
// This disposes JS ownership; it does not prove upstream sockets stopped.
export function cancelBestEffort(resource,reason='Reader teardown'){
 if(!resource)return;
 try{Promise.resolve(resource.cancel(reason)).catch(()=>{});}catch{}
 try{resource.releaseLock?.();}catch{}
}
// Own and dispose only this wait's timer/listener. A late response body is
// cancelled best effort; the underlying operation may ignore the signal.
export async function waitBounded(operation,{signal,deadline=Infinity,error=()=>new Error('DEADLINE: absolute budget exhausted'),onLate}={}){
 if(signal?.aborted||Date.now()>=deadline)throw error();
 let timer,abort,finished=false;
 const stop=new Promise((_,reject)=>{abort=()=>reject(error());signal?.addEventListener('abort',abort,{once:true});if(Number.isFinite(deadline))timer=setTimeout(abort,Math.max(0,deadline-Date.now()));});
 const work=Promise.resolve().then(()=>{if(signal?.aborted||Date.now()>=deadline)throw error();return operation();}).then(value=>{if(finished||signal?.aborted||Date.now()>=deadline){try{onLate?.(value);}catch{}throw error();}return value;});
 try{return await Promise.race([work,stop]);}finally{finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
