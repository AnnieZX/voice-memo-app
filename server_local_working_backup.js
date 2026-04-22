require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const speechsdk = require("microsoft-cognitiveservices-speech-sdk");
const ffmpegPath = require("ffmpeg-static");
const { TextAnalyticsClient } = require("@azure/ai-text-analytics");
const { AzureKeyCredential } = require("@azure/core-auth");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TEMP_DIR = path.join(__dirname, "temp_audio");
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".wav", ".mp3"]);

const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(
        new Error("Unsupported Media Type. Only WAV and MP3 files are supported.")
      );
    }
    cb(null, true);
  },
});

async function safeDelete(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (_) {}
}

function convertToPcmWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg is not available."));
      return;
    }

    const args = [
      "-y",
      "-i",
      inputPath,
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      outputPath,
    ];

    const proc = spawn(ffmpegPath, args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => reject(err));

    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || "Audio conversion failed."));
    });
  });
}

async function prepareAudioForSpeech(uploadedPath, originalName) {
  const ext = path.extname(originalName).toLowerCase();

  if (![".wav", ".mp3"].includes(ext)) {
    throw new Error("Unsupported Media Type. Only WAV and MP3 files are supported.");
  }

  const normalizedPath = path.join(
    TEMP_DIR,
    `${path.parse(path.basename(uploadedPath)).name}-normalized.wav`
  );

  await convertToPcmWav(uploadedPath, normalizedPath);
  return normalizedPath;
}

function transcribeWavFile(wavPath) {
  return new Promise((resolve, reject) => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;

    if (!speechKey || !speechRegion) {
      reject(new Error("Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION in .env"));
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
                offset:
                  typeof w.Offset === "number" ? w.Offset / 10000000 : null,
                duration:
                  typeof w.Duration === "number" ? w.Duration / 10000000 : null,
                confidence:
                  typeof w.Confidence === "number" ? w.Confidence : null,
              }))
            : [];

          const durationSeconds =
            typeof result.duration === "number"
              ? result.duration / 10000000
              : words.length > 0 &&
                words[words.length - 1].offset != null &&
                words[words.length - 1].duration != null
              ? words[words.length - 1].offset + words[words.length - 1].duration
              : null;

          resolve({
            transcript: result.text || "",
            language: detailed?.PrimaryLanguage?.Language || "en-US",
            duration_seconds: durationSeconds,
            confidence:
              typeof best.Confidence === "number" ? best.Confidence : null,
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
    throw new Error("Missing AZURE_LANGUAGE_ENDPOINT or AZURE_LANGUAGE_KEY in .env");
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
      ? `Your memo mentions ${keyPhrases.length} key topics: ${keyPhrases
          .slice(0, 5)
          .join(", ")}.`
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
      reject(new Error("Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION in .env"));
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
          resolve(audioBuffer.toString("base64"));
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

app.get("/", (req, res) => {
  res.json({ message: "Voice Memo Analyzer backend is running." });
});

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  let uploadedPath = null;
  let normalizedPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded." });
    }

    uploadedPath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      await safeDelete(uploadedPath);
      return res.status(415).json({
        error: "Unsupported Media Type. Only WAV and MP3 files are supported.",
      });
    }

    normalizedPath = await prepareAudioForSpeech(
      uploadedPath,
      req.file.originalname
    );

    const result = await transcribeWavFile(normalizedPath);

    await safeDelete(uploadedPath);
    await safeDelete(normalizedPath);

    return res.json(result);
  } catch (err) {
    await safeDelete(uploadedPath);
    await safeDelete(normalizedPath);

    const msg = err?.message || "Unknown error";

    if (
      msg.toLowerCase().includes("unsupported") ||
      msg.toLowerCase().includes("format")
    ) {
      return res.status(415).json({
        error: "Unsupported Media Type. Azure Speech could not process this audio format.",
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
  let normalizedPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded." });
    }

    uploadedPath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(ext)) {
      await safeDelete(uploadedPath);
      return res.status(415).json({
        error: "Unsupported Media Type. Only WAV and MP3 files are supported.",
      });
    }

    normalizedPath = await prepareAudioForSpeech(
      uploadedPath,
      req.file.originalname
    );

    const transcription = await transcribeWavFile(normalizedPath);
    const analysis = await analyzeText(transcription.transcript);
    const summary_text = buildSummary(analysis);
    const summary_audio_base64 = await synthesizeSpeechToBase64(summary_text);

    await safeDelete(uploadedPath);
    await safeDelete(normalizedPath);

    return res.json({
      ...transcription,
      ...analysis,
      summary_text,
      summary_audio_base64,
    });
  } catch (err) {
    await safeDelete(uploadedPath);
    await safeDelete(normalizedPath);

    const msg = err?.message || "Unknown error";

    if (
      msg.toLowerCase().includes("unsupported") ||
      msg.toLowerCase().includes("format")
    ) {
      return res.status(415).json({
        error: "Unsupported Media Type. Azure could not process this audio format.",
        details: msg,
      });
    }

    return res.status(500).json({
      error: "Pipeline processing failed.",
      details: msg,
    });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "Uploaded file exceeds the 25 MB limit.",
      });
    }
  }

  if (
    err?.message &&
    err.message.toLowerCase().includes("only wav and mp3 files are supported")
  ) {
    return res.status(415).json({
      error: err.message,
    });
  }

  return res.status(500).json({
    error: "Server error.",
    details: err.message,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
