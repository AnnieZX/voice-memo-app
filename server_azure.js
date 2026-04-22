const { initTelemetry } = require("./telemetry");
initTelemetry();

console.log("=== STARTING AZURE SERVER ===");

require("dotenv").config();
console.log("dotenv OK");

const express = require("express");
console.log("express OK");

const multer = require("multer");
console.log("multer OK");

const fs = require("fs");
console.log("fs OK");

const fsp = require("fs/promises");
console.log("fsp OK");

const path = require("path");
console.log("path OK");

const { performance } = require("perf_hooks");
console.log("perf_hooks OK");

const speechsdk = require("microsoft-cognitiveservices-speech-sdk");
console.log("speechsdk OK");

const { TextAnalyticsClient } = require("@azure/ai-text-analytics");
console.log("text analytics OK");

const { AzureKeyCredential } = require("@azure/core-auth");
console.log("core-auth OK");

const { metrics, trace } = require("@opentelemetry/api");
console.log("opentelemetry OK");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TEMP_DIR = path.join(__dirname, "temp_audio");
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".wav") {
      return cb(
        new Error(
          "Unsupported Media Type. Only WAV files are supported in this version."
        )
      );
    }
    cb(null, true);
  },
});

/* -------------------------
   Observability: meter/tracer
-------------------------- */
const meter = metrics.getMeter("memo-analyzer");
const tracer = trace.getTracer("memo-analyzer");

const stageSttHist = meter.createHistogram("stage_stt_ms");
const stageLanguageHist = meter.createHistogram("stage_language_ms");
const stageTtsHist = meter.createHistogram("stage_tts_ms");

const sessionLog = [];

const latestMetricState = {
  stt_confidence: 0,
  stt_duration_seconds: 0,
  stt_word_count: 0,
  language_entity_count: 0,
  language_keyphrase_count: 0,
  language_sentiment: 0,
  tts_char_count: 0,
};

const sttConfidenceGauge = meter.createObservableGauge("stt_confidence");
const sttDurationGauge = meter.createObservableGauge("stt_duration_seconds");
const sttWordCountGauge = meter.createObservableGauge("stt_word_count");
const entityCountGauge = meter.createObservableGauge("language_entity_count");
const keyphraseCountGauge = meter.createObservableGauge("language_keyphrase_count");
const sentimentGauge = meter.createObservableGauge("language_sentiment");
const ttsCharCountGauge = meter.createObservableGauge("tts_char_count");

sttConfidenceGauge.addCallback((obs) => {
  obs.observe(latestMetricState.stt_confidence);
});
sttDurationGauge.addCallback((obs) => {
  obs.observe(latestMetricState.stt_duration_seconds);
});
sttWordCountGauge.addCallback((obs) => {
  obs.observe(latestMetricState.stt_word_count);
});
entityCountGauge.addCallback((obs) => {
  obs.observe(latestMetricState.language_entity_count);
});
keyphraseCountGauge.addCallback((obs) => {
  obs.observe(latestMetricState.language_keyphrase_count);
});
sentimentGauge.addCallback((obs) => {
  obs.observe(latestMetricState.language_sentiment);
});
ttsCharCountGauge.addCallback((obs) => {
  obs.observe(latestMetricState.tts_char_count);
});

function updateLatestMetrics(sttResult, languageResult, summaryText) {
  const sentimentMap = { positive: 1.0, neutral: 0.0, negative: -1.0 };

  latestMetricState.stt_confidence = Number(sttResult.confidence ?? 0);
  latestMetricState.stt_duration_seconds = Number(sttResult.duration_seconds ?? 0);
  latestMetricState.stt_word_count = Array.isArray(sttResult.words)
    ? sttResult.words.length
    : (sttResult.transcript || "").trim().split(/\s+/).filter(Boolean).length;

  latestMetricState.language_entity_count = Array.isArray(languageResult.entities)
    ? languageResult.entities.length
    : 0;

  latestMetricState.language_keyphrase_count = Array.isArray(languageResult.key_phrases)
    ? languageResult.key_phrases.length
    : 0;

  latestMetricState.language_sentiment =
    sentimentMap[languageResult?.sentiment?.label] ?? 0.0;

  latestMetricState.tts_char_count = typeof summaryText === "string" ? summaryText.length : 0;
}

