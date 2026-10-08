import {readdir,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {publicSourceIssues} from './public-source-policy.mjs';
const root=process.cwd(),findings=[];
const skipped=new Set(['.git','node_modules','dist','coverage']);
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){
 if(skipped.has(entry.name))continue;
 const file=path.join(dir,entry.name),relative=path.relative(root,file);
 if(spawnSync('git',['check-ignore','--quiet','--',relative],{cwd:root}).status===0)continue;
 if((await lstat(file)).isSymbolicLink()){findings.push({file:relative,issues:['source symlink']});continue;}
 if(entry.isDirectory()){await walk(file);continue;}
 if(/\.env(?:\.|$)/.test(entry.name)&&entry.name!=='.env.example'||/\.(?:pem|key|p12|pfx|db|sqlite|sqlite3|log)$/.test(entry.name)){findings.push({file:relative,issues:['private file type']});continue;}
 const issues=publicSourceIssues(await readFile(file,'utf8'),relative);
 if(issues.length)findings.push({file:relative,issues});
}}
await walk(root);
console.log(JSON.stringify({public_export_check:findings.length?'failed':'passed',findings}));
if(findings.length)process.exitCode=1;
