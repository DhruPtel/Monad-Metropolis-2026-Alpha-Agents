# E2B sandbox template for the agent brain: Hermes Agent, unmodified, pinned at a commit.
# Built by services/orchestrator/src/spike/build-template.ts with E2B's Template.fromDockerfile.
# Python 3.14 because Hermes' uv.lock only resolves for python_full_version >= 3.14.
# Nothing secret is baked in: credentials are injected by E2B's egress proxy per host and never
# enter the sandbox.
FROM python:3.14.3-slim-trixie@sha256:5e59aae31ff0e87511226be8e2b94d78c58f05216efda3b07dbbed938ec8583b

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    HERMES_COMMIT=085d9ee608893bb0611c2fc339c19d8848af9f2b \
    HERMES_DISABLE_LAZY_INSTALLS=1 \
    # httpx (the OpenAI SDK's client) uses certifi unless told otherwise; the system bundle is
    # where E2B's egress proxy CA has to be trusted for header injection to work over HTTPS.
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends git ca-certificates curl sqlite3 \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv==0.12.22

# Source checkout at the pinned commit, installed from Hermes' own lockfile. Extras: mcp (the MCP
# client) and sms, which is only aiohttp, needed by the API server; nothing else optional.
RUN git clone https://github.com/NousResearch/hermes-agent.git /opt/hermes \
 && cd /opt/hermes \
 && git checkout --detach "$HERMES_COMMIT" \
 && test "$(git rev-parse HEAD)" = "$HERMES_COMMIT" \
 && uv sync --frozen --no-dev --python /usr/local/bin/python3.14 --extra mcp --extra sms \
 && ln -s /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes \
 && chmod -R a-w /opt/hermes

# The skill mount point: written by root at sandbox start, read-only to the agent user.
RUN mkdir -p /opt/agent-skills && chmod 555 /opt/agent-skills
