# AgentCert Python SDK

```python
import os
from agentcert_sdk import AgentCertClient

agentcert = AgentCertClient(
    base_url=os.environ["AGENTCERT_BASE_URL"],
    project_id=os.environ["AGENTCERT_PROJECT_ID"],
    api_key=os.environ["AGENTCERT_API_KEY"],
)

decision = agentcert.assess_action(
    externalId="purchase-order-4850",
    principal={"id": "procurement-agent", "type": "agent"},
    actionType="SUBMIT",
    targetSystem="MockERP",
    requestedPermissions=["MockERP:SUBMIT"],
    amount=4850,
    currency="USD",
    expectedState={"status": "SUBMITTED"},
)
```

The client uses only the Python standard library at runtime. It cannot register
identities, grant permissions, or approve runtime actions. An owner or admin
configures those controls in the AgentCert console first.
