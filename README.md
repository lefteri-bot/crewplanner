# Schelle Crew Planner — MVP (WinFix16 Priority)

Dit is een **super-simpele** MVP voor de groendienst:

- **Kaart = alleen Schelle** (straatnamen zichtbaar, geen tekenen, geen zones).
- **Taken = straatnamen** (met optionele omschrijving).
- Ploegen **kiezen zelf** taken (claim), tenzij admin **oplegt** (impose).
- **Anti-chaos:** per ploeg **max 1 actieve taak** tegelijk.

## 1) Installeren (Windows)

1. Installeer **Node.js LTS** (bv. 18 of 20).
2. Open deze map in Verkenner.
3. Dubbelklik op **start-dev.bat**

De app draait dan op:
- http://localhost:3000

> Eerste keer? Dan doet hij automatisch `npm install`.

## 1b) Niet meer manueel starten (Edge app / bureaublad)

Wil je dat je **Edge app** gewoon opent zonder eerst `start-dev` te draaien?

### Optie A — snelste (1 klik)
- Dubbelklik **OPEN_APP.bat**
  - start de server stil op de achtergrond
  - opent daarna een Edge “app” venster

### Optie B — automatisch bij aanmelden (aanrader)
1) Dubbelklik **INSTALL_AUTOSTART.bat**
   - vanaf nu start de server vanzelf bij Windows-aanmelden
2) Dubbelklik **INSTALL_DESKTOP_ICON.bat**
   - maakt een bureaublad-icoon met het logo

Stop autostart? Run **UNINSTALL_AUTOSTART.bat**.

## 1c) App-icoon op gsm (PWA)
1) Open op gsm: `http://<PC-IP-of-Tailscale-IP>:3000/crew`
2) In de browser:
   - **Android/Chrome:** menu ⋮ → **Installeren** / **Add to Home screen**
   - **iPhone/Safari:** deel-knop → **Zet op beginscherm**

Dankzij de **manifest + icons** krijgt de app op je gsm een proper icoon (logo).

## 2) Rollen (MVP)

Er is geen login (bewust: MVP). Bovenaan kies je:
- **Rol:** crew of admin
- **Ploeg:** Groen 1–4
- **UserId:** vrije tekst (bv. je naam)

Alles wordt gelogd in `task_events`.

## 2b) Crew login op gsm (clean)

We hebben nu een aparte, **opgeruimde** crew-pagina:

### Crew (gsm)
- Open: `http://<PC-IP>:3000/crew`
- Tik één keer een **6-cijferige koppelcode** in
- Kies je **ploeg**
- Schrijf **opmerkingen/briefing** bij de actieve taak (zichtbaar voor iedereen)
- Klaar: de gsm onthoudt dit toestel automatisch

### Admin (PC)
- Kies rol **Admin** en vul je **Admin PIN** in
- Ga naar **Dagplanning → Aanwezig**
- Klik naast de naam op **Koppel gsm**
- Geef die code door aan de medewerker (geldig ±10 min)

## 3) Belangrijkste regels

### Max 1 actieve taak per ploeg
Actief = status **CLAIMED** of **IMPOSED**.
Als je al een actieve taak hebt, kan je geen tweede nemen.

### Admin kan opleggen
Admin kan een taak aan een ploeg opleggen.
Als die ploeg al 1 actieve taak heeft:
- admin kan **niet** opleggen (standaard)
- of admin kiest **Override** (huidige taak wordt vrijgegeven)

## 4) Data & database

SQLite database:
- `backend/data/app.db`

Tabellen:
- `tasks`
- `task_events`

Opmerkingen worden opgeslagen als `task_events.type = 'NOTE'`.

## 5) Schelle-only kaart

We gebruiken Leaflet + OpenStreetMap.  
De kaart is beperkt via **maxBounds** rond Schelle.

Je kan (optioneel) de schelle-grens vervangen door een officiële GeoJSON in:
- `frontend/assets/schelle-boundary.geojson`

## 6) Stoppen

Sluit het terminal-venster (of Ctrl+C).

Veel plezier — dit is “simpel genoeg om te werken”. 😉

## Admin PIN (veiligheid)
Admin-acties werken enkel als je een **Admin PIN** invult.
- Standaard PIN (MVP): `1234`
- Verander dit: zet een env var `ADMIN_KEY` op de PC waar de app draait.
  - makkelijk: gebruik `start-dev-adminpin.bat` en pas de PIN aan in dat bestand.

## Tailscale (plannen via 4G/5G)
1) Installeer Tailscale op de PC (planner) + op alle gsm’s.
2) Zorg dat iedereen “connected” is in Tailscale.
3) Open op gsm: `http://TAILSCALE-IP-VAN-DE-PC:3000/crew` (crew) of `http://TAILSCALE-IP-VAN-DE-PC:3000` (admin)
   (Tailscale IP = 100.x.x.x in de Tailscale app)


Update v4: het **Admin PIN** veld staat nu altijd zichtbaar bovenaan (geen catch-22).

## Dagplanning (aanwezigheid, ploegen, voertuigen)
- Vink per dag aan wie **aanwezig** is.
- Stel per ploeg de **leden** samen:
  - ploeg mag **leeg** zijn (ongebruikt)
  - of **2–4 personen**
- Wijs per ploeg max **2 voertuigen** toe.
- Voertuigenlijst beheren kan enkel als **Admin** (met PIN).
