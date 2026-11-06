"""Response schema for the opt-in client-IP diagnostics endpoint."""

from pydantic import BaseModel


class ClientIpDiagnostics(BaseModel):
    """What the backend sees for the calling request, to verify proxy-header behaviour."""

    peer: str | None
    peer_trusted: bool
    configured_header: str | None
    headers: dict[str, str | None]
    network_client_ip: str
    rate_limit_key: str
