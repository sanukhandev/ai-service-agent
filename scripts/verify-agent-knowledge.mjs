#!/usr/bin/env node
/** Check a version and optionally run the managed retrieval smoke before publish. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);const [agent,version,cases]=args;
if(!agent||!version){console.error('Usage: node scripts/verify-agent-knowledge.mjs <agentId> <versionId> [cases.json] [--dry-run]');process.exit(2);}
const command=cases&&!cases.startsWith('--')?'verify':'status';
const input=[command,agent,version];
if(command==='verify')input.push(cases);
if(args.includes('--dry-run'))input.push('--dry-run');
const result=spawnSync(process.execPath,[fileURLToPath(new URL('./ingest-agent-knowledge.mjs',import.meta.url)),...input],{stdio:'inherit',env:process.env});
process.exit(result.status??1);
