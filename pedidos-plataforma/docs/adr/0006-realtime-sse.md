# ADR 0006: Tiempo real con Server-Sent Events

**Estado:** aceptada

**Decisión:** el cliente y el panel reciben actualizaciones por SSE. Redis pub/sub distribuye los eventos entre instancias. Los eventos salen de una tabla outbox escrita en la misma transacción que el cambio de estado.

**Consecuencias:** más simple que WebSocket y suficiente porque la comunicación es unidireccional. El cliente debe reconectar y re-sincronizar el estado al volver la conexión, porque SSE no garantiza entrega durante cortes.
