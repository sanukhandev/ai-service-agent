#!/usr/bin/env node
/** Static localhost n8n proxy contract; does not contact Docker or providers. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const compose=readFileSync(new URL("../docker-compose.yml",import.meta.url),"utf8");
const nginx=readFileSync(new URL("../infra/nginx/default.conf",import.meta.url),"utf8");
const block=name=>compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [\\w-]+:\\n|\\nnetworks:)`))?.[1]??"";
const edge=block("nginx"), n8n=block("n8n");
assert(edge.includes('"127.0.0.1:80:80"'),"local Nginx must bind loopback only");
assert(edge.includes("networks: [frontend, backend]"),"Nginx must reach private n8n");
assert(!/^    ports:/m.test(n8n),"n8n cannot publish host ports");
assert(n8n.includes("N8N_PATH: /n8n/"));
assert(n8n.includes("N8N_EDITOR_BASE_URL: http://localhost/n8n/"));
assert(n8n.includes("N8N_WEBHOOK_URL: http://n8n:5678/"));
assert(n8n.includes('N8N_PROXY_HOPS: "1"'));
assert(nginx.includes("location = /n8n"));
assert(nginx.includes("return 308 /n8n/"));
assert(nginx.includes("rewrite ^/n8n/(.*)$ /$1 break;"),"browser path must strip /n8n");
assert(nginx.includes("proxy_pass http://$n8n_upstream;"));
assert(nginx.includes("resolver 127.0.0.11"),"optional n8n must not break Nginx startup");
assert(nginx.includes("proxy_set_header Upgrade $http_upgrade;"));
assert(nginx.includes("proxy_set_header Connection $n8n_connection_upgrade;"));
assert(nginx.includes("proxy_buffering off;"));
assert(nginx.includes("location ~ ^/n8n/(?:webhook|webhook-test|webhook-waiting|form|form-test|form-waiting|mcp|mcp-test)"),"private n8n triggers cannot be public");
assert(nginx.includes("return 404;"));
assert(nginx.includes("location /api/"));
assert(nginx.includes("location / {"));
for(const file of ["n8n-lead-worker.ts","n8n-quote-worker.ts"]) {
  const node=readFileSync(new URL("../services/api/src/runtime/"+file,import.meta.url),"utf8");
  assert(node.includes("http://n8n:5678/webhook/"),"private worker URLs must not go through public Nginx");
}
console.log("Local n8n proxy PASS: /n8n editor, loopback ingress, private webhooks, no app-route regression");
