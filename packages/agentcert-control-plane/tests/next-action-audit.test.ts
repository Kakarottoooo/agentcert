import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../src/artifacts.js";
import type { EmailProvider } from "../src/notifications.js";
import { AgentCertControlPlane } from "../src/service.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import type { AuthContext } from "../src/types.js";

const owner: AuthContext = {
  kind: "user",
  userId: "00000000-0000-4000-8000-000000000201",
  email: "owner@example.com",
};

const emailProvider: EmailProvider = {
  name: "test",
  configured: true,
  async send() { return { provider: "test" }; },
};

async function setup() {
  const store = new InMemoryControlPlaneStore();
  const service = new AgentCertControlPlane(
    store,
    new MemoryArtifactStore(),
    undefined,
    [],
    undefined,
    undefined,
    fetch,
    emailProvider,
    "https://agentcert.app",
  );
  const bootstrap = await service.bootstrap(owner);
  await store.saveNotificationDestination({
    id: "00000000-0000-4000-8000-000000000202",
    projectId: bootstrap.project.id,
    email: "security@example.com",
    alertTypes: ["next_action_changed"],
    status: "active",
    verifiedAt: "2026-07-20T00:00:00.000Z",
    createdBy: owner.userId!,
    createdAt: "2026-07-20T00:00:00.000Z",
  });
  return { store, service, projectId: bootstrap.project.id };
}

describe("next action explainability and audit", () => {
  it("records only material transitions and enqueues one atomic notification per change", async () => {
    const { store, service, projectId } = await setup();

    const baseline = await service.overview(owner, projectId);
    expect(baseline.nextAction).toMatchObject({ rule: "baseline_missing", kind: "ESTABLISH_BASELINE" });
    expect(baseline.nextActionHistory).toHaveLength(1);
    expect(baseline.nextActionHistory[0]).toMatchObject({
      actor: { kind: "user", role: "owner", actorId: owner.userId },
      inputs: {
        assurance: { status: "NOT_CONFIGURED" },
        approvals: { pendingCount: 0 },
        incidents: { activeCount: 0 },
      },
      decision: { rule: "baseline_missing", kind: "ESTABLISH_BASELINE" },
    });
    expect(await store.listNotificationJobs(projectId)).toHaveLength(0);

    await Promise.all(Array.from({ length: 5 }, () => service.overview(owner, projectId)));
    expect(await store.listNextActionDecisions(projectId)).toHaveLength(1);

    const action = await service.proposeAction(owner, projectId, {
      externalId: "po-4850",
      actionType: "SUBMIT",
      targetSystem: "sandbox-erp",
      amount: 4_850,
    });
    await Promise.all(Array.from({ length: 8 }, () => service.overview(owner, projectId)));

    const changed = await store.listNextActionDecisions(projectId);
    expect(changed).toHaveLength(2);
    expect(changed[0]).toMatchObject({
      inputs: {
        approvals: { pendingCount: 1, selected: { id: action.id, riskLevel: "HIGH" } },
      },
      decision: {
        rule: "pending_approval",
        kind: "REVIEW_PENDING_ACTION",
        context: { actionId: action.id },
      },
      previous: {
        decisionId: changed[1]!.id,
        fingerprint: changed[1]!.fingerprint,
        decision: { rule: "baseline_missing" },
      },
    });

    const jobs = await store.listNotificationJobs(projectId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      alertType: "next_action_changed",
      subject: `[AgentCert] Next action changed: ${changed[0]!.decision.title}`,
    });
    expect(jobs[0]!.text).toContain(`view=actions&project=${projectId}&actionId=${action.id}`);

    await Promise.all(Array.from({ length: 5 }, () => service.overview(owner, projectId)));
    expect(await store.listNextActionDecisions(projectId)).toHaveLength(2);
    expect(await store.listNotificationJobs(projectId)).toHaveLength(1);

    await service.reviewAction(owner, projectId, action.id, false, { comment: "Rejected during audit regression." });
    await Promise.all(Array.from({ length: 5 }, () => service.overview(owner, projectId)));
    expect(await store.listNextActionDecisions(projectId)).toHaveLength(3);
    expect(await store.listNotificationJobs(projectId)).toHaveLength(2);
  });
});
