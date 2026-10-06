// Fixed public-read profile; not runtime configuration.
export const MERGE_LIMITS=Object.freeze({items:32,active:8,item_ms:30000,batch_ms:120000,aggregate_bytes:16*1024*1024,output_bytes:24000,cache_entries:16,cache_bytes:262144,cache_ttl_ms:15000});
if(Object.values(MERGE_LIMITS).some(x=>!Number.isSafeInteger(x)||x<=0)||MERGE_LIMITS.item_ms>MERGE_LIMITS.batch_ms||MERGE_LIMITS.active>MERGE_LIMITS.items)throw Error('Invalid merge limits');
