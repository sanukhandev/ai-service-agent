#!/usr/bin/env node
/**
 * Creates a one-time n8n credentials import file outside this repository.
 * Source secrets from a local .env file with Node 22 --env-file or process env.
 * Never commit the output or print its contents.
 */
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const template = fileURLToPath(new URL("../infra/n8n/ancfz/credentials.template.json", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--output") {
  console.error("Usage: node [--env-file=/private/ancfz-secrets.env] scripts/prepare-ancfz-credentials.mjs --output /private/ancfz-credentials.json");
  process.exit(2);
}

const output = resolve(args[1]);
const rel = relative(root, output);
if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
  console.error("Refusing to write credential secrets inside the repository. Use a private path outside the checkout.");
  process.exit(2);
}
const required = (name, minLength = 1) => {
  const value = process.env[name]?.trim();
  if (!value || value.length < minLength || /^(REPLACE|CHANGE_ME|YOUR_|<)/i.test(value)) {
    throw new Error("Missing or unsafe configuration: " + name);
  }
  return value;
};
const creds = JSON.parse(readFileSync(template, "utf8"));
if (!Array.isArray(creds) || creds.length !== 4) throw new Error("Unexpected credentials template");
const webhook = creds.find(c => c.name === "ANCFZ - Node to n8n Webhook Header");
const sf = creds.find(c => c.name === "ANCFZ - Salesforce OAuth2 Sandbox");
const smtp = creds.find(c => c.name === "ANCFZ - SMTP OTP Delivery");
const gateway = creds.find(c => c.name === "ANCFZ - MockGateway Demo X-API-Key");
if (![webhook, sf, smtp, gateway].every(Boolean)) throw new Error("Missing ANCFZ credential type in template");

webhook.data = { name: "X-ANCFZ-Workflow-Key", value: required("ANCFZ_N8N_WEBHOOK_SECRET", 32) };
sf.data = {
  grantType: "pkce",
  environment: "sandbox",
  clientId: required("ANCFZ_SALESFORCE_CLIENT_ID", 8),
  clientSecret: required("ANCFZ_SALESFORCE_CLIENT_SECRET", 8),
};
const port = Number(process.env.ANCFZ_SMTP_PORT || "587");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid ANCFZ_SMTP_PORT");
const secure = (process.env.ANCFZ_SMTP_TLS || "starttls").trim().toLowerCase();
if (secure !== "starttls" && secure !== "implicit") throw new Error("ANCFZ_SMTP_TLS must be starttls or implicit");
smtp.data = {
  host: required("ANCFZ_SMTP_HOST", 3),
  port,
  secure: secure === "implicit",
  disableStartTls: false,
  user: required("ANCFZ_SMTP_USER", 3),
  password: required("ANCFZ_SMTP_PASSWORD", 8),
};
gateway.data = { name: "X-API-Key", value: required("ANCFZ_MOCKGATEWAY_API_KEY", 16) };

const json = JSON.stringify(creds, null, 2) + "\n";
// Exclusive write prevents accidental overwrites of credentials already generated.
// File permissions must be restricted at creation time, not as a later step.
writeFileSync(output, json, { flag: "wx", mode: 0o600 });
chmodSync(output, 0o600);
console.log("Prepared an n8n credential import file at " + output);
console.log("Contains plaintext secrets: import into n8n privately, then remove this temporary file.");
console.log("Salesforce OAuth2 is not connected yet: authorize the imported credential in n8n before enabling any workflow.");
