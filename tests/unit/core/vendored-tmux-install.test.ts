import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { vendoredTmuxVersionTag } from "../../../src/core/tmux-bundle.ts";
import {
  createAtomicSymlink,
  ensureAbsent,
  ensureSafeTree,
  hashFile,
  installManifestPath,
  parseTarBuffer,
  prepareSourceTree,
  readStrictOctalField,
  removePath,
  type TarEntry,
  validateArchiveEntries,
  writeJsonFile,
} from "../../../src/core/vendored-tmux-install.ts";

type TarBuildEntry =
  | {
      path: string;
      type: "file";
      content: string | Uint8Array;
      mode?: number;
      rawSizeField?: string;
      rawModeField?: string;
      rawTypeflag?: string;
    }
  | {
      path: string;
      type: "directory";
      mode?: number;
      rawSizeField?: string;
      rawModeField?: string;
      rawTypeflag?: string;
    }
  | {
      path: string;
      type:
        | "symlink"
        | "hardlink"
        | "character"
        | "block"
        | "fifo"
        | "contiguous"
        | "pax"
        | "global-pax"
        | "other";
      mode?: number;
      rawSizeField?: string;
      rawModeField?: string;
      rawTypeflag?: string;
    };

function encodeString(buffer: Buffer, value: string, start: number, length: number): void {
  buffer.fill(0, start, start + length);
  buffer.write(value, start, Math.min(Buffer.byteLength(value), length), "utf8");
}

function encodeOctal(buffer: Buffer, value: number, start: number, length: number): void {
  const width = length - 1;
  const text = value.toString(8).padStart(width, "0");
  buffer.fill(0, start, start + length);
  buffer.write(text, start + (width - text.length));
}

function buildTar(entries: ReadonlyArray<TarBuildEntry>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512, 0);
    const isDir = entry.type === "directory";
    const path = isDir && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
    encodeString(header, path, 0, 100);
    if (entry.rawModeField !== undefined) {
      encodeString(header, entry.rawModeField, 100, 8);
    } else {
      encodeOctal(header, entry.mode ?? (isDir ? 0o755 : 0o644), 100, 8);
    }
    encodeOctal(header, 0, 108, 8);
    encodeOctal(header, 0, 116, 8);
    const content = entry.type === "file" ? Buffer.from(entry.content) : Buffer.alloc(0);
    if (entry.rawSizeField !== undefined) {
      encodeString(header, entry.rawSizeField, 124, 12);
    } else {
      encodeOctal(header, content.length, 124, 12);
    }
    encodeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    const typeflag = entry.rawTypeflag
      ? entry.rawTypeflag
      : entry.type === "file"
        ? "0"
        : entry.type === "directory"
          ? "5"
          : entry.type === "symlink"
            ? "2"
            : entry.type === "hardlink"
              ? "1"
              : entry.type === "character"
                ? "3"
                : entry.type === "block"
                  ? "4"
                  : entry.type === "fifo"
                    ? "6"
                    : entry.type === "contiguous"
                      ? "7"
                      : entry.type === "pax"
                        ? "x"
                        : entry.type === "global-pax"
                          ? "g"
                          : "7";
    header.write(typeflag, 156, 1, "utf8");
    encodeString(header, "ustar", 257, 6);
    encodeString(header, "00", 263, 2);
    encodeString(header, "root", 265, 32);
    encodeString(header, "wheel", 297, 32);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    encodeOctal(header, checksum, 148, 8);
    chunks.push(header);
    if (content.length > 0) {
      chunks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) {
        chunks.push(Buffer.alloc(padding, 0));
      }
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function gzippedTar(entries: ReadonlyArray<TarBuildEntry>): {
  tar: Buffer;
  gz: Buffer;
  sha256: string;
} {
  const tar = buildTar(entries);
  const gz = gzipSync(tar);
  const sha256 = createHash("sha256").update(gz).digest("hex");
  return { tar, gz, sha256 };
}

function rewriteFieldAndChecksum(
  tar: Buffer,
  offset: number,
  value: string,
  fieldLength: number,
): Buffer {
  const mutated = Buffer.from(tar);
  mutated.fill(0, offset, offset + fieldLength);
  mutated.write(value, offset, Math.min(Buffer.byteLength(value), fieldLength), "utf8");
  mutated.fill(0x20, 148, 156);
  const checksum = mutated.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  mutated.write(checksumText, 148, 6, "utf8");
  mutated[154] = 0;
  mutated[155] = 0x20;
  return mutated;
}

