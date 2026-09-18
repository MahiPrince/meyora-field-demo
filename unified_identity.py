from __future__ import annotations

import os
from dataclasses import dataclass, asdict
from typing import Any

import jwt
from jwt import PyJWKClient
from fastapi import Header, HTTPException


ENTRA_TENANT_ID = os.getenv("ENTRA_TENANT_ID", "f16f1977-60f1-4477-b789-20b60fd70b84")
ENTRA_API_CLIENT_ID = os.getenv("ENTRA_API_CLIENT_ID", "58d4b552-6ebd-48e1-bdfb-dc751af16a15")
ALICE_ENTRA_OID = os.getenv("ALICE_ENTRA_OID", "41e142c1-9d94-499e-9f9a-90d920b8586f")
MAYA_ENTRA_OID = os.getenv("MAYA_ENTRA_OID", "").strip()
MAYA_ENTRA_LOGIN = os.getenv("MAYA_ENTRA_LOGIN", "").strip().lower()

ISSUER_V2 = f"https://login.microsoftonline.com/{ENTRA_TENANT_ID}/v2.0"
ISSUER_V1 = f"https://sts.windows.net/{ENTRA_TENANT_ID}/"
JWKS_URL = f"https://login.microsoftonline.com/{ENTRA_TENANT_ID}/discovery/v2.0/keys"
JWK_CLIENT = PyJWKClient(JWKS_URL)


@dataclass(frozen=True)
class Principal:
    principal_id: str
    entra_oid: str
    display_name: str
    role: str
    tenant_id: str
    domains: list[str]
    connectors: list[str]
    claims: dict[str, Any]

    @property
    def primary_domain(self) -> str:
        return self.domains[0]

    def public(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("claims", None)
        return d


def _bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(401, "Microsoft access token is required")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(401, "Invalid Authorization header")
    return token.strip()


def _decode_and_validate(token: str) -> dict[str, Any]:
    try:
        key = JWK_CLIENT.get_signing_key_from_jwt(token).key
        # Microsoft access tokens for a custom API can carry either the client id
        # or the api:// application id URI in aud depending on registration details.
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=[ENTRA_API_CLIENT_ID, f"api://{ENTRA_API_CLIENT_ID}"],
            options={"verify_iss": False},
        )
    except Exception as exc:
        raise HTTPException(401, f"Microsoft token validation failed: {type(exc).__name__}") from exc

    if claims.get("tid") != ENTRA_TENANT_ID:
        raise HTTPException(403, "Token belongs to a different Microsoft tenant")
    if claims.get("iss") not in {ISSUER_V1, ISSUER_V2}:
        raise HTTPException(401, "Unexpected Microsoft token issuer")
    if not claims.get("oid"):
        raise HTTPException(401, "Microsoft token does not contain an object id")
    return claims


def _principal_from_claims(claims: dict[str, Any]) -> Principal:
    oid = str(claims["oid"]).lower()
    login = str(claims.get("preferred_username") or claims.get("upn") or "").lower()

    if oid == ALICE_ENTRA_OID.lower():
        return Principal(
            principal_id="alice-sales",
            entra_oid=oid,
            display_name=str(claims.get("name") or "Alice Rep"),
            role="Sales Representative",
            tenant_id="thermo-demo",
            domains=["sales"],
            connectors=["salesforce", "outlook", "teams", "calendar"],
            claims=claims,
        )

    maya_match = bool(MAYA_ENTRA_OID and oid == MAYA_ENTRA_OID.lower()) or bool(
        MAYA_ENTRA_LOGIN and login == MAYA_ENTRA_LOGIN
    )
    if maya_match:
        return Principal(
            principal_id="maya-field-service",
            entra_oid=oid,
            display_name=str(claims.get("name") or "Maya Iyer"),
            role="Field Service Engineer",
            tenant_id="thermo-demo",
            domains=["field_service"],
            connectors=["c4c", "outlook", "teams", "calendar"],
            claims=claims,
        )

    raise HTTPException(
        403,
        "This Microsoft identity is valid but is not assigned to a Meyora demo principal",
    )


def principal_from_authorization(authorization: str | None) -> Principal:
    token = _bearer_token(authorization)
    return _principal_from_claims(_decode_and_validate(token))


def get_principal(authorization: str | None = Header(default=None)) -> Principal:
    return principal_from_authorization(authorization)
