from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
import sqlite3
import time
import uuid
import webbrowser
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path
from threading import Timer
from typing import Any
from urllib.parse import urlparse

import httpx
import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parents[1]
CONFIG_DIR = ROOT / "config"
CONFIG_PATH = CONFIG_DIR / "config.json"
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
DB_PATH = DATA_DIR / "history.sqlite3"

DEFAULT_CONFIG: dict[str, Any] = {
    "active_profile": "openai-compatible",
    "profiles": [
        {
            "name": "openai-compatible",
            "base_url": "https://api.openai.com/v1",
            "api_key": "",
            "model": "gpt-image-2",
        }
    ],
    "server": {"host": "127.0.0.1", "port": 7862},
}

POPULAR_SIZES = {
    "auto",
    "1024x1024",
    "1024x1536",
    "1536x1024",
    "2048x2048",
    "2048x1152",
    "1152x2048",
    "3840x2160",
    "2160x3840",
}

RUNNING_JOBS: dict[str, dict[str, Any]] = {}
ACTIVE_STATUSES = {"queued", "running", "canceling"}


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=12000)
    input_ids: list[str] = Field(default_factory=list)
    size: str = "1024x1536"
    quality: str = "high"
    output_format: str = "png"
    count: int = Field(default=1, ge=1, le=10)
    background: str | None = None
    model: str | None = None
    profile: str | None = None
    mode: str = "auto"


class ProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str | None = None
    model: str = Field(default="gpt-image-2", min_length=1, max_length=120)
    previous_name: str | None = None


class ConfigIn(BaseModel):
    active_profile: str
    profiles: list[ProfileIn]


class ActiveProfileIn(BaseModel):
    name: str


class TestProfileIn(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None


def now_ms() -> int:
    return int(time.time() * 1000)


def utc_stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def ensure_dirs() -> None:
    for path in (CONFIG_DIR, STATIC_DIR, DATA_DIR, UPLOAD_DIR, OUTPUT_DIR):
        path.mkdir(parents=True, exist_ok=True)
    if not CONFIG_PATH.exists():
        CONFIG_PATH.write_text(json.dumps(DEFAULT_CONFIG, indent=2), encoding="utf-8")


def init_db() -> None:
    ensure_dirs()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS generations (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                prompt TEXT NOT NULL,
                mode TEXT NOT NULL,
                profile TEXT NOT NULL,
                base_url TEXT NOT NULL,
                model TEXT NOT NULL,
                size TEXT NOT NULL,
                quality TEXT NOT NULL,
                output_format TEXT NOT NULL,
                count INTEGER NOT NULL,
                status TEXT NOT NULL,
                error TEXT,
                inputs_json TEXT NOT NULL,
                outputs_json TEXT NOT NULL,
                request_json TEXT NOT NULL
            )
            """
        )
        existing_columns = {
            row[1] for row in conn.execute("PRAGMA table_info(generations)").fetchall()
        }
        extra_columns = {
            "updated_at": "TEXT",
            "completed_count": "INTEGER NOT NULL DEFAULT 0",
            "failed_count": "INTEGER NOT NULL DEFAULT 0",
            "errors_json": "TEXT NOT NULL DEFAULT '[]'",
        }
        for column, ddl in extra_columns.items():
            if column not in existing_columns:
                conn.execute(f"ALTER TABLE generations ADD COLUMN {column} {ddl}")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at DESC)"
        )


def mark_interrupted_jobs() -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            UPDATE generations
            SET status = 'interrupted',
                updated_at = ?,
                error = COALESCE(error, 'Server stopped before this job finished.')
            WHERE status IN ('queued', 'running', 'canceling')
            """,
            (utc_stamp(),),
        )


def load_config() -> dict[str, Any]:
    ensure_dirs()
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        raw = DEFAULT_CONFIG.copy()
    raw.setdefault("active_profile", DEFAULT_CONFIG["active_profile"])
    raw.setdefault("profiles", DEFAULT_CONFIG["profiles"])
    raw.setdefault("server", DEFAULT_CONFIG["server"])
    if not raw["profiles"]:
        raw["profiles"] = DEFAULT_CONFIG["profiles"]
    return raw


def save_config(config: dict[str, Any]) -> None:
    ensure_dirs()
    CONFIG_PATH.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")


def normalize_model_name(model: str | None) -> str:
    value = (model or "gpt-image-2").strip()
    aliases = {
        "image-2": "gpt-image-2",
        "gpt-image2": "gpt-image-2",
        "gpt image 2": "gpt-image-2",
        "image2": "gpt-image-2",
    }
    return aliases.get(value.lower(), value)


