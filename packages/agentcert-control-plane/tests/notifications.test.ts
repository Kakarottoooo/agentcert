import { describe, expect, it, vi } from "vitest";
import { ResendEmailProvider } from "../src/notifications.js";

describe("ResendEmailProvider", () => {
  it("sends through the platform account without accepting user SMTP credentials", async () => {
    const requestFetch = vi.fn(async () => new Response(JSON.stringify({ id: "email-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const provider = new ResendEmailProvider("platform-token", "AgentCert <alerts@agentcert.dev>", requestFetch as typeof fetch);

    await expect(provider.send({
      to: "security@example.com",
      subject: "Incident opened",
      text: "A production smoke failed.",
      html: "<p>A production smoke failed.</p>",
    })).resolves.toEqual({ provider: "resend", messageId: "email-1" });

    expect(requestFetch).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer platform-token" }),
    }));
    const body = JSON.parse(String(requestFetch.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ from: "AgentCert <alerts@agentcert.dev>", to: ["security@example.com"] });
    expect(body).not.toHaveProperty("smtpPassword");
  });

  it("surfaces provider failures", async () => {
    const provider = new ResendEmailProvider("platform-token", "alerts@agentcert.dev", async () => new Response(
      JSON.stringify({ message: "domain is not verified" }),
      { status: 422, headers: { "content-type": "application/json" } },
    ));
    await expect(provider.send({ to: "security@example.com", subject: "x", text: "x", html: "x" }))
      .rejects.toThrow("Resend returned 422: domain is not verified");
  });
});
