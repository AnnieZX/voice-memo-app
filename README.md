# Voice Memo Analyzer

## Architecture

This project implements a three-stage Azure AI pipeline:

1. Speech-to-Text (STT) using Azure Speech  
2. Language Analysis using Azure AI Language  
3. Text-to-Speech (TTS) using Azure Neural Voice  

The application also uses Azure Application Insights for observability, including:
- request tracing  
- per-stage latency metrics  
- `/telemetry-summary` endpoint  

---

## Project Files

- `server.js` - local development server  
- `server_azure.js` - Azure deployment server  
- `telemetry.js` - Application Insights initialization  
- `public/` - frontend files  
- `.env.example` - example environment variables  
- `.gitignore` - ignored files and folders  

---

## Setup Instructions

### 1. Clone the repository

```bash
git clone https://github.com/AnnieZX/voice-memo-app.git
cd voice-memo-app
2. Install dependencies
npm install
3. Create environment variables

Copy .env.example to .env and replace the placeholder values with your Azure credentials:

cp .env.example .env
4. Run locally
node server.js
5. Run the Azure deployment version locally
node server_azure.js
API Endpoints
POST /transcribe
POST /analyze
POST /process
GET /telemetry-summary
Azure CLI Commands to Provision Resources from Scratch
Create resource group
az group create --name csc391-speech-rg --location eastus
Create Speech resource (F0)
az cognitiveservices account create \
  --name csc391-speech-resource \
  --resource-group csc391-speech-rg \
  --kind SpeechServices \
  --sku F0 \
  --location eastus \
  --yes
Create Language resource (F0)
az cognitiveservices account create \
  --name csc391-language-resource \
  --resource-group csc391-speech-rg \
  --kind Language \
  --sku F0 \
  --location eastus \
  --yes
Create Application Insights
az monitor app-insights component create \
  --app csc391-insights \
  --location eastus \
  --resource-group csc391-speech-rg \
  --application-type web
Create App Service Plan
az appservice plan create \
  --name csc391-speech-plan \
  --resource-group csc391-speech-rg \
  --sku B1 \
  --is-linux
Create Web App
az webapp create \
  --resource-group csc391-speech-rg \
  --plan csc391-speech-plan \
  --name csc391-speech-luozixiao \
  --runtime "NODE:20-lts"
Set startup command
az webapp config set \
  --resource-group csc391-speech-rg \
  --name csc391-speech-luozixiao \
  --startup-file "node server_azure.js"
Set environment variables
az webapp config appsettings set \
  --resource-group csc391-speech-rg \
  --name csc391-speech-luozixiao \
  --settings \
  AZURE_SPEECH_KEY="YOUR_SPEECH_KEY" \
  AZURE_SPEECH_REGION="eastus" \
  AZURE_LANGUAGE_KEY="YOUR_LANGUAGE_KEY" \
  AZURE_LANGUAGE_ENDPOINT="https://eastus.api.cognitive.microsoft.com/" \
  APPLICATIONINSIGHTS_CONNECTION_STRING="YOUR_APPLICATIONINSIGHTS_CONNECTION_STRING"
Deploy to Azure
az webapp up \
  --resource-group csc391-speech-rg \
  --name csc391-speech-luozixiao \
  --runtime "NODE:20-lts" \
  --sku B1
Important Notes
Do NOT commit .env
Do NOT commit Azure credentials or API keys
.gitignore excludes:
.env
node_modules/
__pycache__/
temp_audio/
