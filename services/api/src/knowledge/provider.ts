/** Gemini Developer API v1beta transport, isolated behind an injectable interface. */
import type { ValidatedSource } from './intake.js';

export type IndexOperation = {name: string; done: boolean; error?: unknown; response?: {documentName?: string; parent?: string}};
export type ProviderDocument = {name: string; state: string; customMetadata?: {key:string;stringValue?:string}[]; mimeType?:string};
export type Retrieval = {text:string; documentResources:string[]; rawAnnotations: unknown[]};
export interface FileSearchProvider {
  createStore(displayName:string):Promise<string>;
  getStore(store:string):Promise<{name:string; pendingDocumentsCount?:string; failedDocumentsCount?:string}>;
  upload(store:string,source:ValidatedSource, metadata:Record<string,string>):Promise<IndexOperation>;
  operation(name:string):Promise<IndexOperation>;
  getDocument(document:string):Promise<ProviderDocument>;
  listDocuments(store:string):Promise<ProviderDocument[]>;
  retrieve(model:string,store:string,prompt:string):Promise<Retrieval>;
  deleteDocument(document:string):Promise<void>;
  deleteStore(store:string):Promise<void>;
}
export class FileSearchError extends Error {
  constructor(readonly code:'rate_limit'|'timeout'|'auth'|'invalid'|'transient'|'not_found'|'provider', readonly retryable:boolean) {super(`FILE_SEARCH_${code.toUpperCase()}`);}
}
export function assertStoreName(s:string):void {
  if(!/^fileSearchStores\/[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(s)) throw new FileSearchError('invalid',false);
}
export function assertDocumentName(store:string,s:string):void {
  assertStoreName(store);
  if(!s.startsWith(store+'/documents/')||!/^fileSearchStores\/[a-z0-9-]+\/documents\/[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(s)) throw new FileSearchError('invalid',false);
}
function classified(status:number): FileSearchError {
  if(status===429) return new FileSearchError('rate_limit',true);
  if(status===408||status===504) return new FileSearchError('timeout',true);
  if(status===401||status===403) return new FileSearchError('auth',false);
  if(status===404) return new FileSearchError('not_found',false);
  if(status>=500) return new FileSearchError('transient',true);
  return new FileSearchError('invalid',false);
}
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export class GoogleFileSearchProvider implements FileSearchProvider {
  constructor(private readonly apiKey:string, private readonly fetcher:typeof fetch=fetch,private readonly attempts=3) {
    if(!apiKey) throw new FileSearchError('auth',false);
  }
  private async request(path:string, init:RequestInit={}, retry=true):Promise<Response> {
    if(!/^\/(?:v1beta|upload\/v1beta)\//.test(path)) throw new FileSearchError('invalid',false);
    let delay=250;
    for(let n=0;n<(retry?this.attempts:1);n++) {
      let result:Response;
      try {
        result=await this.fetcher('https://generativelanguage.googleapis.com'+path,{
          ...init,signal:AbortSignal.timeout(20_000),headers:{'x-goog-api-key':this.apiKey,...init.headers},
        });
      } catch(e) {if(n===this.attempts-1||!retry) throw new FileSearchError('timeout',true);await sleep(delay);delay*=2;continue;}
      if(result.ok) return result;
      const err=classified(result.status);
      if(!retry||!err.retryable||n===this.attempts-1) throw err;
      await sleep(delay+Math.floor(Math.random()*60));delay*=2;
    }
    throw new FileSearchError('provider',true);
  }
  private async json(path:string,method='GET',body?:unknown,retry=true):Promise<any> {
    const res=await this.request(path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined},retry);
    return res.json();
  }
  async createStore(displayName:string):Promise<string> {
    const value=await this.json('/v1beta/fileSearchStores','POST',{displayName},false);
    assertStoreName(value.name);return value.name;
  }
  async getStore(store:string) {assertStoreName(store);return this.json('/v1beta/'+store);}
  async upload(store:string,source:ValidatedSource, metadata:Record<string,string>):Promise<IndexOperation> {
    assertStoreName(store);
    const initial=await this.request('/upload/v1beta/'+store+':uploadToFileSearchStore',{
      method:'POST',headers:{'content-type':'application/json','x-goog-upload-protocol':'resumable',
        'x-goog-upload-command':'start','x-goog-upload-header-content-length':String(source.data.length),
        'x-goog-upload-header-content-type':source.mime,
      },body:JSON.stringify({displayName:source.name,customMetadata:Object.entries(metadata).map(([key,stringValue])=>({key,stringValue}))})
    },false);
    const url=initial.headers.get('x-goog-upload-url');
    // Provider returned URL is a capability: never upload to an arbitrary host.
    if(!url) throw new FileSearchError('provider',true);
    let u:URL;try{u=new URL(url);}catch{throw new FileSearchError('provider',false);}
    if(u.protocol!=='https:'||u.hostname!=='generativelanguage.googleapis.com'||u.port||!u.pathname.startsWith('/upload/')) throw new FileSearchError('provider',false);
    const res=await this.fetcher(u.toString(),{method:'POST',signal:AbortSignal.timeout(40_000),headers:{
      'x-goog-api-key':this.apiKey,'content-type':source.mime,'x-goog-upload-offset':'0','x-goog-upload-command':'upload, finalize',
    },body:new Uint8Array(source.data)});
    if(!res.ok) throw classified(res.status);
    const op=await res.json() as IndexOperation;
    if(!op.name||typeof op.done!=='boolean') throw new FileSearchError('provider',true);
    return op;
  }
  async operation(name:string):Promise<IndexOperation> {
    if(!/^fileSearchStores\/[a-z0-9-]+\/(?:operations|upload\/operations|import\/operations)\/[a-zA-Z0-9_-]+$/.test(name)&&!/^operations\/[a-zA-Z0-9_-]+$/.test(name))throw new FileSearchError('invalid',false);
    return this.json('/v1beta/'+name);
  }
  async getDocument(document:string):Promise<ProviderDocument> {
    if(!/^fileSearchStores\/[a-z0-9-]+\/documents\/[a-z0-9-]+$/.test(document)) throw new FileSearchError('invalid',false);
    return this.json('/v1beta/'+document);
  }
  async listDocuments(store:string):Promise<ProviderDocument[]> {
    assertStoreName(store);const result:ProviderDocument[]=[];let page='';const seen=new Set<string>();
    do {const reply=await this.json('/v1beta/'+store+'/documents?pageSize=20'+(page?'&pageToken='+encodeURIComponent(page):''));
      if(!Array.isArray(reply.documents)&&reply.documents!==undefined) throw new FileSearchError('provider',false);
      result.push(...(reply.documents??[]));page=reply.nextPageToken??'';
      if(page){if(seen.has(page)||seen.size>100)throw new FileSearchError('provider',false);seen.add(page);}
    }while(page);
    return result;
  }
  async retrieve(model:string,store:string,prompt:string):Promise<Retrieval> {
    assertStoreName(store);
    if(!/^[a-zA-Z0-9_.-]+$/.test(model)||!prompt.trim()) throw new FileSearchError('invalid',false);
    const reply=await this.json('/v1beta/models/'+model+':generateContent','POST',{
      contents:[{role:'user',parts:[{text:prompt}]}],tools:[{fileSearch:{fileSearchStoreNames:[store]}}],
      generationConfig:{temperature:0},
    },false);
    const candidate=reply.candidates?.[0];const annotations=candidate?.groundingMetadata?.groundingChunks??[];
    if(!Array.isArray(annotations))throw new FileSearchError('provider',false);
    const resourceNames:string[]=[];
    let providerDocs:ProviderDocument[]|null=null;
    for(const chunk of annotations) {
      const context=chunk?.retrievedContext;
      if(!context)continue;
      const candidates=[context.uri,context.sourceUri,context.documentName];
      let resolved=false;
      for(const raw of candidates) {
        if(typeof raw==='string' && raw.startsWith(store+'/documents/')) {
          assertDocumentName(store,raw);
          resourceNames.push(raw);
          resolved=true;
          break;
        }
      }
      if(resolved)continue;
      // Google's generateContent File Search citations may expose the store
      // plus customMetadata, without an exact document resource name.
      // Resolve ONLY an exact metadata tuple against a provider-listed ACTIVE
      // document. The caller independently confirms this ID in PostgreSQL.
      const rawMetadata=Array.isArray(context.customMetadata)?context.customMetadata:[];
      const wanted:Record<string,string>={};
      for(const item of rawMetadata) {
        if(typeof item?.key==='string'&&typeof item?.stringValue==='string' &&
           !Object.hasOwn(wanted,item.key))wanted[item.key]=item.stringValue;
      }
      const keys=['agentId','knowledgeVersionId','documentId','documentVersionId','sha256'];
      if(!keys.every(k=>wanted[k] && wanted[k].length<128))continue;
      providerDocs??=await this.listDocuments(store);
      const matches=providerDocs.filter(doc=>{
        if(!['STATE_ACTIVE','ACTIVE'].includes(doc.state))return false;
        if(typeof doc.name!=='string'||!doc.name.startsWith(store+'/documents/'))return false;
        const actual:Record<string,string>={};
        for(const md of doc.customMetadata??[]) {
          if(md.key&&typeof md.stringValue==='string' && !Object.hasOwn(actual,md.key))
            actual[md.key]=md.stringValue;
        }
        return keys.every(k=>actual[k]===wanted[k]);
      });
      if(matches.length===1) {
        assertDocumentName(store,matches[0].name);
        resourceNames.push(matches[0].name);
      }
      else if(matches.length>1)throw new FileSearchError('provider',false);
    }
    return {text:(candidate?.content?.parts??[]).map((x:{text?:string})=>x.text??'').join(''),documentResources:[...new Set(resourceNames)],rawAnnotations:annotations};
  }
  async deleteDocument(document:string):Promise<void> {
    if(!/^fileSearchStores\/[a-z0-9-]+\/documents\/[a-z0-9-]+$/.test(document))throw new FileSearchError('invalid',false);
    await this.json('/v1beta/'+document+'?force=true','DELETE',undefined,false);
  }
  async deleteStore(store:string):Promise<void> {
    assertStoreName(store);await this.json('/v1beta/'+store+'?force=false','DELETE',undefined,false);
  }
}
