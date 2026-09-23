// Lädt .env.local bzw. .env für CLI-Skripte (Next.js macht das für die App selbst).
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Datei fehlt – ok
  }
}
