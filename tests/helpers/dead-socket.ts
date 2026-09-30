// A DEAD unix socket on a real disk: a child process listens at the path
// and is SIGKILLed, so nothing unlinks the node and a connect() to it is
// refused (ECONNREFUSED) — the exact shape a crashed tmux server leaves.
// (Closing an in-process listener would unlink the node instead.)

export async function deadUnixSocket(path: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const reader = child.stdout.getReader();
  await reader.read();
  reader.releaseLock();
  child.kill(9);
  await child.exited;
}
