export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSendResult {
  provider: string;
  messageId?: string;
}

export interface EmailProvider {
  readonly name: string;
  readonly configured: boolean;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export class DisabledEmailProvider implements EmailProvider {
  readonly name = "disabled";
  readonly configured = false;
  async send(): Promise<EmailSendResult> { throw new Error("Email notifications are not configured."); }
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  readonly configured = true;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly requestFetch: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const response = await this.requestFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
    });
    const body = await response.json().catch(() => ({})) as { id?: string; message?: string; name?: string };
    if (!response.ok) throw new Error(`Resend returned ${response.status}: ${body.message ?? body.name ?? "email delivery failed"}`);
    return { provider: this.name, messageId: body.id };
  }
}
