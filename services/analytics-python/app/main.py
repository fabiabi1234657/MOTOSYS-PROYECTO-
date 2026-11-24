import asyncio
import os
from contextlib import asynccontextmanager
from datetime import date, timedelta
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.security import APIKeyCookie
from fastapi.openapi.docs import get_swagger_ui_html
from pydantic import BaseModel, Field
from redis.asyncio import Redis
from redis.exceptions import RedisError
from starlette.responses import JSONResponse

from .auth import authenticate, bearer, scoped_vehicle, vehicle_scope, vehicles_in_scope
from .catalog import CATALOG
from .data import ClickHouse, monthly
from .ml import benchmark, recommend


@asynccontextmanager
async def lifespan(app):
    pg = await asyncpg.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=4, command_timeout=4)
    try:
        async with (Redis.from_url(os.environ["REDIS_URL"], decode_responses=True,
                                   socket_connect_timeout=3, socket_timeout=3) as redis,
                    httpx.AsyncClient(timeout=7, limits=httpx.Limits(max_connections=8)) as http):
            app.state.pg = pg
            app.state.redis = redis
            app.state.olap = ClickHouse(http)
            app.state.ml_gate = asyncio.Semaphore(1)
            yield
    finally:
        await pg.close()


app = FastAPI(title="MotoSys Analytics", version="1.0.0", lifespan=lifespan, docs_url=None, servers=[{"url": "/api"}])
cookie_scheme = APIKeyCookie(name="__Host-motosys", auto_error=False)


async def get_account(request: Request, auth=Security(bearer), _cookie=Security(cookie_scheme)):
    return await authenticate(request, auth)


Account = Annotated[dict, Depends(get_account)]


async def datastore_error(_request, _exception):
    return JSONResponse({"detail": "Almacén de datos no disponible."}, status_code=503)


for error in (RedisError, asyncpg.PostgresError, OSError, TimeoutError):
    app.add_exception_handler(error, datastore_error)


async def run_ml(state, function, *args):
    try:
        await asyncio.wait_for(state.ml_gate.acquire(), timeout=0.1)
    except TimeoutError:
        raise HTTPException(503, "El ejecutor ML está ocupado.") from None
    task = asyncio.create_task(asyncio.to_thread(function, *args))

    def finished(job):
        state.ml_gate.release()
        if not job.cancelled():
            job.exception()

    task.add_done_callback(finished)
    return await asyncio.shield(task)


@app.get("/docs", include_in_schema=False)
async def docs():
    return get_swagger_ui_html(openapi_url="/api/analytics/openapi.json", title=app.title)


@app.get("/health")
async def health():
    return {"status": "ok"}


class TcoResult(BaseModel):
    tco_cop: int
    expenses_cop: int
    maintenance_cop: int
    events: int


class MonthlyRow(BaseModel):
    month: date
    bucket: str
    total_cop: int
    events: int


class MaintenanceCounts(BaseModel):
    preventive: int
    corrective: int
    unclassified: int


class CatalogModel(BaseModel):
    make: str
    model: str
    cc: int
    segment: str
    oil_interval_km: int
    service_interval_days: int
    expected_cost_cop: int


class Recommendation(BaseModel):
    next_maintenance_date: date
    expected_cost_cop: int
    history_events: int
    random_state: int
    source: Literal["ml_random_forest", "catalog_baseline"]
    recommended_km_interval: int
    model_reference: str | None


class BenchmarkResult(BaseModel):
    random_state: int
    samples: int
    workers: int
    sequential_ms: float
    parallel_ms: float
    speedup: float
    matching_predictions: bool


@app.get("/analytics/catalog", response_model=list[CatalogModel])
async def catalog(account: Account):
    return CATALOG


@app.get("/analytics/motorcycles/{motorcycle_id}/tco", response_model=TcoResult)
async def tco(request: Request, motorcycle_id: UUID, account: Account):
    state = request.app.state
    vehicle = await vehicle_scope(state.pg, account, motorcycle_id)
    return (await state.olap.query(
        """SELECT sum(amount_cop) AS tco_cop, sumIf(amount_cop,kind='EXPENSE') AS expenses_cop,
        sumIf(amount_cop,kind='MAINTENANCE') AS maintenance_cop, count() AS events
        FROM motosys.fact_vehicle_events FINAL WHERE motorcycle_id={id:UUID}""", id=vehicle,
    ))[0]


@app.get("/analytics/monthly", response_model=list[MonthlyRow])
async def monthly_report(request: Request, account: Account, dimension: Literal["category", "make", "workshop"],
                         since: date | None = None, until: date | None = None):
    until = until or date.today() + timedelta(days=1)
    since = since or until - timedelta(days=365)
    if not 0 < (until - since).days <= 731:
        raise HTTPException(422, "La ventana debe estar entre 1 y 731 días.")
    state = request.app.state
    ids = await vehicles_in_scope(state.pg, account)
    return await monthly(state.olap, ids, dimension, since, until)


@app.get("/analytics/motorcycles/{motorcycle_id}/maintenance", response_model=MaintenanceCounts)
async def maintenance(request: Request, motorcycle_id: UUID, account: Account):
    state = request.app.state
    vehicle = await vehicle_scope(state.pg, account, motorcycle_id)
    return (await state.olap.query(
        """SELECT countIf(lowerUTF8(category) IN ('preventivo','preventive')) AS preventive,
        countIf(lowerUTF8(category) IN ('correctivo','corrective')) AS corrective,
        countIf(lowerUTF8(category) NOT IN ('preventivo','preventive','correctivo','corrective')) AS unclassified
        FROM motosys.fact_vehicle_events FINAL WHERE motorcycle_id={id:UUID} AND kind='MAINTENANCE'""",
        id=vehicle,
    ))[0]


@app.get("/analytics/motorcycles/{motorcycle_id}/recommendation", response_model=Recommendation)
async def recommendation(request: Request, motorcycle_id: UUID, account: Account):
    state = request.app.state
    vehicle = await scoped_vehicle(state.pg, account, motorcycle_id)
    rows = await state.olap.query(
        """SELECT toString(occurred_at) AS date, amount_cop FROM motosys.fact_vehicle_events FINAL
        WHERE motorcycle_id={id:UUID} AND kind='MAINTENANCE'
        ORDER BY occurred_at DESC,event_id DESC LIMIT 256""", id=str(motorcycle_id),
    )
    history = rows[::-1]
    profile = dict(vehicle)
    if len(history) < 6:
        return recommend(history, profile)
    return await run_ml(state, recommend, history, profile)


class BenchmarkRequest(BaseModel):
    samples: int = Field(default=1200, ge=200, le=4000)
    workers: int = Field(default=2, ge=2, le=2)


@app.post("/analytics/ml/benchmark", response_model=BenchmarkResult)
async def benchmark_model(request: Request, body: BenchmarkRequest, account: Account):
    if account["role"] != "SUPER_ADMIN":
        raise HTTPException(403, "Acceso restringido.")
    return await run_ml(request.app.state, benchmark, body.samples, body.workers)
