# Voice Memo Analyzer

## Architecture

This project implements a three-stage Azure AI pipeline:

1. Speech-to-Text (STT) using Azure Speech
2. Language Analysis using Azure AI Language
3. Text-to-Speech (TTS) using Azure Neural Voice

The application also uses Azure Application Insights for observability, including request tracing, per-stage latency metrics, and the `/telemetry-summary` endpoint.

## Project Files

- `server.js` - local development server
- `server_azure.js` - Azure deployment server
- `telemetry.js` - Application Insights initialization
- `public/` - frontend files
- `.env.example` - example environment variables
- `.gitignore` - ignored files and folders

## Setup Instructions

### 1. Clone the repository

```bash
git clone https://github.com/AnnieZX/voice-memo-app.git
cd voice-memo-app