def normalize_base_url(value: str | None) -> str:
    raw = (value or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        raw = f"https://{raw}"
    return raw.rstrip("/")


def base_url_candidates(value: str | None) -> list[str]:
    base = normalize_base_url(value)
    if not base:
        return []
    parsed = urlparse(base)
    candidates = [base]
    path = parsed.path.rstrip("/")
    if path != "/v1":
        candidates.append(f"{base}/v1")
    seen: set[str] = set()
    unique: list[str] = []
    for candidate in candidates:
        if candidate not in seen:
            unique.append(candidate)
            seen.add(candidate)
    return unique


def api_base_url(profile: dict[str, Any]) -> str:
    candidates = base_url_candidates(profile.get("base_url"))
    if not candidates:
        return ""
    parsed = urlparse(candidates[0])
    if parsed.path.rstrip("/") != "/v1" and len(candidates) > 1:
        return candidates[-1]
    return candidates[0]


def extract_model_ids(payload: Any) -> list[str]:
    data = payload.get("data", payload) if isinstance(payload, dict) else payload
    if isinstance(data, dict):
        data = data.get("data", data.get("models", data.get("items", [])))
    if not isinstance(data, list):
        return []
    models: list[str] = []
    for item in data:
        if isinstance(item, str):
            models.append(item)
        elif isinstance(item, dict):
            model_id = item.get("id") or item.get("name") or item.get("model")
            if model_id:
                models.append(str(model_id))
    return models


def redact_profile(profile: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": profile.get("name", ""),
        "base_url": profile.get("base_url", ""),
        "model": normalize_model_name(profile.get("model")),
        "has_api_key": bool(profile.get("api_key")),
    }


def get_profile(name: str | None = None) -> dict[str, Any]:
    config = load_config()
    active_name = name or config.get("active_profile")
    profiles = config.get("profiles", [])
    for profile in profiles:
        if profile.get("name") == active_name:
            resolved = dict(profile)
            resolved["base_url"] = normalize_base_url(str(resolved.get("base_url", "")))
            resolved["model"] = normalize_model_name(resolved.get("model"))
            return resolved
    raise HTTPException(status_code=404, detail=f"Profile not found: {active_name}")


def mask_api_key(profile: dict[str, Any]) -> str:
    key = profile.get("api_key") or os.getenv("OPENAI_API_KEY") or ""
    if not key:
        return ""
    if len(key) <= 10:
        return "*" * len(key)
    return f"{key[:4]}...{key[-4:]}"


def validate_size(size: str) -> None:
    if size == "auto" or size in POPULAR_SIZES:
        return
    parts = size.lower().split("x")
    if len(parts) != 2:
        raise HTTPException(status_code=400, detail="Size must be auto or WIDTHxHEIGHT.")
    try:
        width = int(parts[0])
        height = int(parts[1])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Size must be auto or WIDTHxHEIGHT.") from exc
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=400, detail="Size dimensions must be positive.")
    if width % 16 != 0 or height % 16 != 0:
        raise HTTPException(status_code=400, detail="gpt-image-2 custom sizes must be multiples of 16.")
    if max(width, height) > 3840:
        raise HTTPException(status_code=400, detail="Maximum gpt-image-2 edge is 3840px.")
    if max(width, height) / min(width, height) > 3:
        raise HTTPException(status_code=400, detail="Long-to-short ratio cannot exceed 3:1.")
    pixels = width * height
    if pixels < 655_360 or pixels > 8_294_400:
        raise HTTPException(
            status_code=400,
            detail="gpt-image-2 custom sizes must be between 655,360 and 8,294,400 pixels.",
        )


def validate_generation_request(req: GenerateRequest) -> None:
    validate_size(req.size)
    if req.quality not in {"low", "medium", "high", "auto"}:
        raise HTTPException(status_code=400, detail="Quality must be low, medium, high, or auto.")
    if req.output_format not in {"png", "jpeg", "webp"}:
        raise HTTPException(status_code=400, detail="Output format must be png, jpeg, or webp.")
    if req.background not in {None, "", "auto", "opaque"}:
        raise HTTPException(
            status_code=400,
            detail="This tool only exposes auto/opaque background for gpt-image-2.",
        )
    if req.mode not in {"auto", "generate", "edit"}:
        raise HTTPException(status_code=400, detail="Mode must be auto, generate, or edit.")


def safe_media_path(base: Path, image_id: str) -> Path:
    candidate = (base / Path(image_id).name).resolve()
    base_resolved = base.resolve()
    if not str(candidate).startswith(str(base_resolved)):
        raise HTTPException(status_code=400, detail="Invalid image id.")
    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail=f"Image not found: {image_id}")
    return candidate


def media_record(path: Path, kind: str) -> dict[str, Any]:
    root = UPLOAD_DIR if kind == "upload" else OUTPUT_DIR
    url_root = "/media/uploads" if kind == "upload" else "/media/outputs"
    return {
        "id": path.name,
        "name": path.name,
        "url": f"{url_root}/{path.name}",
        "size": path.stat().st_size,
        "created_at": int(path.stat().st_mtime * 1000),
    }


