/**
 * Phase 9 E2E — Skill Builder → save → Claude Export → ZIP → unzip → validate.
 * Real Postgres + real Brain + real BFF routes (Fastify inject). The Claude package rules
 * are re-implemented here INDEPENDENTLY of Brain's validator (js-yaml, plain regexes), so a
 * bug in one cannot hide behind the other.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import { strFromU8, unzipSync } from 'fflate';
import type { LightMyRequestResponse } from 'fastify';
import { buildServer } from '../../bff/src/server.js';

const built = buildServer();
const app = built.app;
const infra = await (async () => {
  try {
    return (await app.inject({ method: 'GET', url: '/health' })).statusCode === 200;
  } catch {
    return false;
  }
})();
if (!infra) {
  // eslint-disable-next-line no-console
  console.warn('[phase9-export.test.ts] Postgres/Brain not reachable — skipping Phase 9 E2E.');
}

const CLAUDE = { target: 'claude', format: 'skill-package' } as const;

async function build(request: string): Promise<{ id: string; spec: any }> {
  const res = await app.inject({ method: 'POST', url: '/skills/build', payload: { request } });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  expect(body.action).toBe('draft');
  return { id: body.skill.id, spec: body.version.spec };
}

const exportClaude = (id: string, extra: object = {}) =>
  app.inject({ method: 'POST', url: `/skills/${id}/export`, payload: { version: 1, ...CLAUDE, ...extra } });

const compat = (id: string, query: Record<string, string | number | boolean>) =>
  app.inject({
    method: 'GET',
    url: `/skills/${id}/export/compatibility?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`,
  });

function unzipAll(res: LightMyRequestResponse): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(new Uint8Array(res.rawPayload))).map(([p, b]) => [p, strFromU8(b)]));
}

/** What Claude requires of a Skill package (independent re-statement of the documented rules). */
function assertRecognizableClaudeSkill(files: Record<string, string>): { root: string; name: string; description: string } {
  const paths = Object.keys(files);
  const roots = new Set(paths.map((p) => p.split('/')[0]));
  expect(roots.size, `exactly one root folder, got ${[...roots]}`).toBe(1);
  const root = [...roots][0];

  for (const p of paths) expect(p, `ASCII-safe entry path`).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);
  expect(paths).toContain(`${root}/SKILL.md`);

  const markdown = files[`${root}/SKILL.md`];
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  expect(match, 'SKILL.md must start with YAML frontmatter').not.toBeNull();
  const meta = yaml.load(match![1]) as Record<string, unknown>;
  expect(typeof meta.name).toBe('string');
  expect(typeof meta.description).toBe('string');
  const name = meta.name as string;
  const description = meta.description as string;
  expect(name).toMatch(/^[a-z0-9-]{1,64}$/);
  expect(name).not.toMatch(/anthropic|claude/);
  expect(description.trim().length).toBeGreaterThan(0);
  expect(description.length).toBeLessThanOrEqual(1024);
  expect(name + description).not.toMatch(/<\/?[A-Za-z][^>]*>/);
  expect(markdown.split('\n').length).toBeLessThanOrEqual(500);

  // every relative link in SKILL.md resolves to a file in the package (one level deep, no escape)
  const body = markdown.replace(/```[\s\S]*?```/g, '');
  for (const [, target] of body.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:|^#/i.test(target)) continue;
    const resolved = path.posix.normalize(path.posix.join(root, target));
    expect(resolved.startsWith(`${root}/`), `link ${target} stays inside the package`).toBe(true);
    expect(paths, `link ${target} points at a bundled file`).toContain(resolved);
  }
  return { root, name, description };
}

