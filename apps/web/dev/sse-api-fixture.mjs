/** Development-only API/SSE contract fixture. Never imported by Next production code. */
import { createServer } from "node:http";

const port = Number(process.env.FIXTURE_PORT || 4799);
const ticketId = "11111111-1111-4111-8111-111111111111";
const ticket = { id: ticketId, number: "FIXTURE-001", agentKey: "ancfz", status: "open", subject: null, createdAt: new Date().toISOString() };
const messages = [];
let cursor = 0;
let accepted = false;

function json(res, status, data, cookie = false) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...(cookie ? { "Set-Cookie": "fixture_session=local; HttpOnly; SameSite=Lax; Path=/" } : {}) });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url || "/", "http://localhost").pathname;
  if (req.method === "GET" && path === "/test") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>SSE pending</title><main id="result">Running SSE browser check</main><script>
      (async () => {
        try {
          const created = await fetch('/api/v1/agents/ancfz/tickets', { method: 'POST' });
          const ticket = await created.json();
          const sent = await fetch('/api/v1/tickets/' + ticket.id + '/messages', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ requestId: crypto.randomUUID(), text: 'Fixture input' }) });
          if (created.status !== 201 || sent.status !== 202) throw Error('HTTP contract failure');
          const sse = new EventSource('/api/events/tickets/' + ticket.id);
          const events = [];
          sse.addEventListener('message.accepted', e => { events.push('1:' + e.lastEventId); });
          sse.addEventListener('agent.response.completed', e => {
            events.push('2:' + e.lastEventId);
            document.getElementById('result').textContent = events.join(',') === '1:1,2:2' ? 'SSE RECONNECT PASS' : 'SSE RECONNECT FAIL: ' + events.join(',');
            document.title = events.join(',') === '1:1,2:2' ? 'SSE PASS' : 'SSE FAIL';
            sse.close();
          });
        } catch (error) { document.getElementById('result').textContent = 'SSE ERROR: ' + error.message; document.title = 'SSE FAIL'; }
      })();
    </script>`);
    return;
  }
  const owns = req.headers.cookie?.includes("fixture_session=local");
  if (req.method === "POST" && path === "/api/v1/agents/ancfz/tickets") {
    json(res, 201, ticket, true);
    return;
  }
  if (!owns) { json(res, 404, { code: "NOT_FOUND", message: "Not found" }); return; }
  if (req.method === "GET" && path === `/api/v1/tickets/${ticketId}`) {
    json(res, 200, { ticket, messages });
    return;
  }
  if (req.method === "POST" && path === `/api/v1/tickets/${ticketId}/messages`) {
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch { json(res, 400, { code: "BAD_JSON", message: "Invalid JSON" }); return; }
    if (!payload.text || !payload.requestId) { json(res, 400, { code: "BAD_INPUT", message: "Missing text or ID" }); return; }
    const existing = messages.find((m) => m.requestId === payload.requestId);
    const messageId = existing?.id || "22222222-2222-4222-8222-222222222222";
    if (!existing) messages.push({ id: messageId, requestId: payload.requestId, role: "customer", text: payload.text, createdAt: new Date().toISOString() });
    accepted = true;
    json(res, 202, { ticketId, messageId, requestId: payload.requestId, status: "accepted" });
    return;
  }
  if (req.method === "GET" && path === `/api/events/tickets/${ticketId}`) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "Access-Control-Allow-Origin": "http://127.0.0.1:" + port });
    const last = Number(req.headers["last-event-id"] || 0);
    if (accepted && last < 1) {
      cursor = 1;
      res.write(`id: 1\nevent: message.accepted\ndata: ${JSON.stringify({ message: messages[0] })}\n\n`);
      // Force EventSource to reconnect; browser must send Last-Event-ID: 1.
      setTimeout(() => res.end(), 120);
    } else if (accepted && last === 1) {
      cursor = 2;
      const reply = { id: "33333333-3333-4333-8333-333333333333", role: "assistant", text: "Fixture reply (not Sara)", createdAt: new Date().toISOString(), sourceReferences: [] };
      if (!messages.some((m) => m.id === reply.id)) messages.push(reply);
      res.write(`id: 2\nevent: agent.response.completed\ndata: ${JSON.stringify({ message: reply })}\n\n`);
      setTimeout(() => res.end(), 120);
    } else {
      res.write(`: waiting (cursor=${cursor})\n\n`);
      setTimeout(() => res.end(), 120);
    }
    return;
  }
  json(res, 404, { code: "NOT_FOUND", message: "Not found" });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Development fixture at http://127.0.0.1:${port}\n`);
});
