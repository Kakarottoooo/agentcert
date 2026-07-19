import json
import unittest
from unittest.mock import patch

from agentcert_sdk import AgentCertClient, RunRecorder


class FakeResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps({"decision": "REQUIRE_APPROVAL", "id": "action-1"}).encode()


class ClientTest(unittest.TestCase):
    @patch("urllib.request.urlopen", return_value=FakeResponse())
    def test_assess_action_uses_project_scoped_endpoint(self, urlopen):
        client = AgentCertClient("https://agentcert.example", "project-1", "ac_live_test")
        result = client.assess_action(
            externalId="po-1",
            principal={"id": "agent-1"},
            actionType="SUBMIT",
            targetSystem="MockERP",
            requestedPermissions=["MockERP:SUBMIT"],
        )

        request = urlopen.call_args.args[0]
        self.assertEqual(result["decision"], "REQUIRE_APPROVAL")
        self.assertEqual(
            request.full_url, "https://agentcert.example/v1/projects/project-1/actions"
        )
        self.assertEqual(request.headers["Authorization"], "Bearer ac_live_test")

    @patch("urllib.request.urlopen", return_value=FakeResponse())
    def test_upload_evidence_includes_manifest_source_path(self, urlopen):
        client = AgentCertClient("https://agentcert.example", "project-1", "ac_live_test")
        client.upload_evidence(
            b"{}",
            "trace.json",
            content_type="application/json",
            kind="trace",
            run_id="run-1",
            source_path="traces/trace.json",
        )
        request = urlopen.call_args.args[0]
        self.assertIn("sourcePath=traces%2Ftrace.json", request.full_url)

    @patch("urllib.request.urlopen", return_value=FakeResponse())
    def test_send_envelope_uses_idempotency_key(self, urlopen):
        client = AgentCertClient("https://agentcert.example", "project-1", "ac_live_test")
        client.send_envelope(
            {"envelopeId": "envelope-1", "schemaVersion": "agentcert.envelope.v0.1"}
        )
        request = urlopen.call_args.args[0]
        self.assertEqual(request.headers["Idempotency-key"], "envelope-1")


class RecordingRunClient:
    def __init__(self):
        self.started = []
        self.batches = []
        self.idempotency_keys = []
        self.completed = []

    def start_run(self, **input):
        self.started.append(input)
        return {"id": "run-observe-1", "status": "running"}

    def append_events(self, run_id, events, *, idempotency_key=None):
        self.batches.append((run_id, events))
        self.idempotency_keys.append(idempotency_key)
        return {"events": events}

    def complete_run(self, run_id, **input):
        self.completed.append((run_id, input))
        return {"id": run_id, **input}


class RunRecorderTest(unittest.TestCase):
    def test_records_ordered_trace_linked_events(self):
        client = RecordingRunClient()
        recorder = RunRecorder.start(  # type: ignore[arg-type]
            client, {"externalId": "release-1", "kind": "release_gate"}, batch_size=2
        )
        recorder.record_event("tripwire.fault.assertion", payload={"passed": True})
        recorder.complete(status="passed", score=100)

        self.assertEqual(
            [event["sequence"] for _, batch in client.batches for event in batch], [0, 1, 2]
        )
        self.assertEqual(client.started[0]["traceId"], recorder.trace["traceId"])
        self.assertEqual(client.batches[0][1][1]["parentSpanId"], recorder.trace["spanId"])
        self.assertEqual(client.idempotency_keys, ["events-0-1", "events-2-2"])


if __name__ == "__main__":
    unittest.main()
