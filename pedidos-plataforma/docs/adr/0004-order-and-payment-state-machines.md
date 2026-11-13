# ADR 0004: Máquinas de estado separadas para pago y pedido

**Estado:** aceptada

**Decisión:** el estado financiero (`payment_status`) y el operativo (`operational_status`) son independientes. Todo pedido tiene al menos una parte (`order_part`) con su propio estado de retiro; el estado operativo del pedido se deriva de sus partes. Los cambios pasan por un único servicio de transición que valida, escribe `order_status_history` y emite el evento.

**Consecuencias:** un modelo uniforme para `single_point` y `per_item`. Los reembolsos y el pago al retiro no contaminan el flujo operativo. Los estados válidos están en `docs/functional-analysis.md`.
