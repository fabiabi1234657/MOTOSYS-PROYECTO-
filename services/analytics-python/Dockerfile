FROM python:3.13.7-slim-bookworm AS build
WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.13.7-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1
RUN groupadd --system appuser && useradd --system --gid appuser appuser
WORKDIR /app
COPY --from=build /install /usr/local
COPY --chown=appuser:appuser app ./app
USER appuser
EXPOSE 3002
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3002"]
