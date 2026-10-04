# Deutsches Recht MCP – deutsche Nutzungsanleitung

## 1. Keine Rechtsberatung und kein Ersatz für einen Anwalt

**Diese Software leistet keine Rechtsberatung. Sie ersetzt weder eine Rechtsanwältin oder einen Rechtsanwalt noch die individuelle Prüfung Ihres konkreten Falls.**

Sie stellt experimentelle Informations- und Arbeitsmaterialien bereit. Inhalte und daraus erzeugte KI-Antworten können falsch, unvollständig, missverständlich oder veraltet sein. Ein technisch erfolgreicher Abruf ist kein Nachweis rechtlicher Richtigkeit. Ein aktueller Git-Stand bedeutet nicht, dass Gesetze oder Rechtsprechung aktuell und richtig wiedergegeben werden.

Die Software übernimmt keine Fristüberwachung, Vertretung oder fallbezogene anwaltliche Prüfung. Lassen Sie rechtlich erhebliche Entscheidungen, Verträge, Schriftsätze und Fristen fachkundig prüfen. Für verbindliche Beratung zu Ihrem Einzelfall wenden Sie sich an eine zugelassene Rechtsanwältin oder einen zugelassenen Rechtsanwalt.

## 2. Was der MCP-Server bereitstellt

Der Server macht die Textinhalte der Sammlung `Klotzkette/claude-fuer-deutsches-recht` durchsuchbar. Sie installieren nicht sämtliche Skills in Ihrem KI-Client. Stattdessen lädt Claude oder ChatGPT nur die für die Aufgabe gefundenen Dokumente.

Verfügbar sind Skills, Referenzen, Arbeitsabläufe, Vorlagen und weitere Textdokumente. Der Server führt keine Plugin-Hooks, Agenten oder Skripte aus. PDF, DOCX, Bilder und ZIP-Dateien werden nicht in Text umgewandelt; vorhandene Downloadlinks bleiben in den Dokumenten erhalten.

## 3. Verbindung prüfen

Die Einrichtung für Coolify, Claude Web, Claude Code, ChatGPT Web und OpenAI Codex CLI steht in der README des Serverprojekts.

Wählen Sie OAuth mit automatischer Clientregistrierung (DCR). Bei der Anmeldung öffnet sich
die Freigabeseite auf der Domain Ihres MCP-Servers. Prüfen Sie die Adresse, geben Sie dort den
API-Schlüssel des Betreibers ein und bestätigen Sie **Lesezugriff erlauben**. In Coolify entspricht
dieser Schlüssel `SERVICE_PASSWORD_64_LEGALMCP`. Er gehört weder in Chatnachrichten noch in
Felder für OAuth-Client-Secrets. Nach einem Schlüsselwechsel müssen Sie sich erneut anmelden.

Rufen Sie im verbundenen Client auf:

> Nutze den MCP „deutsches-recht“. Rufe zuerst `server_status` auf und sage mir, ob der Index bereit ist, welcher Commit verwendet wird und ob das letzte Update erfolgreich war. Lade noch keine Fachinhalte.

`ready: true` bedeutet, dass ein Index verfügbar ist. `syncDegraded: true` bedeutet, dass ein Update fehlgeschlagen ist; der vorherige Index bleibt nutzbar. `builtAt`, `commit` und `lastSuccess` helfen, die technische Aktualität einzuschätzen.

Der Browseraufruf von `/mcp` kann `Unauthorized` oder `405` anzeigen: Das ist ein Protokollendpunkt. Öffnen Sie `/` für Verbindungshinweise, `/readyz` für die Bereitschaft oder `/guide` für diese Anleitung.

## 4. Rechtsgebiet und passenden Skill finden

Wenn das Rechtsgebiet noch unklar ist:

> Nutze `list_collections`, um die verfügbaren Rechtsgebiete zu zeigen. Blättere bei Bedarf weiter. Ich suche Arbeitsmaterialien für eine Prüfung eines Auftragsverarbeitungsvertrags.

Bei bekanntem Rechtsgebiet suchen Sie mit kurzen Fachbegriffen:

```json
{
  "query": "AVV DSGVO",
  "collection": "datenschutzrecht",
  "kind": "skill",
  "limit": 5
}
```

`search` verknüpft die relevanten Suchbegriffe mit UND. Zu lange Fragestellungen können deshalb keine Treffer liefern. Verwenden Sie dann weniger Begriffe, entfernen Sie den Filter oder durchsuchen Sie eine Sammlung mit `list_documents`. Die Suche arbeitet mit Wortpräfixen, nicht mit semantischen Embeddings.

Ein Beispielprompt:

> Nutze ausschließlich für die Materialsuche den MCP „deutsches-recht“. Suche in „datenschutzrecht“ nach Skills zu „AVV DSGVO“. Zeige höchstens fünf passende Treffer mit Titel, Dokument-ID und Quelllink. Wähle anschließend den passendsten Arbeitsablauf und begründe die Auswahl kurz.

## 5. Dokumente vollständig und gezielt laden

Ein Suchtreffer ist eine Zusammenfassung, nicht der vollständige Skill. Laden Sie den ausgewählten Treffer mit `fetch` und seiner exakten `id`.

