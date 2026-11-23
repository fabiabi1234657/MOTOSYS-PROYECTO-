from datetime import datetime, timedelta, timezone
from time import perf_counter


def fit_forest(x, y, sample, workers):
    from joblib import parallel_backend
    from sklearn.ensemble import RandomForestRegressor

    with parallel_backend("threading", n_jobs=workers):
        forest = RandomForestRegressor(n_estimators=48, min_samples_leaf=2, max_depth=10,
                                      n_jobs=workers, random_state=42)
        forest.fit(x, y)
        return forest.predict(sample)


def benchmark(size, workers):
    import numpy as np

    rng = np.random.default_rng(42)
    x = rng.random((size, 6), dtype=np.float32)
    y = np.column_stack((15 + x[:, 0] * 90 + x[:, 2] * 30,
                         50000 + x[:, 1] * 900000 + x[:, 3] * 300000))
    # Exclude imports from the comparison and use identical input in both runs.
    from sklearn.ensemble import RandomForestRegressor  # noqa: F401

    timings = []
    for jobs in (1, workers):
        start = perf_counter()
        prediction = fit_forest(x, y, x[:16], jobs)
        timings.append((perf_counter() - start, prediction))
    sequential, parallel = timings
    return {"random_state": 42, "samples": size, "workers": workers,
            "sequential_ms": round(sequential[0] * 1000, 2),
            "parallel_ms": round(parallel[0] * 1000, 2),
            "speedup": round(sequential[0] / parallel[0], 3),
            "matching_predictions": bool(np.allclose(sequential[1], parallel[1]))}


def recommend(rows, workers=2):
    if len(rows) < 6:
        return None
    times = [datetime.fromisoformat(row["date"].replace(" ", "T")).replace(tzinfo=timezone.utc)
             for row in rows]
    costs = [row["amount_cop"] for row in rows]
    gaps = [max(1, (end - start).days) for start, end in zip(times, times[1:])]
    features = [[gaps[i - 1], costs[i], times[i].month] for i in range(1, len(times) - 1)]
    targets = [[gaps[i], costs[i + 1]] for i in range(1, len(times) - 1)]
    days, cost = fit_forest(features, targets, [[gaps[-1], costs[-1], times[-1].month]], workers)[0]
    return {"next_maintenance_date": (times[-1] + timedelta(days=round(days))).date().isoformat(),
            "expected_cost_cop": round(cost), "history_events": len(rows), "random_state": 42}
