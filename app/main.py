from fastapi import FastAPI
from app.routers.scanner_v4 import router as scanner_v4_router

app = FastAPI(title="Albany County Crime Tracker")

# Include Scanner v4
app.include_router(scanner_v4_router)

@app.get("/")
async def root():
    return {"message": "Albany County Crime Tracker - Scanner v4 integrated"}

# If this file is not the main entry, the router is still available for import