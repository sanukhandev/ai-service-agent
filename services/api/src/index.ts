import { PersistenceDatabase } from "./database/pool.js";
import { createApi } from "./runtime/app.js";
import { TurnQueue } from "./runtime/turn-queue.js";
import { TurnWorker } from "./runtime/turn-worker.js";

const port=Number(process.env.API_PORT??"4000");
const host=process.env.API_HOST??"0.0.0.0";
if(!Number.isSafeInteger(port)||port<1||port>65535) throw new Error("Invalid API_PORT");

const db=new PersistenceDatabase(process.env.DATABASE_URL);
const queue=new TurnQueue(db);
const app=createApi(db,queue);
const worker=new TurnWorker(db,queue,(data,message)=>app.log.info(data,message));
app.addHook("onClose",async()=>{
  worker.stop();
  await db.close();
});

const shutdown=()=>{void app.close();};
process.on("SIGTERM",shutdown);
process.on("SIGINT",shutdown);

try {
  await db.assertSafeRuntimeRole();
  await app.listen({host,port});
  await worker.start();
} catch(error) {
  app.log.error({errorCode:(error as Error).name,message:(error as Error).message},"Runtime startup failed");
  process.exitCode=1;
  await app.close();
}
