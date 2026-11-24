from datetime import date, datetime, timedelta
from time import perf_counter

from .catalog import profile_for


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


def history_features(gap, cost, event_date, vehicle, profile):
    return [gap, cost, event_date.month, profile["cc"], profile["oil_interval_km"],
            vehicle.get("odometer_km", 0) / profile["oil_interval_km"]]


def predict_from_history(times, costs, vehicle, profile, workers):
    gaps = [max(1, (end - start).days) for start, end in zip(times, times[1:])]
    features = [history_features(gaps[i - 1], costs[i], times[i], vehicle, profile)
                for i in range(1, len(times) - 1)]
    targets = [[gaps[i], costs[i + 1]] for i in range(1, len(times) - 1)]
    sample = history_features(gaps[-1], costs[-1], times[-1], vehicle, profile)
    # Regularize short personal histories with one observation from the reference profile.
    baseline_days = profile["service_interval_days"]
    baseline_cost = profile["expected_cost_cop"]
    features.append(history_features(baseline_days, baseline_cost, times[-1], vehicle, profile))
    targets.append([baseline_days, baseline_cost])
    return fit_forest(features, targets, [sample], workers)[0]


def recommend(rows, vehicle=None, workers=2):
    vehicle = vehicle or {}
    profile, reference = profile_for(vehicle)
    times = [datetime.fromisoformat(row["date"].replace(" ", "T")).date() for row in rows]
    anchor = times[-1] if times else date.today()
    days = profile["service_interval_days"]
    cost = profile["expected_cost_cop"]
    source = "catalog_baseline"
    if len(rows) >= 6:
        days, cost = predict_from_history(times, [row["amount_cop"] for row in rows], vehicle, profile, workers)
        source = "ml_random_forest"
    return {"next_maintenance_date": (anchor + timedelta(days=round(days))).isoformat(),
            "expected_cost_cop": round(cost), "history_events": len(rows), "random_state": 42,
            "source": source, "recommended_km_interval": profile["oil_interval_km"],
            "model_reference": reference}
