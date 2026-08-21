import { start } from "./server.js";

// Fixed default port, so review URLs survive server restarts. The env var
// still wins, and a squatted port falls back to a random one (see start()).
const port = Number(process.env.HUMAN_REVIEW_PORT || 8791);
try {
  await start(port);
} catch {
  // start() already reported the cause (e.g. HUMAN_REVIEW_PORT in use).
  process.exit(1);
}

// The detached server exits on its own once idle (see IDLE_SHUTDOWN_MS).
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
