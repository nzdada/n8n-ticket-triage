// Erzeugt workflow/ticket-triage.json und workflow/fehler-alarm.json (n8n-Import-Format).
// Aufruf: node build/erzeuge-workflow.js
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

// ---------------------------------------------------------------- Code der Code-Nodes

const CODE_PRUEFEN = String.raw`// Eingang prüfen und vereinheitlichen. Ungültige Tickets gehen mit 400 zurück.
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
return $input.all().map((item) => {
  const b = item.json.body ?? item.json;
  const fehler = [];
  const email = String(b.kunde_email ?? '').trim().toLowerCase();
  const betreff = String(b.betreff ?? '').trim();
  const text = String(b.text ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fehler.push('kunde_email fehlt oder ist ungültig');
  if (betreff.length < 3) fehler.push('betreff fehlt');
  if (text.length < 5) fehler.push('text fehlt');
  if (text.length > 5000) fehler.push('text ist zu lang (max. 5000 Zeichen)');
  // Fingerabdruck für die Duplikat-Prüfung: gleiche Absenderin, gleicher Betreff, gleicher Text
  const roh = email + '|' + norm(betreff) + '|' + norm(text);
  let h = 2166136261;
  for (let i = 0; i < roh.length; i++) { h ^= roh.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return { json: {
    gueltig: fehler.length === 0,
    fehler,
    fingerabdruck: 't' + h.toString(16),
    ticket: { kunde_email: email, kunde_name: String(b.kunde_name ?? '').trim(), betreff, text,
              kanal: String(b.kanal ?? 'email'), eingang: new Date().toISOString() },
    antwort: { status: 'abgelehnt', fehler },
  } };
});`;

const CODE_DUPLIKAT = String.raw`// Doppelte Tickets (gleicher Fingerabdruck innerhalb von 24 Stunden) werden nicht erneut bearbeitet.
// Hinweis: n8n speichert diese Daten nur bei produktiven Ausführungen (aktiver Workflow).
const speicher = $getWorkflowStaticData('global');
speicher.gesehen = speicher.gesehen || {};
const jetzt = Date.now();
const FENSTER = 24 * 60 * 60 * 1000;
for (const [fp, zeit] of Object.entries(speicher.gesehen)) {
  if (jetzt - zeit > FENSTER) delete speicher.gesehen[fp];
}
return $input.all().map((item) => {
  const fp = item.json.fingerabdruck;
  const duplikat = Boolean(speicher.gesehen[fp]);
  if (!duplikat) speicher.gesehen[fp] = jetzt;
  return { json: { ...item.json, duplikat,
    antwort: { status: 'duplikat', ticket_id: fp, hinweis: 'Identisches Ticket wurde in den letzten 24 Stunden bereits bearbeitet.' } } };
});`;

