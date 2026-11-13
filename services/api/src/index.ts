import Fastify from "fastify";

const app = Fastify({
  logger: true,
  trustProxy: false, // Set trusted ingress explicitly when external auth is introduced.
});

app.get("/api/health", async () => ({
  status: "ok",
  service: "api",
}));

const port = Number(process.env.API_PORT ?? "4000");
const host = process.env.API_HOST ?? "0.0.0.0";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT must be a valid TCP port");
}

const shutdown = async () => {
  await app.close();
};
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
