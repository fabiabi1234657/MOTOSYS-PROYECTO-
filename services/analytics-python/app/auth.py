import hashlib
import hmac
import json
import re
import time

from fastapi import HTTPException, Request
from fastapi.security import HTTPBearer

bearer = HTTPBearer(auto_error=False)
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")


async def authenticate(request: Request, authorization=None):
    header = request.headers.get("authorization")
    token = authorization.credentials if authorization else request.cookies.get("__Host-motosys")
    if (header and not authorization) or not token or not TOKEN.fullmatch(token):
        raise HTTPException(401, "Sesión requerida.")
    if not header and request.method not in ("GET", "HEAD"):
        cookie = request.cookies.get("__Host-motosys-csrf", "")
        csrf = request.headers.get("x-csrf-token", "")
        if not TOKEN.fullmatch(cookie) or not TOKEN.fullmatch(csrf) or not hmac.compare_digest(cookie, csrf):
            raise HTTPException(403, "Validación CSRF fallida.")
    key = "session:" + hashlib.sha256(token.encode()).hexdigest()
    state = request.app.state
    stored = await state.redis.get(key)
    if stored is None:
        raise HTTPException(401, "Sesión caducada.")
    try:
        session = json.loads(stored)
        remaining = int(session["expiresAt"] - time.time() * 1000)
        account = await state.pg.fetchrow(
            "SELECT id,role,workshop_id,session_version FROM users WHERE id=$1",
            session["userId"],
        )
        if (remaining <= 0 or not account or session.get("version", 0) != account["session_version"]
                or (account["role"] != "RIDER" and session.get("mfa") is not True)
                or not await state.redis.pexpire(key, min(remaining, 1800000))):
            raise HTTPException(401, "Sesión caducada.")
    except (ValueError, TypeError, KeyError):
        raise HTTPException(401, "Sesión inválida.") from None
    return account


def allowed(account, motorcycle):
    return (
        account["role"] == "SUPER_ADMIN"
        or (account["role"] == "RIDER" and account["id"] == motorcycle["owner_id"])
        or (account["role"] == "WORKSHOP_ADMIN" and account["workshop_id"] is not None
            and account["workshop_id"] == motorcycle["workshop_id"])
    )


async def vehicle_scope(pg, account, motorcycle_id):
    row = await pg.fetchrow("SELECT owner_id,workshop_id FROM motorcycles WHERE id=$1", motorcycle_id)
    if not row:
        raise HTTPException(404, "Motocicleta no encontrada.")
    if not allowed(account, row):
        raise HTTPException(403, "Motocicleta fuera de tu ámbito.")
    return str(motorcycle_id)


async def vehicles_in_scope(pg, account):
    # Use current assignments, rather than denormalized historical owner/workshop dimensions.
    rows = await pg.fetch(
        """SELECT id FROM motorcycles WHERE $1='SUPER_ADMIN'
        OR ($1='RIDER' AND owner_id=$2) OR ($1='WORKSHOP_ADMIN' AND workshop_id=$3)
        ORDER BY id LIMIT 5001""",
        account["role"], account["id"], account["workshop_id"],
    )
    if len(rows) > 5000:
        raise HTTPException(422, "El ámbito supera el límite de 5000 motocicletas.")
    return [str(row["id"]) for row in rows]