const CODE_MINIMIEREN = String.raw`// Datenminimierung: Die KI bekommt nur Betreff und Text, persönliche Daten werden vorher maskiert.
// Name und E-Mail-Adresse der Kundin verlassen n8n nicht.
const maskiere = (s) => String(s)
  .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,4})?\b/gi, '[IBAN]')
  .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[E-MAIL]')
  .replace(/(?:\+49|\b0)[\d\s\/\-()]{7,}\d/g, '[TELEFON]');

const SCHEMA = {
  type: 'object',
  properties: {
    kategorie: { type: 'string', enum: ['technische_stoerung', 'termin', 'rechnung', 'angebot', 'beschwerde', 'sonstiges'] },
    dringlichkeit: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
    konfidenz: { type: 'number' },
    begruendung: { type: 'string' },
  },
  required: ['kategorie', 'dringlichkeit', 'konfidenz', 'begruendung'],
  additionalProperties: false,
};

const SYSTEM = [
  'Du ordnest Kundenanfragen eines Anbieters für energetische Sanierung ein (Wärmepumpe, Photovoltaik, Heizung, Fenster).',
  'kategorie: technische_stoerung, termin, rechnung, angebot, beschwerde oder sonstiges.',
  'dringlichkeit "hoch": Heizung, Warmwasser oder Strom sind ausgefallen, Wasser tritt aus, es besteht ein Sicherheitsrisiko, oder ein Termin in den nächsten 48 Stunden ist betroffen.',
  'dringlichkeit "mittel": Beschwerden, Rechnungsfehler, Störungen ohne Ausfall. Sonst "niedrig".',
  'konfidenz: Zahl zwischen 0 und 1, wie sicher die Einordnung ist. Ist die Anfrage unklar oder passt in mehrere Kategorien, gib einen niedrigen Wert.',
  'begruendung: ein kurzer Satz auf Deutsch.',
  'Persönliche Daten sind maskiert, zum Beispiel [E-MAIL] oder [TELEFON]. Erfinde nichts dazu.',
].join('\n');

return $input.all().map((item) => {
  const t = item.json.ticket;
  const betreff = maskiere(t.betreff);
  const text = maskiere(t.text);
  return { json: { ...item.json,
    ticket_maskiert: { betreff, text },
    ki_anfrage: {
      model: 'claude-opus-5-5',
      max_tokens: 2048,
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: 'Betreff: ' + betreff + '\n\nText:\n' + text }],
    },
  } };
});`;

const CODE_AUSWERTEN = String.raw`// KI-Antwort prüfen. Ist die KI nicht erreichbar, lehnt ab oder liefert Unbrauchbares,
// greift eine einfache Regel-Einordnung. Unsichere Fälle entscheidet ein Mensch.
const KATEGORIEN = ['technische_stoerung', 'termin', 'rechnung', 'angebot', 'beschwerde', 'sonstiges'];
const STUFEN = ['hoch', 'mittel', 'niedrig'];
const SCHWELLE = 0.7;

function regeln(betreff, text) {
  const t = (betreff + ' ' + text).toLowerCase();
  const passt = (re) => re.test(t);
  if (passt(/heizung\s+(ist\s+)?(aus|ausgefallen|kalt|defekt|geht nicht)|kein(e|en)?\s+(warm)?wasser|warmwasser\s+(ist\s+)?(aus|weg|kalt)|wasser\s+(tritt|läuft|tropft)|undicht|leck|brand|rauch|stromausfall|strom\s+(ist\s+)?(weg|aus)|notfall|gefahr/))
    return { kategorie: 'technische_stoerung', dringlichkeit: 'hoch', konfidenz: 0.6 };
  if (passt(/rechnung|abbuchung|abgebucht|zahlung|mahnung|betrag|gutschrift/))
    return { kategorie: 'rechnung', dringlichkeit: 'mittel', konfidenz: 0.6 };
  if (passt(/beschwerde|unzufrieden|ärger|enttäuscht|unverschämt|unfreundlich/))
    return { kategorie: 'beschwerde', dringlichkeit: 'mittel', konfidenz: 0.6 };
  if (passt(/termin|verschieb|absag|uhrzeit|kommt der monteur/))
    return { kategorie: 'termin', dringlichkeit: passt(/\b(heute|morgen)\b/) ? 'hoch' : 'niedrig', konfidenz: 0.6 };
  if (passt(/angebot|kosten|preis|förderung|beratung|wärmepumpe|photovoltaik|pv-anlage/))
    return { kategorie: 'angebot', dringlichkeit: 'niedrig', konfidenz: 0.6 };
  return { kategorie: 'sonstiges', dringlichkeit: 'niedrig', konfidenz: 0.3 };
}

const vorher = $('Daten minimieren').all();
return $input.all().map((item, i) => {
  const basis = vorher[i].json;
  const r = item.json;
  let einordnung, quelle = 'ki', hinweis = '';
  try {
    if (r.error) throw new Error('KI nicht erreichbar');
    if (r.stop_reason === 'refusal') throw new Error('KI hat die Anfrage abgelehnt');
    const block = (r.content || []).find((b) => b.type === 'text');
    if (!block) throw new Error('KI-Antwort ohne Text');
    const d = JSON.parse(block.text);
    if (!KATEGORIEN.includes(d.kategorie) || !STUFEN.includes(d.dringlichkeit) || typeof d.konfidenz !== 'number')
      throw new Error('KI-Antwort unvollständig');
    einordnung = { kategorie: d.kategorie, dringlichkeit: d.dringlichkeit,
                   konfidenz: Math.max(0, Math.min(1, d.konfidenz)), begruendung: String(d.begruendung || '') };
  } catch (e) {
    einordnung = { ...regeln(basis.ticket.betreff, basis.ticket.text), begruendung: 'Regel-Einordnung' };
    quelle = 'fallback_regeln';
    hinweis = e.message;
  }
  // Dringendes geht immer sofort raus, auch wenn die Einordnung unsicher ist.
  let route = 'standard';
  if (einordnung.dringlichkeit === 'hoch') route = 'eskalation';
  else if (einordnung.konfidenz < SCHWELLE) route = 'manuell';

  return { json: {
    ticket_id: basis.fingerabdruck,
    ticket: basis.ticket,
    ...einordnung,
    quelle,
    hinweis,
    route,
  } };
});`;

