import pytest

from app.exports.sanitizer import detect_categories, scan_text, scan_value

# Secret-looking values are assembled at runtime so this file itself never
# contains a real-looking credential literal.
OPENAI_STYLE = "sk-" + "Ab3dE5gH7jK9mN1pQ3rS5tU7"
AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP"
GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
JWT = "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk"
PRIVATE_KEY = "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIB..."


@pytest.mark.parametrize(
    "text,category",
    [
        (f"use key {OPENAI_STYLE} for calls", "api_key"),
        (f"aws {AWS_KEY}", "api_key"),
        (f"token {GITHUB_TOKEN}", "api_key"),
        ("Authorization: Bearer abcdef0123456789ABCDEF", "bearer_token"),
        (f"jwt={JWT}", "jwt"),
        (PRIVATE_KEY, "private_key"),
        ("X-API-Key: 0123456789abcdef0123456789", "auth_header"),
        ("connect to postgres://admin:hunter2pass@db.internal/app", "credential_url"),
        ("GET https://api.example.com/data?access_token=abcdef123456", "credential_url"),
        ("https://host/path?access_token=secret", "credential_url"),
        ("https://api.example.com/v1?api_key=abcd1234efgh", "credential_url"),
        ("POST https://idp.example.com/oauth/token?client_secret=s3cr3t-value-123", "credential_url"),
        ("https://user:password@host/path", "credential_url"),
        ("client_secret=s3cr3t-value-123", "secret_assignment"),
        ("access_token = a1b2c3d4e5f6", "secret_assignment"),
        ("password = Tr0ub4dor&3xyz", "secret_assignment"),
        ('config: {"api_key": "a1b2c3d4e5f6g7h8i9"}', "secret_assignment"),
    ],
)
def test_detects_each_category(text, category):
    assert category in detect_categories(text)


@pytest.mark.parametrize(
    "text",
    [
        "Translate the input into natural English.",
        "A Bearer token is required to call the service.",
        "password: required",
        "Set the API key in the environment before running.",
        "See https://example.com/docs/token-economics for background.",
        "Use https://example.com/guide/overview.",
        "The task-based workflow uses sk-learn style pipelines.",
        "api_key: <your-api-key-here>",
        "secret = ${SECRET_VALUE}",
        "password=********",
    ],
)
def test_no_false_positive_on_ordinary_text(text):
    assert detect_categories(text) == set()


# ---- Phase 9 정책: Credential 값의 존재가 기준이며 "경로 이름"은 기준이 아니다 (False-positive 회귀) ----


@pytest.mark.parametrize(
    "text",
    [
        "https://example.com/oauth/token",
        "https://example.com/oauth/authorize",
        "https://example.com/oauth2/v2/token",
        "Exchange the code at https://idp.example.com/oauth/token (POST, form-encoded).",
        "SSO: https://idp.example.com/saml/metadata and https://idp.example.com/sso/login",
        "POST https://example.com/token with grant_type=client_credentials",
        "Open https://example.com/authorize?response_type=code&client_id=my-public-app&scope=read",
        "https://x.io/?access_token=<your-token>",
        "https://x.io/?access_token={token}",
        "https://x.io/?api_key=${API_KEY}",
        "https://x.io/?client_secret=YOUR_CLIENT_SECRET",
        "https://user:<password>@host/path",
        "client_secret=YOUR_CLIENT_SECRET",
        "client_secret=<paste-here>",
        "password=********",
        "api_key: xxxxxxxx",
        "Send the access token in the Authorization header (Bearer scheme).",
    ],
)
def test_documentation_urls_and_placeholders_are_not_credentials(text):
    assert detect_categories(text) == set()
    assert scan_value({"description": text}) == []


@pytest.mark.parametrize(
    "text,category",
    [
        ("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop", "bearer_token"),
        ("https://host/path?access_token=secret", "credential_url"),
        ("https://user:password@host", "credential_url"),
        ("client_secret=s3cr3t-value-123", "secret_assignment"),
        ("password = Tr0ub4dor&3xyz", "secret_assignment"),
        (f"-----BEGIN PRIVATE KEY-----\nMIIEv", "private_key"),
    ],
)
def test_actual_credential_values_are_always_blocked(text, category):
    assert category in detect_categories(text)
    assert scan_value({"description": text})


def test_an_auth_endpoint_url_next_to_a_real_secret_still_blocks_only_because_of_the_secret():
    text = f"POST https://idp.example.com/oauth/token with client_secret=s3cr3t-value-123"
    assert detect_categories(text) == {"secret_assignment"}
    assert "auth_endpoint" not in detect_categories(text)


def test_secret_field_by_name_in_structured_data():
    findings = scan_value({"usageExamples": [{"input": {"apiKey": "9f8e7d6c5b4a3210", "name": "ok"}}]})
    assert [(f.path, f.category) for f in findings] == [("/usageExamples/0/input/apiKey", "secret_field")]


def test_schema_property_named_token_is_not_a_secret():
    # `properties.token` is an object (a JSON-Schema property definition), not a string value.
    assert scan_value({"inputSchema": {"properties": {"token": {"type": "string"}, "password": {"type": "string"}}}}) == []


def test_findings_never_contain_the_secret_value():
    findings = scan_value({"instructions": {"rules": [f"always send {OPENAI_STYLE}"]}, "x": {"password": "Tr0ub4dor&3xyz"}})
    assert findings
    rendered = repr(findings)
    assert OPENAI_STYLE not in rendered
    assert "Tr0ub4dor" not in rendered
    assert {f.category for f in findings} >= {"api_key", "secret_field"}


def test_paths_use_json_pointer_with_optional_label_prefix():
    findings = scan_value({"a/b": [f"x {OPENAI_STYLE}"]}, "child:parser:")
    assert findings[0].path == "child:parser:/a~1b/0"


def test_scan_text_reports_one_finding_per_category_per_path():
    findings = scan_text(f"{OPENAI_STYLE} and again {OPENAI_STYLE}", "references/notes.txt")
    assert [(f.path, f.category) for f in findings] == [("references/notes.txt", "api_key")]
