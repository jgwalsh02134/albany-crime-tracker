from __future__ import annotations

import logging
import traceback
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        error_id = uuid4().hex[:10]
        logger.error(
            "unhandled_exception",
            extra={
                "path": request.url.path,
                "method": request.method,
                "status_code": 500,
                "error_id": error_id,
            },
        )
        logger.debug("traceback:\n%s", traceback.format_exc())
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "message": "Internal server error",
                "error_id": error_id,
            },
        )

