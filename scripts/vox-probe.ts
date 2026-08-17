#!/usr/bin/env bun
// ADR-272: voice operator interface — headless probe CLI (RUNBOOK-vox §6).
//
// Thin shim. All logic lives in `src/core/vox/probe.ts` so it sits
// inside the `src/**` coverage universe — the same split
// `scripts/lint-socket-resolver.ts` → `src/core/socket-resolver-lint.ts`
// already uses.
//
// Usage — the URL carries NO `?token=`; `--token` rides an
// `Authorization: Bearer` header on the upgrade request (pre-upgrade
// gate) and is re-asserted in the `hello` frame. Keeping it out of the
// URL keeps it out of nginx access logs, shell history and `ps`:
//   bun scripts/vox-probe.ts --url ws://127.0.0.1:4390/ws --token "$ATMUX_VOX_TOKEN"
//   bun scripts/vox-probe.ts --url wss://atmux.geoy.ws/ws --token "$T" --seconds 12
//   bun scripts/vox-probe.ts --url ws://127.0.0.1:4390/ws --token "$T" --text "fleet status"
//
// Exit 0 iff a `ready` frame arrived and the socket did not close with an
// error code. All output goes to stderr — stdout stays clean so the probe
// can be piped.

import { formatProbeResult, parseProbeArgs, runProbe } from "../src/core/vox/probe.ts";
import { reportError } from "../src/cli.ts";

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const args = parseProbeArgs(argv);
  const result = await runProbe({
    args,
    log: (line) => {
      process.stderr.write(`vox-probe: ${line}\n`);
    },
  });
  process.stderr.write(`${formatProbeResult(result)}\n`);
  return result.ok ? 0 : 1;
}

let code: number;
try {
  code = await main(process.argv.slice(2));
} catch (e) {
  code = reportError(e);
}
process.exit(code);
