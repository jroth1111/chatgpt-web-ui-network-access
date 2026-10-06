// Lightweight server-side readability extraction for scraped HTML.
// Dependency-free: strips scripts/styles/nav boilerplate, converts headings,
// paragraphs, lists and links to markdown-ish text. Not a full DOM — regex-
// bounded, with hard input/output caps. Runs inside the worker before the
// MCP envelope so the model sees text, not truncated raw HTML.
const BOILERPLATE=/<(script|style|noscript|template|svg|iframe|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi;
export function extractReadable(html,{maxText=60000}={}){
 if(typeof html!=='string'||!html.length)return {text:'',title:null,links:[],text_truncated:false};
 let s=html;
 // 1. cut boilerplate
 s=s.replace(BOILERPLATE,' ');
 // 2. capture title
 const titleM=/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
 const title=titleM?titleM[1].replace(/\s+/g,' ').trim().slice(0,300):null;
 // 3. capture links before flattening (absolute only, capped) — block-level so
 // link text lands on its own line in the output. Replacement uses a FUNCTION
 // so '$&'/'$'' sequences in captured text are never interpreted (ST-5).
 const links=[];const seen=new Set();
 const linkRe=/<a\b[^>]*href="(https?:\/\/[^"\s]+)"[^>]*>([\s\S]*?)<\/a>/gi;
 // Two-pass: collect ALL matches on the pristine string first, then replace
 // back-to-front — avoids stale lastIndex when s mutates (ST-5 adjacent anchors).
 const matches=[];let lm;
 while((lm=linkRe.exec(s))&&matches.length<100)matches.push({m:lm[0],text:lm[2],href:lm[1]});
 for(const {m,text:rawText,href} of matches){
  const text=rawText.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,120);
  const key=href+'|'+text;
  if(!seen.has(key)){
   seen.add(key);links.push({text,href});
   s=s.replace(m,()=>'\n'+rawText+'\n');
  }
 }
 // 4. structural conversions
 s=s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,(m,lvl,body)=>'\n'+'#'.repeat(+lvl)+' '+body.replace(/<[^>]*>/g,'').trim()+'\n');
 s=s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi,'- $1\n');
 s=s.replace(/<\/(ul|ol)>/gi,'\n');
 s=s.replace(/<\/(p|div|section|article|tr|table|blockquote)>/gi,'\n');
 s=s.replace(/<br\s*\/?>/gi,'\n');
 s=s.replace(/<[^>]*>/g,' ');
 // 5. entities + whitespace
 s=s.replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&[a-z#0-9]+;/gi,' ');
 // collapse
 s=s.replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').replace(/^[ \t]+|[ \t]+$/gm,'');
 const truncated=s.length>maxText;
 if(truncated)s=s.slice(0,maxText);
 return {text:s,title,links,text_truncated:truncated,original_bytes:html.length};
}
// SPA shell detector: heuristics for "fetched HTML is an app shell, not content".
// Returns reasons array (empty = looks like real content).
export function detectAppShell(html){
 const reasons=[];
 if(typeof html!=='string'||!html.length)return reasons;
 if(html.length<1000)reasons.push('tiny_response:'+html.length);
 if(/<app-root>|<div id="root"><\/div>|<div id="app"><\/div>|ng-app|data-reactroot/i.test(html))reasons.push('spa_mount_node');
 const bodyText=(html.replace(BOILERPLATE,' ').replace(/<[^>]*>/g,' ')||'').replace(/\s+/g,' ').trim();
 if(bodyText.length<120)reasons.push('low_visible_text:'+bodyText.length);
 if(/login with password|sign in to continue|please log in/i.test(bodyText))reasons.push('login_screen_text');
 return reasons;
}
