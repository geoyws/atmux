import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { vendoredTmuxArchiveRoot } from "./tmux-bundle.ts";

export type TarEntryType =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "character"
  | "block"
  | "fifo"
  | "contiguous"
  | "pax"
  | "global-pax"
  | "other";

export interface TarEntry {
  path: string;
  type: TarEntryType;
  size: number;
  mode: number;
}

export interface ArchiveValidation {
  rootName: string;
  entries: TarEntry[];
}

export interface PreparedSourceTree {
  archiveSha256: string;
  archivePath: string;
  extractedRoot: string;
  validation: ArchiveValidation;
}

export interface TmuxSourceBundleManifest {
  version: string;
  sourceUrl: string;
  sourceSha256: string;
  archiveSha256: string;
  builtBinaryPath: string;
  builtBinarySha256: string;
  installedBinaryPath: string;
  installedRoot: string;
}

const EXPECTED_ARCHIVE_ROOT = vendoredTmuxArchiveRoot();

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readCString(buffer: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) {
    const byte = buffer[i];
    if (byte === undefined || byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

export function readStrictOctalField(
  buffer: Uint8Array,
  start: number,
  end: number,
  label: string,
): number {
  const raw = readCString(buffer, start, end).trim();
  if (raw.length === 0) {
    return 0;
  }
  if (!/^[0-7]+$/u.test(raw)) {
    throw new Error(`tar header ${label} field is malformed octal`);
  }
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`tar header ${label} field is out of range`);
  }
  return parsed;
}

function computeHeaderChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < header.length; i += 1) {
    sum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
  }
  return sum;
}

function typeflagToType(typeflag: number): TarEntryType {
  switch (typeflag) {
    case 0:
    case 48:
      return "file";
    case 53:
      return "directory";
    case 49:
      return "symlink";
    case 50:
      return "hardlink";
    case 51:
      return "character";
    case 52:
      return "block";
    case 54:
      return "fifo";
    case 55:
      return "contiguous";
    case 120:
      return "pax";
    case 103:
      return "global-pax";
    default:
      return "other";
  }
}

function hasControlCharacters(pathname: string): boolean {
  return /[\0\r\n\t]/.test(pathname);
}

function normalizeArchivePath(pathname: string): string {
  return pathname.replace(/\/+$/u, "");
}

function ensureSafeArchivePath(pathname: string): string {
  const trimmed = normalizeArchivePath(pathname);
  if (trimmed.length === 0) {
    throw new Error("archive member has an empty path");
  }
  if (hasControlCharacters(trimmed) || trimmed.includes("\\")) {
    throw new Error(`archive member path contains control or escape characters: ${pathname}`);
  }
  if (posix.isAbsolute(trimmed) || /^[a-zA-Z]:/u.test(trimmed)) {
    throw new Error(`archive member path is absolute: ${pathname}`);
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error(`archive member path is ambiguous: ${pathname}`);
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "..")) {
    throw new Error(`archive member path traverses upward: ${pathname}`);
  }
  const normalized = posix.normalize(trimmed);
  if (normalized !== trimmed) {
    throw new Error(`archive member path is not canonical: ${pathname}`);
  }
  return normalized;
}

interface ParsedTarHeader {
  entry: TarEntry;
  dataOffset: number;
}

