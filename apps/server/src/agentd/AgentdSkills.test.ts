import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AgentdSkills from "./AgentdSkills.ts";
import { CATALOG_URL, gitBlobId } from "./skillCatalog.ts";

const COMMIT = "c".repeat(40);
const text = (value: string) => new TextEncoder().encode(value);
const REPO_FILES: Record<string, Uint8Array> = {
  "skills/demo/SKILL.md": text("---\nname: demo\n---\n"),
  "skills/demo/LICENSE.txt": text("Apache-2.0\n"),
  "skills/demo/scripts/run.py": text("print('hi')\n"),
  "skills/other/SKILL.md": text("other\n"),
  "NOTICES.md": text("notices\n"),
  "README.md": text("readme\n"),
};
const ENTRY = {
  id: "demo",
  name: "Demo",
  description: "A demo",
  group: "research",
  author: "Owner",
  source: {
    url: "https://github.com/owner/repo",
    path: "skills/demo",
    sha: COMMIT,
    notices: ["NOTICES.md"],
  },
  licence: "Apache-2.0",
  reviewedAt: "2026-11-01",
  agents: ["claude", "codex"],
};
const GROUPS = [{ id: "research", name: "Research" }];
const catalogText = (skills: ReadonlyArray<object>) =>
  JSON.stringify({ $schema: "./catalog.schema.json", version: 1, groups: GROUPS, skills });
const CATALOG = catalogText([
  ENTRY,
  { ...ENTRY, id: "claude-only", agents: ["claude", "opencode"] },
]);
const TREE_URL = `https://api.github.com/repos/owner/repo/git/trees/${COMMIT}?recursive=1`;
const rawUrl = (path: string) => `https://raw.githubusercontent.com/owner/repo/${COMMIT}/${path}`;
const treeBody = (extra: ReadonlyArray<object> = []) =>
  JSON.stringify({
    sha: "t".repeat(40),
    truncated: false,
    tree: [
      ...Object.entries(REPO_FILES).map(([path, bytes]) => ({
        path,
        mode: path.endsWith(".py") ? "100755" : "100644",
        type: "blob",
        sha: gitBlobId(bytes),
        size: bytes.byteLength,
      })),
      { path: "skills/demo/scripts", mode: "040000", type: "tree", sha: "d".repeat(40) },
      ...extra,
    ],
  });

type Route = { readonly status: number; readonly body: Uint8Array | string };

const harness = (document?: ManagedPolicyDocument) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const home = path.join(config.baseDir, "home");
    yield* fs.makeDirectory(home, { recursive: true });
    const requests: string[] = [];
    const routes = new Map<string, Route>([
      [CATALOG_URL, { status: 200, body: CATALOG }],
      [TREE_URL, { status: 200, body: treeBody() }],
      ...Object.entries(REPO_FILES).map(([file, body]): [string, Route] => [
        rawUrl(file),
        { status: 200, body },
      ]),
    ]);
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        const route = routes.get(request.url) ?? { status: 404, body: "" };
        return HttpClientResponse.fromWeb(
          request,
          new Response(route.body, { status: route.status }),
        );
      }),
    );
    const service = yield* AgentdSkills.AgentdSkillsService.pipe(
      Effect.provide(
        AgentdSkills.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(HttpClient.HttpClient, client),
              Layer.effect(
                ManagedPolicy.ManagedPolicy,
                ManagedPolicy.fromDocument("policy.json", document).pipe(Effect.orDie),
              ),
              Layer.succeed(HostProcess.HomeDirectory, home),
              Layer.succeed(HostProcess.Environment, {}),
            ),
          ),
        ),
      ),
    );
    const claude = path.join(home, ".claude", "skills");
    const codex = path.join(home, ".agents", "skills");
    const filesUnder = (dir: string) =>
      fs.readDirectory(dir, { recursive: true }).pipe(
        Effect.map((entries) => entries.map((entry) => entry.split(path.sep).join("/")).toSorted()),
        Effect.orElseSucceed((): string[] => []),
      );
    return { fs, path, home, requests, routes, service, claude, codex, filesUnder };
  });

const dependencies = ServerConfig.layerTest("/tmp", { prefix: "agentd-skills-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const states = (skills: {
  readonly skills: ReadonlyArray<{ readonly agents: ReadonlyArray<object> }>;
}) => skills.skills[0]?.agents;

