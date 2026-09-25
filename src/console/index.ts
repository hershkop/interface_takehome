import { startConsole } from "./server.js";

const { url } = await startConsole();
process.stdout.write(
  `\n  Capability console: ${url}\n` +
    `  Local only, no authentication — it can start browser sessions and read evidence.\n\n`,
);
