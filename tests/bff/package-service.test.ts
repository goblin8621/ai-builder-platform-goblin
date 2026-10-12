import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { buildZip, contentDisposition } from '../../bff/src/skill-exports/package.service.js';

const files = [
  { path: 'SKILL.md', content: '# Skill\n한글 내용\n' },
  { path: 'children/parser/skill.json', content: '{"a":1}\n' },
  { path: 'manifest.json', content: '{}\n' },
  { path: 'references/document-928ac031.txt', content: 'doc body' },
];

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** Walks the central directory and returns each entry's [name, dosTime, dosDate]. */
function dosTimestamps(zip: Uint8Array): { name: string; time: number; date: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries: { name: string; time: number; date: number }[] = [];
  let offset = 0;
  while (offset + 46 <= zip.length) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      offset += 1;
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    entries.push({
      name: strFromU8(zip.subarray(offset + 46, offset + 46 + nameLength)),
      time: view.getUint16(offset + 12, true),
      date: view.getUint16(offset + 14, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('buildZip', () => {
  it('puts every file under the package root folder with the exact content (UTF-8 content, ASCII names)', () => {
    const entries = unzipSync(buildZip('my-skill', files));
    expect(Object.keys(entries)).toEqual([
      'my-skill/SKILL.md',
      'my-skill/children/parser/skill.json',
      'my-skill/manifest.json',
      'my-skill/references/document-928ac031.txt',
    ]);
    expect(strFromU8(entries['my-skill/SKILL.md'])).toBe('# Skill\n한글 내용\n');
    expect(strFromU8(entries['my-skill/references/document-928ac031.txt'])).toBe('doc body');
  });

  it('keeps the entry order Brain provided (never re-sorts)', () => {
    const reversed = [...files].reverse();
    expect(Object.keys(unzipSync(buildZip('r', reversed)))).toEqual(reversed.map((f) => `r/${f.path}`));
  });

  it('is byte-for-byte reproducible', () => {
    expect(sha256(buildZip('s', files))).toBe(sha256(buildZip('s', files)));
  });

  it('is identical in every timezone (ZIP has no timezone; the stored mtime must not depend on it)', () => {
    const hashes = ['UTC', 'Asia/Seoul', 'America/Los_Angeles', 'Pacific/Auckland', 'Asia/Kolkata'].map((tz) => {
      process.env.TZ = tz;
      return sha256(buildZip('s', files));
    });
    expect(new Set(hashes).size).toBe(1);
  });

  it('stores one fixed modification time (1980-01-01 00:00:00) for every entry', () => {
    const stamps = dosTimestamps(buildZip('s', files));
    expect(stamps).toHaveLength(files.length);
    for (const stamp of stamps) {
      expect(stamp.time).toBe(0); // 00:00:00
      expect(stamp.date).toBe((0 << 9) | (1 << 5) | 1); // 1980-01-01
    }
  });

  it('does not embed the current time (two builds at different moments are identical)', async () => {
    const first = sha256(buildZip('s', files));
    await new Promise((resolve) => setTimeout(resolve, 2100)); // > DOS 2-second resolution
    expect(sha256(buildZip('s', files))).toBe(first);
  });

  it.each([
    ['../escape.txt'],
    ['/abs.txt'],
    ['a/../b.txt'],
    ['a\\b.txt'],
    ['a//b.txt'],
    ['./x.txt'],
    [''],
    ['nul\0.txt'],
    ['.hidden'],
    ['a/.hidden/b'],
    ['has space.txt'],
    ['references/보고서.txt'],
    ['한글/파일.md'],
    ['café.md'],
    ['x'.repeat(250)],
  ])('refuses the unsafe path %j (zip-slip + ASCII-only defence in depth)', (path) => {
    expect(() => buildZip('s', [{ path, content: 'x' }])).toThrow(/unsafe file path/);
  });

  it('content may be any UTF-8 text; only the ENTRY NAMES must be ASCII', () => {
    const entries = unzipSync(buildZip('s', [{ path: 'SKILL.md', content: '# 한글 제목\n내용 ✓\n' }]));
    expect(strFromU8(entries['s/SKILL.md'])).toBe('# 한글 제목\n내용 ✓\n');
  });

  it('refuses an unsafe package root and duplicate paths', () => {
    expect(() => buildZip('매출-분석', files)).toThrow(/unsafe package root/);
    expect(() => buildZip('../root', files)).toThrow(/unsafe package root/);
    expect(() => buildZip('a/b', files)).toThrow(/single folder/);
    expect(() => buildZip('s', [files[0], files[0]])).toThrow(/duplicate/);
  });
});

describe('contentDisposition', () => {
  it('provides an ASCII fallback plus the exact UTF-8 name', () => {
    const header = contentDisposition('월별-매출-v3.zip');
    expect(header).toBe(`attachment; filename="__-__-v3.zip"; filename*=UTF-8''${encodeURIComponent('월별-매출-v3.zip')}`);
  });

  it('cannot be used to inject header syntax or line breaks', () => {
    const header = contentDisposition('a"b;c\r\nSet-Cookie: x=y.zip');
    expect(header).not.toMatch(/[\r\n]/); // no header splitting
    expect(header.match(/"/g)).toHaveLength(2); // only the two quotes around the fallback
    expect(header.split(';')).toHaveLength(3); // attachment; filename=...; filename*=... — nothing smuggled in
    expect(header).toContain("filename*=UTF-8''a%22b%3Bc%0D%0ASet-Cookie%3A%20x%3Dy.zip"); // everything percent-encoded
  });

  it("escapes characters encodeURIComponent leaves alone (' ( ) *)", () => {
    expect(contentDisposition("a'b(c)*.md")).toContain("filename*=UTF-8''a%27b%28c%29%2A.md");
  });
});