def list_media(base: Path, kind: str) -> list[dict[str, Any]]:
    if not base.exists():
        return []
    files = [p for p in base.iterdir() if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [media_record(p, kind) for p in files]


def history_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    keys = set(row.keys())
    outputs = json.loads(row["outputs_json"] or "[]")
    errors = json.loads(row["errors_json"] or "[]") if "errors_json" in keys else []
    stored_completed = row["completed_count"] if "completed_count" in keys else 0
    stored_failed = row["failed_count"] if "failed_count" in keys else 0
    completed = int(stored_completed or 0)
    failed = int(stored_failed or 0)
    if completed == 0 and row["status"] == "completed" and outputs:
        completed = len(outputs)
    total = int(row["count"] or 0)
    done = min(total, completed + failed) if total else completed + failed
    percent = int((done / total) * 100) if total else 0
    status = row["status"]
    if status == "completed" and total and completed < total:
        status = "partial"
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"] if "updated_at" in keys else row["created_at"],
        "prompt": row["prompt"],
        "mode": row["mode"],
        "profile": row["profile"],
        "base_url": row["base_url"],
        "model": row["model"],
        "size": row["size"],
        "quality": row["quality"],
        "output_format": row["output_format"],
        "count": row["count"],
        "status": status,
        "error": row["error"],
        "inputs": json.loads(row["inputs_json"] or "[]"),
        "outputs": outputs,
        "completed_count": completed,
        "failed_count": failed,
        "errors": errors,
        "progress": {
            "total": total,
            "completed": completed,
            "failed": failed,
            "done": done,
            "percent": percent,
            "active": status in ACTIVE_STATUSES,
        },
        "request": json.loads(row["request_json"] or "{}"),
    }


def insert_history(record: dict[str, Any]) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO generations (
                id, created_at, prompt, mode, profile, base_url, model, size, quality,
                output_format, count, status, error, inputs_json, outputs_json, request_json,
                updated_at, completed_count, failed_count, errors_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record["id"],
                record["created_at"],
                record["prompt"],
                record["mode"],
                record["profile"],
                record["base_url"],
                record["model"],
                record["size"],
                record["quality"],
                record["output_format"],
                record["count"],
                record["status"],
                record.get("error"),
                json.dumps(record.get("inputs", []), ensure_ascii=False),
                json.dumps(record.get("outputs", []), ensure_ascii=False),
                json.dumps(record.get("request", {}), ensure_ascii=False),
                record.get("updated_at", record["created_at"]),
                int(record.get("completed_count", len(record.get("outputs", [])))),
                int(record.get("failed_count", 0)),
                json.dumps(record.get("errors", []), ensure_ascii=False),
            ),
        )


def update_history(record_id: str, **fields: Any) -> None:
    column_map = {
        "status": "status",
        "error": "error",
        "outputs": "outputs_json",
        "request": "request_json",
        "completed_count": "completed_count",
        "failed_count": "failed_count",
        "errors": "errors_json",
        "updated_at": "updated_at",
    }
    assignments = []
    values: list[Any] = []
    for key, value in fields.items():
        column = column_map.get(key)
        if not column:
            continue
        if key in {"outputs", "request", "errors"}:
            value = json.dumps(value, ensure_ascii=False)
        assignments.append(f"{column} = ?")
        values.append(value)
    if not assignments:
        return
    if "updated_at" not in fields:
        assignments.append("updated_at = ?")
        values.append(utc_stamp())
    values.append(record_id)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            f"UPDATE generations SET {', '.join(assignments)} WHERE id = ?",
            values,
        )


def get_history_record(record_id: str) -> dict[str, Any] | None:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM generations WHERE id = ?", (record_id,)).fetchone()
    return history_row_to_dict(row) if row else None


def api_headers(profile: dict[str, Any]) -> dict[str, str]:
    key = profile.get("api_key") or os.getenv("OPENAI_API_KEY") or ""
    if not key:
        raise HTTPException(status_code=400, detail="API key is not configured for the active profile.")
    return {"Authorization": f"Bearer {key}"}


