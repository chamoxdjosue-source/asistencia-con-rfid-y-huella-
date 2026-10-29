

import json
import os
import time
import urllib.request

CONFIGSTORE = os.path.expanduser("~/.config/configstore/firebase-tools.json")
PROJECT = "asistenciarfid-778d2"
CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com"
CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi"

ESTUDIANTES = [
    {"estudiante_id": "EST001", "nombre": "Juan Pérez", "curso": "6to"},
    {"estudiante_id": "EST002", "nombre": "María López", "curso": "6to"},
    {"estudiante_id": "EST003", "nombre": "Carlos Gómez", "curso": "6to"},
    {"estudiante_id": "EST004", "nombre": "Ana Rodríguez", "curso": "5to"},
    {"estudiante_id": "EST005", "nombre": "Pedro Vargas", "curso": "5to"},
]


def get_access_token():
    with open(CONFIGSTORE) as f:
        refresh_token = json.load(f)["tokens"]["refresh_token"]
    data = f"grant_type=refresh_token&client_id={CLIENT_ID}&client_secret={CLIENT_SECRET}&refresh_token={refresh_token}"
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=data.encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["access_token"]


def fields_for(e):
    return {
        "estudiante_id": {"stringValue": e["estudiante_id"]},
        "nombre": {"stringValue": e["nombre"]},
        "curso": {"stringValue": e["curso"]},
        "rfid": {"nullValue": None},
        "saldo": {"integerValue": "20"},
    }


def crear_estudiante(token, e):
    url = (
        f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/%28default%29"
        f"/documents/estudiantes?documentId={e['estudiante_id']}"
    )
    body = json.dumps({"fields": fields_for(e)}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def reset_estudiante(token, e):
    url = (
        f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/%28default%29"
        f"/documents/estudiantes/{e['estudiante_id']}?updateMask.fieldPaths=rfid&updateMask.fieldPaths=saldo"
    )
    body = json.dumps({"fields": fields_for(e)}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="PATCH",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    continuar = input("¿RESETEAR saldo a Bs 20 y RFID a null de los que ya existan? [s/N]: ").strip().lower()
    token = get_access_token()
    for e in ESTUDIANTES:
        try:
            if continuar == "s":
                reset_estudiante(token, e)
                print(f"OK  {e['estudiante_id']} {e['nombre']}: actualizado (saldo 20, rfid null)")
            else:
                crear_estudiante(token, e)
                print(f"OK  {e['estudiante_id']} {e['nombre']}: creado")
        except urllib.error.HTTPError as err:
            body = err.read().decode(errors="ignore")
            if err.code == 409 and continuar != "s":
                print(f"==  {e['estudiante_id']} {e['nombre']}: ya existe (saltando, sin tocar datos)")
            else:
                print(f"ERR {e['estudiante_id']} {e['nombre']}: {err.code} {body[:200]}")


if __name__ == "__main__":
    main()