const CODE_ESKALATION = String.raw`// Dringend: Support-Lead sofort benachrichtigen und Ticket mit hoher Priorität anlegen.
// In der Demo wird die Nachricht nur vorbereitet. Im Betrieb: Slack-, Teams- oder Zoho-Desk-Node anhängen.
return $input.all().map((item) => {
  const j = item.json;
  return { json: { ...j,
    benachrichtigung: { kanal: '#support-eskalation',
      text: 'Dringend (' + j.kategorie + '): ' + j.ticket.betreff + ' – ' + j.begruendung },
    crm: { status: 'eskaliert', prioritaet: 'hoch', kategorie: j.kategorie },
    antwort: { status: 'eskaliert', ticket_id: j.ticket_id, kategorie: j.kategorie, dringlichkeit: j.dringlichkeit,
               konfidenz: j.konfidenz, quelle: j.quelle, begruendung: j.begruendung, hinweis: j.hinweis },
  } };
});`;

const CODE_MANUELL = String.raw`// Unsicher: Ein Mensch entscheidet. Das Ticket landet in der Warteschlange "Manuelle Prüfung".
return $input.all().map((item) => {
  const j = item.json;
  return { json: { ...j,
    aufgabe: { warteschlange: 'manuelle-pruefung',
      grund: 'Einordnung unsicher (Konfidenz ' + j.konfidenz + ', Quelle ' + j.quelle + ')' },
    antwort: { status: 'manuelle_pruefung', ticket_id: j.ticket_id, vorschlag: j.kategorie, dringlichkeit: j.dringlichkeit,
               konfidenz: j.konfidenz, quelle: j.quelle, begruendung: j.begruendung, hinweis: j.hinweis },
  } };
});`;

const CODE_STANDARD = String.raw`// Normalfall: Ticket mit Kategorie und Priorität im CRM anlegen.
// In der Demo wird der Datensatz nur vorbereitet. Im Betrieb: Zoho-Desk-, HubSpot- oder HTTP-Node anhängen.
return $input.all().map((item) => {
  const j = item.json;
  return { json: { ...j,
    crm: { status: 'neu', kategorie: j.kategorie, prioritaet: j.dringlichkeit,
           kontakt: j.ticket.kunde_email, betreff: j.ticket.betreff },
    antwort: { status: 'angelegt', ticket_id: j.ticket_id, kategorie: j.kategorie, dringlichkeit: j.dringlichkeit,
               konfidenz: j.konfidenz, quelle: j.quelle, begruendung: j.begruendung, hinweis: j.hinweis },
  } };
});`;