async def check_profile(profile: dict[str, Any]) -> dict[str, Any]:
    candidates = base_url_candidates(profile.get("base_url"))
    model = normalize_model_name(profile.get("model"))
    if not candidates:
        return {"ok": False, "message": "Base URL is empty.", "models": [], "model_found": False}
    try:
        headers = api_headers(profile)
    except HTTPException as exc:
        return {"ok": False, "message": str(exc.detail), "models": [], "model_found": False}
    checked: list[dict[str, Any]] = []
    best_without_model: dict[str, Any] | None = None
    async with httpx.AsyncClient(timeout=20) as client:
        for base_url in candidates:
            try:
                response = await client.get(f"{base_url}/models", headers=headers)
                if response.status_code >= 400:
                    checked.append(
                        {
                            "base_url": base_url,
                            "ok": False,
                            "message": f"HTTP {response.status_code}: {response.text[:240]}",
                        }
                    )
                    continue
                payload = response.json()
                models = extract_model_ids(payload)
                found = model in models
                checked.append(
                    {
                        "base_url": base_url,
                        "ok": True,
                        "message": "API reachable.",
                        "model_found": found,
                        "model_count": len(models),
                    }
                )
                if found:
                    return {
                        "ok": True,
                        "message": "API reachable.",
                        "models": models[:200],
                        "model_found": True,
                        "model": model,
                        "base_url": base_url,
                        "resolved_base_url": base_url,
                        "checked": checked,
                        "key": mask_api_key(profile),
                        "key_source": "config" if profile.get("api_key") else "env",
                    }
                if models:
                    best_without_model = {
                        "ok": True,
                        "message": f"API reachable, but {model} is not listed.",
                        "models": models[:200],
                        "model_found": False,
                        "model": model,
                        "base_url": base_url,
                        "resolved_base_url": base_url,
                        "checked": checked,
                        "key": mask_api_key(profile),
                        "key_source": "config" if profile.get("api_key") else "env",
                    }
                else:
                    best_without_model = {
                        "ok": True,
                        "message": "API reachable, but no model ids were found in /models.",
                        "models": [],
                        "model_found": False,
                        "model": model,
                        "base_url": base_url,
                        "resolved_base_url": base_url,
                        "checked": checked,
                        "key": mask_api_key(profile),
                        "key_source": "config" if profile.get("api_key") else "env",
                    }
            except Exception as exc:
                checked.append({"base_url": base_url, "ok": False, "message": str(exc)})
    if best_without_model:
        return best_without_model
    return {
        "ok": False,
        "message": checked[-1]["message"] if checked else "API check failed.",
        "models": [],
        "model_found": False,
        "model": model,
        "base_url": candidates[0],
        "checked": checked,
    }


async def collect_image_bytes(response_payload: dict[str, Any], client: httpx.AsyncClient) -> list[bytes]:
    images: list[bytes] = []
    for item in response_payload.get("data", []):
        if not isinstance(item, dict):
            continue
        b64 = item.get("b64_json")
        if b64:
            images.append(base64.b64decode(b64))
            continue
        url = item.get("url")
        if url:
            remote = await client.get(url, timeout=120)
            remote.raise_for_status()
            images.append(remote.content)
    if not images:
        raise HTTPException(status_code=502, detail="Image API returned no image payloads.")
    return images


def output_name(extension: str) -> str:
    ext = "jpg" if extension == "jpeg" else extension
    return f"{utc_stamp().replace(':', '').replace('-', '')}-{uuid.uuid4().hex[:10]}.{ext}"


