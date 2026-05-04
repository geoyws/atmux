#!/usr/bin/env bun
// src/cli.ts — top-level CLI dispatcher (ADR-010).
// Phase-0 stub: real dispatcher (verb resolution, alias routing, top-level catch) lands in Phase 1.

export async function main(_argv: string[]): Promise<number> {
  console.error("atmux-bun: not yet implemented");
  return 1;
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
