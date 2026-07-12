import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createApiServer } from "../server/api-server.js";

const ORCH_BRIEF = {
  slug: "orch-web",
  title: "Orchestration web test",
  description: "Stripe invoicing pain for solo founders",
  queryPlan: {
    harvestMode: "manual" as const,
    manualImports: [
      {
        text: "I invoice from a Google Sheet every month — painful workaround reconciling Stripe payouts.",
        url: "https://interviews.example/sheet-workaround",
      },
      {
        text: "Would pay $30/mo for lightweight solo SaaS invoicing with Stripe sync.",
        url: "https://interviews.example/wtp",
      },
      {
        text: "Month-end Stripe reconciliation is painfully broken and I need a simpler invoicing workflow.",
        url: "https://interviews.example/simpler-tool",
      },
      {
        text: "QuickBooks works fine for enterprise — not a problem for us.",
        url: "https://interviews.example/disconfirming",
      },
    ],
  },
};

describe("@idea-finder/web api", () => {
  it("seeds orchestration brief and serves workspace endpoints", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "idea-finder-web-"));
    const api = createApiServer({
      workspaceDir: dir,
      port: 0,
      seedFixture: true,
      runnerMode: "orchestration",
      harvestMode: "manual",
    });
    const server = await api.listen();

    try {
      const briefs = await api.handle("GET", "/api/briefs", new URLSearchParams());
      expect(briefs.status).toBe(200);
      expect((briefs.body as unknown[]).length).toBeGreaterThan(0);

      const opps = await api.handle("GET", "/api/opportunities", new URLSearchParams());
      expect(opps.status).toBe(200);
      expect((opps.body as unknown[]).length).toBeGreaterThan(0);

      const settings = await api.handle("GET", "/api/settings", new URLSearchParams());
      expect(settings.status).toBe(200);
      expect((settings.body as { runnerMode: string }).runnerMode).toBe("orchestration");
      expect((settings.body as { harvestMode: string }).harvestMode).toBe("manual");
    } finally {
      await server.close();
    }
  });

  it("creates briefs and runs fixture research via handle()", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "idea-finder-web-"));
    const api = createApiServer({
      workspaceDir: dir,
      port: 0,
      seedFixture: false,
      runnerMode: "fixture",
    });

    const created = await api.handle("POST", "/api/briefs", new URLSearchParams(), {
      slug: "demo",
      title: "Demo",
      description: "Test brief",
    });
    expect(created.status).toBe(201);

    const run = await api.handle(
      "POST",
      "/api/briefs/demo/run",
      new URLSearchParams(),
      {},
    );
    expect(run.status).toBe(200);
    const body = run.body as {
      admittedCount: number;
      runnerMode: string;
      rejectedCount: number;
    };
    expect(body.admittedCount).toBe(1);
    expect(body.runnerMode).toBe("fixture");
    expect(body.rejectedCount).toBeGreaterThanOrEqual(0);
  });

  it("runs real orchestration pipeline → inbox → library → board calibration", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "idea-finder-web-orch-"));
    const api = createApiServer({
      workspaceDir: dir,
      port: 0,
      seedFixture: false,
      runnerMode: "orchestration",
      harvestMode: "manual",
    });

    const created = await api.handle("POST", "/api/briefs", new URLSearchParams(), ORCH_BRIEF);
    expect(created.status).toBe(201);

    const run = await api.handle(
      "POST",
      `/api/briefs/${ORCH_BRIEF.slug}/run`,
      new URLSearchParams(),
      { runnerMode: "orchestration", harvestMode: "manual" },
    );
    expect(run.status).toBe(200);
    const runBody = run.body as {
      runnerMode: string;
      harvestMode: string;
      admittedCount: number;
      rejectedCount: number;
      result: { run: { status: string }; signals: unknown[] };
    };
    expect(runBody.runnerMode).toBe("orchestration");
    expect(runBody.harvestMode).toBe("manual");
    expect(runBody.result.run.status).toBe("completed");
    expect(runBody.result.signals.length).toBeGreaterThan(0);
    expect(runBody.admittedCount).toBeGreaterThanOrEqual(1);

    const inbox = await api.handle(
      "GET",
      "/api/inbox",
      new URLSearchParams({ brief: ORCH_BRIEF.slug }),
    );
    expect(inbox.status).toBe(200);
    expect((inbox.body as { inbox: unknown[] }).inbox.length).toBeGreaterThan(0);

    const opps = await api.handle(
      "GET",
      "/api/opportunities",
      new URLSearchParams({ brief: ORCH_BRIEF.slug }),
    );
    expect(opps.status).toBe(200);
    const opportunities = opps.body as { id: string }[];
    expect(opportunities.length).toBeGreaterThanOrEqual(1);

    const calibrated = await api.handle(
      "POST",
      "/api/board/calibrate",
      new URLSearchParams(),
      {
        opportunityId: opportunities[0]!.id,
        action: "park",
        note: "web integration test",
      },
    );
    expect(calibrated.status).toBe(200);
    expect((calibrated.body as { opportunity: { status: string } }).opportunity.status).toBe(
      "parked",
    );
  });

  it("updates runner settings via PATCH /api/settings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "idea-finder-web-"));
    const api = createApiServer({
      workspaceDir: dir,
      port: 0,
      seedFixture: false,
      runnerMode: "orchestration",
      harvestMode: "manual",
    });

    const updated = await api.handle("PATCH", "/api/settings", new URLSearchParams(), {
      runnerMode: "fixture",
    });
    expect(updated.status).toBe(200);
    expect((updated.body as { runnerMode: string }).runnerMode).toBe("fixture");

    const settings = await api.handle("GET", "/api/settings", new URLSearchParams());
    expect((settings.body as { runnerMode: string }).runnerMode).toBe("fixture");
  });

  it("blocks browser Opportunity domain write via agent API", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "idea-finder-web-agent-"));
    const api = createApiServer({
      workspaceDir: dir,
      port: 0,
      seedFixture: true,
      runnerMode: "fixture",
    });

    const created = await api.handle("POST", "/api/agent-tasks", new URLSearchParams(), {
      kind: "browser",
      intent: "write opportunity",
      opportunityId: "opp_test",
      domainWrite: true,
    });
    expect(created.status).toBe(201);
    const taskId = (created.body as { id: string }).id;

    const run = await api.handle(
      "POST",
      `/api/agent-tasks/${taskId}/run`,
      new URLSearchParams(),
    );
    expect(run.status).toBe(200);
    const task = run.body as {
      status: string;
      invocations: { policyDenials: { code: string }[] }[];
    };
    expect(task.status).toBe("blocked");
    expect(
      task.invocations[0]?.policyDenials.some(
        (d) => d.code === "policy.domain_write_forbidden",
      ),
    ).toBe(true);
  });
});
