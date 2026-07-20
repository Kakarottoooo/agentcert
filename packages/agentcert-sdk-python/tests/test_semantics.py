import unittest

from agentcert_sdk import instrument_async_tool, instrument_tool


CAPABILITY = {
    "schemaVersion": "agentcert.capability_manifest.v0.1",
    "id": "data.query",
}


class Recorder:
    def __init__(self):
        self.events = []

    def child_trace(self):
        return {"traceId": "a" * 32, "spanId": "b" * 16}

    def record_event(self, event_type, *, payload, trace):
        self.events.append({"type": event_type, "payload": payload, "trace": trace})


class SemanticsTest(unittest.IsolatedAsyncioTestCase):
    def test_sync_wrapper_records_redacted_semantics(self):
        recorder = Recorder()
        wrapped = instrument_tool(recorder, CAPABILITY, lambda value: {"rows": [value["query"]]}, tool_name="sql_query")

        self.assertEqual(wrapped({"query": "select 1", "api_key": "never-store-this"}), {"rows": ["select 1"]})
        self.assertEqual([item["payload"]["semantic"]["phase"] for item in recorder.events], ["started", "completed"])
        self.assertNotIn("never-store-this", str(recorder.events))

    async def test_async_wrapper_preserves_result(self):
        recorder = Recorder()

        async def execute(value):
            return value + 1

        wrapped = instrument_async_tool(recorder, CAPABILITY, execute)
        self.assertEqual(await wrapped(4), 5)
        self.assertEqual(len(recorder.events), 2)


if __name__ == "__main__":
    unittest.main()
