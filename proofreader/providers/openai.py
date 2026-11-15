"""OpenAI Responses API image transcription; no implicit retry or provider fallback."""
import base64
import os

from .. import net, ocr


def transcribe(image, media_type, model, prompt):
    if not model or len(model) > 200:
        raise ocr.OCRUnavailable("OpenAIの画像入力に対応したモデルIDを指定してください")
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise ocr.OCRUnavailable("OPENAI_API_KEY を設定して再起動してください")
    if media_type not in ("image/jpeg", "image/png"):
        raise ocr.OCRUnavailable("JPEGまたはPNG画像を使ってください")
    encoded = base64.standard_b64encode(image).decode("ascii")
    try:
        response = net.post_json("https://api.openai.com/v1/responses", {
            "model": model, "store": False, "max_output_tokens": 16000,
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": f"data:{media_type};base64,{encoded}", "detail": "high"},
            ]}],
        }, {"Authorization": f"Bearer {key}"})
    except net.FetchError as e:
        raise ocr.OCRUnavailable(str(e)) from e
    blocks = [block for item in response.get("output", []) if item.get("type") == "message"
              for block in item.get("content", [])]
    if any(block.get("type") == "refusal" for block in blocks):
        raise ocr.OCRUnavailable("このページは読み取りを断られました")
    if response.get("status") not in ("completed", "incomplete"):
        raise ocr.OCRUnavailable("読み取りが完了しませんでした。再実行してください")
    usage = response.get("usage") or {}
    return {"text": "\n".join(b.get("text", "") for b in blocks if b.get("type") == "output_text").strip(),
            "model": response.get("model", model), "truncated": response.get("status") == "incomplete",
            "usage": {"input": usage.get("input_tokens", 0), "output": usage.get("output_tokens", 0)}}
