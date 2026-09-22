from app.rag.vectorizer import search


def test_empty_corpus_returns_empty_results():
    assert search("hello", []) == []


def test_ranks_the_chunk_with_more_overlapping_words_first():
    corpus = [
        {"documentId": "doc-1", "chunkIndex": 0, "content": "결제 시스템 장애 대응 절차와 롤백 방법"},
        {"documentId": "doc-2", "chunkIndex": 0, "content": "휴가 신청 및 승인 절차 안내"},
    ]
    results = search("결제 장애 발생 시 롤백 절차가 궁금합니다", corpus, top_k=2)

    assert results[0]["documentId"] == "doc-1"
    assert results[0]["score"] > results[1]["score"]


def test_respects_top_k():
    corpus = [{"documentId": f"doc-{i}", "chunkIndex": 0, "content": f"내용 {i}"} for i in range(10)]
    results = search("내용", corpus, top_k=3)
    assert len(results) == 3


def test_is_deterministic_across_calls():
    corpus = [{"documentId": "doc-1", "chunkIndex": 0, "content": "동일한 문장을 반복해서 테스트합니다"}]
    first = search("동일한 문장", corpus)
    second = search("동일한 문장", corpus)
    assert first == second


def test_unrelated_query_scores_lower_than_related_one():
    corpus = [{"documentId": "doc-1", "chunkIndex": 0, "content": "파이썬 데이터 분석 튜토리얼"}]
    related = search("파이썬 데이터 분석 방법", corpus)[0]["score"]
    unrelated = search("오늘 점심 메뉴 추천", corpus)[0]["score"]
    assert related > unrelated
