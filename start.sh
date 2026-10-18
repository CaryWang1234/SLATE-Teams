#!/bin/bash
echo "[SLATE Teams] Starting backend..."
python3 -m pip install -r backend/requirements.txt -q
python3 -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8130
