"""Sign-in configuration and the current user."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from tiles_api.auth import SLUG, Principal, authenticate
from tiles_api.org_sign_in import provider_by_org
from tiles_api.settings import Settings

router = APIRouter(tags=["auth"])


class AuthConfig(BaseModel):
    """What the browser needs to sign in (public)."""

    enabled: bool
    issuer: str | None
    client_id: str
    # What the browser asks the provider for (an organisation's provider may need its API's scope).
    scope: str = "openid email profile"
    # The organisation whose own provider this is (?org=), or None for this deployment's.
    org: str | None = None
    # True outside production: requests without a token act as the dev user.
    dev_identity: bool


class Me(BaseModel):
    email: str
    name: str
    org: str | None
    via: Literal["oidc", "dev"]


@router.get("/auth/config", response_model=AuthConfig)
def auth_config(request: Request, org: Annotated[str | None, Query(max_length=63)] = None) -> AuthConfig:
    """How the browser signs in here: the OpenID Connect issuer and client, and whether requests
    without a token act as the development user (anywhere but production). With `?org=<slug>`,
    that organisation's own identity provider (T5.05): 404 if it has none."""
    settings: Settings = request.app.state.settings
    if org is not None:
        provider = provider_by_org(request.app.state, org.strip().lower()) if SLUG.match(org.strip().lower()) else None
        if provider is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "That organisation has no sign-in of its own")
        return AuthConfig(
            enabled=True,
            issuer=provider.issuer,
            client_id=provider.client_id,
            scope=provider.scope,
            org=provider.org,
            dev_identity=settings.env != "production",
        )
    return AuthConfig(
        enabled=bool(settings.oidc_issuer),
        issuer=settings.oidc_issuer,
        client_id=settings.oidc_client_id,
        dev_identity=settings.env != "production",
    )


@router.get("/me", response_model=Me)
def me(principal: Annotated[Principal, Depends(authenticate)]) -> Me:
    """Who the request is from: email, name, organisation, and whether it signed in through the
    identity provider (`oidc`) or is the development user (`dev`)."""
    return Me(
        email=principal.email,
        name=principal.name,
        org=principal.org,
        via="oidc" if principal.subject else "dev",
    )
