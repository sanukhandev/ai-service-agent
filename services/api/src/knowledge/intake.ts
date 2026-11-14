import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_ARCHIVE_UNPACKED = 50 * 1024 * 1024;
export type SourceFormat = 'pdf' | 'docx' | 'txt' | 'md';
export type ValidatedSource = { name: string; format: SourceFormat; mime: string; sha256: string; data: Buffer };
const allowed: Record<string, {format: SourceFormat; mime: string}> = {
  '.pdf': {format:'pdf',mime:'application/pdf'},
  '.docx': {format:'docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
  '.txt': {format:'txt',mime:'text/plain'},
  '.md': {format:'md',mime:'text/markdown'},
  '.markdown': {format:'md',mime:'text/markdown'},
};
function reject(reason: string): never { throw new Error(`KNOWLEDGE_INTAKE_${reason}`); }
function utf8(b: Buffer): string {
  try { return new TextDecoder('utf-8', {fatal:true}).decode(b); }
  catch { return reject('INVALID_UTF8'); }
}
function checkText(data: Buffer) {
  const text = utf8(data);
  if (!text.trim() || /\0/.test(text)) reject('EMPTY_OR_BINARY_TEXT');
  if (text.split('').filter(c => c.charCodeAt(0) < 32 && !'\t\n\r\f'.includes(c)).length > 0) reject('INVALID_TEXT_CONTROL');
}
function crc32(b: Buffer): number {
  let crc = -1;
  for (const byte of b) { crc ^= byte; for(let i=0;i<8;i++) crc=(crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ -1) >>> 0;
}
export function zipEntries(bytes: Buffer): {name: string; data: Buffer}[] {
  if (bytes.length < 22) reject('BROKEN_ZIP');
  let eocd=-1;
  for(let i=bytes.length-22;i>=Math.max(0, bytes.length-65557);i--) {
    if(bytes.readUInt32LE(i)===0x06054b50) {eocd=i;break;}
  }
  if(eocd<0) reject('BROKEN_ZIP');
  if(bytes.readUInt16LE(eocd+4) || bytes.readUInt16LE(eocd+6)) reject('ZIP_MULTIDISK');
  const count=bytes.readUInt16LE(eocd+10), size=bytes.readUInt32LE(eocd+12), start=bytes.readUInt32LE(eocd+16);
  if (count>100 || size===0xffffffff || start===0xffffffff || count!==bytes.readUInt16LE(eocd+8) || start+size>eocd) reject('ZIP_LIMIT');
  const seen=new Set<string>(); const entries: {name:string;data:Buffer}[]=[];
  let cursor=start,total=0;
  for(let i=0;i<count;i++) {
    if(cursor+46>start+size || bytes.readUInt32LE(cursor)!==0x02014b50) reject('BROKEN_ZIP_DIRECTORY');
    const flags=bytes.readUInt16LE(cursor+8), method=bytes.readUInt16LE(cursor+10);
    const crc=bytes.readUInt32LE(cursor+16), compressed=bytes.readUInt32LE(cursor+20), uncompressed=bytes.readUInt32LE(cursor+24);
    const nameSize=bytes.readUInt16LE(cursor+28), extra=bytes.readUInt16LE(cursor+30), comment=bytes.readUInt16LE(cursor+32);
    const attrs=bytes.readUInt32LE(cursor+38), offset=bytes.readUInt32LE(cursor+42);
    const nameEnd=cursor+46+nameSize;
    if(nameEnd+extra+comment>start+size) reject('BROKEN_ZIP_DIRECTORY');
    const name=utf8(bytes.subarray(cursor+46,nameEnd));
    cursor=nameEnd+extra+comment;
    const unixMode=(attrs>>>16)&0xffff, fileType=unixMode&0xf000;
    if (flags&1 || flags&0x40 || ![0,8].includes(method) || [0xa000,0x6000].includes(fileType)) reject('ZIP_UNSAFE_MEMBER');
    if(!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').some(p=>p==='..'||p==='.') || seen.has(name.toLowerCase())) reject('ZIP_TRAVERSAL_OR_DUPLICATE');
    seen.add(name.toLowerCase());
    if(name.endsWith('/')) continue;
    if(!compressed || !uncompressed || uncompressed>MAX_SOURCE_BYTES || uncompressed>compressed*100 || (total+=uncompressed)>MAX_ARCHIVE_UNPACKED) reject('ZIP_BOMB');
    if(offset+30>bytes.length || bytes.readUInt32LE(offset)!==0x04034b50) reject('BROKEN_ZIP_MEMBER');
    const localFlags=bytes.readUInt16LE(offset+6), localMethod=bytes.readUInt16LE(offset+8);
    if((localFlags&1) || localMethod!==method) reject('ZIP_HEADER_MISMATCH');
    const localNameSize=bytes.readUInt16LE(offset+26),localExtra=bytes.readUInt16LE(offset+28);
    const payload=offset+30+localNameSize+localExtra;
    if(payload+compressed>start) reject('BROKEN_ZIP_MEMBER');
    const packed=bytes.subarray(payload,payload+compressed);
    let data: Buffer;
    try { data=method===0?Buffer.from(packed):inflateRawSync(packed,{maxOutputLength:uncompressed}); }
    catch { return reject('ZIP_DECOMPRESSION'); }
    if(data.length!==uncompressed || crc32(data)!==crc) reject('ZIP_CRC_MISMATCH');
    entries.push({name,data});
  }
  if(cursor!==start+size || entries.length===0) reject('EMPTY_ZIP');
  return entries;
}
export function validateSource(name: string, data: Buffer, declaredMime?: string): ValidatedSource {
  const ext=extname(name).toLowerCase(), kind=allowed[ext];
  if(!kind || /[/\\\0]/.test(name) || name.startsWith('.')) reject('UNSUPPORTED_EXTENSION');
  if(data.length===0 || data.length>MAX_SOURCE_BYTES) reject('SIZE');
  if(declaredMime && declaredMime.toLowerCase().split(';')[0].trim()!==kind.mime) reject('MIME_MISMATCH');
  if(kind.format==='pdf') {
    if(!data.subarray(0,8).toString('latin1').startsWith('%PDF-') || !data.subarray(-2048).toString('latin1').includes('%%EOF')) reject('INVALID_PDF');
  } else if(kind.format==='docx') {
    if(data.readUInt32LE(0)!==0x04034b50) reject('INVALID_DOCX');
    const members=zipEntries(data);
    if(!members.some(x=>x.name==='[Content_Types].xml') || !members.some(x=>x.name==='word/document.xml' && /<w:t(?:\s|>)/.test(utf8(x.data)))) reject('INVALID_DOCX');
  } else checkText(data);
  return {name,format:kind.format,mime:kind.mime,sha256:createHash('sha256').update(data).digest('hex'),data};
}
export async function readSourceFile(path: string, declaredMime?: string): Promise<ValidatedSource> {
  const s=await lstat(path);
  if(!s.isFile() || s.isSymbolicLink() || s.size===0 || s.size>MAX_SOURCE_BYTES) reject('UNSAFE_FILE');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    if(!stat.isFile() || stat.size!==s.size || stat.ino!==s.ino || stat.dev!==s.dev) reject('RACE_DETECTED');
    const data=await handle.readFile();
    return validateSource(basename(path),data,declaredMime);
  } finally { await handle.close(); }
}
export function expandApprovedArchive(name: string, data: Buffer, enabled=false): ValidatedSource[] {
  if(extname(name).toLowerCase()!=='.zip' || !enabled) reject('ARCHIVE_DISABLED');
  if(data.length===0 || data.length>MAX_SOURCE_BYTES) reject('SIZE');
  return zipEntries(data).map(member => validateSource(member.name.split('/').pop()!,member.data));
}
export async function readArchiveFile(path:string):Promise<Buffer> {
  if(extname(path).toLowerCase()!=='.zip')reject('ARCHIVE_EXTENSION');
  const s=await lstat(path);
  if(!s.isFile()||s.isSymbolicLink()||!s.size||s.size>MAX_SOURCE_BYTES)reject('UNSAFE_ARCHIVE');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const f=await handle.stat();if(!f.isFile()||f.ino!==s.ino||f.dev!==s.dev||f.size!==s.size)reject('RACE_DETECTED');return await handle.readFile();}
  finally{await handle.close();}
}
export async function withPrivateStage<T>(run: (stage:string)=>Promise<T>): Promise<T> {
  const stage=await mkdtemp(join(tmpdir(),'knowledge-stage-'));
  await (await import('node:fs/promises')).chmod(stage,0o700);
  try {return await run(stage);} finally {await rm(stage,{recursive:true,force:true});}
}
/** Durable approved originals: operator-managed private storage, not the transient staging directory. */
export async function retainOriginal(root: string, agentId: string, versionId: string, source: ValidatedSource): Promise<string> {
  if(!/^[\da-f-]{36}$/i.test(agentId)|| !/^[\da-f-]{36}$/i.test(versionId)) reject('INVALID_SCOPE');
  const base=resolve(root); await mkdir(base,{recursive:true,mode:0o700});
  const {chmod,lstat:stat}=await import('node:fs/promises');
  if((await stat(base)).isSymbolicLink()) reject('UNSAFE_VAULT');
  await chmod(base,0o700);
  const dir=join(base,agentId,versionId); await mkdir(dir,{recursive:true,mode:0o700}); await chmod(join(base,agentId),0o700);await chmod(dir,0o700);
  const path=join(dir,source.sha256+extname(source.name).toLowerCase());
  try {await writeFile(path,source.data,{flag:'wx',mode:0o600});}
  catch(err) { if((err as NodeJS.ErrnoException).code!=='EEXIST') throw err;
    const existing=await readSourceFile(path);
    if(existing.sha256!==source.sha256) reject('VAULT_COLLISION'); }
  return path;
}
