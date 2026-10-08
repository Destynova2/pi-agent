import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";

// Listeners exist only inside the disposable container. Preserve localhost origins
// for selected development services without publishing ports or sharing host files.
const ports = process.argv.slice(2);
if (ports.length > 16 || new Set(ports).size !== ports.length || ports.some(port => !/^[1-9][0-9]{3,4}$/.test(port) || Number(port) < 1024 || Number(port) > 65535)) {
  throw new Error("Expected at most 16 distinct localhost ports from 1024 to 65535");
}
for (const port of ports) {
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createServer(client => {
      const upstream = createConnection({ host: "host.containers.internal", port: Number(port) });
      const timer = setTimeout(() => upstream.destroy(), 5000);
      upstream.once("connect", () => { clearTimeout(timer); client.pipe(upstream); upstream.pipe(client); });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      upstream.once("close", () => { clearTimeout(timer); client.destroy(); });
      client.once("close", () => upstream.destroy());
    });
    server.maxConnections = 64;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(port), host, resolve); });
  }
}
const child = spawn(process.execPath, ["/opt/pi-browser/node_modules/@playwright/mcp/cli.js",
  "--headless", "--browser", "chromium", "--no-sandbox", "--isolated", "--output-dir", "/tmp/artifacts"], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.once("error", error => { console.error(error.message); process.exit(1); });
child.once("exit", (code, signal) => process.exit(code ?? (signal === "SIGINT" ? 130 : 143)));
