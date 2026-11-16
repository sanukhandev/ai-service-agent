/** Display-only filtering. Keep citations and private knowledge links hidden,
 * but allow ONLY owner-ticket quotation/invoice URLs and trusted sandbox
 * checkout URLs explicitly issued by Node workflow notices.
 */
export function safeChatTransactionUrl(url:string,ticketId?:string):boolean{
  if(!ticketId || !/^[0-9a-f-]{36}$/i.test(ticketId))return false;
  const prefix="/api/v1/tickets/"+encodeURIComponent(ticketId)+"/";
  if(url.startsWith(prefix)){
    const suffix=url.slice(prefix.length);
    return /^(?:quotations|invoices)\/[0-9a-f-]{36}\/pdf$/i.test(suffix);
  }
  try{
    const u=new URL(url);
    return u.protocol==="https:" && u.hostname==="mockgateway.com" &&
      /^\/pg\/pay\/[A-Za-z0-9_-]+\/?$/.test(u.pathname) &&
      !u.username&&!u.password&&!u.search&&!u.hash;
  }catch{return false;}
}

export function conversationalText(text:string,ticketId?:string):string{
  return text
    .replace(/【[^】]*†(?:source|file|citation)】/g,"")
    .replace(/\bANCFZ Official Knowledge Reference\b/g,"")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,(_all:string,label:string,url:string)=>{
      if(safeChatTransactionUrl(url,ticketId))return "["+label+"]("+url+")";
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
