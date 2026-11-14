#!/usr/bin/env node
/** Operator-only. Mutating operations require an authenticated P2 repository adapter. */
import {resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {readSourceFile,expandApprovedArchive} from '../services/api/dist/knowledge/intake.js';
import {GoogleFileSearchProvider} from '../services/api/dist/knowledge/provider.js';
import {KnowledgePublisher} from '../services/api/dist/knowledge/publisher.js';

const [command,...raw]=process.argv.slice(2);
const dryRun=raw.includes('--dry-run');const args=raw.filter(x=>x!=='--dry-run');
const commands='validate <files...> | preview <files...> | create <agentId> <versionId> | submit <agentId> <versionId> <documentId> <documentVersionId> <file> | approve <agentId> <versionId> <documentId> <documentVersionId> | index <agentId> <versionId> <documentId> <documentVersionId> | status <agentId> <versionId> | verify <agentId> <versionId> <cases.json> | publish <agentId> <versionId> <expectedCurrentId|null> | retire <agentId> <versionId> | revoke <agentId> <versionId> <reason>';
async function main(){
  if(!command||command==='help'){console.log(commands);return;}
  if(['validate','preview'].includes(command)){
    if(!args.length)throw new Error('Source path required');
    const docs=[];
    for(const file of args){
      if(file.toLowerCase().endsWith('.zip')){
        if(process.env.KNOWLEDGE_ENABLE_ARCHIVES!=='true')throw new Error('ZIP_DISABLED');
        const bytes=await readFile(file);
        for(const doc of expandApprovedArchive(file,bytes,true))docs.push({name:doc.name,sha256:doc.sha256,mime:doc.mime,bytes:doc.data.length});
      }else {const doc=await readSourceFile(file);docs.push({name:doc.name,sha256:doc.sha256,mime:doc.mime,bytes:doc.data.length});}
    }
    console.log(JSON.stringify({dryRun:true,sources:docs},null,2));return;
  }
  if(dryRun){console.log(JSON.stringify({dryRun:true,command,arguments:args.map((s,i)=>i>3?'[REDACTED]':s)}));return;}
  const mod=process.env.AGENT_KNOWLEDGE_REPOSITORY_MODULE;
  if(!mod||!isAbsolute(mod))throw new Error('P2_REPOSITORY_ADAPTER_REQUIRED: set an absolute local AGENT_KNOWLEDGE_REPOSITORY_MODULE; no in-memory production fallback');
  const adapter=await import(pathToFileURL(resolve(mod)).href);
  if(typeof adapter.createKnowledgeRepository!=='function')throw new Error('P2_REPOSITORY_INVALID');
  const repo=await adapter.createKnowledgeRepository({operatorToken:process.env.KNOWLEDGE_OPERATOR_TOKEN});
  const [agent,version,x,y,z]=args;
  if(!agent||!version)throw new Error('agent/version required');
  const provider=new GoogleFileSearchProvider(process.env.GEMINI_API_KEY??'');
  const pipeline=new KnowledgePublisher(repo,provider,process.env.AGENT_KNOWLEDGE_ORIGINALS_ROOT??'',process.env.GEMINI_FILE_SEARCH_MODEL??'');
  if(!process.env.AGENT_KNOWLEDGE_ORIGINALS_ROOT||!process.env.GEMINI_FILE_SEARCH_MODEL)throw new Error('VAULT_AND_MODEL_REQUIRED');
  let result;
  switch(command){
    case 'create':result=await pipeline.createDraft(agent,version);break;
    case 'submit':if(!x||!y||!z)throw new Error('documentId, documentVersionId, file required');result=await pipeline.receive(agent,version,x,y,z);break;
    case 'approve':if(!x||!y)throw new Error('documentId, documentVersionId required');result=await pipeline.approve(agent,version,x,y);break;
    case 'index':if(!x||!y)throw new Error('documentId, documentVersionId required');result=await pipeline.index(agent,version,x,y);break;
    case 'status':result=await pipeline.inspect(agent,version);break;
    case 'verify':if(!x)throw new Error('cases.json required');result=await pipeline.verify(agent,version,JSON.parse(await readFile(x,'utf8')));break;
    case 'publish':if(!x)throw new Error('expectedCurrentId or null required');await pipeline.publish(agent,version,x==='null'?null:x);result={published:true};break;
    case 'retire':await pipeline.retire(agent,version);result={retired:true};break;
    case 'revoke':if(!x)throw new Error('reason required');await pipeline.revoke(agent,version,x);result={revoked:true};break;
    default:throw new Error('Unknown command. '+commands);
  }
  // Paths, source text, secret tokens and API credentials are never printed.
  console.log(JSON.stringify(result,(k,v)=>['originalPath','data','operatorToken','apiKey'].includes(k)?'[PRIVATE]':v,2));
}
main().catch(err=>{console.error((err instanceof Error?err.message:String(err)).replace(/AIza[\w-]+/g,'[REDACTED]'));process.exitCode=1;});
