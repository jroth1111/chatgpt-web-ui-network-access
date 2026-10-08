// Bounded validation of one length-framed DNS A response. This is protocol
// evidence, not a claim that any returned address is reachable or trustworthy.
const failure=code=>{const error=Error(code);error.code=code;throw error;};
export function parseDnsTcpResponse(packet,{name,id=0x1234}={}){
 if(!(packet instanceof Uint8Array)||packet.length===0)failure('dns_no_response');
 if(packet.length<14||packet.length>65537)failure('dns_frame_invalid');
 const length=(packet[0]<<8)|packet[1];
 if(length!==packet.length-2||length<12)failure('dns_frame_invalid');
 const bytes=packet.subarray(2),word=at=>{
  if(at<0||at+2>bytes.length)failure('dns_response_truncated');
  return (bytes[at]<<8)|bytes[at+1];
 };
 const query=String(name??'').replace(/\.$/,'').toLowerCase();
 if(word(0)!==id)failure('dns_id_mismatch');
 const flags=word(2),rcode=flags&15;
 if(!(flags&0x8000)||(flags&0x7800)||(flags&0x0200))failure('dns_flags_invalid');
 if(word(4)!==1)failure('dns_question_invalid');
 const counts=[word(6),word(8),word(10)];
 if(counts.reduce((a,b)=>a+b,0)>128)failure('dns_record_limit');
 function readName(start){
  let at=start,end=null,chars=0;const labels=[],seen=new Set();
  for(let steps=0;steps<128;steps++){
   if(at>=bytes.length||seen.has(at))failure('dns_name_invalid');seen.add(at);
   const n=bytes[at++];
   if(n===0)return {value:labels.join('.').toLowerCase(),end:end??at};
   if((n&0xc0)===0xc0){
    if(at>=bytes.length)failure('dns_name_invalid');
    const pointer=((n&63)<<8)|bytes[at++];
    if(pointer>=bytes.length)failure('dns_name_invalid');end??=at;at=pointer;continue;
   }
   if(n>63||at+n>bytes.length||(chars+=n+1)>255)failure('dns_name_invalid');
   let label='';for(let j=0;j<n;j++){
    const c=bytes[at++];if(!/[a-z0-9-]/i.test(String.fromCharCode(c)))failure('dns_name_invalid');label+=String.fromCharCode(c);
   }labels.push(label);
  }failure('dns_name_invalid');
 }
 const question=readName(12);let at=question.end;
 if(question.value!==query||word(at)!==1||word(at+2)!==1)failure('dns_question_mismatch');at+=4;
 const records=[];
 for(let section=0;section<3;section++)for(let i=0;i<counts[section];i++){
  const owner=readName(at);at=owner.end;
  const type=word(at),klass=word(at+2),ttl=word(at+4)*65536+word(at+6),size=word(at+8);at+=10;
  if(at+size>bytes.length)failure('dns_response_truncated');
  if(section===0&&klass===1){
   if(type===1){if(size!==4)failure('dns_a_record_invalid');records.push({name:owner.value,type:'A',ttl,address:Array.from(bytes.subarray(at,at+4)).join('.')});}
   else if(type===5){const target=readName(at);if(target.end!==at+size)failure('dns_cname_invalid');records.push({name:owner.value,type:'CNAME',target:target.value,ttl});}
  }at+=size;
 }
 if(at!==bytes.length)failure('dns_trailing_bytes');
 const owners=new Set([query]);for(let i=0;i<records.length;i++)for(const r of records)if(r.type==='CNAME'&&owners.has(r.name))owners.add(r.target);
 const answers=rcode===0?records.filter(r=>r.type==='A'&&owners.has(r.name)):[];
 return {transaction_id:id,question:{name:question.value,type:'A',class:'IN'},rcode,
  dns_status:rcode===0?(answers.length?'answered':'no_a_answers'):rcode===3?'nxdomain':'resolver_error',
  answer_count:counts[0],answers,answer_available:answers.length>0,dns_response_validated:true};
}
