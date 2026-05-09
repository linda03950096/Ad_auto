#!/usr/bin/env python3
"""
Daily Korean makeup video picker and analyzer.
Searches YouTube for today's best Korean makeup videos,
extracts products via Claude, saves to daily_picks.json.

Required env vars:
  YOUTUBE_API_KEY   — YouTube Data API v3 key
  ANTHROPIC_API_KEY — Anthropic API key
"""

import os, json, time, re, sys
from datetime import datetime, timezone, timedelta
from xml.etree import ElementTree as ET
import requests

YT_KEY     = os.environ["YOUTUBE_API_KEY"]
CLAUDE_KEY = os.environ["ANTHROPIC_API_KEY"]
MODEL      = "claude-haiku-4-5-20251001"
OUT_FILE   = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "daily_picks.json")
TARGET     = 5

SEARCH_QUERIES = [
    ("메이크업 손민수",              "date"),
    ("아이돌 메이크업 따라하기",     "viewCount"),
    ("셀럽 메이크업 손민수 제품",    "relevance"),
    ("뷰티 메이크업 신제품 리뷰",    "date"),
]

CATEGORIES = (
    "베이스/프라이머,파운데이션,쿠션,컨실러,세팅파우더/픽서,"
    "블러셔,하이라이터,컨투어/쉐딩,아이브로우,아이섀도우,"
    "아이라이너,마스카라,립,기타"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.5",
}

# ── YouTube helpers ────────────────────────────────────────────────────

def yt_search(query, order, published_after, max_results=15):
    r = requests.get(
        "https://www.googleapis.com/youtube/v3/search",
        params={
            "key": YT_KEY,
            "q": query,
            "type": "video",
            "part": "snippet",
            "relevanceLanguage": "ko",
            "regionCode": "KR",
            "videoCategoryId": "26",   # Howto & Style
            "publishedAfter": published_after,
            "order": order,
            "maxResults": max_results,
        },
        timeout=15,
    )
    r.raise_for_status()
    return [item["id"]["videoId"] for item in r.json().get("items", []) if "videoId" in item["id"]]


def yt_details(video_ids):
    """Fetch snippet + statistics for up to 50 video IDs."""
    r = requests.get(
        "https://www.googleapis.com/youtube/v3/videos",
        params={
            "key": YT_KEY,
            "id": ",".join(video_ids),
            "part": "snippet,statistics",
        },
        timeout=15,
    )
    r.raise_for_status()
    return r.json().get("items", [])


def score(item):
    stats = item.get("statistics", {})
    views = int(stats.get("viewCount", 0))
    likes = int(stats.get("likeCount", 0))

    pub    = item["snippet"]["publishedAt"]
    pub_dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
    age_h  = (datetime.now(timezone.utc) - pub_dt).total_seconds() / 3600
    recency_bonus = max(0.2, 1.0 - age_h / 168)   # decays over a week

    return (views + likes * 10) * (1 + recency_bonus)


# ── Transcript fetching ────────────────────────────────────────────────

def fetch_transcript(video_id):
    # 1. Try timedtext JSON (ko then en, manual then asr)
    for lang in ("ko", "en"):
        for kind in ("", "&kind=asr"):
            try:
                url = (
                    f"https://www.youtube.com/api/timedtext"
                    f"?v={video_id}&lang={lang}{kind}&fmt=json3"
                )
                r = requests.get(url, headers=HEADERS, timeout=10)
                if r.status_code == 200 and r.content:
                    data = r.json()
                    parts = []
                    for ev in data.get("events", []):
                        if "segs" in ev:
                            parts.append("".join(s.get("utf8", "") for s in ev["segs"]))
                    text = " ".join(parts).strip()
                    if len(text) > 80:
                        return text
            except Exception:
                pass

    # 2. Parse watch page for captionTracks URLs
    try:
        r = requests.get(
            f"https://www.youtube.com/watch?v={video_id}",
            headers=HEADERS,
            timeout=20,
        )
        m = re.search(r'"captionTracks":\s*(\[.*?\])', r.text)
        if m:
            tracks = json.loads(m.group(1))
            # Prefer Korean
            tracks.sort(key=lambda t: 0 if "ko" in t.get("languageCode", "") else 1)
            for track in tracks:
                base = track.get("baseUrl")
                if not base:
                    continue
                try:
                    cr   = requests.get(base, headers=HEADERS, timeout=10)
                    root = ET.fromstring(cr.text)
                    text = " ".join((el.text or "").strip() for el in root.iter("text"))
                    if len(text) > 80:
                        return text
                except Exception:
                    pass
    except Exception:
        pass

    return None


# ── Claude analysis ────────────────────────────────────────────────────

