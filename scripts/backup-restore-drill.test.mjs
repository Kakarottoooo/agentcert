import test from "node:test";
import assert from "node:assert/strict";
import { validateRestoreTarget } from "./backup-restore-drill.mjs";

test("requires a separate, explicitly confirmed restore target", () => {
  assert.throws(() => validateRestoreTarget(
    "postgresql://user:secret@db.example.com/prod",
    "postgresql://user:secret@db.example.com/prod",
    "prod",
  ), /must not be the source/);
  assert.throws(() => validateRestoreTarget(
    "postgresql://user:secret@db.example.com/prod",
    "postgresql://user:secret@db.example.com/other",
    "other",
  ), /must contain restore/);
  assert.throws(() => validateRestoreTarget(
    "postgresql://user:secret@db.example.com/prod",
    "postgresql://user:secret@db.example.com/agentcert_restore",
    "wrong",
  ), /must exactly match/);
});

test("returns sanitized connection metadata for an approved drill", () => {
  const result = validateRestoreTarget(
    "postgresql://user:source-secret@source.example.com/prod",
    "postgresql://user:target-secret@target.example.com/agentcert_restore",
    "agentcert_restore",
  );
  assert.equal(result.target.database, "agentcert_restore");
  assert.equal(result.target.password, "target-secret");
});
