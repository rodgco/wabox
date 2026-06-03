// Convenience entry for `npm start` / running from a checkout.
// The real CLI lives in bin/cli.js (the `wabox` command).
import { startGateway } from './src/gateway.js';

startGateway().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