```json
{"id":"datenschutzrecht/skills/avv-pruefung/SKILL.md"}
```

Wenn die Antwort `nextOffset` enthält, laden Sie die Folgeseite mit `get_content`. Übernehmen Sie die zurückgegebene Zahl unverändert. Ein Beispiel, bei dem die vorige Antwort `nextOffset: 10000` gemeldet hat:

```json
{
  "id": "datenschutzrecht/skills/avv-pruefung/SKILL.md",
  "offset": 10000,
  "maxChars": 10000
}
```

Lesen Sie weiter, bis `nextOffset` null ist. Referenzen und Vorlagen werden separat geladen. Relative Links beziehen sich auf den Ordner des abgerufenen Dokuments; lösen Sie sie zu einer Repository-ID auf und übergeben Sie diese an `get_content`. Wenn ein Linkziel nicht im Textindex enthalten ist, nutzen Sie den angegebenen Quelllink im passenden Client-Werkzeug.

> Lade den ausgewählten Skill vollständig, einschließlich aller Folgeseiten. Lade danach nur die darin genannten Referenzen, die für meine Aufgabe erforderlich sind. Nenne fehlende Unterlagen und ungeprüfte Annahmen, bevor du ein Arbeitsdokument erstellst.

## 6. Mit den Materialien arbeiten

Beschreiben Sie Ihr gewünschtes Ergebnis: beispielsweise eine Checkliste, eine Fragenliste für ein Anwaltsgespräch, eine Dokumentenübersicht oder einen Entwurf zur späteren Prüfung. Geben Sie nur die dafür nötigen Angaben an.

> Verwende den geladenen Arbeitsablauf für eine vorläufige Checkliste zu diesem anonymisierten Vertragsauszug. Trenne feststellbare Textmerkmale, offene Fragen und noch zu überprüfende rechtliche Aussagen. Kennzeichne das Ergebnis als Entwurf zur fachkundigen Prüfung und nenne die tatsächlich verwendeten Quellen. Behaupte keine anwaltliche Freigabe.

Eine passende Abschlussanweisung:

> Prüfe, ob alle benötigten Skill-Seiten gelesen wurden. Nenne den Repository-Commit und die Dokument-IDs. Markiere Aussagen, für die aktuelle amtliche Quellen oder eine anwaltliche Prüfung fehlen. Erfinde keine Urteile, Fundstellen oder Fristen.

Der MCP-Server recherchiert nicht selbst in amtlichen Datenbanken. Wenn aktuelle Rechtsquellen benötigt werden, muss der Client geeignete zusätzliche Recherchewerkzeuge verwenden. Überprüfen Sie, ob die angegebenen Quellen tatsächlich abgerufen wurden.

## 7. Vertrauliche Angaben und Zugriff

Der Server benötigt keine Mandantenakten für die Materialsuche. Seine Tools nehmen Suchbegriffe, Filter und Dokument-IDs entgegen, keine Uploads. Halten Sie Suchbegriffe daher sachlich und anonymisiert.

Texte, die Sie zusätzlich in Claude, ChatGPT oder einen anderen Client eingeben, werden nach dessen Einstellungen verarbeitet. Die lokale Bereitstellung des MCP-Servers macht einen Cloud-Client nicht zu einem lokalen KI-System. Tokens gehören in die Client-Konfiguration oder geeignete Umgebungsvariablen, nicht in Chatnachrichten oder öffentliche Projektdateien.

## 8. Typische Probleme

| Anzeige | Vorgehen |
| --- | --- |
| `Unauthorized` / 401 | OAuth-Anmeldung im Client starten oder erneuern; bei statischer CLI-Konfiguration Bearer-Header und API-Schlüssel prüfen. |
| OAuth-Anmeldung schlägt fehl | DCR/automatische Registrierung wählen; Betreiber muss `OAUTH_ENABLED=true` und die korrekte HTTPS-`PUBLIC_URL` setzen. |
| `API-Schlüssel ungültig` | Den aktuellen Betreiber-Schlüssel verwenden; nach fünf Fehlversuchen Verbindung neu starten. |
| 403 / `Invalid Host` | Der Betreiber muss den öffentlichen Host über `PUBLIC_URL` oder `ALLOWED_HOSTS` freigeben. |
| 403 / `Origin not allowed` | Der Betreiber muss den tatsächlich verwendeten Browser-Origin gezielt freigeben, falls der Client einen Origin sendet. |
| 503 / `Index is building` | Erstdownload und Indexaufbau abwarten; `/readyz` und Betreiberlogs prüfen. |
| 429 / `Rate limit exceeded` | Warten, Anzahl der Aufrufe verringern; bei geteilter Nutzung den Betreiber kontaktieren. |
| Keine Suchtreffer | Weniger Fachbegriffe verwenden oder mit `list_documents` browsen. |
| `Unknown document ID` | Die aktuelle ID aus einem Suchtreffer übernehmen; der Inhalt kann im Quellrepository verschoben worden sein. |
| Abgeschnittener Text | Alle Seiten über `nextOffset` abrufen. |

**Auch bei fehlerfreiem Betrieb bleibt die Software eine experimentelle Informationshilfe und kein Ersatz für anwaltliche Beratung.**
