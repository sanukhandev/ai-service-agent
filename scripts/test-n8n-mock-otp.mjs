#!/usr/bin/env node
// Local synthetic OTP delivery smoke. Never use a real customer identifier.
import { randomInt, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = resolve(fileURLToPath(new URL("../", import.meta.url)));
const secret = process.env.ANCFZ_N8N_WEBHOOK_SECRET;
if (typeof secret !== "string" || secret.length < 32) {
  console.error("Set ANCFZ_N8N_WEBHOOK_SECRET privately before running synthetic OTP smoke");
  process.exitCode = 1;
} else {
  const ticketId = randomUUID();
  const otp = String(randomInt(0, 1000000)).padStart(6, "0");
  const result = spawnSync("docker",
    ["compose", "--profile", "workflows", "exec", "-T", "n8n", "node",
      "/workflows/ancfz/test-mock-otp.mjs"],
    {
      cwd, input: JSON.stringify({ ticketId, otp, secret, email: "tester@example.invalid" }),
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 25000,
    });
  if (result.error || result.status !== 0) {
    // The webhook key and code must never appear in diagnostic output.
    console.error("Synthetic OTP smoke failed. Confirm mock mode, active mock workflow, and private Header Auth credential.");
    process.exitCode = 1;
  } else {
    try {
      const outcome = JSON.parse(result.stdout.trim());
      if (!outcome.ok || outcome.status !== "mock_recorded") throw Error();
      console.log("Mock OTP recorded for synthetic ticket " + ticketId +
        "; find the test code in the ANCFZ_POC_OTPS table (expires at " + outcome.expiresAt + ").");
    } catch {
      console.error("Synthetic OTP smoke did not receive a valid mock confirmation.");
      process.exitCode = 1;
    }
  }
}
