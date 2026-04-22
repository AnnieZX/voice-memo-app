require("dotenv").config();

const { useAzureMonitor } = require("@azure/monitor-opentelemetry");

function initTelemetry() {
  const connectionString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

  if (!connectionString) {
    throw new Error("APPLICATIONINSIGHTS_CONNECTION_STRING not set");
  }

  useAzureMonitor({
    azureMonitorExporterOptions: { connectionString },
  });

  console.log("Application Insights initialized.");
}

module.exports = { initTelemetry };
