"""Provider adapters return independent readings with a common result shape."""
import os

from .. import ocr
from . import openai

PROMPT_VERSION = "printed-arabic-2"


def catalog():
    return {
        "anthropic": {"label": "Anthropic", "available": ocr.available(),
                      "reason": ocr.reason(), "models": ocr.MODELS, "default": ocr.MODEL},
        "openai": {"label": "OpenAI", "available": bool(os.environ.get("OPENAI_API_KEY")),
                   "reason": " .env に OPENAI_API_KEY を設定して再起動してください",
                   "models": {}, "default": os.environ.get("OPENAI_OCR_MODEL", "")},
    }


def transcribe(image, media_type, provider="anthropic", model=None):
    if provider == "anthropic":
        model = model or ocr.MODEL
        result = ocr.transcribe(image, media_type, model=model)
    elif provider == "openai":
        model = model or os.environ.get("OPENAI_OCR_MODEL", "")
        result = openai.transcribe(image, media_type, model, ocr.PROMPT)
    else:
        raise ocr.OCRUnavailable("このAI提供元は使えません")
    if not result.get("text", "").strip():
        raise ocr.OCRUnavailable("読み取り結果が空でした。本文は変更していません")
    return {**result, "provider": provider, "requested_model": model, "prompt_version": PROMPT_VERSION}
