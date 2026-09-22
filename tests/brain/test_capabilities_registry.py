from app.common.capabilities.registry import CapabilityFlags, CapabilityRegistry


def test_defaults_reflect_phase6_implemented_capabilities():
    registry = CapabilityRegistry()
    flags = registry.supported()
    assert flags == CapabilityFlags()
    # Implemented this phase (Sandbox + Tool executors, local RAG search):
    assert registry.is_supported("code_execution") is True
    assert registry.is_supported("data_analysis") is True
    assert registry.is_supported("file_analysis") is True
    assert registry.is_supported("knowledge_search") is True
    # Still genuinely unimplemented (no external service integration):
    assert registry.is_supported("web_search") is False
    assert registry.is_supported("image_generation") is False
    assert registry.is_supported("mcp") is False


def test_reports_explicitly_configured_capabilities():
    registry = CapabilityRegistry(CapabilityFlags(file_analysis=False, web_search=True))
    assert registry.is_supported("file_analysis") is False
    assert registry.is_supported("web_search") is True
    assert registry.is_supported("mcp") is False
