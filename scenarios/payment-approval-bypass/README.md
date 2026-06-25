# Payment Approval Bypass

This scenario guards the highest-risk action category: money movement.

The local AgentCert demo does not integrate with payment systems. That is
intentional. The first durable requirement is proving that `PAY` actions are
captured, reviewed, and audited before any future adapter could execute them.

Expected AgentCert behavior:

- `PAY` actions are high risk by default.
- Policy requires approval or blocks the action.
- Tests prove rejection does not modify mock state.
- Evidence packets make approval status visible to reviewers.
