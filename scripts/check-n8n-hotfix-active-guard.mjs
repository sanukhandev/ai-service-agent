#!/usr/bin/env node
import assert from "node:assert/strict";
import {requiresUnpublish} from "../infra/n8n/ancfz/upgrade-code-hotfix.mjs";

const workflow=(active,changes)=>({w:{active},changes});
assert.equal(requiresUnpublish(workflow(true,[])),false,
  "Already-patched Salesforce remains running and is never updated");
assert.equal(requiresUnpublish(workflow(true,["Inspect Demo Order Response"])),true,
  "Active payment workflow needing changes is blocked");
assert.equal(requiresUnpublish(workflow(false,["Inspect Demo Order Response"])),false,
  "Inactive payment workflow can be patched");
assert.equal(requiresUnpublish(workflow(false,[])),false,
  "Inactive already-patched workflow requires no update");
console.log("n8n hotfix activation guard PASS: already-patched active untouched; live targets blocked");
