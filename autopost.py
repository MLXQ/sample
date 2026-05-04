"""
사진을 폴더에 떨어뜨리거나 인자로 넘기면 자동으로:
  1) Claude API 가 캡션(제목/본문/태그) 을 생성
  2) 저장된 네이버 쿠키로 블로그에 게시
까지 한 번에 처리합니다.

필수 환경변수:
    ANTHROPIC_API_KEY   Claude API 키
    NAVER_BLOG_ID       네이버 블로그 ID (또는 --blog-id)

사용 예시:
    # 폴더 감시 모드 (기본). inbox/ 에 사진을 떨어뜨리면 자동 게시
    python autopost.py --watch

    # 한 장만 즉시 처리하고 종료
    python autopost.py photo.jpg

    # 임시저장 + 브라우저 숨김
    python autopost.py photo.jpg --draft --headless

처리 흐름:
    inbox/photo.jpg
      → Claude 가 캡션 생성
      → 네이버 블로그에 게시
      → 성공: posted/photo.jpg 로 이동
      → 실패: failed/photo.jpg 로 이동 (오류 로그는 콘솔)

처음 실행 전 한 번만:
    python setup_login.py    # 네이버 쿠키 저장
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
import traceback
from pathlib import Path
from typing import Callable

from playwright.sync_api import sync_playwright
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv() -> bool:
        return False

from caption import SUPPORTED_MEDIA, generate_caption
from post import post as naver_post


IMAGE_EXTS = set(SUPPORTED_MEDIA.keys())
STABILIZE_TIMEOUT = 30.0
STABILIZE_INTERVAL = 1.0
STABILIZE_REQUIRED = 2.0


def is_image(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in IMAGE_EXTS


def wait_until_stable(path: Path) -> bool:
    """파일 크기가 변하지 않을 때까지 기다립니다(복사 중 처리 방지)."""
    deadline = time.time() + STABILIZE_TIMEOUT
    last_size = -1
    stable_for = 0.0
    while time.time() < deadline:
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return False
        if size > 0 and size == last_size:
            stable_for += STABILIZE_INTERVAL
            if stable_for >= STABILIZE_REQUIRED:
                return True
        else:
            stable_for = 0.0
            last_size = size
        time.sleep(STABILIZE_INTERVAL)
    return False


def _move_unique(src: Path, dst_dir: Path) -> Path:
    dst_dir.mkdir(parents=True, exist_ok=True)
    target = dst_dir / src.name
    if target.exists():
        target = dst_dir / f"{src.stem}_{int(time.time())}{src.suffix}"
    shutil.move(str(src), str(target))
    return target


def process_one(
    photo: Path,
    *,
    blog_id: str,
    posted_dir: Path,
    failed_dir: Path,
    extra_tags: list[str],
    draft: bool,
    headless: bool,
) -> None:
    print(f"\n[처리 시작] {photo.name}")
    try:
        cap = generate_caption(photo)
        print(f"  제목: {cap.title}")
        print(f"  본문: {cap.content[:60]}...")
        print(f"  태그: {cap.tags}")

        merged_tags: list[str] = []
        for t in list(cap.tags) + extra_tags:
            t = t.strip().lstrip("#")
            if t and t not in merged_tags:
                merged_tags.append(t)

        with sync_playwright() as pw:
            naver_post(
                pw,
                blog_id=blog_id,
                photo_path=photo,
                title=cap.title,
                content=cap.content,
                tags=merged_tags,
                draft=draft,
                headless=headless,
            )

        target = _move_unique(photo, posted_dir)
        print(f"[완료] {photo.name} → {target}")
    except Exception as e:
        print(f"[실패] {photo.name}: {e}", file=sys.stderr)
        traceback.print_exc()
        try:
            target = _move_unique(photo, failed_dir)
            print(f"  → {target} 로 이동", file=sys.stderr)
        except Exception as move_err:
            print(f"  실패 폴더로 이동 중 추가 오류: {move_err}", file=sys.stderr)


class InboxHandler(FileSystemEventHandler):
    def __init__(self, processor: Callable[[Path], None]) -> None:
        self.processor = processor

    def _maybe_process(self, raw_path: str) -> None:
        path = Path(raw_path)
        if not is_image(path):
            return
        if not wait_until_stable(path):
            print(f"[건너뜀] {path.name} (파일 안정화 시간 초과)", file=sys.stderr)
            return
        if not path.exists():
            return
        self.processor(path)

    def on_created(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        self._maybe_process(event.src_path)

    def on_moved(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        dest = getattr(event, "dest_path", None)
        if dest:
            self._maybe_process(dest)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="네이버 블로그 자동 게시 파이프라인")
    parser.add_argument("photo", nargs="?", help="이 한 장만 즉시 처리하고 종료")
    parser.add_argument(
        "--watch",
        action="store_true",
        help="감시 모드(기본). photo 인자가 없으면 자동으로 활성화됩니다.",
    )
    parser.add_argument(
        "--inbox",
        default=os.environ.get("NAVER_BLOG_INBOX", "inbox"),
        help="감시할 입력 폴더 (기본: inbox)",
    )
    parser.add_argument(
        "--posted",
        default=os.environ.get("NAVER_BLOG_POSTED", "posted"),
        help="게시 성공 후 사진을 옮길 폴더 (기본: posted)",
    )
    parser.add_argument(
        "--failed",
        default=os.environ.get("NAVER_BLOG_FAILED", "failed"),
        help="게시 실패 시 사진을 옮길 폴더 (기본: failed)",
    )
    parser.add_argument(
        "--blog-id",
        default=os.environ.get("NAVER_BLOG_ID"),
        help="네이버 블로그 ID (없으면 환경변수 NAVER_BLOG_ID 사용)",
    )
    parser.add_argument(
        "--tag",
        action="append",
        default=[],
        help="모든 글에 추가할 고정 태그 (여러 번 지정 가능)",
    )
    parser.add_argument("--draft", action="store_true", help="발행 대신 임시저장")
    parser.add_argument("--headless", action="store_true", help="브라우저 창 숨김")
    return parser.parse_args()


def main() -> None:
    load_dotenv()
    args = parse_args()

    if not args.blog_id:
        print(
            "블로그 ID 가 필요합니다. --blog-id 또는 NAVER_BLOG_ID 환경변수를 지정하세요.",
            file=sys.stderr,
        )
        sys.exit(1)
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print(
            "ANTHROPIC_API_KEY 환경변수가 필요합니다. .env 파일에 키를 넣어 주세요.",
            file=sys.stderr,
        )
        sys.exit(1)

    env_tags = [t.strip() for t in os.environ.get("NAVER_BLOG_TAGS", "").split(",")]
    extra_tags: list[str] = []
    for t in args.tag + env_tags:
        t = t.strip().lstrip("#")
        if t and t not in extra_tags:
            extra_tags.append(t)

    posted_dir = Path(args.posted).expanduser().resolve()
    failed_dir = Path(args.failed).expanduser().resolve()

    def processor(p: Path) -> None:
        process_one(
            p,
            blog_id=args.blog_id,
            posted_dir=posted_dir,
            failed_dir=failed_dir,
            extra_tags=extra_tags,
            draft=args.draft,
            headless=args.headless,
        )

    if args.photo:
        photo = Path(args.photo).expanduser().resolve()
        if not photo.exists():
            print(f"파일을 찾을 수 없습니다: {photo}", file=sys.stderr)
            sys.exit(1)
        processor(photo)
        return

    inbox = Path(args.inbox).expanduser().resolve()
    inbox.mkdir(parents=True, exist_ok=True)
    print(f"[감시 시작] {inbox}")
    print("  사진을 이 폴더에 떨어뜨리면 자동으로 게시됩니다. Ctrl+C 로 종료.")

    for existing in sorted(inbox.iterdir()):
        if is_image(existing) and wait_until_stable(existing):
            processor(existing)

    handler = InboxHandler(processor)
    observer = Observer()
    observer.schedule(handler, str(inbox), recursive=False)
    observer.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n종료 중...")
    finally:
        observer.stop()
        observer.join()


if __name__ == "__main__":
    main()
