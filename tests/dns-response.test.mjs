import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDnsTcpResponse} from '../src/dns-response.mjs';
import {buildDnsQuery,edgeDnsTcp} from '../src/edge-probes.mjs';
function reply({id=0x1234,rcode=0,answer=true}={}){
 const q=buildDnsQuery('example.com',id),body=new Uint8Array(q.length+(answer?16:0));body.set(q);body[2]=0x81;body[3]=0x80|rcode;body[7]=answer?1:0;
 if(answer)body.set([0xc0,0x0c,0,1,0,1,0,0,0,60,0,4,192,0,2,1],q.length);
 const packet=new Uint8Array(body.length+2);packet[0]=body.length>>8;packet[1]=body.length&255;packet.set(body,2);return packet;
}
test('DNS reply requires a complete frame, matching transaction and question',()=>{
 const parsed=parseDnsTcpResponse(reply(),{name:'EXAMPLE.COM.'});
 assert.equal(parsed.dns_response_validated,true);assert.equal(parsed.answer_available,true);assert.equal(parsed.answers[0].address,'192.0.2.1');assert.equal(parsed.answers[0].ttl,60);
 assert.throws(()=>parseDnsTcpResponse(new Uint8Array(),{name:'example.com'}),/dns_no_response/);
 assert.throws(()=>parseDnsTcpResponse(reply().subarray(0,20),{name:'example.com'}),/dns_frame_invalid/);
 assert.throws(()=>parseDnsTcpResponse(reply({id:1}),{name:'example.com'}),/dns_id_mismatch/);
 assert.throws(()=>parseDnsTcpResponse(reply(),{name:'other.example'}),/dns_question_mismatch/);
});
test('valid negative resolution is distinguished from an absent or malformed response',()=>{
 const n=parseDnsTcpResponse(reply({rcode:3,answer:false}),{name:'example.com'});
 assert.equal(n.dns_response_validated,true);assert.equal(n.answer_available,false);assert.equal(n.dns_status,'nxdomain');
 assert.equal(parseDnsTcpResponse(reply({rcode:3}),{name:'example.com'}).answer_available,false);
 const packet=reply();packet[4]=0x01;assert.throws(()=>parseDnsTcpResponse(packet,{name:'example.com'}),/dns_flags_invalid/);
 const loop=reply();loop[14]=0xc0;loop[15]=0x0c;assert.throws(()=>parseDnsTcpResponse(loop,{name:'example.com'}),/dns_name_invalid/);
});
function socketFixture(bytes){
 let controller;const seen={written:[],halfClosed:false};
 const connect=(address,options)=>{seen.address=address;seen.options=options;return {
  readable:new ReadableStream({start(c){controller=c;}}),
  writable:new WritableStream({write(b){seen.written.push(b);const output=typeof bytes==='function'?bytes(b):bytes;if(output.length)controller.enqueue(output);controller.close();},close(){seen.halfClosed=true;}}),close:()=>{},
 };};return {connect,seen};
}
test('helper uses a non-Cloudflare resolver, clear DNS transport and no premature FIN',async()=>{
 const {connect,seen}=socketFixture(b=>reply({id:(b[2]<<8)|b[3]})),out=await edgeDnsTcp('example.com',{connectImpl:connect});
 assert.deepEqual(seen.address,{hostname:'8.8.8.8',port:53});assert.equal(seen.options.secureTransport,'off');assert.equal(seen.halfClosed,false);
 assert.equal(seen.written[0].length,31);assert.equal(out.status,'PASS');assert.equal(out.dns_response_validated,true);assert.equal(out.answers[0].address,'192.0.2.1');
});
test('empty TCP completion is not successful DNS evidence',async()=>{
 const {connect}=socketFixture(new Uint8Array()),out=await edgeDnsTcp('example.com',{connectImpl:connect});
 assert.equal(out.ok,false);assert.equal(out.status,'FAIL');assert.equal(out.dns_response_validated,false);assert.equal(out.error.code,'dns_no_response');assert.equal(out.bytes_received,0);
});