function emitPipelineEvent(sttResult, langResult, audioFormat, success = true, errorStage = null, errorMsg = null) {
  const span = trace.getActiveSpan();
  if (!span) return;

  if (success) {
    span.setAttribute("event.name", "pipeline_completed");
    span.setAttribute("stt.confidence", Number(sttResult?.confidence ?? 0));
    span.setAttribute("stt.language", sttResult?.language || "unknown");
    span.setAttribute("entities.count", Array.isArray(langResult?.entities) ? langResult.entities.length : 0);
    span.setAttribute("sentiment", langResult?.sentiment?.label || "unknown");
    span.setAttribute("audio.format", audioFormat || "unknown");
  } else {
    span.setAttribute("event.name", "pipeline_error");
    span.setAttribute("error.stage", errorStage || "unknown");
    span.setAttribute("error.message", errorMsg || "unknown");
    span.recordException(new Error(errorMsg || "Unknown pipeline error"));
  }
}

function logPipelineCall(sttResult, langResult, timings, summaryText) {
  sessionLog.push({
    timestamp: new Date().toISOString(),
    confidence: Number(sttResult.confidence ?? 0),
    language: sttResult.language || "unknown",
    entityCount: Array.isArray(langResult.entities) ? langResult.entities.length : 0,
    keyphraseCount: Array.isArray(langResult.key_phrases) ? langResult.key_phrases.length : 0,
    sentiment: langResult?.sentiment?.label || "unknown",
    sttMs: timings.sttMs,
    languageMs: timings.languageMs,
    ttsMs: timings.ttsMs,
    durationSeconds: Number(sttResult.duration_seconds ?? 0),
    wordCount: Array.isArray(sttResult.words)
      ? sttResult.words.length
      : (sttResult.transcript || "").trim().split(/\s+/).filter(Boolean).length,
    ttsCharCount: typeof summaryText === "string" ? summaryText.length : 0,
  });
}

async function safeDelete(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (_) {}
}

function transcribeWavFile(wavPath) {
  return new Promise((resolve, reject) => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;

    if (!speechKey || !speechRegion) {
      reject(new Error("Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION in environment."));
      return;
    }

    const speechConfig = speechsdk.SpeechConfig.fromSubscription(
      speechKey,
      speechRegion
    );
    speechConfig.speechRecognitionLanguage = "en-US";
    speechConfig.outputFormat = speechsdk.OutputFormat.Detailed;
    speechConfig.requestWordLevelTimestamps();

    let audioConfig;
    try {
      audioConfig = speechsdk.AudioConfig.fromWavFileInput(
        fs.readFileSync(wavPath)
      );
    } catch (err) {
      reject(new Error("Unsupported audio format."));
      return;
    }

    const recognizer = new speechsdk.SpeechRecognizer(speechConfig, audioConfig);

    recognizer.recognizeOnceAsync(
      (result) => {
        try {
          if (result.reason !== speechsdk.ResultReason.RecognizedSpeech) {
            reject(new Error("No speech could be recognized from the audio."));
            return;
          }

          let detailed = {};
          try {
            detailed = JSON.parse(result.json || "{}");
          } catch (_) {
            detailed = {};
          }

          const best = detailed?.NBest?.[0] || {};
          const words = Array.isArray(best.Words)
            ? best.Words.map((w) => ({
                word: w.Word,
                offset: typeof w.Offset === "number" ? w.Offset / 10000000 : null,
                duration: typeof w.Duration === "number" ? w.Duration / 10000000 : null,
                confidence: typeof w.Confidence === "number" ? w.Confidence : null,
              }))
            : [];

          resolve({
            transcript: result.text || "",
            language: detailed?.PrimaryLanguage?.Language || "en-US",
            duration_seconds:
              typeof result.duration === "number" ? result.duration / 10000000 : null,
            confidence: typeof best.Confidence === "number" ? best.Confidence : null,
            words,
          });
        } catch (err) {
          reject(err);
        } finally {
          recognizer.close();
        }
      },
      (err) => {
        recognizer.close();
        reject(err);
      }
    );
  });
}

function getLanguageClient() {
  const endpoint = process.env.AZURE_LANGUAGE_ENDPOINT;
  const key = process.env.AZURE_LANGUAGE_KEY;

  if (!endpoint || !key) {
    throw new Error("Missing AZURE_LANGUAGE_ENDPOINT or AZURE_LANGUAGE_KEY in environment.");
  }

  return new TextAnalyticsClient(endpoint, new AzureKeyCredential(key));
}

