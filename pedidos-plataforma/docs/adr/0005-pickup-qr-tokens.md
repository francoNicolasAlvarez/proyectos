# ADR 0005: QR de retiro presentado por el cliente

**Estado:** aceptada

**Decisión:** el cliente presenta un QR único por parte de pedido y el empleado lo escanea. Token aleatorio de 128 bits; en la base solo se guarda su hash. Se genera además un código corto como alternativa si falla la cámara o el QR. El consumo es una operación atómica (`UPDATE ... WHERE used_at IS NULL RETURNING`) que registra empleado y hora. Al escanear se muestra el contenido del pedido al operador.

**Alternativa descartada:** QR estático del local escaneado por el cliente (depende de la conectividad del cliente, es fácil de fotografiar y reutilizar, y no escala con varios puestos).

**Aparte:** el QR de ubicación (sector) es otro concepto: estático, impreso, solo precarga el origen del pedido y no otorga ninguna autorización.
