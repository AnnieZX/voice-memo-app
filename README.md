# Voice Memo Analyzer

A full-stack Node.js application that analyzes voice memos using a three-stage Azure AI pipeline:

1. **Speech-to-Text (STT)** with Azure Speech
2. **Language Analysis** with Azure AI Language
3. **Text-to-Speech (TTS)** with Azure Neural Voice

The app also includes **Azure Application Insights** for observability with request tracing, per-stage latency metrics, and a telemetry summary endpoint.

---

## Features

- Upload/process audio through an end-to-end AI pipeline
- Separate API endpoints for each stage (`/transcribe`, `/analyze`, `/process`)
- Azure-ready server entrypoint for deployment
- Built-in telemetry instrumentation with:
  - request tracing
  - per-stage latency
  - `/telemetry-summary` endpoint

---

## Project Structure

```text
.
├── server.js              # Local development server
├── server_azure.js        # Azure deployment server
├── telemetry.js           # Application Insights initialization
├── public/                # Frontend static files
├── .env.example           # Example environment variables
└── .gitignore             # Ignored files/folders
```

---

## Prerequisites

- **Node.js 20+** (recommended for Azure runtime compatibility)
- **npm**
- **Azure account** (for Speech, Language, App Insights, and App Service)
- **Azure CLI** (for provisioning/deployment)

---

## Quick Start (Local)

### 1) Clone the repository

```bash
git clone https://github.com/AnnieZX/voice-memo-app.git
cd voice-memo-app
```

### 2) Install dependencies

```bash
npm install
```

### 3) Configure environment variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Update `.env` with your Azure values.

### 4) Run local development server

```bash
node server.js
```

### 5) Run Azure deployment version locally

```bash
node server_azure.js
```

---

## Environment Variables

Use `.env.example` as the template. Typical required variables:

- `AZURE_SPEECH_KEY`
- `AZURE_SPEECH_REGION`
- `AZURE_LANGUAGE_KEY`
- `AZURE_LANGUAGE_ENDPOINT`
- `APPLICATIONINSIGHTS_CONNECTION_STRING`

> Keep `.env` local only. Never commit secrets.

---

## API Endpoints

- `POST /transcribe`
  Converts speech audio to text.

- `POST /analyze`
  Runs language analysis on text input.

- `POST /process`
  Executes the full pipeline (STT -> analysis -> TTS).

- `GET /telemetry-summary`
  Returns summarized telemetry/latency data.

---

## Azure Provisioning (from scratch)

### Create Resource Group

```bash
az group create --name csc391-speech-rg --location eastus
```

### Create Speech Resource (F0)

```bash
az cognitiveservices account create \
  --name csc391-speech-resource \
  --resource-group csc391-speech-rg \
  --kind SpeechServices \
  --sku F0 \
  --location eastus \
  --yes
```

### Create Language Resource (F0)

```bash
az cognitiveservices account create \
  --name csc391-language-resource \
  --resource-group csc391-speech-rg \
  --kind Language \
  --sku F0 \
  --location eastus \
  --yes
```

### Create Application Insights

```bash
az monitor app-insights component create \
  --app csc391-insights \
  --location eastus \
  --resource-group csc391-speech-rg \
  --application-type web
```

### Create App Service Plan

```bash
az appservice plan create \
  --name csc391-speech-plan \
  --resource-group csc391-speech-rg \
  --sku B1 \
  --is-linux
```

### Create Web App

```bash
az webapp create \
  --resource-group csc391-speech-rg \
  --plan csc391-speech-plan \
  --name csc391-speech-luozixiao \
  --runtime "NODE:20-lts"
```

### Set Startup Command

```bash
az webapp config set \
  --resource-group csc391-speech-rg \
  --name csc391-speech-luozixiao \
  --startup-file "node server_azure.js"
```

### Configure App Settings (Environment Variables)

```bash
az webapp config appsettings set \
  --resource-group csc391-speech-rg \
  --name csc391-speech-luozixiao \
  --settings \
  AZURE_SPEECH_KEY="YOUR_SPEECH_KEY" \
  AZURE_SPEECH_REGION="eastus" \
  AZURE_LANGUAGE_KEY="YOUR_LANGUAGE_KEY" \
  AZURE_LANGUAGE_ENDPOINT="https://eastus.api.cognitive.microsoft.com/" \
  APPLICATIONINSIGHTS_CONNECTION_STRING="YOUR_APPLICATIONINSIGHTS_CONNECTION_STRING"
```

### Deploy to Azure

```bash
az webapp up \
  --resource-group csc391-speech-rg \
  --name csc391-speech-luozixiao \
  --runtime "NODE:20-lts" \
  --sku B1
```

---

## Observability

Application Insights is initialized in `telemetry.js` and is used for:

- request-level tracing
- pipeline-stage latency metrics
- operational insight via `/telemetry-summary`

---

## Security Notes

- Do **not** commit `.env`
- Do **not** commit Azure credentials, API keys, or connection strings
- Rotate keys immediately if secrets are exposed

---

## `.gitignore` (expected exclusions)

- `.env`
- `node_modules/`
- `__pycache__/`
- `temp_audio/`

---

## Troubleshooting

- **Authentication/401 errors**: verify keys and endpoint values in `.env` or App Settings.
- **Region mismatch**: ensure resource region and endpoint region align (e.g., `eastus`).
- **App fails on Azure startup**: confirm startup command is `node server_azure.js`.
- **No telemetry**: verify `APPLICATIONINSIGHTS_CONNECTION_STRING` is set correctly.

---

## License

Add your project license here (e.g., MIT) if applicable.

