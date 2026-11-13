# P0: FastAPI shell. P1 installs Azure CLI in this Linux image,
# adds AzureCliCredential and uses the mounted private login volume.
FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app/ ./app/
RUN useradd --uid 10001 --create-home app && mkdir -p /home/app/.azure \
    && chown -R app:app /home/app/.azure /app
USER app
ENV AZURE_CONFIG_DIR=/home/app/.azure
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
