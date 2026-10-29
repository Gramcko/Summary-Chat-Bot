import { buildApp } from "./app.js";
import { InMemoryStore } from "./lib/store.js";

const port = Number(process.env["PORT"] ?? 3000);
// Safe default: bind to loopback only. Containers set HOST=0.0.0.0.
const host = process.env["HOST"] ?? "127.0.0.1";

const app = await buildApp({
  store: new InMemoryStore(),
  cookieSecure: process.env["COOKIE_SECURE"] === "true",
  logger: process.env["NODE_ENV"] !== "test",
});

await app.listen({ port, host });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
