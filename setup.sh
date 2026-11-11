#!/usr/bin/env bash
# Einrichtung in einem Schritt: fragt die nötigen Angaben ab und startet das Dashboard.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker wurde nicht gefunden. Auf TrueNAS bitte zuerst unter 'Apps' einen Pool auswählen." >&2
  exit 1
fi

if [ -f .env ]; then
  echo "Vorhandene .env wird verwendet."
else
  read -r -p "IP-Adresse oder Name deines TrueNAS (z. B. 192.168.1.10): " host
  read -r -s -p "TrueNAS-API-Key (Eingabe bleibt unsichtbar): " key; echo
  read -r -s -p "Passwort für das Dashboard (leer = ohne Passwort): " pass; echo
  if [ -z "$host" ] || [ -z "$key" ]; then
    echo "Adresse und API-Key werden benötigt." >&2
    exit 1
  fi
  case "$host$key$pass" in *"'"*) echo "Einfache Anführungszeichen (') sind nicht erlaubt." >&2; exit 1;; esac
  grep -v -E '^(TRUENAS_HOST|TRUENAS_API_KEY|DASHBOARD_PASSWORD)=' .env.example > .env
  # Werte in Hochkommas, damit Sonderzeichen unverändert bleiben
  printf "\n# ---------- Von setup.sh eingetragen ----------\nTRUENAS_HOST='%s'\nTRUENAS_API_KEY='%s'\nDASHBOARD_PASSWORD='%s'\n" "$host" "$key" "$pass" >> .env
  chmod 600 .env
  echo ".env wurde angelegt. E-Mail, Kalender und Wetter kannst du dort später ergänzen."
fi

docker compose up -d --build
echo
echo "Fertig. Das Dashboard läuft unter: http://<IP-dieses-Rechners>:8080"