def analyze(transcript, title, channel):
    content = transcript or f"영상 제목: {title}\n채널: {channel}\n(자막 없음 — 제목으로만 추정)"

    prompt = f"""다음은 유튜브 메이크업 영상 정보입니다.

제목: {title}
채널: {channel}
내용:
{content[:8000]}

영상에서 언급된 메이크업 제품을 추출하고 아래 JSON 형식으로만 응답하세요. JSON 외 텍스트는 절대 쓰지 마세요.

{{
  "products": [
    {{
      "category": "카테고리",
      "brand": "브랜드명",
      "name": "제품명",
      "shade": "호수·색상 (없으면 null)",
      "price": "가격 (없으면 null)"
    }}
  ],
  "hashtags": ["#해시태그"]
}}

카테고리(이 중에서만): {CATEGORIES}

규칙:
- 실제 언급된 제품만 추출 (자막 없으면 제목·채널명에서 최대한 유추)
- 해시태그 6-12개, #메이크업 #손민수 반드시 포함
- JSON만 출력"""

    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": CLAUDE_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": MODEL,
            "max_tokens": 1500,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=40,
    )
    r.raise_for_status()
    raw = r.json()["content"][0]["text"]
    m   = re.search(r"\{[\s\S]*\}", raw)
    if not m:
        return {"products": [], "hashtags": []}
    return json.loads(m.group(0))


# ── Post builder ───────────────────────────────────────────────────────

def build_post(products, creator_info, hashtags):
    by_cat = {}
    for p in products:
        by_cat.setdefault(p["category"], []).append(p)

    lines = ["링크를 통해 구매 시 일정 수수료를 지급 받을 수 있습니다.", ""]
    lines.append(f"✺ {creator_info} 메이크업 손민수")

    for cat, items in by_cat.items():
        lines.append(f"\n♡ {cat}")
        for p in items:
            name  = " ".join(x for x in [p.get("brand"), p["name"]] if x)
            shade = f" / {p['shade']}" if p.get("shade") else ""
            price = f" / {p['price']}" if p.get("price") else " / -"
            lines.append(f"{name}{shade}{price}")
            lines.append("🔗")

    if hashtags:
        lines.append("")
        lines.append(" ".join(hashtags))

    return "\n".join(lines)


# ── Main ───────────────────────────────────────────────────────────────

def main():
    now = datetime.now(timezone.utc)
    print(f"[{now:%Y-%m-%d %H:%M} UTC] Starting daily analysis...")

    # Expand search window if today is quiet (1 day → 7 days → 30 days)
    for days_back in (1, 7, 30):
        pub_after = (now - timedelta(days=days_back)).strftime("%Y-%m-%dT%H:%M:%SZ")
        print(f"\nSearching: last {days_back} day(s), after {pub_after}")

        seen, candidates = set(), []
        for query, order in SEARCH_QUERIES:
            try:
                ids = yt_search(query, order, pub_after)
                for vid in ids:
                    if vid not in seen:
                        seen.add(vid)
                        candidates.append(vid)
                print(f"  [{query}] → {len(ids)} results")
                time.sleep(0.4)
            except Exception as e:
                print(f"  Search failed ({query}): {e}")

        if not candidates:
            print("  No candidates, expanding window...")
            continue

        # Batch-fetch statistics (max 50 per request)
        details = []
        for i in range(0, len(candidates), 50):
            try:
                details.extend(yt_details(candidates[i:i + 50]))
                time.sleep(0.3)
            except Exception as e:
                print(f"  Details fetch failed: {e}")

        if not details:
            continue

        details.sort(key=score, reverse=True)
        top5 = details[:TARGET]
        print(f"\nTop {len(top5)} selected. Analyzing...")

        results = []
        for item in top5:
            vid_id  = item["id"]
            title   = item["snippet"]["title"]
            channel = item["snippet"]["channelTitle"]
            thumb   = item["snippet"]["thumbnails"].get("medium", {}).get("url", "")
            pub     = item["snippet"]["publishedAt"]
            stats   = item.get("statistics", {})

            print(f"\n  [{channel}] {title[:60]}")

            transcript = fetch_transcript(vid_id)
            print(f"    Transcript: {'OK' if transcript else 'NONE'} ({len(transcript or '')} chars)")

            try:
                analysis = analyze(transcript, title, channel)
                time.sleep(1.2)  # Anthropic rate-limit buffer
            except Exception as e:
                print(f"    Analysis failed: {e}")
                analysis = {"products": [], "hashtags": []}

            post = build_post(analysis["products"], channel, analysis["hashtags"])

            results.append({
                "videoId":          vid_id,
                "title":            title,
                "channelTitle":     channel,
                "thumbnail":        thumb,
                "publishedAt":      pub,
                "url":              f"https://www.youtube.com/watch?v={vid_id}",
                "viewCount":        int(stats.get("viewCount", 0)),
                "likeCount":        int(stats.get("likeCount", 0)),
                "products":         analysis["products"],
                "hashtags":         analysis["hashtags"],
                "postText":         post,
                "transcriptFetched": transcript is not None,
            })
            print(f"    Products extracted: {len(analysis['products'])}")

        output = {
            "date":        now.strftime("%Y-%m-%d"),
            "generatedAt": now.isoformat(),
            "timeWindow":  f"최근 {days_back}일",
            "videos":      results,
        }

        with open(OUT_FILE, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        print(f"\nSaved {len(results)} videos → {OUT_FILE}")
        return

    print("ERROR: No videos found in any time window.")
    sys.exit(1)


if __name__ == "__main__":
    main()