describe("vendored tmux source archive safety", () => {
  test("parseTarBuffer keeps archive member names separate from type metadata", () => {
    const { tar } = gzippedTar([
      { path: "tmux-3.7c", type: "directory" },
      { path: "tmux-3.7c/README", type: "file", content: "hello\n", mode: 0o644 },
    ]);

    const entries = parseTarBuffer(tar);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.path).toBe("tmux-3.7c/");
    expect(entries[0]?.type).toBe("directory");
    expect(entries[1]?.path).toBe("tmux-3.7c/README");
    expect(entries[1]?.type).toBe("file");
    expect(entries[1]?.size).toBe(6);
  });

  test("validateArchiveEntries rejects traversal, absolute, control, and special entries", () => {
    const cases: ReadonlyArray<{ entry: TarEntry; pattern: RegExp }> = [
      { entry: { path: "", type: "file", size: 1, mode: 0o644 }, pattern: /empty path/ },
      { entry: { path: ".", type: "directory", size: 0, mode: 0o755 }, pattern: /ambiguous/ },
      {
        entry: { path: "tmux-3.7c/README/./child", type: "file", size: 1, mode: 0o644 },
        pattern: /not canonical/,
      },
      {
        entry: { path: "tmux-3.7c", type: "file", size: 1, mode: 0o644 },
        pattern: /root must be a directory/,
      },
      {
        entry: { path: "/tmux-3.7c/README", type: "file", size: 1, mode: 0o644 },
        pattern: /absolute/,
      },
      {
        entry: { path: "tmux-3.7c/../README", type: "file", size: 1, mode: 0o644 },
        pattern: /traverses upward/,
      },
      {
        entry: { path: "tmux-3.7c/READ\nME", type: "file", size: 1, mode: 0o644 },
        pattern: /control/,
      },
      {
        entry: { path: "other/README", type: "file", size: 1, mode: 0o644 },
        pattern: /outside expected root/,
      },
      {
        entry: { path: "tmux-3.7c/link", type: "symlink", size: 0, mode: 0o777 },
        pattern: /not allowed/,
      },
      {
        entry: { path: "tmux-3.7c/hard", type: "hardlink", size: 0, mode: 0o777 },
        pattern: /not allowed/,
      },
      {
        entry: { path: "tmux-3.7c/dev", type: "character", size: 0, mode: 0o600 },
        pattern: /not allowed/,
      },
      {
        entry: { path: "tmux-3.7c/fifo", type: "fifo", size: 0, mode: 0o600 },
        pattern: /not allowed/,
      },
    ];

    for (const { entry, pattern } of cases) {
      expect(() =>
        validateArchiveEntries([
          { path: "tmux-3.7c", type: "directory", size: 0, mode: 0o755 },
          entry,
        ]),
      ).toThrow(pattern);
    }

    expect(() =>
      validateArchiveEntries([
        { path: "tmux-3.7c", type: "directory", size: 0, mode: 0o755 },
        { path: "tmux-3.7c/bin", type: "file", size: 1, mode: 0o755 },
        { path: "tmux-3.7c/bin/tmux", type: "file", size: 1, mode: 0o755 },
      ]),
    ).toThrow(/collides with non-directory ancestor/);

    expect(() =>
      validateArchiveEntries([
        { path: "tmux-3.7c", type: "directory", size: 0, mode: 0o755 },
        { path: "tmux-3.7c/bin/tmux", type: "file", size: 1, mode: 0o755 },
        { path: "tmux-3.7c/bin", type: "file", size: 1, mode: 0o755 },
      ]),
    ).toThrow(/collides with non-directory ancestor/);

    expect(
      validateArchiveEntries([
        { path: "tmux-3.7c", type: "directory", size: 0, mode: 0o755 },
        { path: "tmux-3.7c/bin/tmux", type: "file", size: 1, mode: 0o755 },
        { path: "tmux-3.7c/bin", type: "directory", size: 0, mode: 0o755 },
      ]),
    ).toMatchObject({ rootName: "tmux-3.7c" });

    expect(() =>
      validateArchiveEntries([
        { path: "tmux-3.7c", type: "directory", size: 0, mode: 0o755 },
        { path: "tmux-3.7c/README", type: "file", size: 1, mode: 0o644 },
        { path: "tmux-3.7c/README", type: "file", size: 1, mode: 0o644 },
      ]),
    ).toThrow(/duplicated/);

    expect(() => validateArchiveEntries([])).toThrow(/expected root directory/);
  });

  test("parseTarBuffer rejects malformed octal, checksum, and truncated archives", () => {
    const { tar } = gzippedTar([
      { path: "tmux-3.7c", type: "directory" },
      { path: "tmux-3.7c/README", type: "file", content: "hello\n" },
    ]);

    const malformedOctal = rewriteFieldAndChecksum(tar, 124, "00000000x", 12);
    expect(() => parseTarBuffer(malformedOctal)).toThrow(/malformed octal/);

    const badChecksum = Buffer.from(tar);
    badChecksum[0] = badChecksum[0] === 0x74 ? 0x75 : 0x74;
    expect(() => parseTarBuffer(badChecksum)).toThrow(/checksum mismatch/);

    const truncatedPayload = tar.subarray(0, tar.length - 10);
    expect(() => parseTarBuffer(truncatedPayload)).toThrow(
      /two zero blocks terminator|ended mid-payload/,
    );

    const truncatedTerminator = tar.subarray(0, tar.length - 1024);
    expect(() => parseTarBuffer(truncatedTerminator)).toThrow(
      /two zero blocks|trailing non-zero|ended mid-header/,
    );

    expect(() => parseTarBuffer(Buffer.alloc(511))).toThrow(/ended mid-header/);

    const trailingNonZero = Buffer.concat([Buffer.alloc(1024, 0), Buffer.from("x")]);
    expect(() => parseTarBuffer(trailingNonZero)).toThrow(
      /trailing non-zero data after terminator/,
    );
  });

  test("parseTarBuffer and ensureSafeTree cover the remaining type and filesystem branches", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-tar-"));
    try {
      const { tar } = gzippedTar([
        { path: "tmux-3.7c", type: "directory" },
        { path: "tmux-3.7c/hard", type: "hardlink" },
        { path: "tmux-3.7c/char", type: "character" },
        { path: "tmux-3.7c/block", type: "block" },
        { path: "tmux-3.7c/fifo", type: "fifo" },
        { path: "tmux-3.7c/contig", type: "contiguous" },
        { path: "tmux-3.7c/pax", type: "pax" },
        { path: "tmux-3.7c/global", type: "global-pax" },
        { path: "tmux-3.7c/other", type: "other" },
      ]);
      const parsed = parseTarBuffer(tar);
      expect(parsed.map((entry) => entry.type)).toEqual([
        "directory",
        "symlink",
        "character",
        "block",
        "fifo",
        "contiguous",
        "pax",
        "global-pax",
        "contiguous",
      ]);
      expect(
        parseTarBuffer(buildTar([{ path: "tmux-3.7c/hard", type: "hardlink" }]))[0]?.type,
      ).toBe("symlink");
      expect(parseTarBuffer(buildTar([{ path: "tmux-3.7c/link", type: "symlink" }]))[0]?.type).toBe(
        "hardlink",
      );

      const unknownTypeTar = buildTar([{ path: "tmux-3.7c", type: "directory", rawTypeflag: "z" }]);
      expect(parseTarBuffer(unknownTypeTar)).toEqual([
        { path: "tmux-3.7c/", type: "other", size: 0, mode: 0o755 },
      ]);

      const oversizedField = Buffer.alloc(64, 0x37);
      expect(() => readStrictOctalField(oversizedField, 0, oversizedField.length, "mode")).toThrow(
        /out of range/,
      );

      const blankFields = buildTar([
        {
          path: "tmux-3.7c",
          type: "directory",
          rawSizeField: "        ",
          rawModeField: "        ",
        },
      ]);
      expect(parseTarBuffer(blankFields)).toEqual([
        { path: "tmux-3.7c/", type: "directory", size: 0, mode: 0 },
      ]);

      const rootFile = join(scratch, "file-root");
      await writeFile(rootFile, "file\n");
      await expect(ensureSafeTree(rootFile)).rejects.toThrow(/not a directory/);

      const hostile = join(scratch, "hostile");
      await mkdir(hostile, { recursive: true });
      await symlink("README", join(hostile, "link"));
      await expect(ensureSafeTree(hostile)).rejects.toThrow(/symlink/);

      const fifoRoot = join(scratch, "fifo-root");
      await mkdir(fifoRoot, { recursive: true });
      const fifoResult = spawnSync("mkfifo", [join(fifoRoot, "pipe")]);
      expect(fifoResult.status).toBe(0);
      await expect(ensureSafeTree(fifoRoot)).rejects.toThrow(/special entry/);

      const overflowTar = buildTar([{ path: "tmux-3.7c", type: "file", content: "a" }]);
      const midPayload = Buffer.from(overflowTar.subarray(0, 512));
      midPayload.fill(0x20, 148, 156);
      midPayload.write("00000000001", 124, 11, "utf8");
      const midPayloadChecksum = midPayload.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
      const midPayloadChecksumText = midPayloadChecksum.toString(8).padStart(6, "0");
      midPayload.write(midPayloadChecksumText, 148, 6, "utf8");
      midPayload[154] = 0;
      midPayload[155] = 0x20;
      expect(() => parseTarBuffer(midPayload)).toThrow(/ended mid-payload/);

      const midPadding = overflowTar.subarray(0, 512 + 1 + 10);
      expect(() => parseTarBuffer(midPadding)).toThrow(/ended mid-padding/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("filesystem helpers write json, create links, and remove paths", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-tar-"));
    try {
      const jsonPath = join(scratch, "nested", "manifest.json");
      const linkPath = join(scratch, "link");
      const targetPath = join(scratch, "target");
      const treePath = join(scratch, "tree");
      const absentPath = join(scratch, "absent");
      const occupiedLink = join(scratch, "occupied");
      await mkdir(targetPath, { recursive: true });
      await writeJsonFile(jsonPath, { hello: "world" });
      expect(JSON.parse(await readFile(jsonPath, "utf8"))).toEqual({ hello: "world" });
      expect(await hashFile(jsonPath)).toBe(
        createHash("sha256")
          .update(await readFile(jsonPath))
          .digest("hex"),
      );
      await expect(createAtomicSymlink(targetPath, occupiedLink)).resolves.toBeUndefined();
      expect(await readlink(occupiedLink)).toBe(targetPath);
      await expect(createAtomicSymlink(targetPath, occupiedLink)).resolves.toBeUndefined();
      expect(await readlink(occupiedLink)).toBe(targetPath);
      await writeFile(join(scratch, "file"), "occupied\n");
      await expect(createAtomicSymlink(targetPath, join(scratch, "file"))).rejects.toThrow(
        /non-symlink/,
      );
      await expect(ensureAbsent(absentPath)).resolves.toBeUndefined();
      await writeFile(absentPath, "present\n");
      await expect(ensureAbsent(absentPath)).rejects.toThrow(/destination already exists/);
      await createAtomicSymlink(targetPath, linkPath);
      expect(await readlink(linkPath)).toBe(targetPath);
      expect(installManifestPath(scratch)).toBe(
        join(scratch, "vendor", "tmux", "install-manifest.json"),
      );
      await mkdir(treePath, { recursive: true });
      await writeFile(join(treePath, "payload"), "payload\n");
      await removePath(treePath);
      expect(existsSync(treePath)).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("vendored tmux bundle exposes the current version tag", () => {
    expect(vendoredTmuxVersionTag()).toBe("tmux 3.7c");
  });

  test("prepareSourceTree verifies the archive hash before extraction", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-tar-"));
    try {
      const { gz } = gzippedTar([
        { path: "tmux-3.7c", type: "directory" },
        { path: "tmux-3.7c/README", type: "file", content: "hello\n" },
      ]);
      const archivePath = join(scratch, "tmux-3.7c.tar.gz");
      await writeFile(archivePath, gz);
      await expect(
        prepareSourceTree(archivePath, "deadbeef", join(scratch, "extract")),
      ).rejects.toThrow(/sha256 mismatch/);
      expect(existsSync(join(scratch, "extract"))).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("extractTarBufferToRoot rejects a mismatched precomputed validation", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-tar-"));
    try {
      const { tar, gz, sha256 } = gzippedTar([
        { path: "tmux-3.7c", type: "directory" },
        { path: "tmux-3.7c/README", type: "file", content: "hello\n" },
      ]);
      const archivePath = join(scratch, "tmux-3.7c.tar.gz");
      await writeFile(archivePath, gz);
      await expect(
        prepareSourceTree(archivePath, sha256, join(scratch, "extract")),
      ).resolves.toMatchObject({ validation: { rootName: "tmux-3.7c" } });

      const { extractTarBufferToRoot } = await import("../../../src/core/vendored-tmux-install.ts");
      await expect(
        extractTarBufferToRoot(new Uint8Array(tar), join(scratch, "extract-2"), {
          rootName: "tmux-3.7c",
          entries: [{ path: "tmux-3.7c/OTHER", type: "file", size: 1, mode: 0o644 }],
        }),
      ).rejects.toThrow(/does not match archive contents/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("prepareSourceTree extracts the safe archive and ensureSafeTree re-walks without following links", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "atmux-tar-"));
    try {
      const { gz, sha256 } = gzippedTar([
        { path: "tmux-3.7c/README", type: "file", content: "hello\n" },
      ]);
      const archivePath = join(scratch, "tmux-3.7c.tar.gz");
      await writeFile(archivePath, gz);
      const prepared = await prepareSourceTree(archivePath, sha256, join(scratch, "extract"));
      expect(prepared.validation.rootName).toBe("tmux-3.7c");
      expect(existsSync(join(scratch, "extract", "tmux-3.7c", "README"))).toBe(true);

      const hostile = join(scratch, "hostile");
      await mkdir(hostile, { recursive: true });
      await symlink("README", join(hostile, "link"));
      await expect(ensureSafeTree(hostile)).rejects.toThrow(/symlink/);

      const officialArchive = "/private/tmp/tmux-3.7c.tar.gz";
      if (existsSync(officialArchive)) {
        const officialBytes = await readFile(officialArchive);
        const officialSha256 = createHash("sha256").update(officialBytes).digest("hex");
        const official = await prepareSourceTree(
          officialArchive,
          officialSha256,
          join(scratch, "official"),
        );
        expect(official.validation.rootName).toBe("tmux-3.7c");
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