async def call_generation_api(req: GenerateRequest, profile: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    base_url = api_base_url(profile)
    model = req.model or profile.get("model") or "gpt-image-2"
    payload: dict[str, Any] = {
        "model": model,
        "prompt": req.prompt,
        "n": req.count,
        "size": req.size,
        "quality": req.quality,
        "output_format": req.output_format,
    }
    if req.background:
        payload["background"] = req.background
    headers = api_headers(profile)
    async with httpx.AsyncClient(timeout=300) as client:
        response = await client.post(f"{base_url}/images/generations", headers=headers, json=payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"Image API error {response.status_code}: {response.text[:800]}")
        image_bytes = await collect_image_bytes(response.json(), client)
    outputs = []
    for raw in image_bytes:
        path = OUTPUT_DIR / output_name(req.output_format)
        path.write_bytes(raw)
        outputs.append(media_record(path, "output"))
    return outputs, payload


async def call_edit_api(
    req: GenerateRequest,
    profile: dict[str, Any],
    image_paths: list[Path],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    base_url = api_base_url(profile)
    model = req.model or profile.get("model") or "gpt-image-2"
    form = {
        "model": model,
        "prompt": req.prompt,
        "n": str(req.count),
        "size": req.size,
        "quality": req.quality,
        "output_format": req.output_format,
    }
    if req.background:
        form["background"] = req.background
    headers = api_headers(profile)
    with ExitStack() as stack:
        files = []
        for path in image_paths:
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            handle = stack.enter_context(path.open("rb"))
            files.append(("image", (path.name, handle, mime)))
        async with httpx.AsyncClient(timeout=300) as client:
            response = await client.post(
                f"{base_url}/images/edits",
                headers=headers,
                data=form,
                files=files,
            )
            if response.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Image API error {response.status_code}: {response.text[:800]}")
            image_bytes = await collect_image_bytes(response.json(), client)
    outputs = []
    for raw in image_bytes:
        path = OUTPUT_DIR / output_name(req.output_format)
        path.write_bytes(raw)
        outputs.append(media_record(path, "output"))
    request_preview = dict(form)
    request_preview["image"] = [p.name for p in image_paths]
    return outputs, request_preview


def request_preview(req: GenerateRequest, mode: str, image_paths: list[Path]) -> dict[str, Any]:
    preview: dict[str, Any] = {
        "model": req.model,
        "prompt": req.prompt,
        "requested_count": req.count,
        "per_request_n": 1,
        "size": req.size,
        "quality": req.quality,
        "output_format": req.output_format,
        "mode": mode,
    }
    if req.background:
        preview["background"] = req.background
    if image_paths:
        preview["image"] = [p.name for p in image_paths]
    return preview


def configured_profiles(preferred_name: str | None = None) -> list[dict[str, Any]]:
    config = load_config()
    raw_profiles = config.get("profiles", [])
    preferred = preferred_name or config.get("active_profile")
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()
    ordered_names = [preferred] if preferred else []
    ordered_names.extend(profile.get("name") for profile in raw_profiles if profile.get("name") != preferred)
    for name in ordered_names:
        if not name or name in seen:
            continue
        seen.add(name)
        for profile in raw_profiles:
            if profile.get("name") != name:
                continue
            resolved = dict(profile)
            resolved["base_url"] = normalize_base_url(str(resolved.get("base_url", "")))
            resolved["model"] = normalize_model_name(resolved.get("model"))
            if resolved.get("base_url") and (resolved.get("api_key") or os.getenv("OPENAI_API_KEY")):
                selected.append(resolved)
            break
    return selected


def fallback_profiles(primary: dict[str, Any]) -> list[dict[str, Any]]:
    primary_name = primary.get("name")
    requested_model = normalize_model_name(primary.get("model"))
    alternates: list[dict[str, Any]] = []
    for profile in configured_profiles(primary_name):
        if profile.get("name") == primary_name:
            continue
        candidate_model = normalize_model_name(profile.get("model"))
        if requested_model and candidate_model != requested_model:
            continue
        alternates.append(profile)
    return alternates


def should_retry_with_fallback(exc: Exception) -> bool:
    message = str(exc.detail) if isinstance(exc, HTTPException) else str(exc)
    lower = (message or "").lower()
    if isinstance(exc, HTTPException) and exc.status_code < 500:
        return False
    hard_failures = (
        "invalid api key",
        '"code":"invalid_api_key"',
        "api key is not configured",
        "profile not found",
        "edit mode needs at least one imported image",
        "quality must be",
        "output format must be",
        "size must be",
        "background for gpt-image-2",
        "invalid image id",
        "image not found",
    )
    if any(token in lower for token in hard_failures):
        return False
    retryable_tokens = (
        "image api error 429",
        "rate limit",
        "concurrency limit exceeded",
        "image api error 502",
        "image api error 503",
        "image api error 504",
        "timed out",
        "timeout",
        "getaddrinfo failed",
        "all connection attempts failed",
        "unable to connect to the remote server",
        "connection refused",
        "connection reset",
        "temporarily unavailable",
        "no image payloads",
    )
    return any(token in lower for token in retryable_tokens)


def provider_attempt_error(exc: Exception) -> str:
    if isinstance(exc, HTTPException):
        return str(exc.detail)
    return str(exc)


async def call_with_fallback(
    req: GenerateRequest,
    profile: dict[str, Any],
    image_paths: list[Path],
    mode: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    attempts: list[dict[str, Any]] = []
    providers = [profile, *fallback_profiles(profile)]
    last_exc: Exception | None = None
    for index, candidate in enumerate(providers):
        candidate_name = str(candidate.get("name") or "")
        candidate_base_url = api_base_url(candidate)
        try:
            if mode == "edit":
                output, payload = await call_edit_api_once(req, candidate, image_paths)
            else:
                output, payload = await call_generation_api_once(req, candidate)
            meta = {
                "profile": candidate_name,
                "base_url": candidate_base_url,
                "fallback_used": index > 0,
                "attempts": attempts + [
                    {
                        "profile": candidate_name,
                        "base_url": candidate_base_url,
                        "status": "ok",
                    }
                ],
            }
            return output, payload, meta
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            last_exc = exc
            attempts.append(
                {
                    "profile": candidate_name,
                    "base_url": candidate_base_url,
                    "status": "error",
                    "error": provider_attempt_error(exc),
                }
            )
            if not should_retry_with_fallback(exc) or index >= len(providers) - 1:
                break
    if last_exc is None:
        raise HTTPException(status_code=500, detail="No available profile for image generation.")
    attempt_summary = " -> ".join(
        f"{item['profile'] or item['base_url']}: {item.get('error', item.get('status', 'error'))}"
        for item in attempts
    )
    if should_retry_with_fallback(last_exc) and len(attempts) > 1:
        message = f"{provider_attempt_error(last_exc)} | tried: {attempt_summary}"
        raise HTTPException(status_code=502, detail=message)
    raise last_exc


async def call_generation_api_once(
    req: GenerateRequest,
    profile: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    base_url = api_base_url(profile)
    model = req.model or profile.get("model") or "gpt-image-2"
    payload: dict[str, Any] = {
        "model": model,
        "prompt": req.prompt,
        "n": 1,
        "size": req.size,
        "quality": req.quality,
        "output_format": req.output_format,
    }
    if req.background:
        payload["background"] = req.background
    headers = api_headers(profile)
    async with httpx.AsyncClient(timeout=300) as client:
        response = await client.post(f"{base_url}/images/generations", headers=headers, json=payload)
        if response.status_code >= 400:
            raise HTTPException(status_code=502, detail=f"Image API error {response.status_code}: {response.text[:800]}")
        image_bytes = await collect_image_bytes(response.json(), client)
    path = OUTPUT_DIR / output_name(req.output_format)
    path.write_bytes(image_bytes[0])
    return media_record(path, "output"), payload


async def call_edit_api_once(
    req: GenerateRequest,
    profile: dict[str, Any],
    image_paths: list[Path],
) -> tuple[dict[str, Any], dict[str, Any]]:
    base_url = api_base_url(profile)
    model = req.model or profile.get("model") or "gpt-image-2"
    form = {
        "model": model,
        "prompt": req.prompt,
        "n": "1",
        "size": req.size,
        "quality": req.quality,
        "output_format": req.output_format,
    }
    if req.background:
        form["background"] = req.background
    headers = api_headers(profile)
    with ExitStack() as stack:
        files = []
        for path in image_paths:
            mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            handle = stack.enter_context(path.open("rb"))
            files.append(("image", (path.name, handle, mime)))
        async with httpx.AsyncClient(timeout=300) as client:
            response = await client.post(
                f"{base_url}/images/edits",
                headers=headers,
                data=form,
                files=files,
            )
            if response.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"Image API error {response.status_code}: {response.text[:800]}")
            image_bytes = await collect_image_bytes(response.json(), client)
    path = OUTPUT_DIR / output_name(req.output_format)
    path.write_bytes(image_bytes[0])
    payload_preview = dict(form)
    payload_preview["image"] = [p.name for p in image_paths]
    return media_record(path, "output"), payload_preview


def exception_message(exc: Exception) -> str:
    def humanize_error_message(message: str) -> str:
        text = (message or "").strip()
        lower = text.lower()
        if "getaddrinfo failed" in lower:
            return "无法连接到服务地址（DNS 解析失败）。请检查当前 Profile 的 Base URL 是否写错。"
        if "invalid api key" in lower or '"code":"invalid_api_key"' in lower:
            return "API Key 无效。请检查当前 Profile 的密钥。"
        if "concurrency limit exceeded" in lower:
            return "并发已满（429）。当前账号同时运行的图片任务太多，请减少并发任务或稍后重试。"
        if "rate limit" in lower and "429" in lower:
            return "请求被限流（429）。请稍后重试，或减少同时运行的任务数量。"
        if "content safety service is temporarily unavailable" in lower:
            return "服务商内容安全服务暂时不可用（503）。这是上游服务问题，请稍后重试。"
        if "image api returned no image payloads" in lower:
            return "接口返回成功，但没有图片数据。通常是服务商兼容性问题或上游异常。"
        if "image api error 502" in lower:
            return "服务商上游服务异常（502）。请稍后重试。"
        if "image api error 503" in lower:
            return "服务商暂时不可用（503）。请稍后重试。"
        if "image api error 504" in lower or "timed out" in lower or "timeout" in lower:
            return "请求超时。服务响应过慢，请稍后重试。"
        if "unable to connect to the remote server" in lower or "all connection attempts failed" in lower:
            return "无法连接到服务。请检查网络、代理或 Base URL。"
        return text

    if isinstance(exc, HTTPException):
        return humanize_error_message(str(exc.detail))
    return humanize_error_message(str(exc))


async def run_generation_job(
    job_id: str,
    req: GenerateRequest,
    profile: dict[str, Any],
    image_paths: list[Path],
    mode: str,
    cancel_event: asyncio.Event,
) -> None:
    outputs: list[dict[str, Any]] = []
    errors: list[str] = []
    completed = 0
    failed = 0
    final_status = "completed"
    final_error: str | None = None
    preview = request_preview(req, mode, image_paths)
    try:
        for index in range(req.count):
            if cancel_event.is_set():
                final_status = "canceled"
                break
            try:
                output, payload, provider_meta = await call_with_fallback(req, profile, image_paths, mode)
                outputs.append(output)
                completed += 1
                update_history(
                    job_id,
                    status="running" if completed < req.count else "completed",
                    outputs=outputs,
                    request={
                        **preview,
                        "last_payload": payload,
                        "last_profile": provider_meta["profile"],
                        "last_base_url": provider_meta["base_url"],
                        "fallback_used": provider_meta["fallback_used"],
                        "attempts": provider_meta["attempts"],
                    },
                    completed_count=completed,
                    failed_count=failed,
                    errors=errors,
                )
            except asyncio.CancelledError:
                cancel_event.set()
                final_status = "canceled"
                break
            except Exception as exc:
                failed += 1
                message = f"#{index + 1}: {exception_message(exc)}"
                errors.append(message)
                update_history(
                    job_id,
                    status="running" if completed + failed < req.count else "failed",
                    outputs=outputs,
                    completed_count=completed,
                    failed_count=failed,
                    errors=errors,
                    error="\n".join(errors),
                )
        if cancel_event.is_set():
            final_status = "canceled"
            final_error = "Canceled by user."
        elif failed and completed:
            final_status = "partial"
            final_error = "\n".join(errors)
        elif failed and not completed:
            final_status = "failed"
            final_error = "\n".join(errors)
        elif completed >= req.count:
            final_status = "completed"
        update_history(
            job_id,
            status=final_status,
            error=final_error,
            outputs=outputs,
            completed_count=completed,
            failed_count=failed,
            errors=errors,
        )
    finally:
        RUNNING_JOBS.pop(job_id, None)


def prepare_job(req: GenerateRequest) -> tuple[dict[str, Any], dict[str, Any], list[Path], str]:
    validate_generation_request(req)
    profile = get_profile(req.profile)
    image_paths = [safe_media_path(UPLOAD_DIR, image_id) for image_id in req.input_ids]
    if req.mode == "edit" and not image_paths:
        raise HTTPException(status_code=400, detail="Edit mode needs at least one imported image.")
    mode = "edit" if (req.mode == "edit" or (req.mode == "auto" and image_paths)) else "generate"
    job_id = uuid.uuid4().hex
    created_at = utc_stamp()
    preview = request_preview(req, mode, image_paths)
    preview["fallback_candidates"] = [
        {
            "profile": item.get("name", ""),
            "base_url": api_base_url(item),
            "model": item.get("model") or "gpt-image-2",
        }
        for item in [profile, *fallback_profiles(profile)]
    ]
    record = {
        "id": job_id,
        "created_at": created_at,
        "updated_at": created_at,
        "prompt": req.prompt,
        "mode": mode,
        "profile": profile.get("name", ""),
        "base_url": api_base_url(profile),
        "model": req.model or profile.get("model") or "gpt-image-2",
        "size": req.size,
        "quality": req.quality,
        "output_format": req.output_format,
        "count": req.count,
        "status": "running",
        "error": None,
        "inputs": [media_record(path, "upload") for path in image_paths],
        "outputs": [],
        "completed_count": 0,
        "failed_count": 0,
        "errors": [],
        "request": preview,
    }
    return record, profile, image_paths, mode


async def start_generation_job(req: GenerateRequest) -> dict[str, Any]:
    record, profile, image_paths, mode = prepare_job(req)
    insert_history(record)
    cancel_event = asyncio.Event()
    task = asyncio.create_task(
        run_generation_job(record["id"], req, profile, image_paths, mode, cancel_event)
    )
    RUNNING_JOBS[record["id"]] = {"task": task, "cancel_event": cancel_event}
    return get_history_record(record["id"]) or record


ensure_dirs()
init_db()


@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    mark_interrupted_jobs()
    profile = get_profile()
    status = await check_profile(profile)
    state = "ok" if status["ok"] else "not ready"
    print(f"[api-check] {profile.get('name')} {state}: {status['message']}")
    yield


app = FastAPI(title="gpt-image-studio", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/media/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/media/outputs", StaticFiles(directory=OUTPUT_DIR), name="outputs")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/config")
async def read_config() -> dict[str, Any]:
    config = load_config()
    return {
        "active_profile": config.get("active_profile"),
        "profiles": [redact_profile(p) for p in config.get("profiles", [])],
        "server": config.get("server", {}),
    }


@app.post("/api/config")
async def write_config(config_in: ConfigIn) -> dict[str, Any]:
    old = load_config()
    old_by_name = {p.get("name"): p for p in old.get("profiles", [])}
    profiles = []
    for incoming in config_in.profiles:
        old_profile = old_by_name.get(incoming.name) or old_by_name.get(incoming.previous_name) or {}
        profile = {
            "name": incoming.name,
            "base_url": normalize_base_url(incoming.base_url),
            "api_key": old_profile.get("api_key", ""),
            "model": normalize_model_name(incoming.model),
        }
        if incoming.api_key:
            profile["api_key"] = incoming.api_key
        old_base_url = normalize_base_url(old_profile.get("base_url"))
        old_model = normalize_model_name(old_profile.get("model"))
        should_check = (
            incoming.api_key is not None
            or old_base_url != profile["base_url"]
            or old_model != profile["model"]
        )
        if should_check:
            check = await check_profile(profile)
            if not check.get("ok"):
                raise HTTPException(
                    status_code=400,
                    detail=f"Profile check failed for {incoming.name}: {check.get('message', 'API check failed.')}",
                )
            if check.get("ok") and check.get("resolved_base_url"):
                profile["base_url"] = str(check["resolved_base_url"])
        profiles.append(profile)
    if not any(p["name"] == config_in.active_profile for p in profiles):
        raise HTTPException(status_code=400, detail="Active profile must exist in profiles.")
    merged = {
        "active_profile": config_in.active_profile,
        "profiles": profiles,
        "server": old.get("server", DEFAULT_CONFIG["server"]),
    }
    save_config(merged)
    return await read_config()


@app.post("/api/config/active")
async def set_active_profile(payload: ActiveProfileIn) -> dict[str, Any]:
    config = load_config()
    if not any(p.get("name") == payload.name for p in config.get("profiles", [])):
        raise HTTPException(status_code=404, detail=f"Profile not found: {payload.name}")
    config["active_profile"] = payload.name
    save_config(config)
    return await read_config()


@app.post("/api/config/test")
async def test_profile(payload: TestProfileIn) -> dict[str, Any]:
    if payload.name and not payload.base_url:
        profile = get_profile(payload.name)
    else:
        active = get_profile()
        profile = dict(active)
        if payload.name:
            profile["name"] = payload.name
        if payload.base_url:
            profile["base_url"] = normalize_base_url(payload.base_url)
        if payload.api_key:
            profile["api_key"] = payload.api_key
        if payload.model:
            profile["model"] = normalize_model_name(payload.model)
    return await check_profile(profile)


@app.get("/api/status")
async def status() -> dict[str, Any]:
    profile = get_profile()
    result = await check_profile(profile)
    result["active_profile"] = profile.get("name")
    return result


@app.get("/api/uploads")
async def uploads() -> dict[str, Any]:
    return {"items": list_media(UPLOAD_DIR, "upload")}


@app.post("/api/upload")
async def upload_images(files: list[UploadFile] = File(...)) -> dict[str, Any]:
    saved = []
    allowed = {"image/png", "image/jpeg", "image/webp"}
    for file in files:
        if file.content_type not in allowed:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {file.content_type}")
        suffix = Path(file.filename or "image.png").suffix.lower()
        if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
            suffix = ".png"
        name = f"{utc_stamp().replace(':', '').replace('-', '')}-{uuid.uuid4().hex[:10]}{suffix}"
        path = UPLOAD_DIR / name
        path.write_bytes(await file.read())
        saved.append(media_record(path, "upload"))
    return {"items": saved}


@app.delete("/api/uploads/{image_id}")
async def delete_upload(image_id: str) -> dict[str, Any]:
    path = safe_media_path(UPLOAD_DIR, image_id)
    path.unlink()
    return {"deleted": 1, "id": image_id}


@app.get("/api/history")
async def history(limit: int = 80) -> dict[str, Any]:
    limit = min(max(limit, 1), 300)
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM generations ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return {"items": [history_row_to_dict(row) for row in rows]}


@app.get("/api/history/{generation_id}")
async def history_item(generation_id: str) -> dict[str, Any]:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM generations WHERE id = ?", (generation_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="History item not found.")
    return history_row_to_dict(row)


@app.delete("/api/history/{generation_id}")
async def delete_history_item(generation_id: str) -> dict[str, Any]:
    job = RUNNING_JOBS.get(generation_id)
    canceled = False
    if job:
        job["cancel_event"].set()
        task: asyncio.Task = job["task"]
        task.cancel()
        canceled = True
    with sqlite3.connect(DB_PATH) as conn:
        deleted = conn.execute("DELETE FROM generations WHERE id = ?", (generation_id,)).rowcount
    return {"deleted": deleted, "canceled": canceled}


@app.post("/api/jobs")
async def create_job(req: GenerateRequest) -> dict[str, Any]:
    return await start_generation_job(req)


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict[str, Any]:
    record = get_history_record(job_id)
    if not record:
        raise HTTPException(status_code=404, detail="Job not found.")
    job = RUNNING_JOBS.get(job_id)
    if job:
        update_history(job_id, status="canceling", error="Cancel requested by user.")
        job["cancel_event"].set()
        task: asyncio.Task = job["task"]
        task.cancel()
        return get_history_record(job_id) or {"id": job_id, "status": "canceling"}
    if record["status"] in ACTIVE_STATUSES:
        update_history(job_id, status="canceled", error="Canceled after server restart.")
        return get_history_record(job_id) or {"id": job_id, "status": "canceled"}
    return record


@app.post("/api/generate")
async def generate(req: GenerateRequest) -> dict[str, Any]:
    return await start_generation_job(req)


def main() -> None:
    config = load_config()
    server = config.get("server", {})
    host = str(server.get("host", "127.0.0.1"))
    port = int(server.get("port", 7862))
    url = f"http://{host}:{port}"
    if os.getenv("GPT_IMAGE_STUDIO_NO_BROWSER") != "1":
        Timer(1.0, lambda: webbrowser.open(url)).start()
    print(f"[server] gpt-image-studio: {url}")
    print(f"[config] {CONFIG_PATH}")
    uvicorn.run("image_studio.server:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
