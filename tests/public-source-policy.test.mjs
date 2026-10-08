import test from 'node:test';
import assert from 'node:assert/strict';
import {publicSourceIssues} from '../scripts/public-source-policy.mjs';
import {runtimeConfig} from '../src/config.mjs';
test('privacy policy accepts reserved examples and retains mandatory licence attribution',()=>{
 assert.deepEqual(publicSourceIssues('owner@example.com dev@fixture.test https://your-site.example.com'),[]);
 assert.deepEqual(publicSourceIssues('Maintainer <'+['author','upstream.org'].join('@')+'>','vendor/LICENSE'),[]);
});
test('privacy policy rejects private emails, deployment hosts, IDs, paths and personal repository templates',()=>{
 const privateValues=[['person','operator.org'].join('@'),'https://private.'+'operator.chatgpt.site','appgprj_'+ 'a'.repeat(32),['','Users','private','source',''].join('/'),['https:','','github.com','operator','chatgpt-web-ui-network-access'].join('/')];
 for(const value of privateValues)assert.ok(publicSourceIssues(value).length);
});
test('runtime bindings are explicit, normalized and missing configuration fails closed',()=>{
 assert.deepEqual(runtimeConfig(),{owner_email:'',origin:'',project:'local-dev'});
 assert.deepEqual(runtimeConfig({OWNER_EMAIL:' OWNER@EXAMPLE.COM ',ORIGIN:'https://site.example.invalid/path',PROJECT_ID:'synthetic'}),{owner_email:'owner@example.com',origin:'https://site.example.invalid',project:'synthetic'});
 assert.equal(runtimeConfig({ORIGIN:'https://credentials@site.example.invalid'}).origin,'');
});
