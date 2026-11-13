"""Internal FastAPI AI Gateway shell; Foundry integration is P1."""

from fastapi import FastAPI

app = FastAPI(title="AI Service Agent Gateway", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "ai-gateway"}
