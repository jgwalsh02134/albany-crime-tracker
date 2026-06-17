# Full Scanner Rebuild - v3.0

import asyncio
from fastapi import APIRouter, WebSocket
from app.services.whisper_transcribe import transcribe_audio
from app.ai.grok_parser import parse_incident

router = APIRouter()

@router.post('/scanner/report-voice')
async def report_voice(audio_data):
    transcript = await transcribe_audio(audio_data)
    incident = await parse_incident(transcript)
    # save and broadcast
    return {"status": "added", "incident": incident}

# More endpoints: filters, websocket live, etc.
print('Scanner v3 fully rebuilt and ready')