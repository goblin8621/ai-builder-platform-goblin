from app.common.errors import AppError


def test_http_status_mapping():
    assert AppError("validation_error", "bad input").http_status == 400
    assert AppError("not_found", "missing").http_status == 404
    assert AppError("version_conflict", "stale").http_status == 409
    assert AppError("internal_error", "boom").http_status == 500


def test_to_api_error_carries_request_id_and_details():
    err = AppError("validation_error", "bad input", details={"field": "name"})
    api_error = err.to_api_error(request_id="req-1")
    assert api_error.code == "validation_error"
    assert api_error.message == "bad input"
    assert api_error.details == {"field": "name"}
    assert api_error.requestId == "req-1"
