import json
import os

from fastapi import HTTPException
from httpx import HTTPError


class ClickHouse:
    def __init__(self, client):
        self.client = client
        self.url = os.environ.get("CLICKHOUSE_URL", "http://clickhouse:8123")
        self.headers = {"X-ClickHouse-User": os.getenv("CLICKHOUSE_USER", "motosys"),
                        "X-ClickHouse-Key": os.environ.get("CLICKHOUSE_PASSWORD", "")}

    async def query(self, sql, **bindings):
        params = {"default_format": "JSONEachRow", "output_format_json_quote_64bit_integers": "0",
                  "max_threads": "2", "max_execution_time": "5"}
        params.update({f"param_{key}": str(value) for key, value in bindings.items()})
        if isinstance(bindings.get("ids"), list):
            params["param_ids"] = "[" + ",".join("'" + item + "'" for item in bindings["ids"]) + "]"
        try:
            response = await self.client.post(self.url, params=params, headers=self.headers, content=sql)
            response.raise_for_status()
            return [json.loads(line) for line in response.text.splitlines() if line]
        except (HTTPError, ValueError):
            raise HTTPException(503, "Consulta analítica no disponible.") from None


DIMENSIONS = {"category": "category", "make": "make",
              "workshop": "ifNull(toString(workshop_id), 'sin-taller')"}


async def monthly(store, ids, dimension, since, until):
    if not ids:
        return []
    column = DIMENSIONS[dimension]
    return await store.query(
        f"""SELECT toString(toStartOfMonth(occurred_at)) AS month, {column} AS bucket,
        sum(amount_cop) AS total_cop, count() AS events
        FROM motosys.fact_vehicle_events FINAL WHERE motorcycle_id IN {{ids:Array(UUID)}}
        AND occurred_at >= {{since:Date}} AND occurred_at < {{until:Date}}
        GROUP BY month,bucket ORDER BY month,bucket LIMIT 2000""",
        ids=ids, since=since, until=until,
    )
