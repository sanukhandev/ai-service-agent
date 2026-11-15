#!/usr/bin/env node
/** POC offline concurrency gate: no Foundry, Postgres or n8n calls. */
import assert from "node:assert/strict";
import { TurnWorker } from "../services/api/dist/runtime/turn-worker.js";

const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
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
  assert.deepEqual(started,["1","2","3"],"Only three independent ticket turns may run initially");
  release.get("1")();
  await sleep(80);
  assert.deepEqual(started,["1","2","3","4"],"Completing one turn schedules another queued ticket");
  for(const resolve of release.values())resolve();
  await sleep(30);
  console.log("Bounded turn worker PASS: three independent requests, backpressure and replacement claim");
} finally {worker.stop();}
