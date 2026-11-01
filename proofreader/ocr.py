"""Transcribe one page image with Claude, as an independent second reading for proofreading."""
import base64

MODEL = "claude-opus-5-5"

PROMPT = """This is a scanned page of a printed Arabic book. Transcribe it exactly as printed.

- Keep the printed spelling, even where it looks wrong. Do not correct, normalise, modernise or complete words, and do not add hamzas, vowel signs or punctuation that are not on the page.
- Keep the printed line breaks: one printed line per output line.
- If there is a running header or page number, put it on the first line, starting with "@HEADER ".
- If there are footnotes, write a line "@FOOTNOTES" before them and transcribe them in order.
- Write [?] for any word you cannot read; never guess a word from context, especially personal names.
- Output only the transcription, with no comments."""


class OCRUnavailable(Exception):
    pass


def available():
    try:
        import anthropic  # noqa: F401
        return True
    except ImportError:
        return False


def transcribe(image_bytes, media_type="image/jpeg", model=MODEL, effort="medium"):
    try:
        import anthropic
    except ImportError as e:
        raise OCRUnavailable("anthropic パッケージが入っていません（pip install -r requirements.txt）") from e

    client = anthropic.Anthropic()
    try:
        response = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": effort},
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                                 "data": base64.standard_b64encode(image_bytes).decode("ascii")}},
                    {"type": "text", "text": PROMPT},
                ],
            }],
        )
    except anthropic.AuthenticationError as e:
        raise OCRUnavailable("APIの認証に失敗しました。ANTHROPIC_API_KEY を設定するか ant auth login を実行してください") from e
    except anthropic.RateLimitError as e:
        raise OCRUnavailable("APIの利用上限に達しました。少し待ってから再実行してください") from e
    except anthropic.APIStatusError as e:
        raise OCRUnavailable(f"APIエラー（{e.status_code}）: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise OCRUnavailable("APIに接続できません。ネットワークを確認してください") from e

    if response.stop_reason == "refusal":
        raise OCRUnavailable("このページは読み取りを断られました")
    text = "".join(b.text for b in response.content if b.type == "text").strip()
    return {"text": text, "model": response.model, "truncated": response.stop_reason == "max_tokens",
            "usage": {"input": response.usage.input_tokens, "output": response.usage.output_tokens}}