const CODE_ALARM = String.raw`// Läuft, wenn im Ticket-Workflow ein unerwarteter Fehler auftritt.
// Bereitet eine Alarm-Nachricht vor. Im Betrieb: Slack-, Teams- oder E-Mail-Node anhängen.
return $input.all().map((item) => {
  const e = item.json;
  return { json: {
    alarm: {
      kanal: '#automation-alarme',
      text: 'Fehler im Workflow "' + (e.workflow?.name ?? '?') + '" in Node "' + (e.execution?.lastNodeExecuted ?? '?') + '": ' + (e.execution?.error?.message ?? 'unbekannt'),
      ausfuehrung: e.execution?.url ?? '',
    },
  } };
});`;

// ---------------------------------------------------------------- Nodes

let n = 0;
const id = () => "a1b2c3d4-0000-4000-8000-" + String(++n).padStart(12, "0");
const code = (name, js, pos) => ({ parameters: { jsCode: js }, id: id(), name, type: "n8n-nodes-base.code", typeVersion: 2, position: pos });
const wennBool = (name, feld, pos) => ({ parameters: { conditions: { boolean: [{ value1: "={{ $json." + feld + " }}", value2: true }] } }, id: id(), name, type: "n8n-nodes-base.if", typeVersion: 1, position: pos });
const wennText = (name, feld, wert, pos) => ({ parameters: { conditions: { string: [{ value1: "={{ $json." + feld + " }}", operation: "equal", value2: wert }] } }, id: id(), name, type: "n8n-nodes-base.if", typeVersion: 1, position: pos });
const antworte = (name, code, pos) => ({ parameters: { respondWith: "json", responseBody: "={{ JSON.stringify($json.antwort) }}", options: { responseCode: code } }, id: id(), name, type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: pos });
const notiz = (inhalt, pos, w, h) => ({ parameters: { content: inhalt, width: w, height: h }, id: id(), name: "Notiz " + n, type: "n8n-nodes-base.stickyNote", typeVersion: 1, position: pos });

const nodes = [
  notiz("## Ticket-Triage mit KI\nEingang → Prüfung → Duplikate → Datenminimierung → KI-Einordnung mit Fallback → Routing.\n\nNeue Version immer **erst inaktiv** mit den Testtickets prüfen (`test/teste-workflow.js`), dann aktivieren.\nAlle Daten in diesem Repo sind erfunden.", [-120, -360], 620, 240),
  { parameters: { httpMethod: "POST", path: "ticket-triage", responseMode: "responseNode", options: {} }, id: id(), name: "Ticket eingang", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 0], webhookId: "8f3d2c1a-4b5e-4c6d-9e7f-0a1b2c3d4e5f" },
  code("Ticket prüfen", CODE_PRUEFEN, [220, 0]),
  wennBool("Gültig?", "gueltig", [440, 0]),
  antworte("Antwort: ungültig (400)", 400, [660, 200]),
  code("Duplikat prüfen", CODE_DUPLIKAT, [660, -20]),
  wennBool("Duplikat?", "duplikat", [880, -20]),
  antworte("Antwort: Duplikat (200)", 200, [1100, -220]),
  code("Daten minimieren", CODE_MINIMIEREN, [1100, 0]),
  {
    parameters: {
      method: "POST", url: "https://api.anthropic.com/v1/messages",
      authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: "anthropic-version", value: "2023-06-01" },
        { name: "anthropic-beta", value: "server-side-fallback-2026-07-01" },
      ] },
      sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify($json.ki_anfrage) }}",
      options: { timeout: 30000 },
    },
    id: id(), name: "KI-Einordnung (Claude)", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [1320, 0],
    retryOnFail: true, maxTries: 2, waitBetweenTries: 2000, onError: "continueRegularOutput",
    notes: "Credential: Header Auth, Name x-api-key, Wert = Anthropic-API-Key. Fehlt der Key oder ist die API down, greift im nächsten Schritt die Regel-Einordnung.",
  },
  code("Antwort prüfen + Fallback", CODE_AUSWERTEN, [1540, 0]),
  wennText("Eskalieren?", "route", "eskalation", [1760, 0]),
  code("Eskalation vorbereiten", CODE_ESKALATION, [1980, -200]),
  antworte("Antwort: eskaliert", 200, [2200, -200]),
  wennText("Mensch entscheiden?", "route", "manuell", [1980, 100]),
  code("Manuelle Prüfung", CODE_MANUELL, [2200, 0]),
  antworte("Antwort: manuell", 200, [2420, 0]),
  code("Im CRM anlegen", CODE_STANDARD, [2200, 220]),
  antworte("Antwort: angelegt", 200, [2420, 220]),
  notiz("**Datenschutz:** Name und E-Mail gehen nie an die KI. IBAN, E-Mail und Telefon im Text werden maskiert.", [1020, 180], 300, 120),
  notiz("**Mensch entscheidet:** Dringendes wird immer eskaliert. Ist die KI unsicher (Konfidenz < 0,7) oder ausgefallen, landet das Ticket in der manuellen Prüfung.", [1700, 300], 340, 140),
];

