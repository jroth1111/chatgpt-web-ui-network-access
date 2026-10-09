import test from 'node:test';
import assert from 'node:assert/strict';
import {failureEvidence} from '../src/upstream-errors.mjs';
test('bounded diagnostic evidence identifies error families without exposing raw text',()=>{
 const envelope={status:'error',message:'private.operator.invalid SECRET',timings:[{reason:'NS_ERROR_UNKNOWN_HOST at https://target.example.invalid/a?token=SECRET'}]},raw=JSON.stringify(envelope),out=failureEvidence(raw,envelope,'https://target.example.invalid/a',500);
 assert.equal(out.message_class,'dns');assert.equal(out.target_host_mentioned,true);assert.deepEqual(out.known_errors,['NS_ERROR_UNKNOWN_HOST']);assert.doesNotMatch(JSON.stringify(out),/SECRET|private\.operator|target\.example/);
});
test('proxy failure remains distinct and a partial hostname is not target-bound proof',()=>{
 const e={error:'proxy-connection-failed on target.example.invalid.evil'};
 const out=failureEvidence(JSON.stringify(e),e,'https://target.example.invalid/',500);assert.equal(out.message_class,'proxy');assert.equal(out.target_host_mentioned,false);
});
test('opaque plain text produces bounded unknown evidence rather than a guessed DNS cause',()=>{
 const out=failureEvidence('Internal server error',null,'https://missing.invalid',500);assert.equal(out.format,'text');assert.equal(out.message_class,'unknown');assert.equal(out.known_error_count,0);
});
