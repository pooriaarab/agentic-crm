import { beforeEach, describe, expect, test } from "vitest";
import { createGuards, resetCosts } from "agentic-core";
import { parseArgs, runCli, UsageError, type CliIo } from "./cli.js";
import { MemoryCrmStore } from "./crm.js";

function testIo(overrides: Partial<CliIo> = {}): CliIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    store: new MemoryCrmStore(),
    ...overrides,
  };
}

beforeEach(() => {
  resetCosts();
});

describe("parseArgs", () => {
  test("empty args print help", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  test("--version selects version", () => {
    expect(parseArgs(["--version"]).command).toBe("version");
  });

  test("add-prospect takes fields and dry run", () => {
    const request = parseArgs([
      "add-prospect",
      "--name",
      "Ava",
      "--email",
      "a@b.test",
      "--dry-run",
    ]);
    expect(request.command).toBe("add-prospect");
    expect(request.dryRun).toBe(true);
    expect(request.flags).toMatchObject({ name: "Ava", email: "a@b.test" });
  });

  test("add-prospect without email throws", () => {
    expect(() => parseArgs(["add-prospect", "--name", "Ava"])).toThrow(/needs --email/);
  });

  test("unknown command throws UsageError", () => {
    expect(() => parseArgs(["frobnicate"])).toThrow(UsageError);
  });

  test("unknown flag throws UsageError", () => {
    expect(() => parseArgs(["get-prospect", "--name", "Ava"])).toThrow(/unknown flag/);
  });

  test("bad store value throws", () => {
    expect(() => parseArgs(["list-prospects", "--store", "s3"])).toThrow(/--store/);
  });

  test("move-lead needs id and stage", () => {
    expect(() => parseArgs(["move-lead", "--id", "1"])).toThrow(/needs --stage/);
  });
});

describe("runCli prospects", () => {
  test("add then get then list", async () => {
    const io = testIo();
    const code = await runCli(["add-prospect", "--name", "Ava", "--email", "ava@example.com"], io);
    expect(code).toBe(0);
    const written = JSON.parse(io.outLines[0] as string);
    expect(written.dryRun).toBe(false);
    const id = written.result.id as string;

    const ioGet = testIo({ store: io.store });
    expect(await runCli(["get-prospect", "--id", id], ioGet)).toBe(0);
    expect(JSON.parse(ioGet.outLines[0] as string)).toMatchObject({ email: "ava@example.com" });

    const ioList = testIo({ store: io.store });
    expect(await runCli(["list-prospects"], ioList)).toBe(0);
    expect(JSON.parse(ioList.outLines[0] as string)).toHaveLength(1);
  });

  test("dry run previews and writes nothing", async () => {
    const io = testIo();
    const code = await runCli(
      ["add-prospect", "--name", "Ava", "--email", "ava@example.com", "--dry-run"],
      io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.outLines[0] as string)).toMatchObject({ dryRun: true });
    const ioList = testIo({ store: io.store });
    await runCli(["list-prospects"], ioList);
    expect(JSON.parse(ioList.outLines[0] as string)).toHaveLength(0);
  });

  test("update and delete round trip", async () => {
    const io = testIo();
    await runCli(["add-prospect", "--name", "Ava", "--email", "ava@example.com"], io);
    const id = (JSON.parse(io.outLines[0] as string).result as { id: string }).id;
    const ioUpdate = testIo({ store: io.store });
    expect(await runCli(["update-prospect", "--id", id, "--status", "qualified"], ioUpdate)).toBe(0);
    expect(JSON.parse(ioUpdate.outLines[0] as string).result).toMatchObject({ status: "qualified" });
    const ioDelete = testIo({ store: io.store });
    expect(await runCli(["delete-prospect", "--id", id], ioDelete)).toBe(0);
    const ioGet = testIo({ store: io.store });
    expect(await runCli(["get-prospect", "--id", id], ioGet)).toBe(1);
    expect(ioGet.errLines[0]).toContain("no prospect");
  });

  test("a bad email exits 1 with a plain message", async () => {
    const io = testIo();
    const code = await runCli(["add-prospect", "--name", "Ava", "--email", "bad"], io);
    expect(code).toBe(1);
    expect(io.errLines[0]).toContain("email");
  });

  test("a denied guard exits 1 and writes nothing", async () => {
    const io = testIo({ guards: createGuards({ blocklist: ["banned"] }) });
    const code = await runCli(["add-prospect", "--name", "Banned", "--email", "b@example.com"], io);
    expect(code).toBe(1);
    expect(io.errLines[0]).toContain("GuardError");
    const ioList = testIo({ store: io.store });
    await runCli(["list-prospects"], ioList);
    expect(JSON.parse(ioList.outLines[0] as string)).toHaveLength(0);
  });
});

describe("runCli vendors and leads", () => {
  test("vendor add, list with query, delete", async () => {
    const io = testIo();
    await runCli(["add-vendor", "--name", "Ink Supply", "--category", "office"], io);
    const id = (JSON.parse(io.outLines[0] as string).result as { id: string }).id;
    const ioList = testIo({ store: io.store });
    await runCli(["list-vendors", "--query", "ink"], ioList);
    expect(JSON.parse(ioList.outLines[0] as string)).toHaveLength(1);
    const ioDelete = testIo({ store: io.store });
    expect(await runCli(["delete-vendor", "--id", id], ioDelete)).toBe(0);
  });

  test("lead add, move, list by stage", async () => {
    const io = testIo();
    await runCli(
      ["add-lead", "--title", "Rebuild", "--value", "1200", "--currency", "USD"],
      io,
    );
    const id = (JSON.parse(io.outLines[0] as string).result as { id: string }).id;
    const ioMove = testIo({ store: io.store });
    expect(await runCli(["move-lead", "--id", id, "--stage", "proposal"], ioMove)).toBe(0);
    const ioList = testIo({ store: io.store });
    await runCli(["list-leads", "--stage", "proposal"], ioList);
    expect(JSON.parse(ioList.outLines[0] as string)).toHaveLength(1);
  });

  test("move-lead rejects a bad stage", async () => {
    const io = testIo();
    const code = await runCli(["move-lead", "--id", "x", "--stage", "maybe"], io);
    expect(code).toBe(1);
    expect(io.errLines[0]).toContain("stage");
  });

  test("a bad value exits 2", async () => {
    const io = testIo();
    const code = await runCli(["add-lead", "--title", "T", "--value", "lots"], io);
    expect(code).toBe(2);
    expect(io.errLines[0]).toContain("--value");
  });
});

describe("runCli meta", () => {
  test("bad usage exits 2", async () => {
    const io = testIo();
    const code = await runCli(["bogus"], io);
    expect(code).toBe(2);
    expect(io.errLines.length).toBeGreaterThan(0);
  });

  test("version prints a version string", async () => {
    const io = testIo();
    const code = await runCli(["--version"], io);
    expect(code).toBe(0);
    expect(io.outLines[0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("costs prints the report", async () => {
    const io = testIo();
    await runCli(["add-prospect", "--name", "Ava", "--email", "ava@example.com"], io);
    const ioCosts = testIo({ store: io.store });
    expect(await runCli(["costs"], ioCosts)).toBe(0);
    expect(JSON.parse(ioCosts.outLines[0] as string)).toMatchObject({ units: 1 });
  });

  test("missing d1 env exits 1 with the var names", async () => {
    const io = testIo({ store: undefined, env: {} });
    const code = await runCli(["list-prospects", "--store", "d1"], io);
    expect(code).toBe(1);
    expect(io.errLines[0]).toContain("CLOUDFLARE_ACCOUNT_ID");
  });
});
