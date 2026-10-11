import { describe, expect, test } from "vitest";
import worker, { type WorkerEnv } from "./worker.js";
import { FakeD1Binding, FakeKvBinding } from "./fakes.js";

function env(): WorkerEnv & { kv: FakeKvBinding } {
  const kv = new FakeKvBinding();
  return { DB: new FakeD1Binding(), VENDOR_CACHE: kv, PACK_NAME: "probe", kv };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://pack.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("worker", () => {
  test("GET /health reports ok", async () => {
    const response = await worker.fetch(new Request("https://pack.test/health"), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pack: "probe" });
  });

  test("prospect REST round trip", async () => {
    const target = env();
    const created = await worker.fetch(
      post("/prospects", { name: "Ava", email: "ava@example.com" }),
      target,
    );
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;

    const seen = await worker.fetch(new Request(`https://pack.test/prospects/${id}`), target);
    expect(seen.status).toBe(200);

    const listed = await worker.fetch(new Request("https://pack.test/prospects?query=ava"), target);
    expect((await listed.json()) as unknown[]).toHaveLength(1);

    const patched = await worker.fetch(
      new Request(`https://pack.test/prospects/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "qualified" }),
      }),
      target,
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ status: "qualified" });

    const removed = await worker.fetch(
      new Request(`https://pack.test/prospects/${id}`, { method: "DELETE" }),
      target,
    );
    expect(removed.status).toBe(200);
    const gone = await worker.fetch(new Request(`https://pack.test/prospects/${id}`), target);
    expect(gone.status).toBe(404);
  });

  test("vendor writes reach the KV mirror", async () => {
    const target = env();
    const created = await worker.fetch(post("/vendors", { name: "Ink Supply" }), target);
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: string }).id;
    const mirror = await target.kv.get(`vendor:${id}`);
    expect(mirror).not.toBeNull();
    expect(JSON.parse(mirror as string)).toMatchObject({ name: "Ink Supply" });

    await worker.fetch(new Request(`https://pack.test/vendors/${id}`, { method: "DELETE" }), target);
    expect(await target.kv.get(`vendor:${id}`)).toBeNull();
  });

  test("lead move changes the stage", async () => {
    const target = env();
    const created = await worker.fetch(post("/leads", { title: "Rebuild" }), target);
    const id = ((await created.json()) as { id: string }).id;
    const moved = await worker.fetch(post(`/leads/${id}/move`, { stage: "won" }), target);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ stage: "won" });
  });

  test("bad bodies and filters return 400", async () => {
    const target = env();
    const badBody = await worker.fetch(post("/prospects", { name: "Ava" }), target);
    expect(badBody.status).toBe(400);
    const badFilter = await worker.fetch(
      new Request("https://pack.test/prospects?status=bogus"),
      target,
    );
    expect(badFilter.status).toBe(400);
    const badMove = await worker.fetch(post("/leads/x/move", { stage: "maybe" }), target);
    expect(badMove.status).toBe(400);
  });

  test("unknown routes return 404", async () => {
    const response = await worker.fetch(new Request("https://pack.test/nowhere"), env());
    expect(response.status).toBe(404);
  });
});
