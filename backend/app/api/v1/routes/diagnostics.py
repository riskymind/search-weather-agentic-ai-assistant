"""Opt-in diagnostics for verifying client-IP resolution on a deployed platform.

Disabled unless CLIENT_IP_DIAGNOSTICS=true *and* API_ACCESS_KEY is set; otherwise it returns
404 as if it did not exist. It only reports the caller's own request, never other clients.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from starlette.exceptions import HTTPException

from app.api.dependencies import (
    client_key,
    enforce_rate_limit,
    get_settings_dep,
    network_client_ip,
    require_api_access,
)
from app.core.client_ip import FORWARDED_CLIENT_IP_HEADER, is_trusted_peer
from app.core.config import Settings
from app.schemas.diagnostics import ClientIpDiagnostics

router = APIRouter(prefix="/diagnostics", tags=["diagnostics"], include_in_schema=False)

REPORTED_HEADERS = ("cf-connecting-ip", "true-client-ip", "x-forwarded-for", "x-real-ip", FORWARDED_CLIENT_IP_HEADER)


@router.get("/client-ip", response_model=ClientIpDiagnostics, dependencies=[Depends(enforce_rate_limit)])
async def client_ip(request: Request, settings: Annotated[Settings, Depends(get_settings_dep)]) -> ClientIpDiagnostics:
    if not settings.client_ip_diagnostics or settings.api_access_key is None:
        raise HTTPException(status_code=404, detail="Not Found")
    await require_api_access(request)
    peer = request.client.host if request.client else None
    return ClientIpDiagnostics(
        peer=peer,
        peer_trusted=is_trusted_peer(peer, settings.trusted_proxy_networks),
        configured_header=settings.client_ip_header,
        headers={name: request.headers.get(name) for name in REPORTED_HEADERS},
        network_client_ip=network_client_ip(request),
        rate_limit_key=client_key(request),
    )
