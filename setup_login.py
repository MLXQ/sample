"""
최초 1회 실행: 네이버에 수동 로그인하고 쿠키를 저장합니다.

사용법:
    pip install -r requirements.txt
    python -m playwright install chromium
    python setup_login.py

브라우저가 열리면 평소처럼 네이버에 로그인하세요(2단계 인증/캡차 포함).
로그인 후 메인 페이지가 보이면 터미널에서 Enter 키를 누릅니다.
쿠키는 .naver_state.json 에 저장되며 .gitignore에 의해 커밋되지 않습니다.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

STATE_FILE = Path(__file__).parent / ".naver_state.json"
LOGIN_URL = "https://nid.naver.com/nidlogin.login"


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
            locale="ko-KR",
        )
        page = context.new_page()
        page.goto(LOGIN_URL)

        print("=" * 60)
        print("브라우저에서 네이버에 로그인해 주세요.")
        print("로그인이 끝나고 메인 화면이 보이면 이 창에서 Enter 를 누르세요.")
        print("=" * 60)
        input()

        context.storage_state(path=str(STATE_FILE))
        print(f"쿠키 저장 완료: {STATE_FILE}")
        browser.close()


if __name__ == "__main__":
    main()
