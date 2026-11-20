import { describe, expect, it } from "@effect/vitest";

import {
  type CatalogEntry,
  fetchDue,
  gitBlobId,
  parseCatalog,
  planFiles,
  resolveInside,
  safeRelativePath,
  skillsDirectory,
} from "./skillCatalog.ts";

const COMMIT = "c".repeat(40);
const SHA = "a".repeat(40);

describe("safeRelativePath", () => {
  it.each([
    ["SKILL.md", true],
    ["scripts/run.py", true],
    ["../escape", false],
    ["a/../../escape", false],
    ["a/./b", false],
    ["/etc/passwd", false],
    ["C:/Windows/system.ini", false],
    ["a\\..\\b", false],
    ["a//b", false],
    ["file:stream", false],
    ["con", false],
    ["NUL.txt", false],
    ["trailing.", false],
    ["trailing ", false],
    ["", false],
  ] as const)("%j safe: %s", (path, safe) => {
    expect(safeRelativePath(path) !== null).toBe(safe);
  });
});

describe("resolveInside", () => {
  it.each([
    ["linux", "/home/u/.claude/skills", "pdf", "/home/u/.claude/skills/pdf"],
    [
      "darwin",
      "/Users/u/.agents/skills",
      "pdf/LICENSE.txt",
      "/Users/u/.agents/skills/pdf/LICENSE.txt",
    ],
    [
      "win32",
      "C:\\Users\\u\\.claude\\skills",
      "pdf/scripts/a.py",
      "C:\\Users\\u\\.claude\\skills\\pdf\\scripts\\a.py",
    ],
    ["win32", "C:\\Users\\u\\.claude\\skills", "../pdf", null],
    ["linux", "/home/u/.claude/skills", "../../.bashrc", null],
  ] as const)("%s %s + %s", (platform, root, relative, expected) => {
    expect(resolveInside(platform, root, relative)).toBe(expected);
  });
});

describe("skillsDirectory", () => {
  it.each([
    ["linux", "/home/u", {}, "/home/u/.claude/skills", "/home/u/.agents/skills"],
    ["darwin", "/Users/u", {}, "/Users/u/.claude/skills", "/Users/u/.agents/skills"],
    ["win32", "C:\\Users\\u", {}, "C:\\Users\\u\\.claude\\skills", "C:\\Users\\u\\.agents\\skills"],
    [
      "win32",
      "C:\\Users\\u",
      { CLAUDE_CONFIG_DIR: "D:\\claude" },
      "D:\\claude\\skills",
      "C:\\Users\\u\\.agents\\skills",
    ],
    [
      "linux",
      "/home/u",
      { CLAUDE_CONFIG_DIR: "/srv/claude" },
      "/srv/claude/skills",
      "/home/u/.agents/skills",
    ],
  ] as const)("%s %s %j", (platform, home, env, claude, codex) => {
    const host = { platform, home, env };
    expect(skillsDirectory("claude", host)).toBe(claude);
    expect(skillsDirectory("codex", host)).toBe(codex);
  });
});

describe("parseCatalog", () => {
  const entry = {
    name: "pdf",
    description: "PDFs",
    repository: "anthropics/skills",
    commit: COMMIT,
    path: "skills/pdf",
  };
  const text = (skills: ReadonlyArray<object>) => JSON.stringify({ schemaVersion: 1, skills });
  it("reads a valid catalogue", () => {
    expect(parseCatalog(text([entry]))?.skills).toEqual([entry]);
  });
  it.each([
    ["a Skill named twice", [entry, entry]],
    ["a path leaving the repository", [{ ...entry, path: "../pdf" }]],
    ["a notice with an unsafe path", [{ ...entry, notices: ["/etc/passwd"] }]],
    ["a branch instead of a commit", [{ ...entry, commit: "main" }]],
    ["a name that is not a folder name", [{ ...entry, name: "../pdf" }]],
  ])("refuses %s", (_label, skills) => {
    expect(parseCatalog(text(skills))).toBeNull();
  });
  it("refuses text that is not JSON", () => {
    expect(parseCatalog("<html>")).toBeNull();
  });
});

describe("fetchDue", () => {
  const day = 24 * 60 * 60 * 1000;
  it.each([
    [null, 0, true],
    [{ attemptedAt: new Date(0).toISOString() }, day - 1, false],
    [{ attemptedAt: new Date(0).toISOString() }, day, true],
    [{ attemptedAt: new Date(10 * day).toISOString() }, day, true],
  ] as const)("cache %j at %s: %s", (cache, now, due) => {
    expect(fetchDue(cache, now)).toBe(due);
  });
});

describe("planFiles", () => {
  const entry: CatalogEntry = {
    name: "demo",
    description: "",
    repository: "o/r",
    commit: COMMIT,
    path: "skills/demo",
    notices: ["NOTICE.md"],
  };
  const blob = (path: string, mode = "100644") => ({
    path,
    mode,
    type: "blob",
    sha: SHA,
    size: 10,
  });
  const tree = (...items: ReadonlyArray<ReturnType<typeof blob>>) => ({
    truncated: false,
    tree: [...items],
  });

  it("takes the folder's files and the notices at its top", () => {
    const plan = planFiles(
      entry,
      tree(
        blob("skills/demo/SKILL.md"),
        blob("skills/demo/scripts/a.py", "100755"),
        blob("skills/other/SKILL.md"),
        blob("NOTICE.md"),
      ),
    );
    expect(plan).toEqual({
      _tag: "Files",
      files: [
        { source: "skills/demo/SKILL.md", target: "SKILL.md", sha: SHA },
        { source: "skills/demo/scripts/a.py", target: "scripts/a.py", sha: SHA },
        { source: "NOTICE.md", target: "NOTICE.md", sha: SHA },
      ],
    });
  });
  it.each([
    [
      "a symlink",
      tree(blob("skills/demo/SKILL.md"), blob("skills/demo/link", "120000"), blob("NOTICE.md")),
      "unsafe",
    ],
    [
      "a submodule",
      tree(
        blob("skills/demo/SKILL.md"),
        { ...blob("skills/demo/sub", "160000"), type: "commit" },
        blob("NOTICE.md"),
      ),
      "unsafe",
    ],
    [
      "a path escaping the folder",
      tree(blob("skills/demo/SKILL.md"), blob("skills/demo/a/../../../x"), blob("NOTICE.md")),
      "unsafe",
    ],
    [
      "a file named as the manifest",
      tree(blob("skills/demo/SKILL.md"), blob("skills/demo/.agentd-skill.json"), blob("NOTICE.md")),
      "unsafe",
    ],
    [
      "a notice clashing with a file",
      tree(blob("skills/demo/SKILL.md"), blob("skills/demo/notice.md"), blob("NOTICE.md")),
      "unsafe",
    ],
    ["no SKILL.md", tree(blob("skills/demo/README.md"), blob("NOTICE.md")), "download"],
    ["a missing notice", tree(blob("skills/demo/SKILL.md")), "download"],
  ] as const)("refuses %s", (_label, input, reason) => {
    expect(planFiles(entry, input)).toMatchObject({ _tag: "Refused", reason });
  });
  it("refuses a listing git cut short", () => {
    expect(
      planFiles(entry, { ...tree(blob("skills/demo/SKILL.md")), truncated: true }),
    ).toMatchObject({
      _tag: "Refused",
      reason: "download",
    });
  });
});

describe("gitBlobId", () => {
  it("matches git hash-object", () => {
    // printf 'hello\n' | git hash-object --stdin
    expect(gitBlobId(new TextEncoder().encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });
});
