# Deutsches Recht MCP

Ein Docker-kompatibler MCP-Server für die Textmaterialien aus
[`Klotzkette/claude-fuer-deutsches-recht`](https://github.com/Klotzkette/claude-fuer-deutsches-recht).
Claude und ChatGPT laden passende Skills, Referenzen und Vorlagen gezielt über sechs Tools;
die Installation der gesamten Plugin-Sammlung entfällt.

> **KEINE RECHTSBERATUNG. Diese Software ersetzt keine Rechtsanwältin und keinen Rechtsanwalt.**
> Inhalte und KI-Ausgaben können falsch, unvollständig oder veraltet sein.
> Der Server übernimmt keine individuelle Fallprüfung, Vertretung oder Fristüberwachung.
> Rechtlich erhebliche Entscheidungen und Dokumente müssen unabhängig und fachkundig geprüft werden.
> Einzelheiten: [Disclaimer](DISCLAIMER.md).

[Coolify](#installation-in-coolify) · [Docker](#lokal-mit-docker) · [Claude Web](#claude-web) · [Claude CLI](#claude-code-cli) · [ChatGPT Web](#chatgpt-web) · [OpenAI CLI](#chatgptopenai-cli-codex) · [Deutsche Nutzungsanleitung](docs/NUTZUNG.md)

## Installation in Coolify

Verwenden Sie **das Serverprojekt mit dieser README, dem Dockerfile und `compose.coolify.yaml`** als Git-Quelle.
Das Inhaltsrepository allein enthält diesen Server nicht; die Inhalte werden separat synchronisiert.

1. Neues Git-basiertes Projekt anlegen; Build Pack **Docker Compose** wählen.
2. Base Directory `/` und Docker Compose Location `/compose.coolify.yaml` einstellen.
3. Konfiguration laden. Coolify erzeugt `SERVICE_PASSWORD_64_LEGALMCP`; dieser 64-stellige Wert wird als `MCP_AUTH_TOKEN` eingesetzt und bleibt bei Redeployments erhalten.
4. Beim Dienst `legal-mcp` eine HTTPS-Domain eintragen, beispielsweise `https://recht.example.com:3000`. `:3000` bezeichnet den internen Proxy-Zielport; öffentlich verwenden Sie `https://recht.example.com`.
5. Prüfen, dass `SERVICE_URL_LEGAL_MCP_3000` die verwendete Domain enthält. Daraus erhält der Server `PUBLIC_URL` und erlaubt deren Host automatisch. Bei abweichender Domain diese zusätzlich in `ALLOWED_HOSTS` eintragen.
6. Deploy starten. Nach Download und Indexaufbau muss `https://recht.example.com/readyz` mit 200 antworten.

Generierte Variablen und Proxy-Routing folgen der [offiziellen Coolify-Dokumentation](https://coolify.io/docs/applications/builds/docker-compose).
Bei älteren Versionen ohne Unterstützung dieser Variablen aktualisieren oder URL und Token ausdrücklich konfigurieren.

**API-Schlüssel ablesen:** In Coolify `SERVICE_PASSWORD_64_LEGALMCP` anzeigen. Bei der OAuth-Anmeldung
auf der eigenen Serverdomain eingeben; dieser Wert ist kein OAuth-Client-Secret.
Der Server protokolliert den Wert nicht. Coolifys Dashboard-Login ist keine MCP-Authentifizierung.

OAuth ist in der Coolify-Compose-Datei aktiviert. `PUBLIC_URL` muss die öffentlich erreichbare
HTTPS-Adresse **ohne Pfad, Query oder internen Port** enthalten, zum Beispiel `https://recht.example.com`.
Nach einem Update redeployen; ein vorgeschalteter OAuth-Gateway ist nicht erforderlich.

Die Compose-Datei veröffentlicht keinen Host-Port. Coolify übernimmt HTTPS und routet intern auf Port 3000.
`legal-index` und `legal-source` sind persistente Volumes. Pro Volume-Paar darf nur ein Server schreiben;
keine parallelen Instanzen oder überlappenden Deployments mit gemeinsamen Volumes betreiben.
Mehrere GB freien Speicher und vorzugsweise mindestens 2 GB RAM für Erstaufbau und Ersatzindex vorsehen.
Die Inhaltsprüfung erfolgt standardmäßig alle 15 Minuten; `SYNC_INTERVAL_SECONDS` passt den Abstand an.

## Lokal mit Docker

Voraussetzung: Docker mit Compose.

```sh
docker compose up -d --build
docker compose logs -f
```

Eine `.env` ist optional. Ohne festen Token erzeugt der Server automatisch einen zufälligen Token
mit 256 Bit Entropie in `/app/data/auth-token`, sofern öffentlicher Zugriff nicht ausdrücklich aktiviert ist.
Dieser bleibt im Volume erhalten. Ein explizites `MCP_AUTH_TOKEN` hat Vorrang.
Die bereits vorbereitete lokale Installation verwendet ihren bisherigen Token aus `.env` weiter.

Token bei Bedarf ausdrücklich anzeigen:

```sh
docker compose exec -T legal-mcp node scripts/show-token.mjs
```

Dieser Befehl gibt ein Geheimnis aus: nur im eigenen Terminal ausführen, nicht in öffentlichen Logs.
Coolify zeigt seinen eigenen generierten Token in der Oberfläche.

- MCP: `http://localhost:3000/mcp`
- Browserhinweise: `http://localhost:3000/`
- Bereitschaft: `http://localhost:3000/readyz`
- Deutsche Anleitung: `http://localhost:3000/guide`

`/mcp` ist ein Protokollendpunkt. Ein normaler Browseraufruf sendet keinen Bearer-Header und kann `Unauthorized` anzeigen.
Nutzen Sie einen MCP-Client oder öffnen Sie `/`. Der Standard-Port ist nur auf `127.0.0.1` veröffentlicht;
Cloud-Clients benötigen eine erreichbare HTTPS-Domain.

Optional `.env.example` nach `.env` kopieren und anpassen; vorhandene `.env` erhalten.
PowerShell: `Copy-Item .env.example .env`. Änderungen mit `docker compose up -d` anwenden.
`docker compose stop` erhält die Volumes.

## Clients einrichten

| Client | Verbindung | Authentifizierung |
| --- | --- | --- |
| Claude Web | Erreichbare HTTPS-URL `/mcp` | Integriertes OAuth mit API-Schlüssel-Freigabe |
| Claude Code CLI | HTTP/HTTPS oder stdio | OAuth oder Bearer-Header; stdio ohne HTTP-Token |
| ChatGPT Web | Remote-MCP-App im freigeschalteten Entwickler-Modus | Integriertes OAuth mit dynamischer Clientregistrierung |
| OpenAI Codex CLI | HTTP/HTTPS oder stdio | OAuth oder Bearer-Token aus Umgebungsvariable |

Ersetzen Sie `https://recht.example.com/mcp` durch Ihre URL.
CLI-Clients können lokal `http://localhost:3000/mcp` verwenden.
Web-Menüs und Verfügbarkeit hängen vom Konto und den Administratoreinstellungen ab.

### Claude Web

1. **Customize/Anpassen → Connectors/Verbindungen → Add custom connector** öffnen.
2. Namen `Deutsches Recht` und die vollständige MCP-URL eintragen.
3. **Sign in now/Jetzt anmelden** und als OAuth-Client **Register automatically/Automatisch registrieren** wählen.
4. Auf der Freigabeseite die eigene Serverdomain prüfen, den API-Schlüssel eingeben und **Lesezugriff erlauben** klicken.
5. Speichern, verbinden und für die Unterhaltung aktivieren; feste Anfrage-Header sind hierfür nicht nötig.
6. Claude bitten: „Nutze Deutsches Recht und rufe `server_status` auf.“

Einrichtung: [Anthropics Connector-Anleitung](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
Dieser Server unterstützt DCR, keine veröffentlichten Client-Identitätsdokumente (CIMD).
Alternativ **No sign in** und den festen Header `Authorization: Bearer <API-Schlüssel>` verwenden,
wenn Ihre Oberfläche Anfrage-Header anbietet. Schlüssel nicht in Chatnachrichten senden.

### Claude Code CLI

Claude Code muss installiert und angemeldet sein. Für OAuth ohne festen Header hinzufügen:

```sh
claude mcp add --transport http --scope user deutsches-recht https://recht.example.com/mcp
claude
```

In Claude Code `/mcp` öffnen, `deutsches-recht` wählen und die Anmeldung starten.
Auf der eigenen Freigabeseite den API-Schlüssel eingeben und den Lesezugriff bestätigen.
Bei einer bestehenden Verbindung mit festem Header diesen Eintrag vor der OAuth-Einrichtung entfernen.

**Alternative mit statischem Bearer-Token:** Token ohne sichtbare Eingabe einlesen.

Bash:

```sh
read -rsp 'MCP-Token: ' LEGAL_MCP_TOKEN
echo
export LEGAL_MCP_TOKEN
claude mcp add --transport http --scope user deutsches-recht https://recht.example.com/mcp --header "Authorization: Bearer $LEGAL_MCP_TOKEN"
claude mcp list
claude
```

PowerShell:

```powershell
$mcpSecret = Read-Host 'MCP-Token' -AsSecureString
$env:LEGAL_MCP_TOKEN = [System.Net.NetworkCredential]::new('', $mcpSecret).Password
claude mcp add --transport http --scope user deutsches-recht https://recht.example.com/mcp --header "Authorization: Bearer $env:LEGAL_MCP_TOKEN"
claude mcp list
claude
```

In Claude Code `/mcp` öffnen und den Status prüfen.
`--header` speichert den expandierten Token in der persönlichen Client-Konfiguration;
deshalb `--scope user` verwenden und diese Konfiguration nicht veröffentlichen.
Bei Tokenwechsel die persönliche Verbindung aktualisieren.
HTTP, Header und Scopes: [Claude-Code-Dokumentation](https://code.claude.com/docs/en/mcp).

### ChatGPT Web

1. Den verfügbaren **Developer mode/Entwickler-Modus** aktivieren und eine Remote-MCP-App mit der HTTPS-URL `/mcp` anlegen.
2. **OAuth** als Authentifizierung und **DCR/dynamische Clientregistrierung** wählen. Keine statischen Clientdaten vorgeben.
3. Verbinden. Auf der Freigabeseite der eigenen Serverdomain den API-Schlüssel eingeben und **Lesezugriff erlauben** bestätigen.
4. App für die Unterhaltung aktivieren und `server_status` testen.

Discovery liefert die URLs für Autorisierung, Tokens und Clientregistrierung automatisch.
Der API-Schlüssel gehört in die Server-Anmeldeseite, nicht in Felder für OAuth-Client-ID oder Client-Secret.
Konten- und Menüabhängigkeiten: [OpenAI-Anleitung](https://developers.openai.com/api/docs/guides/developer-mode).
Der Server benötigt keinen OpenAI-API-Schlüssel.

Optionaler öffentlicher Betrieb: `ALLOW_PUBLIC_READ=true` und redeployen. Dies deaktiviert OAuth und
Bearer-Prüfung ausdrücklich, auch bei gespeichertem Coolify-Token. Jeder erreichende Client kann lesen;
in ChatGPT dann **No Authentication** wählen. Zum Schutz `ALLOW_PUBLIC_READ=false` zurücksetzen.

### ChatGPT/OpenAI CLI: Codex

Mit „ChatGPT CLI“ ist hier die offizielle **OpenAI Codex CLI** gemeint: ein eigener Client,
keine ChatGPT-Websitzung. Die MCP-Konfiguration ist von ChatGPT Web getrennt.
Codex muss installiert und angemeldet sein. OAuth einrichten:

```sh
codex mcp add deutsches-recht --url https://recht.example.com/mcp
codex mcp login deutsches-recht
codex mcp list
```

Auf der Server-Anmeldeseite den API-Schlüssel eingeben. Falls die aktuelle CLI eine Registrierungswahl
anbietet, DCR verwenden (`codex mcp login deutsches-recht --oauth-client-registration dcr`).
Bei vorhandener Bearer-Konfiguration deren Token-Variable für diesen Eintrag entfernen.

**Alternative ohne OAuth:** `LEGAL_MCP_TOKEN` wie im Bash- oder PowerShell-Beispiel oben einlesen, dann:

```sh
codex mcp add deutsches-recht --url https://recht.example.com/mcp --bearer-token-env-var LEGAL_MCP_TOKEN
codex mcp list
codex
```

Die Umgebungsvariable muss auch bei späteren Codex-Starts vorhanden sein.
Alternativ in der persönlichen `~/.codex/config.toml` ergänzen, vorhandene Einträge erhalten:

```toml
[mcp_servers.deutsches-recht]
url = "https://recht.example.com/mcp"
bearer_token_env_var = "LEGAL_MCP_TOKEN"
```

Gespeichert wird der **Variablenname**, nicht der Tokenwert. `codex mcp login` ist nur für OAuth erforderlich.
HTTP und Token-Variablen: [offizielle Codex-MCP-Dokumentation](https://developers.openai.com/codex/mcp).

### Optional: lokales stdio

Für Claude Desktop oder andere lokale Clients zuerst `npm ci` und `npm run build` ausführen.
Absolute Pfade anpassen:

```json
{
  "mcpServers": {
    "deutsches-recht": {
      "command": "node",
      "args": ["/absoluter/pfad/zum/server/dist/main.js"],
      "env": {
        "TRANSPORT": "stdio",
        "DATA_DIR": "/absoluter/pfad/zum/server/data",
        "REPO_DIR": "/absoluter/pfad/zum/server/content/repository"
      }
    }
  }
}
```

Logs laufen auf stderr, MCP auf stdout. ChatGPT Web startet keinen lokalen stdio-Prozess.

## Den MCP auf Deutsch nutzen

Die vollständige [deutsche Nutzungsanleitung](docs/NUTZUNG.md) erklärt Suche, Auswahl, Folgeseiten,
Referenzen und Quellenprüfung. Sie ist auch unter `/guide` erreichbar.

Einstiegsprompt:

> Nutze den MCP „deutsches-recht“. Prüfe zuerst `server_status`. Suche in „datenschutzrecht“ nach Skills für „AVV DSGVO“. Zeige höchstens fünf Treffer. Lade den passendsten Skill vollständig einschließlich aller Folgeseiten und nötigen Referenzen. Erstelle zunächst eine Fragenliste zur fachkundigen Prüfung. Kennzeichne offene Annahmen und ungeprüfte Rechtsquellen. Behaupte keine Rechtsberatung oder anwaltliche Freigabe.

| Tool | Aufgabe |
| --- | --- |
| `search` | Volltextsuche; standardmäßig 8, höchstens 20 Treffer; Filter `collection`, `kind` |
| `fetch` | Erste 10.000 Zeichen über die genaue Dokument-ID |
| `get_content` | Folgeseite mit `offset`; maximal 20.000 Zeichen |
| `list_collections` | Rechtsgebiete/Sammlungen mit Pagination |
| `list_documents` | IDs und Kurzbeschreibungen einer Sammlung |
| `server_status` | Commit, Umfang, Aktualisierung und Disclaimer |

`nextOffset` unverändert übernehmen und bis null weiterlesen. Suchbegriffe werden mit UND verknüpft;
ab drei Zeichen gilt Präfixsuche. Bei fehlenden Treffern weniger Fachbegriffe verwenden.
Quelllinks sind an einen Git-Commit gebunden.
Ressourcen: `legal://status`, `legal://disclaimer`, `legal://document/{kodierte-id}?offset=0`.

## Konfiguration und Betrieb

| Variable | Standard / Bedeutung |
| --- | --- |
| `MCP_AUTH_TOKEN` | Optionaler fester Token; Vorrang vor automatischer Token-Datei |
| `AUTO_AUTH_TOKEN` | `true`; Token ohne Vorgabe automatisch persistent erzeugen |
| `ALLOW_PUBLIC_READ` | `false`; `true` deaktiviert Authentifizierung ausdrücklich |
| `PUBLIC_URL` | OAuth-Issuer und erlaubter Host; öffentliches HTTPS-Origin ohne Pfad; Docker lokal `http://localhost:3000` |
| `OAUTH_ENABLED` | Compose `true`; nativ automatisch bei vorhandener `PUBLIC_URL`; `false` deaktiviert nur OAuth |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]`; zusätzliche Hostnamen ohne Port |
| `ALLOWED_ORIGINS` | Leer; Origin-Header erfordern eine genaue Freigabe |
| `SYNC_INTERVAL_SECONDS` | `900`; mindestens 30 |
| `REPO_URL`, `REPO_BRANCH` | Inhaltsrepository über HTTPS; leerer Branch folgt Remote-Standard |
| `SOURCE_BASE_URL` | GitHub-Basis für Quelllinks; bei anderer Quelle anpassen |
| `SPARSE_CHECKOUT` | `true`; flacher partieller Clone mit Textdateien |
| `GIT_TIMEOUT_SECONDS` | `300` pro Git-Aufruf |
| `MAX_FILE_BYTES` | `2000000`; größere Dateien werden übersprungen |
| `RATE_LIMIT_PER_MINUTE` | `120` pro direkter Peer-IP; Forwarded-Header werden nicht vertraut |
| `LOG_LEVEL` | `info`; `debug` ergänzt Tool-Laufzeiten |
| `TRANSPORT`, `HOST`, `PORT` | Nativ `http`, `127.0.0.1`, `3000`; Container intern `0.0.0.0:3000` |
| `DATA_DIR`, `REPO_DIR` | Nativ `data/`, `content/repository/`; Docker persistente Pfade unter `/app` |
| `SYNC_ENABLED` | `false` für nativen Offline-Betrieb mit vorhandenem Checkout |

`REPO_DIR` ist ein verwalteter Mirror; Updates setzen ihn auf den abgerufenen Commit zurück.
Niemals auf einen Arbeitscheckout zeigen lassen. Unveränderte Stände überspringen den Indexaufbau.
Updatefehler erhalten den letzten nutzbaren Index. Hinter Coolify teilen Clients dessen Peer-IP-Limit;
bei gemeinsamer Nutzung passend dimensionieren, ohne ungeprüfte Forwarded-Header freizugeben.

Tokenwechsel: festen Token in Coolify/der Umgebung ändern, redeployen, Clients aktualisieren.
OAuth-Freigaben werden dabei widerrufen; OAuth-Clients erneut anmelden.
Für Datei-Tokens einen festen neuen Token vorgeben, statt das Datenvolume zu löschen.
Volume-Löschung entfernt auch Index, Mirror und gegebenenfalls den generierten Token.

### Bestehende Installation auf die kanonische Inhaltsquelle umstellen

In Coolify oder einer vorhandenen `.env` auch gespeicherte Überschreibungen aktualisieren:
`REPO_URL=https://github.com/Klotzkette/claude-fuer-deutsches-recht.git` und
`SOURCE_BASE_URL=https://github.com/Klotzkette/claude-fuer-deutsches-recht`.
Den vorhandenen Inhaltsmirror vor dem Redeployment ebenfalls umstellen; keine Volumes oder Tokens löschen:

```sh
docker compose exec -T legal-mcp git -C /app/content/repository remote set-url origin https://github.com/Klotzkette/claude-fuer-deutsches-recht.git
docker compose up -d --build
```

Für Coolify den ersten Befehl als `git -C /app/content/repository remote set-url origin ...`
im Container-Terminal ausführen und anschließend redeployen. Bei nativer Installation den
verwalteten Mirror unter `content/repository` entsprechend umstellen. Die Git-Remote des
Serverprojekts `KlotzketteMCP` bleibt davon unabhängig.

- `/healthz`: Prozess läuft; ohne Token.
- `/readyz`: Index verfügbar; ohne Token.
- `/metrics`: Prometheus; gleiche Authentifizierung wie `/mcp`.
- `/`, `/guide`, `/disclaimer`: öffentliche Hinweise ohne Geheimnisse.
- JSON-Logs: Status, Laufzeiten und Updates; keine Suchtexte oder Authorization-Header. Rotation: drei Dateien zu je 10 MB.

### OAuth mit API-Schlüssel

Der integrierte Authorization Server verwendet Authorization Code mit **PKCE S256**, dynamische
Clientregistrierung und den Lese-Scope `legal:read`. Autorisierung ist an die konfigurierte Ressource
`PUBLIC_URL/mcp` gebunden. Browserfreigaben benötigen einen CSRF-geschützten POST mit dem API-Schlüssel;
dieser wird nicht an den OAuth-Client weitergereicht. Das ist ein gemeinsamer Betreiber-Schlüssel,
keine Benutzerverwaltung mit individuellen Berechtigungen.

Zugriffstokens gelten eine Stunde, Freigaben höchstens 30 Tage. Refresh-Tokens werden bei jeder
Verwendung ersetzt; erkannte Wiederverwendung widerruft die gesamte Freigabe. `/revoke` erlaubt
Client-authentifizierten Widerruf. Ein API-Schlüssel- oder Issuer-Wechsel widerruft alle Freigaben.
OAuth-Endpunkte haben eigene Limits; hinter Coolify teilen Anfragen dessen Peer-IP.

`data/oauth.sqlite` speichert Clientdaten und Freigaben persistent. Zugriffs- und Refresh-Tokens
liegen nur als SHA-256-Hashes vor; registrierte Client-Secrets sind für die SDK-Authentifizierung in
dieser Datenbank gespeichert. Volume und Backups vertraulich behandeln. Unter Linux hat die Datei
Modus `0600`. Bei geändertem lokalem Host-Port auch `PUBLIC_URL` mit dessen tatsächlichem Port setzen.

Discovery: `/.well-known/oauth-authorization-server` und `/.well-known/oauth-protected-resource/mcp`.
Protokollgrundlage: [MCP-Autorisierung](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
OAuth läuft vollständig im Server; es braucht keinen zusätzlichen Identity Provider.

SQLite FTS5, gewichtetes BM25, Präfixindexe, vorbereitete Abfragen und begrenzter Cache halten Abfragen klein.
Worker bauen Ersatzindexe im Hintergrund. [Gemessene Performance](docs/performance.md).
SQLite-Abfragen laufen im Hauptprozess synchron; breite uncached Suchen beanspruchen den Event-Loop.

Indexiert werden verfolgte UTF-8-Textdateien, Lizenzen und Notices; Symlinks, Binärdateien und übergroße Dateien werden übersprungen.
PDF/DOCX/ZIP werden nicht extrahiert, Plugin-Hooks und Skripte nicht ausgeführt.
Upstream-Herkunfts- und Lizenzhinweise bleiben erhalten (`Apache-2.0 OR MIT` laut NOTICE).

## Entwicklung und Prüfung

Node.js 24+ und Git erforderlich:

```sh
npm ci
npm run build
npm start
npm run dev
npm run check
npm test
npm run benchmark
```

`start`/`dev` lesen eine vorhandene `.env`; direkter `node dist/main.js` nur die Prozessumgebung.
Tests prüfen Retrieval, HTTP/stdio, Updates sowie OAuth-Discovery, echte SDK-Anmeldung, PKCE,
CSRF, Tokenrotation, Widerruf, Persistenz und Zugriffsschutz mit lokalen Fixtures.
`benchmark` benötigt einen aufgebauten nativen Index. Container prüfen und messen:

```sh
docker compose exec -T legal-mcp node scripts/smoke.mjs
docker compose exec -T legal-mcp npm run benchmark
```

Code: `src/`; Tests: `tests/`; Anleitungen: `docs/`.
