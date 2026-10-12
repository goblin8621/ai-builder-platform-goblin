import { strToU8, zipSync, type Zippable } from 'fflate';
import { AppError } from '../errors/index.js';

/**
 * Packaging + download helpers (10번 §15: BFF owns file composition, ZIP and
 * the download response; Brain never produces ZIP bytes).
 *
 * Reproducible ZIP (Phase 9 확정 결정 #6): same files in ⇒ same bytes out.
 *  - entry order = the order Brain gives (already sorted); never re-sorted here
 *  - one FIXED mtime for every entry (see FIXED_MTIME)
 *  - UTF-8 names/content; fixed compression level
 *  - `fflate` is pinned to an exact version in package.json because the
 *    deflate output is part of the bytes.
 */

export type PackageFile = { path: string; content: string };

/**
 * ZIP stores a DOS timestamp with NO timezone, and fflate reads it through
 * LOCAL-time getters. Building the Date from local components makes the
 * stored value 1980-01-01 00:00:00 on every machine and TZ (1980 is the
 * earliest representable DOS date) — `new Date(Date.UTC(1980, ...))` would
 * NOT be stable across timezones.
 *
 * Built per call, never cached at module load: a cached Date is an absolute
 * instant in the TZ that was active at import time, which falls outside the
 * DOS range (or changes the bytes) if the process TZ differs later.
 */
function fixedMtime(): Date {
  return new Date(1980, 0, 1, 0, 0, 0);
}
const COMPRESSION_LEVEL = 6;

/**
 * Every ZIP entry path must be ASCII-safe (Phase 9 확정 결정): ASCII letters,
 * digits and `._-`, each segment starting with an alphanumeric, `/` as the
 * only separator. That excludes absolute paths, `.`/`..`, hidden files,
 * backslashes, control characters, empty segments and ANY non-ASCII name —
 * so a package extracts identically with every tool on every platform.
 * Brain already derives paths this way; this re-check is defense in depth.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_PATH_LENGTH = 200;

function assertSafeSegment(value: string, what: string): void {
  const unsafe = value.length === 0 || value.length > MAX_PATH_LENGTH || !value.split('/').every((s) => SAFE_SEGMENT.test(s));
  if (unsafe) {
    throw new AppError('internal_error', `Refusing to package an unsafe ${what}`, { code: 'EXPORT_UNSAFE_PATH' });
  }
}

export function buildZip(packageRoot: string, files: PackageFile[]): Uint8Array {
  assertSafeSegment(packageRoot, 'package root');
  if (packageRoot.includes('/')) {
    throw new AppError('internal_error', 'Package root must be a single folder name', { code: 'EXPORT_UNSAFE_PATH' });
  }

  const entries: Zippable = {};
  for (const file of files) {
    assertSafeSegment(file.path, 'file path');
    const entryPath = `${packageRoot}/${file.path}`;
    if (entryPath in entries) {
      throw new AppError('internal_error', 'Export produced duplicate file paths', {
        code: 'EXPORT_INTERNAL_PATH_COLLISION',
      });
    }
    entries[entryPath] = [strToU8(file.content), { level: COMPRESSION_LEVEL, mtime: fixedMtime() }];
  }
  return zipSync(entries);
}

/**
 * RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name (Korean Skill
 * names stay readable) with no way to inject header syntax or CR/LF.
 */
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
