#!/usr/bin/env node
// Only used by the operator's local smoke script. Never installed as a webhook.
let input = "";
for await (const chunk of process.stdin) {
  input += chunk.toString("utf8");
  if (input.length > 4096) throw Error("Invalid local test request size");
}
try {
  if (process.env.APP_ENV !== "development" || process.env.ANCFZ_OTP_MOCK_ENABLED !== "true") {
    throw Error("Synthetic OTP smoke is not enabled in this n8n container");
  }
  const payload = JSON.parse(input);
  if (!/^[a-f0-9-]{36}$/i.test(payload.ticketId) ||
      !/^\d{6}$/.test(payload.otp) ||
      payload.email !== "tester@example.invalid" ||
      typeof payload.secret !== "string" || payload.secret.length < 32) {
    throw Error("Invalid synthetic OTP test request");
  }
  const response = await fetch("http://127.0.0.1:5678/webhook/ancfz/otp-email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-ANCFZ-Workflow-Key": payload.secret,
    },
    body: JSON.stringify({
      agentKey: "ancfz",
      ticketId: payload.ticketId,
      email: payload.email,
      otp: payload.otp,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error("Mock delivery webhook rejected request (HTTP " + response.status + ")");
  const data = await response.json();
  if (data.status !== "mock_recorded" || data.delivered !== false || data.testOnly !== true) {
    throw Error("Expected mock-only response. Do not use the SMTP workflow during this test");
  }
  process.stdout.write(JSON.stringify({
    ok: true, status: data.status, ticketId: payload.ticketId,
    expiresAt: data.expiresAt, delivered: false,
  }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: String(error?.message || "Synthetic OTP dispatch failed").slice(0,180),
  }) + "\n");
  process.exitCode = 1;
}