async function analyzeText(text) {
  const client = getLanguageClient();

  const [keyPhraseResult] = await client.extractKeyPhrases([text]);
  const [entityResult] = await client.recognizeEntities([text]);
  const [sentimentResult] = await client.analyzeSentiment([text]);
  const [linkedEntityResult] = await client.recognizeLinkedEntities([text]);

  return {
    key_phrases: keyPhraseResult.keyPhrases || [],
    entities: (entityResult.entities || []).map((e) => ({
      text: e.text,
      category: e.category,
      subCategory: e.subCategory || null,
      confidenceScore: e.confidenceScore,
      offset: e.offset,
      length: e.length,
    })),
    sentiment: {
      label: sentimentResult.sentiment,
      confidenceScores: sentimentResult.confidenceScores,
    },
    linked_entities: (linkedEntityResult.entities || []).map((e) => ({
      name: e.name,
      url: e.url,
      dataSource: e.dataSource,
      language: e.language,
      matches: e.matches,
    })),
  };
}

function buildSummary(analysis) {
  const keyPhrases = analysis.key_phrases || [];
  const sentimentLabel = analysis.sentiment?.label || "neutral";
  const entities = analysis.entities || [];

  const entityTypeCounts = {};
  for (const entity of entities) {
    const type = entity.category || "Unknown";
    entityTypeCounts[type] = (entityTypeCounts[type] || 0) + 1;
  }

  const keyPhrasePart =
    keyPhrases.length > 0
      ? `Your memo mentions ${keyPhrases.length} key topics: ${keyPhrases.slice(0, 5).join(", ")}.`
      : `I did not detect any major key topics in the memo.`;

  const sentimentPart = `The overall tone is ${sentimentLabel}.`;

  const entitySummary =
    Object.keys(entityTypeCounts).length > 0
      ? Object.entries(entityTypeCounts)
          .map(([type, count]) => `${count} ${type}`)
          .join(", ")
      : "no named entities";

  const entityPart = `I detected ${entitySummary}.`;

  return `${keyPhrasePart} ${sentimentPart} ${entityPart}`;
}

function synthesizeSpeechToBase64(text) {
  return new Promise((resolve, reject) => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;

    if (!speechKey || !speechRegion) {
      reject(new Error("Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION in environment."));
      return;
    }

    const speechConfig = speechsdk.SpeechConfig.fromSubscription(
      speechKey,
      speechRegion
    );

    speechConfig.speechSynthesisVoiceName = "en-US-JennyNeural";
    speechConfig.speechSynthesisOutputFormat =
      speechsdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

    const synthesizer = new speechsdk.SpeechSynthesizer(speechConfig);

    synthesizer.speakTextAsync(
      text,
      (result) => {
        try {
          if (result.reason !== speechsdk.ResultReason.SynthesizingAudioCompleted) {
            reject(new Error("Text-to-speech synthesis failed."));
            return;
          }

          const audioBuffer = Buffer.from(result.audioData);
          resolve({
            audioBase64: audioBuffer.toString("base64"),
            charCount: text.length,
          });
        } catch (err) {
          reject(err);
        } finally {
          synthesizer.close();
        }
      },
      (err) => {
        synthesizer.close();
        reject(err);
      }
    );
  });
}

/* -------------------------
   Routes
-------------------------- */

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  let uploadedPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded." });
    }

    uploadedPath = req.file.path;
    const result = await transcribeWavFile(uploadedPath);
    await safeDelete(uploadedPath);

    return res.json(result);
  } catch (err) {
    await safeDelete(uploadedPath);

    const msg = err?.message || "Unknown error";
    if (msg.toLowerCase().includes("unsupported") || msg.toLowerCase().includes("format")) {
      return res.status(415).json({
        error: "Unsupported Media Type. Only WAV files are supported in this version.",
        details: msg,
      });
    }

    return res.status(500).json({
      error: "Transcription failed.",
      details: msg,
    });
  }
});

app.post("/analyze", async (req, res) => {
  try {
    const text = req.body?.text;
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        error: 'Request body must include a non-empty "text" field.',
      });
    }

    const analysis = await analyzeText(text.trim());
    return res.json(analysis);
  } catch (err) {
    return res.status(500).json({
      error: "Text analysis failed.",
      details: err.message,
    });
  }
});

