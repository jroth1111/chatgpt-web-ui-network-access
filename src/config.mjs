// Deployment configuration. All values come from environment bindings at
// publish time (ChatGPT Sites → Site settings). No secrets belong in source.
export const OWNER_EMAIL=globalThis.OWNER_EMAIL??'owner@example.com';
export const PROJECT=globalThis.PROJECT_ID??'local-dev';
export const ORIGIN=globalThis.ORIGIN??'https://your-site.example.com';
export const BUILD=globalThis.BUILD??'__BUILD_ID__';
export const SOFTWARE_VERSION='2.7.18';
export const SOURCE_COMMIT=globalThis.SOURCE_COMMIT??'';
