# ARC-Deals – Marktscanner für ARC Raiders

Konsolen-Tool in **Node.js (ohne externe Abhängigkeiten)**, das den Spielermarkt von ARC Raiders auf [metaforge.app](https://metaforge.app) rund um die Uhr beobachtet und unterbewertete Angebote meldet.

## Was es macht

- **Datenabruf über eine öffentliche REST-API**: rund 55 Seiten Verkaufs- und Kaufangebote, mit Wiederholungslogik bei Netzwerkfehlern.
- **Marktpreis per Median**, nur aus frischen Angeboten und Verkäufen der letzten 48 Stunden, weil neue Gegenstände schnell im Preis fallen.
- **Filter gegen Fehlsignale**: Mindestumsatz pro Tag, Bewertungen und Aktivität des Verkäufers, Ausreißer bei Kaufgesuchen.
- **Auswertung von Freitext mit einem Sprachmodell (LLM)**: Verkäufer schreiben den echten Preis oft nur in die Beschreibung („1:75“, „5:1“).
  - Das Modell liefert nur strukturierte Daten (Variante und Menge). Den Preis rechnet der Code selbst aus, weil die Modelle sich in der Arithmetik verrechneten.
  - Schlüssel-Pool über drei OpenAI-kompatible Anbieter (Groq, Gemini, OpenRouter). Der Anbieter wird am Schlüssel-Präfix erkannt, das Modell automatisch über `/models` gewählt, Rate-Limits werden pro Anbieter eingehalten.
- **Telegram-Benachrichtigungen** mit Warteschlange, Ruhezeiten (02:00–12:00 Uhr Berlin, ohne Ton) und Duplikatschutz über eine persistente ID-Liste.

## Start

```bash
node deals.js
```

Optional:

- `ai-key.example.txt` → `ai-key.txt` kopieren und einen kostenlosen API-Schlüssel eintragen.
- `telegram.example.txt` → `telegram.txt` kopieren und Bot-Token und Kanal eintragen.
- Auf einem Server gehen auch die Umgebungsvariablen `AI_KEYS`, `TG_TOKEN` und `TG_CHAT`.

Alle Einstellungen stehen im Objekt `CONFIG` am Anfang von `deals.js`. Die Kommentare im Code sind auf Russisch.

## Technik

Node.js ≥ 18 (natives `fetch`), Dateisystem-Persistenz, asynchrone Worker-Pools, ANSI-Konsolenausgabe.

Entwickelt mit KI-Unterstützung (Claude Code). Von mir stammen Anforderungen, Fachlogik, Tests mit echten Marktdaten und der Betrieb.