app.post("/process", upload.single("audio"), async (req, res) => {
  let uploadedPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded." });
    }

    uploadedPath = req.file.path;
    const audioFormat = path.extname(req.file.originalname).replace(".", "").toLowerCase() || "wav";

    await tracer.startActiveSpan("pipeline.process", async (rootSpan) => {
      rootSpan.setAttribute("audio.format", audioFormat);

      const sttWrapped = await tracer.startActiveSpan(
        "stage.speech_to_text",
        async (sttSpan) => {
          const t0 = performance.now();
          const result = await transcribeWavFile(uploadedPath);
          const sttMs = performance.now() - t0;

          sttSpan.setAttribute("stt.confidence", Number(result.confidence ?? 0));
          sttSpan.setAttribute(
            "stt.word_count",
            Array.isArray(result.words)
              ? result.words.length
              : (result.transcript || "").trim().split(/\s+/).filter(Boolean).length
          );
          sttSpan.setAttribute("duration_ms", sttMs);
          sttSpan.end();

          return { result, sttMs };
        }
      );

      const langWrapped = await tracer.startActiveSpan(
        "stage.language_analysis",
        async (langSpan) => {
          const t0 = performance.now();
          const result = await analyzeText(sttWrapped.result.transcript);
          const langMs = performance.now() - t0;

          langSpan.setAttribute("entity_count", result.entities.length);
          langSpan.setAttribute("sentiment", result.sentiment.label);
          langSpan.setAttribute("duration_ms", langMs);
          langSpan.end();

          return { result, langMs };
        }
      );

      const ttsWrapped = await tracer.startActiveSpan(
        "stage.text_to_speech",
        async (ttsSpan) => {
          const t0 = performance.now();
          const summaryText = buildSummary(langWrapped.result);
          const result = await synthesizeSpeechToBase64(summaryText);
          const ttsMs = performance.now() - t0;

          ttsSpan.setAttribute("char_count", summaryText.length);
          ttsSpan.setAttribute("duration_ms", ttsMs);
          ttsSpan.end();

          return { result, ttsMs, summaryText };
        }
      );

      stageSttHist.record(sttWrapped.sttMs, {
        audio_format: audioFormat,
        language: sttWrapped.result.language,
      });
      stageLanguageHist.record(langWrapped.langMs, {
        audio_format: audioFormat,
        language: sttWrapped.result.language,
      });
      stageTtsHist.record(ttsWrapped.ttsMs, {
        audio_format: audioFormat,
        language: sttWrapped.result.language,
      });

      updateLatestMetrics(
        sttWrapped.result,
        langWrapped.result,
        ttsWrapped.summaryText
      );

      logPipelineCall(
        sttWrapped.result,
        langWrapped.result,
        {
          sttMs: sttWrapped.sttMs,
          languageMs: langWrapped.langMs,
          ttsMs: ttsWrapped.ttsMs,
        },
        ttsWrapped.summaryText
      );

      emitPipelineEvent(
        sttWrapped.result,
        langWrapped.result,
        audioFormat,
        true
      );

      rootSpan.end();

      await safeDelete(uploadedPath);

      return res.json({
        ...sttWrapped.result,
        ...langWrapped.result,
        summary_text: ttsWrapped.summaryText,
        summary_audio_base64: ttsWrapped.result.audioBase64,
      });
    });
  } catch (err) {
    await safeDelete(uploadedPath);

    emitPipelineEvent(
      null,
      null,
      req?.file?.originalname || "unknown",
      false,
      "process",
      err.message
    );

    const msg = err?.message || "Unknown error";
    if (msg.toLowerCase().includes("unsupported") || msg.toLowerCase().includes("format")) {
      return res.status(415).json({
        error: "Unsupported Media Type. Only WAV files are supported in this version.",
        details: msg,
      });
    }

    return res.status(500).json({
      error: "Pipeline processing failed.",
      details: msg,
    });
  }
});

app.get("/telemetry-summary", (req, res) => {
  if (sessionLog.length === 0) {
    return res.json({ message: "No calls yet" });
  }

  const confs = sessionLog.map((e) => e.confidence);
  const avg = confs.reduce((a, b) => a + b, 0) / confs.length;
  const sortedStt = sessionLog.map((e) => e.sttMs).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(sortedStt.length * 0.95) - 1);

  res.json({
    total_calls: sessionLog.length,
    avg_confidence: Math.round(avg * 1000) / 1000,
    min_confidence: Math.min(...confs),
    p95_stt_ms: sortedStt[p95Index],
    sentiment_breakdown: ["positive", "neutral", "negative"].reduce(
      (acc, s) => ({
        ...acc,
        [s]: sessionLog.filter((e) => e.sentiment === s).length,
      }),
      {}
    ),
    calls: sessionLog.slice(-10),
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      error: "Uploaded file exceeds the 25 MB limit.",
    });
  }

  return res.status(500).json({
    error: "Server error.",
    details: err.message,
  });
});

app.listen(PORT, () => {
  console.log(`Azure server running on port ${PORT}`);
});