describe.skipIf(!infra)('Phase 9 E2E', () => {
  afterAll(async () => {
    await app.close();
    await built.dbPool.end();
  });

  it('Prompt Skill: Builder → save → Claude export → unzip → SKILL.md + valid YAML metadata + recognizable structure', async () => {
    const { id, spec } = await build('입력받은 한국어 문장을 자연스러운 영어로 번역하는 Skill 만들어줘');
    expect(spec.skillType).toBe('prompt');

    const compatibility = (await compat(id, { version: 1, ...CLAUDE })).json();
    expect(compatibility.compatibility.level).toBe('full');
    expect(compatibility.blockers).toEqual([]);

    const res = await exportClaude(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['x-export-compatibility']).toBe('full');

    const files = unzipAll(res);
    const { root, name, description } = assertRecognizableClaudeSkill(files);
    expect(Object.keys(files).sort()).toEqual([`${root}/SKILL.md`, `${root}/manifest.json`, `${root}/skill.json`]);
    // A Korean-only request has no ASCII slug: the folder is `skill-<id8>` and the Claude name is the same safe id.
    expect(root).toMatch(/^skill-[0-9a-f]{8}$/);
    expect(name).toBe(root);
    expect(description).toContain('번역');

    const manifest = JSON.parse(files[`${root}/manifest.json`]);
    expect(manifest.skill).toMatchObject({ displayName: spec.name, archivePath: root, version: 1 });
    expect(manifest.export).toMatchObject({ target: 'claude', format: 'skill-package' });
    const skillJson = JSON.parse(files[`${root}/skill.json`]);
    expect(skillJson.formatVersion).toBe('1.0');
    expect(JSON.stringify(skillJson)).not.toContain(id); // no internal id without includeSourceSpec
  });

  it('the exported ZIP is accepted by the stock unzip tool (ASCII entry names, even for a Korean Skill)', () => {
    // covered per-file above; here the OS tool is the judge
    // (skipped silently where `unzip` is not installed)
    return (async () => {
      const { id } = await build('입력받은 한국어 문장을 자연스러운 영어로 번역하는 Skill 만들어줘');
      const res = await exportClaude(id);
      const dir = mkdtempSync(path.join(tmpdir(), 'phase9-'));
      try {
        const zip = path.join(dir, 'package.zip');
        writeFileSync(zip, res.rawPayload);
        let output: string;
        try {
          output = execFileSync('unzip', ['-t', zip], { encoding: 'utf-8', env: { PATH: process.env.PATH, LC_ALL: 'C' } });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // no unzip on this machine
          throw err;
        }
        expect(output).toContain('No errors detected');
        execFileSync('unzip', ['-q', zip, '-d', path.join(dir, 'out')], { env: { PATH: process.env.PATH, LC_ALL: 'C' } });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
  });

  it('Knowledge Skill: Builder → connect documents → includeKnowledge → references + manifest maps the original names', async () => {
    const docA = (await app.inject({ method: 'POST', url: '/documents', payload: { fileName: '매출 정책 문서.md', content: '# 정책\r\n마감 규칙' } })).json().document;
    const docB = (await app.inject({ method: 'POST', url: '/documents', payload: { fileName: '재고 기준표.txt', content: '안전재고 100' } })).json().document;
    const dup = (await app.inject({ method: 'POST', url: '/documents', payload: { fileName: '재고 기준표.txt', content: '같은 이름의 다른 문서' } })).json().document;

    const { id, spec } = await build('문서를 검색해서 답변하는 지식 skill 만들어줘');
    expect(spec.skillType).toBe('knowledge');
    // "구성" tab: connect Knowledge → a new saved Version (v2)
    const documentIds = [docA.id, docB.id, dup.id];
    const patched = await app.inject({
      method: 'PATCH',
      url: `/skills/${id}`,
      payload: { expectedVersion: 1, spec: { ...spec, name: '매출 지식 도우미', knowledge: { mode: 'selected', documentIds } } },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    // Not allowed yet → Compatibility explains (200, blocked) and the real Export is a 403.
    const blocked = await compat(id, { version: 2, ...CLAUDE, includeKnowledge: true });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().compatibility.level).toBe('blocked');

    for (const doc of [docA, docB, dup]) {
      expect((await app.inject({ method: 'PATCH', url: `/documents/${doc.id}`, payload: { exportAllowed: true } })).statusCode).toBe(200);
    }
    const ok = (await compat(id, { version: 2, ...CLAUDE, includeKnowledge: true })).json();
    expect(ok.blockers).toEqual([]);
    expect(ok.compatibility.level).toBe('full');
    expect(ok.compatibility.summary.knowledge).toEqual({ documents: 3, included: 3, workspaceScope: false });

    const res = await exportClaude(id, { version: 2, includeKnowledge: true });
    expect(res.statusCode, res.body).toBe(200);
    const files = unzipAll(res);
    const { root } = assertRecognizableClaudeSkill(files);

    const references = Object.keys(files).filter((p) => p.startsWith(`${root}/references/`)).sort();
    expect(references).toHaveLength(3); // duplicate display names → three distinct ASCII paths
    expect(new Set(references).size).toBe(3);
    const manifest = JSON.parse(files[`${root}/manifest.json`]);
    expect(manifest.skill.displayName).toBe('매출 지식 도우미');
    const entries = Object.values<any>(manifest.knowledge);
    expect(entries.map((e) => e.fileName).sort()).toEqual(['매출 정책 문서.md', '재고 기준표.txt', '재고 기준표.txt'].sort());
    for (const entry of entries) {
      expect(entry.included).toBe(true);
      expect(`${root}/${entry.path}`).toSatisfy((p: string) => references.includes(p));
      expect(createHash('sha256').update(files[`${root}/${entry.path}`]).digest('hex')).toBe(entry.contentHash);
    }
    const policy = entries.find((e) => e.fileName === '매출 정책 문서.md');
    expect(files[`${root}/${policy.path}`]).toBe('# 정책\n마감 규칙'); // CRLF normalized
    // SKILL.md shows the display names (UTF-8 text) but links ASCII paths
    expect(files[`${root}/SKILL.md`]).toContain(`[매출 정책 문서.md](${policy.path})`);
  });

  it('Tool Skill: Builder → Claude export → Required MCP is shown in Compatibility (and acknowledgement is required)', async () => {
    const { id, spec } = await build('서비스 상태 조회 skill 만들어줘');
    expect(spec.skillType).toBe('tool');

    const body = (await compat(id, { version: 1, ...CLAUDE })).json();
    expect(body.compatibility.level).toBe('partial');
    expect(body.compatibility.summary.requiredMcp).toEqual(['service-status']);
    expect(body.compatibility.summary.unsupportedCapabilities.map((c: any) => c.id)).toContain('tools');

    expect(JSON.parse((await exportClaude(id)).body).error.details.code).toBe('EXPORT_ACK_REQUIRED');
    const res = await exportClaude(id, { acknowledgeWarnings: true });
    expect(res.statusCode, res.body).toBe(200);
    const files = unzipAll(res);
    const { root } = assertRecognizableClaudeSkill(files);
    const skillMd = files[`${root}/SKILL.md`];
    expect(skillMd).toContain('## Required tools');
    expect(skillMd).toContain('`ServerName:service-status`'); // fully qualified MCP naming
    expect(JSON.parse(files[`${root}/manifest.json`]).requirements.tools).toEqual(['service-status']);
  });

  it('Unauthorized Knowledge: Compatibility BLOCKED (200, no document metadata) → the real Export is 403', async () => {
    const secretName = `기밀-로드맵-${Date.now()}.txt`;
    const doc = (await app.inject({ method: 'POST', url: '/documents', payload: { fileName: secretName, content: '비공개 내용' } })).json().document;
    const { id, spec } = await build('문서를 검색해서 답변하는 지식 skill 만들어줘');
    await app.inject({
      method: 'PATCH',
      url: `/skills/${id}`,
      payload: { expectedVersion: 1, spec: { ...spec, knowledge: { mode: 'selected', documentIds: [doc.id] } } },
    });

    const explained = await compat(id, { version: 2, ...CLAUDE, includeKnowledge: true });
    expect(explained.statusCode).toBe(200);
    const body = explained.json();
    expect(body.compatibility.level).toBe('blocked');
    expect(body.blockers.map((b: any) => b.code)).toEqual(['KNOWLEDGE_EXPORT_FORBIDDEN']);
    expect(body.lock).toBeNull();
    for (const leaked of [secretName, doc.id, '비공개 내용']) expect(explained.body).not.toContain(leaked);

    const enforced = await exportClaude(id, { version: 2, includeKnowledge: true, acknowledgeWarnings: true });
    expect(enforced.statusCode).toBe(403);
    expect(enforced.json().error.details).toEqual({ code: 'EXPORT_DOCUMENT_NOT_ALLOWED', reasons: { export_not_allowed: 1 } });
    for (const leaked of [secretName, doc.id, '비공개 내용']) expect(enforced.body).not.toContain(leaked);

    // A member cannot grant the permission; Export without Include Knowledge still works (References Only).
    const memberTry = await app.inject({ method: 'PATCH', url: `/documents/${doc.id}`, payload: { exportAllowed: true }, headers: { 'x-dev-workspace-role': 'member' } });
    expect(memberTry.statusCode).toBe(403);
    expect((await exportClaude(id, { version: 2, acknowledgeWarnings: true })).statusCode).toBe(200);
  });

  it('Generic formats and the unsupported/missing-adapter distinctions work end to end', async () => {
    const { id } = await build('입력받은 한국어 문장을 자연스러운 영어로 번역하는 Skill 만들어줘');
    const md = await app.inject({ method: 'POST', url: `/skills/${id}/export`, payload: { version: 1, target: 'generic', format: 'markdown' } });
    expect(md.statusCode).toBe(200);
    expect(md.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(md.body.startsWith('---')).toBe(false); // generic Markdown has no provider frontmatter
    const raw = await app.inject({ method: 'POST', url: `/skills/${id}/export`, payload: { version: 1, target: 'generic', format: 'raw-spec' } });
    expect(raw.json().schemaVersion).toBe('1.0');

    const unsupported = await app.inject({ method: 'POST', url: `/skills/${id}/export`, payload: { version: 1, target: 'gemini', format: 'skill-package' } });
    expect(unsupported.json().error.details.code).toBe('EXPORT_TARGET_UNSUPPORTED');
    const noFormat = await app.inject({ method: 'POST', url: `/skills/${id}/export`, payload: { version: 1, target: 'claude', format: 'markdown' } });
    expect(noFormat.json().error.details.code).toBe('EXPORT_FORMAT_UNSUPPORTED');
  });
});
