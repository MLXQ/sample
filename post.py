"""
저장된 쿠키로 네이버 블로그에 사진 + 캡션을 자동 게시합니다.

사용법:
    python post.py <사진경로> --title "제목" --content "본문"

예시:
    NAVER_BLOG_ID=myblog python post.py ~/photo.jpg \
        --title "오늘의 산책" --content "한강에서 본 노을입니다."

옵션:
    --blog-id    네이버 블로그 ID (환경변수 NAVER_BLOG_ID로도 지정 가능)
    --draft      발행 대신 임시저장만 수행 (선반영 테스트 권장)
    --headless   브라우저 창을 띄우지 않고 실행
    --tag        태그 (여러 번 지정 가능)

주의:
    네이버 스마트에디터의 DOM은 자주 바뀌므로 셀렉터가 어긋날 수 있습니다.
    문제가 있으면 우선 --draft 로 동작 확인 후 발행하세요.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import (
    Page,
    Playwright,
    TimeoutError as PlaywrightTimeoutError,
    sync_playwright,
)

STATE_FILE = Path(__file__).parent / ".naver_state.json"
WRITE_URL_TEMPLATE = "https://blog.naver.com/{blog_id}?Redirect=Write&"


def dismiss_resume_popup(page: Page) -> None:
    """이전에 작성하던 글을 이어서 쓸지 묻는 레이어가 뜨면 '취소'를 눌러 새로 작성합니다."""
    frame = page.frame(name="mainFrame")
    if frame is None:
        return
    for label in ("취소", "새로 작성"):
        try:
            btn = frame.locator(f"button:has-text('{label}')").first
            btn.wait_for(state="visible", timeout=2500)
            btn.click()
            return
        except PlaywrightTimeoutError:
            continue


def dismiss_help_popups(page: Page) -> None:
    """도움말/기능 안내 팝업을 닫습니다."""
    frame = page.frame(name="mainFrame")
    if frame is None:
        return
    for selector in (
        "button.se-help-panel-close-button",
        ".se-popup-button-cancel",
        "button[aria-label='닫기']",
    ):
        try:
            loc = frame.locator(selector).first
            loc.click(timeout=1500)
        except PlaywrightTimeoutError:
            pass
        except Exception:
            pass


def fill_title(page: Page, title: str) -> None:
    frame = page.frame(name="mainFrame")
    assert frame is not None, "mainFrame 을 찾지 못했습니다."
    title_area = frame.locator(".se-title-text .se-text-paragraph").first
    title_area.click(timeout=15000)
    page.keyboard.type(title, delay=15)


def upload_photo(page: Page, photo_path: Path) -> None:
    frame = page.frame(name="mainFrame")
    assert frame is not None
    page.keyboard.press("Tab")
    time.sleep(0.5)

    candidates = (
        "button.se-image-toolbar-button",
        "button[aria-label='사진']",
        "button[data-name='image']",
    )
    photo_btn = None
    for sel in candidates:
        loc = frame.locator(sel).first
        try:
            loc.wait_for(state="visible", timeout=3000)
            photo_btn = loc
            break
        except PlaywrightTimeoutError:
            continue
    if photo_btn is None:
        raise RuntimeError(
            "사진 업로드 버튼을 찾지 못했습니다. 네이버 에디터 UI가 바뀌었을 수 있습니다."
        )

    with page.expect_file_chooser() as fc:
        photo_btn.click()
    fc.value.set_files(str(photo_path))

    # 업로드/렌더 대기
    page.wait_for_timeout(6000)


def type_body(page: Page, content: str) -> None:
    if not content:
        return
    page.keyboard.press("End")
    page.keyboard.press("Enter")
    page.keyboard.type(content, delay=10)


def click_publish(page: Page, draft: bool, tags: list[str]) -> None:
    frame = page.frame(name="mainFrame")
    assert frame is not None

    if draft:
        for sel in ("button:has-text('저장')", "button[aria-label='저장']"):
            try:
                frame.locator(sel).first.click(timeout=4000)
                page.wait_for_timeout(2500)
                return
            except PlaywrightTimeoutError:
                continue
        raise RuntimeError("임시저장 버튼을 찾지 못했습니다.")

    publish_opened = False
    for sel in (
        "button.publish_btn__m9KHH",
        "button:has-text('발행')",
        ".publish_btn_area button",
    ):
        try:
            frame.locator(sel).first.click(timeout=4000)
            publish_opened = True
            break
        except PlaywrightTimeoutError:
            continue
    if not publish_opened:
        raise RuntimeError("발행 패널을 여는 버튼을 찾지 못했습니다.")

    page.wait_for_timeout(1500)

    # 태그 입력
    if tags:
        for sel in ("input#tag-input", "input[placeholder*='태그']"):
            try:
                tag_input = frame.locator(sel).first
                tag_input.click(timeout=3000)
                for tag in tags:
                    page.keyboard.type(tag, delay=10)
                    page.keyboard.press("Enter")
                break
            except PlaywrightTimeoutError:
                continue

    # 최종 발행 버튼 (패널 안)
    for sel in (
        "button.confirm_btn__WEaBq",
        "button:has-text('공개 발행')",
        "button.btn_publish",
        ".btn_area button:has-text('발행')",
    ):
        try:
            frame.locator(sel).first.click(timeout=4000)
            page.wait_for_timeout(5000)
            return
        except PlaywrightTimeoutError:
            continue
    raise RuntimeError("최종 발행 버튼을 찾지 못했습니다.")


def post(
    pw: Playwright,
    blog_id: str,
    photo_path: Path,
    title: str,
    content: str,
    tags: list[str],
    draft: bool,
    headless: bool,
) -> None:
    if not STATE_FILE.exists():
        print("로그인 쿠키가 없습니다. 먼저 `python setup_login.py` 를 실행해 주세요.")
        sys.exit(1)

    browser = pw.chromium.launch(headless=headless)
    context = browser.new_context(
        storage_state=str(STATE_FILE),
        locale="ko-KR",
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
    )
    page = context.new_page()
    page.set_default_timeout(20000)

    try:
        page.goto(WRITE_URL_TEMPLATE.format(blog_id=blog_id))
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(2500)

        dismiss_resume_popup(page)
        dismiss_help_popups(page)

        fill_title(page, title)
        upload_photo(page, photo_path)
        type_body(page, content)
        click_publish(page, draft=draft, tags=tags)

        if draft:
            print("임시저장 완료. 네이버 블로그 글쓰기 화면에서 확인하세요.")
        else:
            print("발행 완료.")
    finally:
        browser.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="네이버 블로그 자동 게시")
    parser.add_argument("photo", help="업로드할 사진 파일 경로")
    parser.add_argument("--title", required=True, help="포스트 제목")
    parser.add_argument("--content", default="", help="본문 텍스트(캡션)")
    parser.add_argument(
        "--blog-id",
        default=os.environ.get("NAVER_BLOG_ID"),
        help="네이버 블로그 ID (없으면 환경변수 NAVER_BLOG_ID 사용)",
    )
    parser.add_argument("--tag", action="append", default=[], help="태그 (여러 번 지정 가능)")
    parser.add_argument("--draft", action="store_true", help="발행하지 않고 임시저장")
    parser.add_argument("--headless", action="store_true", help="브라우저 창 숨김")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if not args.blog_id:
        print("블로그 ID 가 필요합니다. --blog-id 또는 NAVER_BLOG_ID 환경변수를 지정하세요.")
        sys.exit(1)

    photo_path = Path(args.photo).expanduser().resolve()
    if not photo_path.exists():
        print(f"사진 파일을 찾을 수 없습니다: {photo_path}")
        sys.exit(1)

    with sync_playwright() as pw:
        post(
            pw,
            blog_id=args.blog_id,
            photo_path=photo_path,
            title=args.title,
            content=args.content,
            tags=args.tag,
            draft=args.draft,
            headless=args.headless,
        )


if __name__ == "__main__":
    main()
