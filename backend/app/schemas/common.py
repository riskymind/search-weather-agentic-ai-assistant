"""Schemas shared across endpoints."""

from typing import Literal

from pydantic import BaseModel


class ErrorBody(BaseModel):
    code: str
    message: str
    details: list[dict[str, object]] | None = None


class ErrorResponse(BaseModel):
    """Envelope used for every non-2xx response."""

    error: ErrorBody


class HealthResponse(BaseModel):
    status: Literal["healthy"] = "healthy"
    service: str
    version: str
    environment: str
