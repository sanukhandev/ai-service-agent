/** Approved source normalization for independent Node evidence verification.
 * Data is untrusted; normalized text is never an instruction to the agent.
 * Scanned/empty PDFs require a separate operator-approved OCR artifact.
 */
import { PDFParse } from "pdf-parse";
import { zipEntries } from "./intake.js";

// Hard ceiling for trusted normalized source text; source/archive byte caps remain enforced.
const MAX_NORMALIZED_CHARACTERS = 1_000_000;

function xmlText(raw:string):string {
  return raw.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,(source,token:string)=>{
    const named:Record<string,string>={amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};
    if(named[token])return named[token];
    const radix=token.startsWith("#x")?16:10;
    const n=Number.parseInt(token.slice(radix===16?2:1),radix);
    return Number.isFinite(n)&&n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)
      ?String.fromCodePoint(n):source;
  });
}

function docxText(bytes:Buffer):string {
  const entries=zipEntries(bytes);
  const main=entries.find(x=>x.name==="word/document.xml");
  if(!main)throw new Error("KNOWLEDGE_MISSING_DOCX_TEXT");
  const xml=new TextDecoder("utf-8",{fatal:true}).decode(main.data);
  const paragraphs:string[]=[];
  let totalCharacters=0;
  for(const m of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)){
    const parts:string[]=[];
    const body=m[1]??"";
    for(const fragment of body.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br|cr)\s*\/?\s*>/g)){
      if(fragment[1]!==undefined)parts.push(xmlText(fragment[1]));
      else parts.push(" ");
    }
    const paragraph=parts.join("");
    if(!paragraph.trim())continue;
    totalCharacters+=paragraph.length+(paragraphs.length?1:0);
    if(totalCharacters>MAX_NORMALIZED_CHARACTERS)
      throw new Error("KNOWLEDGE_NORMALIZED_TEXT_TOO_LARGE");
    paragraphs.push(paragraph);
  }
  return paragraphs.join("\n");
}

export async function normalizedSourceText(bytes:Buffer,mime:string):Promise<string> {
  if(bytes.byteLength===0 || bytes.byteLength>20*1024*1024)
    throw new Error("KNOWLEDGE_UNSAFE_SOURCE_SIZE");
  let text:string;
  if(mime==="text/plain"||mime==="text/markdown"){
    text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  }else if(mime==="application/vnd.openxmlformats-officedocument.wordprocessingml.document"){
    text=docxText(bytes);
  }else if(mime==="application/pdf"){
    const parser=new PDFParse({data:new Uint8Array(bytes)});
    try {text=(await parser.getText()).text;}
    finally{await parser.destroy();}
  }else{
    throw new Error("KNOWLEDGE_UNSUPPORTED_EXTRACTION");
  }
  const normalized=text.replace(/\r\n?/g,"\n").replace(/[\u0000-\u0008\u000b\u000e-\u001f]/g,"").trim();
  if(!normalized)throw new Error("KNOWLEDGE_OCR_OR_TEXT_EXTRACTION_REQUIRED");
  if(normalized.length>MAX_NORMALIZED_CHARACTERS)
    throw new Error("KNOWLEDGE_NORMALIZED_TEXT_TOO_LARGE");
  return normalized;
}
