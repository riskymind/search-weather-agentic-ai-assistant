"""Version 1 API router."""

from fastapi import APIRouter

from app.api.v1.routes import agent, diagnostics, health

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(health.router)
api_router.include_router(agent.router)
api_router.include_router(diagnostics.router)
