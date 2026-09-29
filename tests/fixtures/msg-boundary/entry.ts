// Fixture for msg-boundary.test.ts: an entry that never names tmux.
import { hop } from "./hop1.ts";

export const entry = (): string => hop();
