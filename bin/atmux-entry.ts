#!/usr/bin/env bun
// Build entry shim — bun build needs a .ts extension to follow imports.
// At runtime, only bin/atmux is used (which has the same content sans the .ts)
import { main } from "../src/cli.ts";
main(Bun.argv.slice(2)).then((code) => process.exit(code));
