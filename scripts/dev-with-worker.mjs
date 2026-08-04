import { spawn } from "node:child_process";

const children = new Set();
let shuttingDown = false;

function start(name, args) {
  const child = spawn("npx", args, {
    stdio: "inherit",
    env: process.env,
  });
  children.add(child);

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      const label = signal ? `${signal}` : `exit ${code ?? 0}`;
      console.error(`[${name}] stopped (${label}); stopping dev services`);
      shutdown(code ?? 1);
    }
  });

  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

start("api", ["tsx", "watch", "src/server.ts"]);
start("study-guide-worker", ["tsx", "watch", "src/worker.ts"]);
