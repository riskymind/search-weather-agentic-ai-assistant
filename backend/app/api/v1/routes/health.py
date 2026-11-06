"""Liveness endpoint. Makes no outbound calls, so it is cheap for platform health checks."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.dependencies import get_settings_dep
from app.core.config import SERVICE_NAME, SERVICE_VERSION, Settings
from app.schemas.common import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse, summary="Service health")
async def health(settings: Annotated[Settings, Depends(get_settings_dep)]) -> HealthResponse:
    return HealthResponse(service=SERVICE_NAME, version=SERVICE_VERSION, environment=settings.app_env)
