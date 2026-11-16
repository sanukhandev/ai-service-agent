#!/usr/bin/env node
/** POC offline concurrency gate: no Foundry, Postgres or n8n calls. */
import assert from "node:assert/strict";
import { TurnWorker } from "../services/api/dist/runtime/turn-worker.js";

const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
// Regression-check the default conservative setting, and the explicit 3-slot override.
process.env.FOUNDRY_TURN_CONCURRENCY="1";
const claimed=[1,2,3,4].map(id=>({id:String(id)}));
const started=[];
const release=new Map();
const queue={
  reconcileMissing:async()=>0,
  recoverAbandoned:async()=>0,
  claim:async()=>claimed.shift()??null,
};
const worker=new TurnWorker({},queue,()=>{});
worker.process=async turn=>{
  started.push(turn.id);
  await new Promise(resolve=>release.set(turn.id,resolve));
};
try {
  await worker.start();
  await sleep(80);
  assert.deepEqual(started,["1"],"Default throttle allows only one ticket turn");
  release.get("1")();
  await sleep(80);
  assert.deepEqual(started,["1","2"],"Completing one turn schedules the next queued ticket");
  release.get("2")();
  await sleep(80);
  assert.deepEqual(started,["1","2","3"]);
  release.get("3")();
  await sleep(80);
  assert.deepEqual(started,["1","2","3","4"]);
  for(const resolve of release.values())resolve();
  await sleep(30);
  console.log("Bounded turn worker PASS: conservative serial execution and next ticket scheduling");
} finally {worker.stop();}
