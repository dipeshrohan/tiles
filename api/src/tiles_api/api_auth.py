"""Sign-in configuration and the current user."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from tiles_api.auth import Principal, authenticate
from tiles_api.settings import Settings

router = APIRouter(tags=["auth"])


class AuthConfig(BaseModel):
    """What the browser needs to sign in (public)."""

    enabled: bool
    issuer: str | None
    client_id: str
    # True outside production: requests without a token act as the dev user.
    dev_identity: bool


class Me(BaseModel):
    email: str
    name: str
    org: str | None
    via: Literal["oidc", "dev"]


@router.get("/auth/config", response_model=AuthConfig)
def auth_config(request: Request) -> AuthConfig:
    settings: Settings = request.app.state.settings
    return AuthConfig(
        enabled=bool(settings.oidc_issuer),
        issuer=settings.oidc_issuer,
        client_id=settings.oidc_client_id,
        dev_identity=settings.env != "production",
    )


@router.get("/me", response_model=Me)
def me(principal: Annotated[Principal, Depends(authenticate)]) -> Me:
    return Me(
        email=principal.email,
        name=principal.name,
        org=principal.org,
        via="oidc" if principal.subject else "dev",
    )
