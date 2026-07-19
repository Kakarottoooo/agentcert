import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryArtifactStore } from "../src/artifacts.js";
import { Authenticator } from "../src/auth.js";
import type { EmailMessage, EmailProvider } from "../src/notifications.js";
import { AgentCertControlPlane, ControlPlaneError } from "../src/service.js";
import { InMemoryControlPlaneStore } from "../src/store.js";
import { createControlPlaneHttpServer } from "../src/server.js";
import type { AuthContext } from "../src/types.js";

class CaptureEmailProvider implements EmailProvider {
  readonly name = "capture";
  readonly configured = true;
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage) { this.messages.push(message); return { provider: this.name, messageId: `message-${this.messages.length}` }; }
}

const owner: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000001", email: "owner@example.com" };
const operator: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000002", email: "operator@example.com" };
const viewer: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000003", email: "viewer@example.com" };

function invitationToken(message: EmailMessage): string {
  const match = message.text.match(/[?&]invite=([^\s]+)/);
  if (!match) throw new Error("Invitation token was not present in the email.");
  return decodeURIComponent(match[1]!);
}

async function setup() {
  const store = new InMemoryControlPlaneStore();
  const email = new CaptureEmailProvider();
  const service = new AgentCertControlPlane(store, new MemoryArtifactStore(), undefined, [], undefined, undefined, fetch, email, "https://agentcert.app");
  const bootstrap = await service.bootstrap(owner);
  const secondProject = await service.createProject(owner, { name: "Restricted project" });
  return { store, email, service, bootstrap, secondProject };
}

describe("Team & Access Management v0.1", () => {
  it("accepts a hashed, email-bound invitation and enforces project-scoped operator access", async () => {
    const { store, email, service, bootstrap, secondProject } = await setup();
    const created = await service.createTeamInvitation(owner, bootstrap.organization.id, {
      email: operator.email, role: "operator", projectIds: [secondProject.id],
    });

    expect(created).not.toHaveProperty("tokenHash");
    expect(created).toMatchObject({ deliveryStatus: "sent", role: "operator", projectIds: [secondProject.id] });
    const stored = (await store.listTeamInvitations(bootstrap.organization.id))[0]!;
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.tokenHash).not.toContain(invitationToken(email.messages[0]!));

    const accepted = await service.acceptTeamInvitation(operator, { token: invitationToken(email.messages[0]!) });
    expect(accepted).toEqual({ organizationId: bootstrap.organization.id, projectId: secondProject.id });
    expect((await service.projects(operator)).map((project) => project.id)).toEqual([secondProject.id]);
    await expect(service.startRun(operator, secondProject.id, { externalId: "operator-run", kind: "custom" })).resolves.toMatchObject({ externalId: "operator-run" });
    await expect(service.listAssuranceCases(operator, secondProject.id)).resolves.toEqual([]);
    await expect(service.onboardingStatus(operator, secondProject.id))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403, code: "project_role_insufficient" });
    await expect(service.listRuns(operator, bootstrap.project.id)).rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403, code: "project_access_denied" });

    const snapshot = await service.teamSnapshot(operator, bootstrap.organization.id);
    expect(snapshot.audit.map((item) => item.action)).toEqual(expect.arrayContaining(["invitation_created", "invitation_accepted"]));
    expect(snapshot.invitations[0]).not.toHaveProperty("tokenHash");

    await service.updateTeamMember(owner, bootstrap.organization.id, operator.userId!, { role: "viewer", projectIds: [secondProject.id] });
    await expect(service.startRun(operator, secondProject.id, { externalId: "viewer-write", kind: "custom" }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403, code: "project_role_insufficient" });
    await service.updateTeamMember(owner, bootstrap.organization.id, operator.userId!, { role: "operator", projectIds: [secondProject.id] });
    await service.removeTeamMember(owner, bootstrap.organization.id, operator.userId!);
    expect(await service.projects(operator)).toEqual([]);
    expect((await service.teamSnapshot(owner, bootstrap.organization.id)).audit.map((item) => item.action))
      .toEqual(expect.arrayContaining(["member_role_changed", "member_removed"]));
  });

  it("binds acceptance to the invited email and keeps viewers read-only", async () => {
    const { email, service, bootstrap } = await setup();
    await service.createTeamInvitation(owner, bootstrap.organization.id, { email: viewer.email, role: "viewer", projectIds: [bootstrap.project.id] });
    const token = invitationToken(email.messages[0]!);
    await expect(service.acceptTeamInvitation({ ...viewer, email: "wrong@example.com" }, { token }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403, code: "team_invitation_email_mismatch" });
    await service.acceptTeamInvitation(viewer, { token });
    await expect(service.listRuns(viewer, bootstrap.project.id)).resolves.toEqual([]);
    await expect(service.startRun(viewer, bootstrap.project.id, { externalId: "forbidden", kind: "custom" }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403, code: "project_role_insufficient" });
  });

  it("enforces admin delegation boundaries and protects the last owner", async () => {
    const { email, service, bootstrap } = await setup();
    await service.createTeamInvitation(owner, bootstrap.organization.id, { email: "admin@example.com", role: "admin", projectIds: [] });
    const admin: AuthContext = { kind: "user", userId: "00000000-0000-4000-8000-000000000004", email: "admin@example.com" };
    await service.acceptTeamInvitation(admin, { token: invitationToken(email.messages[0]!) });
    await expect(service.createProject(admin, { name: "Admin project", organizationId: bootstrap.organization.id }))
      .resolves.toMatchObject({ organizationId: bootstrap.organization.id, name: "Admin project" });

    await expect(service.createTeamInvitation(admin, bootstrap.organization.id, { email: "other-admin@example.com", role: "admin", projectIds: [] }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403, code: "team_role_assignment_forbidden" });
    await expect(service.updateTeamMember(admin, bootstrap.organization.id, owner.userId!, { role: "viewer", projectIds: [bootstrap.project.id] }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 403, code: "team_member_manage_forbidden" });
    await expect(service.updateTeamMember(owner, bootstrap.organization.id, owner.userId!, { role: "admin" }))
      .rejects.toMatchObject<Partial<ControlPlaneError>>({ status: 409, code: "team_last_owner" });
  });

  it("exposes authenticated team routes without returning invitation hashes", async () => {
    const { store, email, service, bootstrap } = await setup();
    const server = createControlPlaneHttpServer({
      service, authenticator: new Authenticator({ store, devMode: true }), publicConfig: {
        kind: "agentcert.control_plane_config", hosted: true, publicUrl: "http://127.0.0.1", auth: { provider: "development", registrationOpen: true },
      }, host: "127.0.0.1", port: 0, dashboardDir: ".", maxArtifactBytes: 1024,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const headers = { authorization: "Bearer dev-local-token", "content-type": "application/json" };
      const invite = await fetch(`${base}/v1/organizations/${bootstrap.organization.id}/invitations`, {
        method: "POST", headers, body: JSON.stringify({ email: "api-viewer@example.com", role: "viewer", projectIds: [bootstrap.project.id] }),
      });
      expect(invite.status).toBe(201);
      expect(await invite.json()).not.toHaveProperty("tokenHash");
      expect(email.messages).toHaveLength(1);
      const team = await fetch(`${base}/v1/organizations/${bootstrap.organization.id}/team`, { headers });
      expect(team.status).toBe(200);
      expect(await team.json()).toMatchObject({ currentMembership: { role: "owner" }, invitations: [{ email: "api-viewer@example.com" }] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
