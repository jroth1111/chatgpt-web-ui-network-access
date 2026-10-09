// Deployment configuration. All values come from environment bindings at
// publish time (ChatGPT Sites → Site settings). No secrets belong in source.
export const OWNER_EMAIL=globalThis.OWNER_EMAIL??'';
export const PROJECT=globalThis.PROJECT_ID??'local-dev';
export const ORIGIN=globalThis.ORIGIN??'';
export const BUILD=globalThis.BUILD??'__BUILD_ID__';
export const SOFTWARE_VERSION='2.7.23';
export const SOURCE_COMMIT=globalThis.SOURCE_COMMIT??'';

// Native Workers bindings are passed as env, not guaranteed global variables.
// Missing identity/origin fail closed; examples must never become real grants.
export function runtimeConfig(env={}){
 const owner=env.OWNER_EMAIL??OWNER_EMAIL,rawOrigin=env.ORIGIN??ORIGIN;
 let origin='';
 try{const url=new URL(rawOrigin);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)origin=url.origin;}catch{}
 return {owner_email:typeof owner==='string'?owner.trim().toLowerCase():'',origin,project:env.PROJECT_ID??PROJECT};
}