it.effect("fetches the catalogue at most once a day and serves the cache when a fetch fails", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const first = yield* h.service.list;
    expect(first.source).toBe("fetched");
    expect(first.groups).toEqual(GROUPS);
    expect(first.skills.map((skill) => skill.id)).toEqual(["demo", "claude-only"]);

    expect((yield* h.service.list).source).toBe("cache");
    expect(h.requests).toEqual([CATALOG_URL]);

    yield* TestClock.adjust("25 hours");
    h.routes.set(CATALOG_URL, { status: 503, body: "" });
    const failed = yield* h.service.list;
    expect(failed).toMatchObject({ source: "cache", fetchedAt: first.fetchedAt });
    expect(failed.skills.map((skill) => skill.id)).toEqual(["demo", "claude-only"]);
    expect(h.requests).toEqual([CATALOG_URL, CATALOG_URL]);

    // The failed attempt counts: no new request until another day has passed.
    yield* h.service.list;
    expect(h.requests).toHaveLength(2);

    yield* TestClock.adjust("25 hours");
    h.routes.set(CATALOG_URL, {
      status: 200,
      body: catalogText([{ ...ENTRY, group: "undefined-group" }]),
    });
    const invalid = yield* h.service.list;
    expect(invalid.source).toBe("cache");
    expect(invalid.skills.map((skill) => skill.id)).toEqual(["demo", "claude-only"]);
    expect(h.requests).toHaveLength(3);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("with no cache and a failed fetch, the catalogue is empty", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.routes.set(CATALOG_URL, { status: 500, body: "" });
    expect(yield* h.service.list).toEqual({ source: "none", groups: [], skills: [] });
  }).pipe(Effect.provide(dependencies)),
);

