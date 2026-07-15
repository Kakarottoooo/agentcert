import json
import unittest
from unittest.mock import patch

from agentcert_sdk import AgentCertClient


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


if __name__ == "__main__":
    unittest.main()
