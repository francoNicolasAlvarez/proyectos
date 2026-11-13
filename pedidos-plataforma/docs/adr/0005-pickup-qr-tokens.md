# ADR 0005: QR de retiro presentado por el cliente

**Estado:** aceptada

**Decisión:** el cliente presenta un QR único por parte de pedido y el empleado lo escanea. Token aleatorio de 128 bits; en la base solo se guarda su hash. Se genera además un código corto como alternativa si falla la cámara o el QR. El consumo es una operación atómica (`UPDATE ... WHERE used_at IS NULL RETURNING`) que registra empleado y hora. Al escanear se muestra el contenido del pedido al operador.

**Alternativa descartada:** QR estático del local escaneado por el cliente (depende de la conectividad del cliente, es fácil de fotografiar y reutilizar, y no escala con varios puestos).

**Aparte:** el QR de ubicación (sector) es otro concepto: estático, impreso, solo precarga el origen del pedido y no otorga ninguna autorización.

## Enmienda (implementación)

El token de 128 bits aleatorio guardado solo como hash impedía que el cliente volviera a mostrar su QR (el servidor no podía reconstruirlo). Se reemplazó por un **token firmado**: `HMAC-SHA256(clave del servidor, "pickup:{tenant}:{parte}")`. En la base se guarda únicamente `sha256(token)` para la búsqueda, y el cliente puede recuperar su QR cuando quiera (`getPickupCredentials`). La seguridad no cambia: el token no se puede adivinar sin la clave del servidor, la base de datos no contiene el token en claro, y el **uso único** lo garantiza `used_at` con consumo atómico, no el token. El código corto (4 caracteres sin letras ambiguas) se guarda en claro y es único entre los tokens vigentes del local. Implementado en `apps/api/src/pickup-token.ts` y `order-service.ts`.

Consecuencia a vigilar: la clave del servidor pasa a ser un secreto crítico (rotarla invalida los QR vigentes). Los lectores de tablas de tokens no pueden hacerse pasar por el cliente sin esa clave.