it.effect("a policy that turns the catalogue off makes no request", () =>
  Effect.gen(function* () {
    const h = yield* harness({
      schemaVersion: 1,
      organization: "Example Corp",
      limits: { skillCatalog: false },
    });
    expect(yield* h.service.list).toEqual({
      source: "off",
      organization: "Example Corp",
      groups: [],
      skills: [],
    });
    const refused = yield* h.service.install({ id: "demo", agent: "claude" }).pipe(Effect.flip);
    expect(refused.reason).toBe("policy");
    expect(h.requests).toEqual([]);
    expect(yield* h.filesUnder(h.claude)).toEqual([]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect(
  "installs the pinned folder, its notices and a manifest, and lists each agent's state",
  () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const listed = yield* h.service.install({ id: "demo", agent: "claude" });
      expect(states(listed)).toEqual([
        { agent: "claude", state: "managed", commit: COMMIT },
        { agent: "codex", state: "absent" },
      ]);
      expect(yield* h.filesUnder(h.claude)).toEqual([
        "demo",
        "demo/.agentd-skill.json",
        "demo/LICENSE.txt",
        "demo/NOTICES.md",
        "demo/SKILL.md",
        "demo/scripts",
        "demo/scripts/run.py",
      ]);
      const folder = h.path.join(h.claude, "demo");
      expect(yield* h.fs.readFileString(h.path.join(folder, "scripts", "run.py"))).toBe(
        "print('hi')\n",
      );
      const manifest = JSON.parse(
        yield* h.fs.readFileString(h.path.join(folder, ".agentd-skill.json")),
      );
      expect(manifest).toMatchObject({
        name: "demo",
        repository: "owner/repo",
        commit: COMMIT,
        files: ["SKILL.md", "LICENSE.txt", "scripts/run.py", "NOTICES.md"],
      });

      yield* h.fs.makeDirectory(h.path.join(h.codex, "demo"), { recursive: true });
      yield* h.fs.writeFileString(h.path.join(h.codex, "demo", "SKILL.md"), "mine\n");
      expect(states(yield* h.service.list)).toEqual([
        { agent: "claude", state: "managed", commit: COMMIT },
        { agent: "codex", state: "manual" },
      ]);
    }).pipe(Effect.provide(dependencies)),
);

it.effect("lists each entry's details and only the agents it supports", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const listed = yield* h.service.list;
    const { agents: _agents, ...entry } = ENTRY;
    expect(listed.skills).toEqual([
      {
        ...entry,
        agents: [
          { agent: "claude", state: "absent" },
          { agent: "codex", state: "absent" },
        ],
      },
      { ...entry, id: "claude-only", agents: [{ agent: "claude", state: "absent" }] },
    ]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("install is refused for an agent the entry does not list, before any download", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const refused = yield* h.service
      .install({ id: "claude-only", agent: "codex", replace: true })
      .pipe(Effect.flip);
    expect(refused.reason).toBe("unsupported");
    expect(h.requests).toEqual([CATALOG_URL]);
    expect(yield* h.filesUnder(h.home)).toEqual([]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("install is refused for a source that is not a GitHub repository", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    h.routes.set(CATALOG_URL, {
      status: 200,
      body: catalogText([
        { ...ENTRY, source: { ...ENTRY.source, url: "https://gitlab.com/owner/repo" } },
      ]),
    });
    const refused = yield* h.service.install({ id: "demo", agent: "claude" }).pipe(Effect.flip);
    expect(refused.reason).toBe("download");
    expect(h.requests).toEqual([CATALOG_URL]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("a hand-installed Skill of the same name is replaced only when asked", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    const folder = h.path.join(h.codex, "demo");
    yield* h.fs.makeDirectory(folder, { recursive: true });
    yield* h.fs.writeFileString(h.path.join(folder, "SKILL.md"), "mine\n");

    const refused = yield* h.service.install({ id: "demo", agent: "codex" }).pipe(Effect.flip);
    expect(refused.reason).toBe("conflict");
    expect(yield* h.fs.readFileString(h.path.join(folder, "SKILL.md"))).toBe("mine\n");
    expect(h.requests).toEqual([CATALOG_URL]);

    const replaced = yield* h.service.install({ id: "demo", agent: "codex", replace: true });
    expect(states(replaced)?.[1]).toEqual({ agent: "codex", state: "managed", commit: COMMIT });
    expect(yield* h.fs.readFileString(h.path.join(folder, "SKILL.md"))).toBe(
      "---\nname: demo\n---\n",
    );
    expect(yield* h.filesUnder(h.codex)).not.toContain("demo/mine");
    expect((yield* h.filesUnder(h.codex)).filter((entry) => entry.startsWith("."))).toEqual([]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect.each([
  [
    "a missing commit",
    (h: Harness) => h.routes.set(TREE_URL, { status: 404, body: "" }),
    "download",
  ],
  [
    "a file that does not match the commit",
    (h: Harness) =>
      h.routes.set(rawUrl("skills/demo/scripts/run.py"), { status: 200, body: "tampered" }),
    "download",
  ],
  [
    "a failed download midway",
    (h: Harness) => h.routes.set(rawUrl("skills/demo/scripts/run.py"), { status: 500, body: "" }),
    "download",
  ],
  [
    "a path escaping the folder",
    (h: Harness) =>
      h.routes.set(TREE_URL, {
        status: 200,
        body: treeBody([
          {
            path: "skills/demo/x/../../../../evil",
            mode: "100644",
            type: "blob",
            sha: "e".repeat(40),
            size: 1,
          },
        ]),
      }),
    "unsafe",
  ],
  [
    "a symlink",
    (h: Harness) =>
      h.routes.set(TREE_URL, {
        status: 200,
        body: treeBody([
          { path: "skills/demo/link", mode: "120000", type: "blob", sha: "e".repeat(40), size: 9 },
        ]),
      }),
    "unsafe",
  ],
] as const)("%s writes nothing", ([_label, breakIt, reason]) =>
  Effect.gen(function* () {
    const h = yield* harness();
    breakIt(h);
    const failed = yield* h.service.install({ id: "demo", agent: "claude" }).pipe(Effect.flip);
    expect(failed.reason).toBe(reason);
    expect(yield* h.filesUnder(h.claude)).toEqual([]);
    expect(yield* h.filesUnder(h.home)).toEqual([]);
  }).pipe(Effect.provide(dependencies)),
);

type Harness = Effect.Success<ReturnType<typeof harness>>;

it.effect("an update keeps a managed install whole when its download fails", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.install({ id: "demo", agent: "claude" });
    const before = yield* h.filesUnder(h.claude);
    h.routes.set(rawUrl("skills/demo/SKILL.md"), { status: 500, body: "" });
    yield* h.service.install({ id: "demo", agent: "claude" }).pipe(Effect.flip);
    expect(yield* h.filesUnder(h.claude)).toEqual(before);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("an update does not drop files added to a managed install without replace", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.install({ id: "demo", agent: "claude" });
    // Reinstalling an untouched install is fine.
    yield* h.service.install({ id: "demo", agent: "claude" });
    const added = h.path.join(h.claude, "demo", "scripts", "notes.txt");
    yield* h.fs.writeFileString(added, "mine\n");
    const refused = yield* h.service.install({ id: "demo", agent: "claude" }).pipe(Effect.flip);
    expect(refused.reason).toBe("conflict");
    expect(yield* h.fs.readFileString(added)).toBe("mine\n");
  }).pipe(Effect.provide(dependencies)),
);

it.effect("remove deletes only what the manifest lists", () =>
  Effect.gen(function* () {
    const h = yield* harness();
    yield* h.service.install({ id: "demo", agent: "claude" });
    const folder = h.path.join(h.claude, "demo");
    yield* h.fs.writeFileString(h.path.join(folder, "scripts", "notes.txt"), "mine\n");

    const listed = yield* h.service.remove({ id: "demo", agent: "claude" });
    expect(yield* h.filesUnder(h.claude)).toEqual([
      "demo",
      "demo/scripts",
      "demo/scripts/notes.txt",
    ]);
    expect(states(listed)?.[0]).toEqual({ agent: "claude", state: "manual" });

    const refused = yield* h.service.remove({ id: "demo", agent: "claude" }).pipe(Effect.flip);
    expect(refused.reason).toBe("conflict");
    expect(yield* h.filesUnder(h.claude)).toEqual([
      "demo",
      "demo/scripts",
      "demo/scripts/notes.txt",
    ]);

    yield* h.fs.remove(h.path.join(folder, "scripts", "notes.txt"));
    yield* h.service.install({ id: "demo", agent: "claude", replace: true });
    yield* h.service.remove({ id: "demo", agent: "claude" });
    expect(yield* h.filesUnder(h.claude)).toEqual([]);
  }).pipe(Effect.provide(dependencies)),
);
