/**
 * Presentation-only cleanup for conversational messages.
 * Original model text and structured evidence are retained in PostgreSQL.
 * Business PDFs stay accessible only through authenticated action panels.
 */
export function conversationalText(text:string):string {
  return text
    // Native Foundry IQ inline references should not turn into buttons/chips.
    .replace(/【[^】]*†(?:source|file|citation)】/g,"")
    .replace(/\bANCFZ Official Knowledge Reference\b/g,"")
    // Hide chat download links (invoice/quote/knowledge) while leaving the
    // secure quotation and checkout PDF controls available separately.
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_all:string,label:string,url:string)=>{
      if(/(?:\/api\/v1\/tickets\/|download|\.(?:pdf|docx?)(?:[?#]|$))/i.test(url) ||
        /^download\b/i.test(label))return "";
      return label;
    })
    .replace(/https?:\/\/[^\s<>)]+/g,(url:string)=>
      /(?:search\.windows\.net|blob\.core\.windows\.net|\/download\b|\.(?:pdf|docx?)(?:[?#]|$))/i.test(url)
        ? "" : url)
    .replace(/[ \t]{2,}/g," ")
    .replace(/\s+([,.!?;:])/g,"$1")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
}