const by = (name) => nodes.find((x) => x.name === name).name;
const c = (...ziele) => ziele.map((z) => [{ node: by(z), type: "main", index: 0 }]);
const connections = {
  "Ticket eingang": { main: c("Ticket prüfen") },
  "Ticket prüfen": { main: c("Gültig?") },
  "Gültig?": { main: [[{ node: "Duplikat prüfen", type: "main", index: 0 }], [{ node: "Antwort: ungültig (400)", type: "main", index: 0 }]] },
  "Duplikat prüfen": { main: c("Duplikat?") },
  "Duplikat?": { main: [[{ node: "Antwort: Duplikat (200)", type: "main", index: 0 }], [{ node: "Daten minimieren", type: "main", index: 0 }]] },
  "Daten minimieren": { main: c("KI-Einordnung (Claude)") },
  "KI-Einordnung (Claude)": { main: c("Antwort prüfen + Fallback") },
  "Antwort prüfen + Fallback": { main: c("Eskalieren?") },
  "Eskalieren?": { main: [[{ node: "Eskalation vorbereiten", type: "main", index: 0 }], [{ node: "Mensch entscheiden?", type: "main", index: 0 }]] },
  "Eskalation vorbereiten": { main: c("Antwort: eskaliert") },
  "Mensch entscheiden?": { main: [[{ node: "Manuelle Prüfung", type: "main", index: 0 }], [{ node: "Im CRM anlegen", type: "main", index: 0 }]] },
  "Manuelle Prüfung": { main: c("Antwort: manuell") },
  "Im CRM anlegen": { main: c("Antwort: angelegt") },
};

const workflow = {
  name: "Ticket-Triage mit KI (Demo)",
  nodes, connections, active: false,
  settings: { executionOrder: "v1", saveDataErrorExecution: "all", saveDataSuccessExecution: "all" },
  pinData: {}, meta: { templateCredsSetupCompleted: false },
};

const alarm = {
  name: "Fehler-Alarm (Demo)",
  nodes: [
    { parameters: {}, id: id(), name: "Fehler im Workflow", type: "n8n-nodes-base.errorTrigger", typeVersion: 1, position: [0, 0] },
    code("Alarm vorbereiten", CODE_ALARM, [240, 0]),
  ],
  connections: { "Fehler im Workflow": { main: [[{ node: "Alarm vorbereiten", type: "main", index: 0 }]] } },
  active: false, settings: { executionOrder: "v1" }, pinData: {},
};

fs.mkdirSync(path.join(ROOT, "workflow"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "workflow", "ticket-triage.json"), JSON.stringify(workflow, null, 2));
fs.writeFileSync(path.join(ROOT, "workflow", "fehler-alarm.json"), JSON.stringify(alarm, null, 2));
console.log("geschrieben: workflow/ticket-triage.json (" + nodes.length + " Nodes), workflow/fehler-alarm.json");
