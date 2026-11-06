"""Client IP resolution behind a reverse proxy.

Forwarded headers are only meaningful when set by infrastructure you control, and only
trustworthy when the request provably came through it.

On Render, requests pass through Cloudflare and then Render's proxy. `X-Forwarded-For` keeps
whatever the client sent and appends to it, so it is spoofable and is deliberately *not*
used. Cloudflare sets `CF-Connecting-IP` on every plan. `True-Client-IP` is only added by
Cloudflare on Enterprise zones (or by a Managed Transform), so without it a client-supplied
value could pass through unchanged. Which header Render's edge actually overwrites must be
verified against the deployed service (see docs/DEPLOYMENT.md, "Client IP").

Rule: honour the configured header only if the direct peer (the socket address) is in a
trusted proxy network, i.e. the request came through the platform's private network rather
than straight from the internet; otherwise use the peer address. Anything that is not a
single valid IP address is ignored.
"""

from collections.abc import Mapping, Sequence
from ipaddress import IPv4Network, IPv6Network, ip_address

# End-user IP reported by the frontend's server-side proxy. Trusted only alongside a valid
# API access key (see `app.api.dependencies.client_key`).
FORWARDED_CLIENT_IP_HEADER = "x-client-ip"


def parse_ip(value: str | None) -> str | None:
    """Return the normalised IP address in `value`, or None if it is not exactly one IP."""
    try:
        return str(ip_address((value or "").strip()))
    except ValueError:
        return None


def resolve_client_ip(
    peer: str | None,
    headers: Mapping[str, str],
    header_name: str | None,
    trusted_networks: Sequence[IPv4Network | IPv6Network],
) -> str:
    """Return the best-known client IP at the network boundary."""
    if not peer:
        return "unknown"
    if not header_name or not is_trusted_peer(peer, trusted_networks):
        return peer
    return parse_ip(headers.get(header_name)) or peer


def is_trusted_peer(peer: str | None, trusted_networks: Sequence[IPv4Network | IPv6Network]) -> bool:
    """True when `peer` is an IP inside one of the trusted proxy networks."""
    try:
        peer_ip = ip_address(peer or "")
    except ValueError:
        return False
    return any(peer_ip in network for network in trusted_networks)
