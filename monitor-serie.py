#!/usr/bin/env python3
"""Monitor serie del ESP32 para el lector del comedor.

Imprime todo lo que manda la placa por el USB y, si se le pasa un archivo,
lo va guardando (asi se puede revisar despues lo que paso).

Uso:
    python3 scripts/monitor-serie.py                  # solo mostrar
    python3 scripts/monitor-serie.py /tmp/esp32.log   # mostrar y guardar
    python3 scripts/monitor-serie.py /tmp/esp32.log /dev/ttyUSB0 115200

Nota: al abrir el puerto pyserial activa DTR/RTS y la placa se reinicia. Por
eso se sueltan los dos nada mas abrir: la placa arranca y se ve el mensaje
"Listo. Acerque una tarjeta...".
"""
import os
import sys
import time

try:
    import serial
except ImportError:
    print("Falta pyserial. Instalalo con:  pip3 install pyserial")
    sys.exit(1)

archivo = sys.argv[1] if len(sys.argv) > 1 else None
puerto = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("ESP32_PUERTO", "/dev/ttyUSB0")
baudios = int(sys.argv[3]) if len(sys.argv) > 3 else 115200

try:
    s = serial.Serial(puerto, baudios, timeout=0.3)
except serial.SerialException as e:
    print(f"No se pudo abrir {puerto}: {e}")
    print("Revisa que la placa este conectada por USB (ls /dev/ttyUSB*).")
    sys.exit(1)

s.dtr = False
s.rts = False
s.reset_input_buffer()

salida = open(archivo, "a", encoding="utf-8") if archivo else None
print(f"== Escuchando {puerto} a {baudios} baudios ==", flush=True)
if archivo:
    print(f"== Guardando en {archivo} ==", flush=True)
print("== Ctrl+C para salir ==", flush=True)

try:
    while True:
        datos = s.read(2048)
        if not datos:
            continue
        texto = datos.decode("utf-8", "replace")
        sys.stdout.write(texto)
        sys.stdout.flush()
        if salida:
            salida.write(texto)
            salida.flush()
except KeyboardInterrupt:
    pass
finally:
    if salida:
        salida.close()
    s.close()
    print("\n== Monitor cerrado ==")
