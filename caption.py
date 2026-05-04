"""
사진 한 장으로 네이버 블로그용 제목/본문/태그를 생성합니다.

ANTHROPIC_API_KEY 환경변수가 필요합니다.

사용법:
    python caption.py photo.jpg
    >>> from caption import generate_caption
    >>> cap = generate_caption("photo.jpg")
    >>> cap.title, cap.content, cap.tags
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import sys
from pathlib import Path
from typing import List

import anthropic
from pydantic import BaseModel, Field


class Caption(BaseModel):
    title: str = Field(description="20-40자 사이의 매력적인 한국어 제목. 이모지/특수기호는 최소화.")
    content: str = Field(
        description=(
            "200-500자 사이의 한국어 본문. 자연스러운 일기체. "
            "사진에 보이는 것을 묘사하고 분위기/감상을 덧붙입니다. "
            "본문 안에 #해시태그를 넣지 않습니다."
        )
    )
    tags: List[str] = Field(
        description=(
            "3-7개의 한국어 태그. # 기호 없이 단어만. "
            "사진의 주제, 장소, 활동, 분위기를 반영합니다."
        )
    )


SUPPORTED_MEDIA = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


SYSTEM_PROMPT = """\
당신은 네이버 블로그용 한국어 캡션을 만들어 주는 작가입니다.
사진 한 장을 보고 제목, 본문, 태그를 생성합니다.

원칙:
- 제목은 20-40자, 호기심을 끌되 과장·낚시성 표현은 피합니다.
- 본문은 200-500자, 사진에 실제로 보이는 사실 + 분위기/감상을 일기체로 자연스럽게 씁니다.
- 본문 안에는 해시태그를 넣지 않습니다. 태그는 별도 필드입니다.
- 태그는 3-7개, 사진의 주제·장소·활동·분위기를 반영합니다. # 기호 없이 단어만.
- 사진에서 분명히 식별되지 않는 가게·브랜드·인물 이름은 추측하지 않습니다.
- 광고·협찬으로 오해될 표현, 과도한 감탄사는 피합니다.
"""

USER_PROMPT = "이 사진으로 네이버 블로그 글을 만들어 주세요."


def _image_block(image_path: Path) -> dict:
    suffix = image_path.suffix.lower()
    media_type = SUPPORTED_MEDIA.get(suffix)
    if media_type is None:
        guessed, _ = mimetypes.guess_type(str(image_path))
        media_type = guessed if guessed in SUPPORTED_MEDIA.values() else "image/jpeg"
    data = base64.standard_b64encode(image_path.read_bytes()).decode("utf-8")
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": data},
    }


def generate_caption(
    image_path: str | Path,
    *,
    client: anthropic.Anthropic | None = None,
    model: str = "claude-opus-4-7",
) -> Caption:
    """사진 한 장 → Caption(title, content, tags)."""
    path = Path(image_path).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(path)
    if path.suffix.lower() not in SUPPORTED_MEDIA:
        raise ValueError(f"지원하지 않는 이미지 형식입니다: {path.suffix}")

    client = client or anthropic.Anthropic()
    response = client.messages.parse(
        model=model,
        max_tokens=2048,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": [
                    _image_block(path),
                    {"type": "text", "text": USER_PROMPT},
                ],
            }
        ],
        output_format=Caption,
    )
    return response.parsed_output


def main() -> None:
    parser = argparse.ArgumentParser(description="사진 → 네이버 블로그 캡션")
    parser.add_argument("image", help="이미지 파일 경로")
    parser.add_argument(
        "--model",
        default="claude-opus-4-7",
        help="사용할 Claude 모델 ID (기본: claude-opus-4-7)",
    )
    args = parser.parse_args()

    try:
        cap = generate_caption(args.image, model=args.model)
    except FileNotFoundError as e:
        print(f"파일을 찾을 수 없습니다: {e}", file=sys.stderr)
        sys.exit(1)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

    print(json.dumps(cap.model_dump(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
