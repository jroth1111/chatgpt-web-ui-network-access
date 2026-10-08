// Preserve third-party licence notices; reject operator-specific source data.
export function publicSourceIssues(text,file=''){
 const issues=[];
 if(/appg(?:prj|dep|ver)_[a-f0-9]{16,}|plugin_asdk_app_sites_[a-f0-9]+|\/Users\/[^/\s]+\/|\/workspace\/scratch\//i.test(text))issues.push('private deployment identity or local path');
 if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))issues.push('private key');
 if(/https?:\/\/[a-z0-9-]+\.[a-z0-9-]+\.chatgpt\.site\b/i.test(text))issues.push('personal deployment host');
 if(!/(?:^vendor\/|licen[cs]e|^attribution\/)/i.test(file)){
  // Exact fake userinfo in negative URL-parser tests is not an email address.
  // Do not exempt arbitrary credentials or addresses merely because of a path.
  const emailText=/^tests\//.test(file)?text.replace(/https?:\/\/user(?::(?:pass|pw|password))?@(?:www\.)?(?:youtube\.com|youtu\.be)\b/g,'https://synthetic-userinfo.invalid'):text;
  for(const email of emailText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/ig)||[]){
   const domain=email.split('@')[1].toLowerCase();
   if(!/(?:^|\.)example\.(?:com|net|org)$|\.(?:test|invalid|example)$/.test(domain)){issues.push('non-example email address');break;}
  }
 }
 if(/github\.com\/(?!YOUR_USERNAME\/|YOUR_ACCOUNT\/)[a-z0-9_-]+\/chatgpt-web-ui-(?:network-access|youtube-transcripts)\b/i.test(text))issues.push('personal repository account in template');
 return issues;
}
