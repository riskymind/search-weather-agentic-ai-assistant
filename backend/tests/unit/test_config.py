import pytest

from app.core.config import ConfigurationError, load_settings
from tests.conftest import FAKE_OPENAI_KEY, make_settings


def test_defaults(settings):
    assert settings.openai_model == "gpt-4o-mini"
    assert settings.app_env == "development"
    assert settings.weather_api_base_url == "https://api.weatherstack.com"
    assert settings.cors_origins == ["http://localhost:3000"]
    assert settings.agent_max_steps > 0
    assert settings.agent_timeout_seconds > 0


def test_missing_required_variables_are_all_reported():
    with pytest.raises(ConfigurationError) as exc_info:
        load_settings(_env_file=None)
    message = str(exc_info.value)
    for name in ("OPENAI_API_KEY", "TAVILY_API_KEY", "WEATHER_API_KEY"):
        assert f"{name}: is required but not set" in message


def test_reads_from_environment(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", FAKE_OPENAI_KEY)
    monkeypatch.setenv("TAVILY_API_KEY", "tvly-x-0000")
    monkeypatch.setenv("WEATHER_API_KEY", "wx-x-0000")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-4.1-mini")
    monkeypatch.setenv("LOG_LEVEL", "debug")
    settings = load_settings(_env_file=None)
    assert settings.openai_model == "gpt-4.1-mini"
    assert settings.log_level == "DEBUG"
    assert settings.openai_api_key.get_secret_value() == FAKE_OPENAI_KEY


def test_blank_secret_is_rejected():
    with pytest.raises(ConfigurationError, match="OPENAI_API_KEY: Value error, must not be empty"):
        make_settings(openai_api_key="   ")


def test_secrets_never_appear_in_errors_or_repr():
    with pytest.raises(ConfigurationError) as exc_info:
        make_settings(openai_api_key="sk-super-secret-value", agent_max_steps=0)
    assert "sk-super-secret-value" not in str(exc_info.value)
    assert "sk-super-secret-value" not in repr(make_settings(openai_api_key="sk-super-secret-value"))


@pytest.mark.parametrize(
    "url",
    ["http://api.weatherstack.com", "ftp://api.weatherstack.com", "api.weatherstack.com", "https://"],
)
def test_weather_base_url_must_be_https(url):
    with pytest.raises(ConfigurationError, match=r"WEATHER_API_BASE_URL: .*https://"):
        make_settings(weather_api_base_url=url)


def test_weather_base_url_trailing_slash_is_normalised():
    assert make_settings(weather_api_base_url="https://api.weatherstack.com/").weather_api_base_url == (
        "https://api.weatherstack.com"
    )


def test_frontend_url_required_in_production():
    with pytest.raises(ConfigurationError, match="FRONTEND_URL: Value error, is required when APP_ENV=production"):
        make_settings(app_env="production")


def test_all_production_problems_are_reported_together():
    with pytest.raises(ConfigurationError) as exc_info:
        load_settings(_env_file=None, app_env="production", weather_api_base_url="http://x")
    lines = str(exc_info.value).splitlines()[1:]
    assert sorted(line.split(":")[0].strip(" -") for line in lines) == [
        "ALLOW_PUBLIC_AGENT_API",
        "FRONTEND_URL",
        "OPENAI_API_KEY",
        "TAVILY_API_KEY",
        "WEATHER_API_BASE_URL",
        "WEATHER_API_KEY",
    ]


def test_frontend_url_multiple_origins():
    settings = make_settings(
        app_env="production", frontend_url="https://app.vercel.app, https://example.com/", allow_public_agent_api=True
    )
    assert settings.cors_origins == ["https://app.vercel.app", "https://example.com"]
    assert settings.is_production


@pytest.mark.parametrize("value", ["*", "https://*.vercel.app", "https://app.vercel.app/path", "not-a-url"])
def test_frontend_url_rejects_invalid_origins(value):
    with pytest.raises(ConfigurationError, match="FRONTEND_URL"):
        make_settings(frontend_url=value)


def test_invalid_app_env_rejected():
    with pytest.raises(ConfigurationError, match="APP_ENV"):
        make_settings(app_env="staging")


def test_production_refuses_unauthenticated_agent_api_by_default():
    with pytest.raises(ConfigurationError, match=r"ALLOW_PUBLIC_AGENT_API: .*set API_ACCESS_KEY"):
        make_settings(app_env="production", frontend_url="https://app.vercel.app")
    # Either an access key or an explicit opt-in satisfies it.
    assert make_settings(app_env="production", frontend_url="https://a.app", api_access_key="k" * 32).api_access_key
    assert make_settings(app_env="production", frontend_url="https://a.app", allow_public_agent_api=True)


def test_access_key_must_be_strong():
    with pytest.raises(ConfigurationError, match=r"API_ACCESS_KEY: .*at least 32 characters"):
        make_settings(api_access_key="short")
    assert make_settings(api_access_key="").api_access_key is None


def test_proxy_settings_validation():
    settings = make_settings(client_ip_header="True-Client-IP", trusted_proxy_cidrs="10.0.0.0/8, 192.168.1.7")
    assert settings.client_ip_header == "true-client-ip"
    assert [str(n) for n in settings.trusted_proxy_networks] == ["10.0.0.0/8", "192.168.1.7/32"]
    with pytest.raises(ConfigurationError, match="CLIENT_IP_HEADER"):
        make_settings(client_ip_header="Bad Header: x")
    with pytest.raises(ConfigurationError, match="TRUSTED_PROXY_CIDRS"):
        make_settings(trusted_proxy_cidrs="10.0.0.0/8,not-a-network")


def test_settings_never_read_dotenv_in_tests(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("OPENAI_API_KEY=sk-from-dotenv\n")
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ConfigurationError, match="OPENAI_API_KEY: is required"):
        load_settings()
