import { describe, expect, it, beforeEach } from "vitest";
import { captureActionIntent } from "../src/service.js";
import { parsePolicyConfig } from "../src/policy-config.js";
import { resetActionGatewayStore } from "../src/store.js";

describe("policy-as-code", () => {
  beforeEach(() => {
    resetActionGatewayStore();
  });

  it("parses policy config rules", () => {
    const rules = parsePolicyConfig({
      schemaVersion: "1",
      rules: [
        {
          id: "block-demo-payments",
          name: "Block demo payments",
          description: "Payments are blocked in this demo policy.",
          actionTypes: ["PAY"],
          effect: "BLOCK",
          enabled: true,
        },
      ],
    });

    expect(rules).toHaveLength(1);
    expect(rules[0]?.effect).toBe("BLOCK");
  });

  it("applies custom policy rules when capturing an action", () => {
    const rules = parsePolicyConfig({
      schemaVersion: "1",
      rules: [
        {
          id: "block-demo-payments",
          name: "Block demo payments",
          description: "Payments are blocked in this demo policy.",
          actionTypes: ["PAY"],
          effect: "BLOCK",
          enabled: true,
        },
      ],
    });

    const review = captureActionIntent(
      {
        sourceAgentName: "FinanceAgent",
        actionType: "PAY",
        targetSystem: "MockAP",
        title: "Pay demo invoice",
        description: "Attempt a local mock payment.",
        businessObjectType: "invoice",
        businessObjectId: "inv-demo",
        amount: 25,
        currency: "USD",
        beforeState: { status: "APPROVED" },
        proposedAfterState: { status: "PAID" },
        fieldsChanged: [{ field: "status", before: "APPROVED", after: "PAID" }],
      },
      { policyRules: rules },
    );

    expect(review.blocked).toBe(true);
    expect(review.action.status).toBe("CANCELLED");
    expect(review.policyRules.map((rule) => rule.id)).toEqual(["block-demo-payments"]);
  });

  it("always blocks production actions in the local demo runtime", () => {
    const rules = parsePolicyConfig({
      schemaVersion: "1",
      rules: [
        {
          id: "allow-submit",
          name: "Allow submit",
          description: "Allow submit actions in a custom policy.",
          actionTypes: ["SUBMIT"],
          effect: "ALLOW",
          enabled: true,
        },
      ],
    });

    const review = captureActionIntent(
      {
        sourceAgentName: "ProcurementAgent",
        actionType: "SUBMIT",
        targetSystem: "MockERP",
        environment: "production",
        title: "Submit production purchase order",
        description: "This should be blocked in the local demo runtime.",
        businessObjectType: "purchase_order",
        businessObjectId: "po-prod",
        amount: 10,
        beforeState: { status: "DRAFT" },
        proposedAfterState: { status: "SUBMITTED" },
        fieldsChanged: [{ field: "status", before: "DRAFT", after: "SUBMITTED" }],
      },
      { policyRules: rules },
    );

    expect(review.blocked).toBe(true);
    expect(review.action.status).toBe("CANCELLED");
    expect(review.policyRules.map((rule) => rule.id)).toContain("production-actions-blocked-in-demo");
  });
});
