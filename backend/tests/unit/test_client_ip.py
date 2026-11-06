from ipaddress import ip_network

from app.core.client_ip import is_trusted_peer, parse_ip, resolve_client_ip

PRIVATE = [ip_network("10.0.0.0/8"), ip_network("127.0.0.0/8")]
HEADER = "true-client-ip"


def test_header_ignored_when_not_configured():
    assert resolve_client_ip("10.1.2.3", {HEADER: "203.0.113.9"}, None, PRIVATE) == "10.1.2.3"


def test_header_used_when_request_came_through_trusted_proxy():
    assert resolve_client_ip("10.21.157.68", {HEADER: "203.0.113.9"}, HEADER, PRIVATE) == "203.0.113.9"
    assert resolve_client_ip("10.0.0.1", {HEADER: "2001:db8::1"}, HEADER, PRIVATE) == "2001:db8::1"


def test_header_ignored_from_untrusted_peer():
    # A client connecting directly cannot choose its own identity.
    assert resolve_client_ip("198.51.100.4", {HEADER: "203.0.113.9"}, HEADER, PRIVATE) == "198.51.100.4"


def test_invalid_or_missing_header_falls_back_to_peer():
    for value in ("", "not-an-ip", "203.0.113.9, 198.51.100.1", "<script>"):
        assert resolve_client_ip("10.0.0.1", {HEADER: value}, HEADER, PRIVATE) == "10.0.0.1"
    assert resolve_client_ip("10.0.0.1", {}, HEADER, PRIVATE) == "10.0.0.1"


def test_x_forwarded_for_is_never_used():
    headers = {"x-forwarded-for": "6.6.6.6, 203.0.113.9, 104.22.17.40"}
    assert resolve_client_ip("10.0.0.1", headers, HEADER, PRIVATE) == "10.0.0.1"


def test_missing_peer():
    assert resolve_client_ip(None, {}, HEADER, PRIVATE) == "unknown"


def test_cf_connecting_ip_from_trusted_peer():
    headers = {"cf-connecting-ip": "203.0.113.7", "true-client-ip": "6.6.6.6", "x-forwarded-for": "6.6.6.6"}
    assert resolve_client_ip("10.0.0.1", headers, "cf-connecting-ip", PRIVATE) == "203.0.113.7"


def test_spoofed_headers_from_internet_peer_are_ignored():
    headers = {"cf-connecting-ip": "6.6.6.6", "true-client-ip": "6.6.6.6", "x-forwarded-for": "6.6.6.6"}
    for header in ("cf-connecting-ip", "true-client-ip"):
        assert resolve_client_ip("198.51.100.4", headers, header, PRIVATE) == "198.51.100.4"


def test_parse_ip():
    assert parse_ip(" 203.0.113.9 ") == "203.0.113.9"
    assert parse_ip("2001:DB8::1") == "2001:db8::1"
    for value in (None, "", "1.2.3.4, 5.6.7.8", "example.com", "1.2.3.4:80"):
        assert parse_ip(value) is None


def test_is_trusted_peer():
    assert is_trusted_peer("10.9.8.7", PRIVATE)
    assert not is_trusted_peer("198.51.100.4", PRIVATE)
    assert not is_trusted_peer("testclient", PRIVATE)
    assert not is_trusted_peer(None, PRIVATE)
