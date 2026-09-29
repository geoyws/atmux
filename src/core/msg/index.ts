// ADR-292: `atmux msg` mailbox — barrel (excluded from the coverage
// denominator per bunfig.toml's `**/index.ts` rule, like every other
// barrel). All logic lives in `./mailbox.ts`.
export * from "./mailbox.ts";