function readTarHeader(buffer: Uint8Array, offset: number): ParsedTarHeader | null {
  if (offset + 512 > buffer.length) {
    throw new Error("tar archive ended mid-header");
  }
  const header = buffer.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) {
    const remainder = buffer.subarray(offset);
    if (remainder.length < 1024) {
      throw new Error("tar archive ended before the two zero blocks terminator");
    }
    if (remainder.some((byte) => byte !== 0)) {
      throw new Error("tar archive has trailing non-zero data after terminator");
    }
    return null;
  }

  const declaredChecksum = readStrictOctalField(header, 148, 156, "checksum");
  const computedChecksum = computeHeaderChecksum(header);
  if (declaredChecksum !== computedChecksum) {
    throw new Error(
      `tar header checksum mismatch: got ${declaredChecksum}, expected ${computedChecksum}`,
    );
  }

  const rawName = readCString(header, 0, 100);
  const rawPrefix = readCString(header, 345, 500);
  const rawPath = rawPrefix.length > 0 ? `${rawPrefix}/${rawName}` : rawName;
  const size = readStrictOctalField(header, 124, 136, "size");
  const mode = readStrictOctalField(header, 100, 108, "mode");
  const type = typeflagToType(header[156] ?? 0);

  if (offset + 512 + size > buffer.length) {
    throw new Error(`tar archive ended mid-payload for ${rawPath || "<unknown>"}`);
  }
  const padding = (512 - (size % 512)) % 512;
  if (offset + 512 + size + padding > buffer.length) {
    throw new Error(`tar archive ended mid-padding for ${rawPath || "<unknown>"}`);
  }

  return {
    entry: {
      path: rawPath,
      type,
      size,
      mode,
    },
    dataOffset: offset + 512,
  };
}

function isAncestorPath(ancestor: string, candidate: string): boolean {
  return candidate.startsWith(`${ancestor}/`);
}

function archiveValidationMatches(left: ArchiveValidation, right: ArchiveValidation): boolean {
  if (left.rootName !== right.rootName || left.entries.length !== right.entries.length) {
    return false;
  }
  return left.entries.every((entry, index) => {
    const other = right.entries[index];
    return (
      other !== undefined &&
      entry.path === other.path &&
      entry.type === other.type &&
      entry.size === other.size &&
      entry.mode === other.mode
    );
  });
}

function validateNormalizedEntries(
  entries: ReadonlyArray<TarEntry>,
  expectedRoot: string,
): ArchiveValidation {
  const validated: TarEntry[] = [];
  const seen = new Map<string, TarEntryType>();
  if (entries.length === 0) {
    throw new Error(`archive must contain expected root directory ${expectedRoot}`);
  }

  for (const entry of entries) {
    if (entry.type !== "file" && entry.type !== "directory") {
      throw new Error(`archive member type is not allowed: ${entry.path} (${entry.type})`);
    }

    const safePath = ensureSafeArchivePath(entry.path);
    if (safePath !== expectedRoot && !isAncestorPath(expectedRoot, safePath)) {
      throw new Error(`archive member lies outside expected root ${expectedRoot}: ${entry.path}`);
    }

    if (safePath === expectedRoot) {
      if (entry.type !== "directory") {
        throw new Error(`archive root must be a directory: ${entry.path}`);
      }
    }

    for (const [existingPath, existingType] of seen.entries()) {
      if (existingPath === safePath) {
        throw new Error(`archive member path is duplicated after normalization: ${safePath}`);
      }
      if (isAncestorPath(existingPath, safePath)) {
        if (existingType !== "directory") {
          throw new Error(
            `archive member collides with non-directory ancestor: ${existingPath} vs ${safePath}`,
          );
        }
      } else if (isAncestorPath(safePath, existingPath)) {
        if (entry.type !== "directory") {
          throw new Error(
            `archive member collides with non-directory ancestor: ${safePath} vs ${existingPath}`,
          );
        }
      }
    }

    seen.set(safePath, entry.type);
    validated.push({ ...entry, path: safePath });
  }

  return { rootName: expectedRoot, entries: validated };
}

export function parseTarBuffer(buffer: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let terminated = false;

  while (offset < buffer.length) {
    const parsed = readTarHeader(buffer, offset);
    if (parsed === null) {
      terminated = true;
      break;
    }

    entries.push(parsed.entry);
    const contentEnd = parsed.dataOffset + parsed.entry.size;
    const padding = (512 - (parsed.entry.size % 512)) % 512;
    offset = contentEnd + padding;
  }

  if (!terminated) {
    throw new Error("tar archive ended before the two zero blocks terminator");
  }

  return entries;
}

