// Schickt alle Testtickets an den Webhook und prüft das Ergebnis.
// Aufruf: node test/teste-workflow.js [webhook-url]
// Standard-URL: http://localhost:5678/webhook/ticket-triage
const fs = require("fs");
const path = require("path");

const URL = process.argv[2] || "http://localhost:5678/webhook/ticket-triage";
const faelle = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "testdaten", "tickets.json"), "utf8"));
// Eindeutiger Testlauf, damit die Duplikat-Sperre (24 h) frühere Läufe nicht mitzählt
const lauf = Date.now().toString(36);

(async () => {
  let ok = 0;
  let modus = null;
  console.log("Testlauf " + lauf + " → " + URL + "\n");
  for (const [i, fall] of faelle.entries()) {
    const ticket = { ...fall.ticket };
    if (ticket.kunde_email) ticket.kunde_email = ticket.kunde_email.replace("@", "+" + lauf + "@");
    const start = Date.now();
    const res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ticket) });
    const body = await res.json().catch(() => ({}));
    if (body.quelle && !modus) modus = body.quelle === "ki" ? "mit_ki" : "ohne_ki";
    const erwartet = fall.erwartet[modus || "ohne_ki"];
    const passt = erwartet.includes(body.status);
    if (passt) ok++;
    console.log(
      (passt ? "OK    " : "FALSCH") + "  " + String(i + 1).padStart(2) + ". " + fall.name.padEnd(36) +
      " HTTP " + res.status + "  " + String(body.status).padEnd(18) +
      (body.kategorie || body.vorschlag || "").padEnd(20) + String(body.dringlichkeit || "").padEnd(8) +
      (body.konfidenz !== undefined ? "Konfidenz " + body.konfidenz : "").padEnd(16) +
      String(Date.now() - start).padStart(5) + " ms" + (passt ? "" : "   erwartet: " + erwartet.join(" oder "))
    );
  }
  console.log("\nModus: " + (modus === "mit_ki" ? "mit KI (Claude)" : "ohne KI (Regel-Fallback)") + " · " + ok + " von " + faelle.length + " wie erwartet");
  process.exit(ok === faelle.length ? 0 : 1);
})().catch((e) => { console.error("Fehler: " + e.message); process.exit(2); });