export function validateArchiveEntries(entries: ReadonlyArray<TarEntry>): ArchiveValidation {
  return validateNormalizedEntries(entries, EXPECTED_ARCHIVE_ROOT);
}

export async function extractTarBufferToRoot(
  buffer: Uint8Array,
  destRoot: string,
  validation?: ArchiveValidation,
): Promise<ArchiveValidation> {
  const parsed = validateArchiveEntries(parseTarBuffer(buffer));
  if (validation !== undefined && !archiveValidationMatches(validation, parsed)) {
    throw new Error("supplied archive validation does not match archive contents");
  }
  const rootPath = join(destRoot, parsed.rootName);
  await mkdir(destRoot, { recursive: true });

  let offset = 0;
  while (offset < buffer.length) {
    const header = readTarHeader(buffer, offset);
    if (header === null) {
      break;
    }

    const normalized = ensureSafeArchivePath(header.entry.path);
    const target = join(destRoot, normalized);
    if (header.entry.type === "directory") {
      await mkdir(target, { recursive: true });
    } else if (header.entry.type === "file") {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        buffer.subarray(header.dataOffset, header.dataOffset + header.entry.size),
      );
      if (header.entry.mode > 0) {
        await chmod(target, header.entry.mode & 0o777);
      }
    }

    const padding = (512 - (header.entry.size % 512)) % 512;
    offset = header.dataOffset + header.entry.size + padding;
  }

  await ensureSafeTree(rootPath);
  return parsed;
}

export async function ensureSafeTree(root: string): Promise<void> {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`extracted source root is not a directory: ${root}`);
  }

  async function walk(dir: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const full = join(dir, dirent.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) {
        throw new Error(`extracted tree contains symlink: ${full}`);
      }
      if (stat.isCharacterDevice() || stat.isBlockDevice() || stat.isFIFO() || stat.isSocket()) {
        throw new Error(`extracted tree contains special entry: ${full}`);
      }
      if (stat.isDirectory()) {
        await walk(full);
      }
    }
  }

  await walk(root);
}

export async function readArchiveFile(archivePath: string): Promise<Uint8Array> {
  return await readFile(archivePath);
}

export async function verifyArchiveSha256(
  archivePath: string,
  expectedSha256: string,
): Promise<{ archiveSha256: string; bytes: Uint8Array }> {
  const bytes = await readArchiveFile(archivePath);
  const archiveSha256 = sha256Hex(bytes);
  if (archiveSha256 !== expectedSha256) {
    throw new Error(
      `tmux source archive sha256 mismatch: got ${archiveSha256}, expected ${expectedSha256}`,
    );
  }
  return { archiveSha256, bytes };
}

export async function prepareSourceTree(
  archivePath: string,
  expectedSha256: string,
  destRoot: string,
): Promise<PreparedSourceTree> {
  const { archiveSha256, bytes } = await verifyArchiveSha256(archivePath, expectedSha256);
  const tar = gunzipSync(bytes);
  const validation = validateArchiveEntries(parseTarBuffer(tar));
  const extractedRoot = join(destRoot, validation.rootName);
  await extractTarBufferToRoot(tar, destRoot, validation);
  return { archiveSha256, archivePath, extractedRoot, validation };
}

export async function hashFile(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function ensureAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`destination already exists: ${path}`);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export async function createAtomicSymlink(target: string, linkPath: string): Promise<void> {
  const parent = dirname(linkPath);
  const tmpLink = join(
    parent,
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(parent, { recursive: true });

  if (existsSync(linkPath)) {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink destination: ${linkPath}`);
    }
  }

  await rm(tmpLink, { force: true });
  await symlink(target, tmpLink);
  await rename(tmpLink, linkPath);
}

export async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function installManifestPath(versionRoot: string): string {
  return join(versionRoot, "vendor", "tmux", "install-manifest.json");
}
