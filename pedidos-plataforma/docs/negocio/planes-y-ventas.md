# Planes, suscripción y promociones

Estado: **propuesta técnica sin validar comercialmente**. Los precios y las comisiones no están definidos ni inventados acá: los decide el negocio. El código (`packages/shared/src/plans.ts` y `promotions.ts`) ya implementa las reglas y está probado, pero todavía **no está conectado a la API**: falta decidir el modelo de cobro (ver "Decisiones pendientes").

## 1. Planes propuestos

| | Gratuito | Básico | Pro |
|---|---|---|---|
| Personal | hasta 3 | hasta 10 | sin tope |
| Puntos de retiro | 1 | hasta 3 | sin tope |
| Sectores con QR | hasta 10 | hasta 50 | sin tope |
| Menús de evento | no | no | sí |
| Promociones | no | sí | sí |
| Topes por pedido editables | no | sí | sí |
| Reportes | ninguno | básicos | avanzados |

Los topes son un punto de partida para conversar con locales reales. Una prueba automática garantiza que cada plan superior incluya todo lo del inferior.

Idea de venta: el plan gratuito deja probar el producto completo en un local chico; las funciones que se vuelven necesarias al crecer (más puntos de retiro, eventos, promociones) son el motivo natural para subir de plan. Cuando un local choca con un tope, el sistema indica a qué plan pasar (`upgradeTo`), para mostrar un mensaje de mejora en el momento justo.

## 2. Ciclo de vida de la suscripción

```
alta → prueba (14 días) → activa → (no renueva) → gracia (5 días) → suspendida
                                        ↑                              │
                                        └──────── paga ────────────────┘
cancelada: no recibe pedidos ni edita
```

Reglas ya implementadas y probadas:
- La prueba dura 14 días; en los últimos 3 se muestra un aviso.
- Si no se paga al terminar la prueba o el período, hay **5 días de gracia** con todo funcionando y un aviso de pago pendiente.
- Pasada la gracia el local queda en **solo lectura**: los clientes no pueden pedir y el personal no puede editar el catálogo.
- **Nunca se corta la atención de pedidos ya pagados**, en ningún estado, porque hay dinero de clientes en juego.
- El plan gratuito no vence.

Los plazos (14 y 5 días) son supuestos ajustables en `TRIAL_DAYS` y `GRACE_DAYS`.

## 3. Promociones

Reglas implementadas:
- Porcentaje (1 a 100) o monto fijo, siempre en centavos enteros y redondeando hacia abajo.
- Condiciones: vigencia, subtotal mínimo, tope de descuento, usos totales y por persona.
- El descuento nunca supera el subtotal.
- No se acumulan: se aplica la que más descuenta (en empate, el código menor, para ser estable).

Cuidado de producto: la promoción baja lo que cobra el local y lo que se paga en línea, pero los **topes de gasto por pedido** (ej. $100.000) deben seguir calculándose sobre el subtotal sin descuento, para que una promoción no sirva para esquivar el límite. Esto se decide al integrarla.

## 4. Preguntas de negocio que conviene validar

Ninguna tiene respuesta en el repositorio; son hipótesis para contrastar con locales:
1. Ya decidido: el modelo es **suscripción fija por local** (sin comisión por pedido). Falta definir los montos por plan y la periodicidad (mensual o anual).
2. ¿Qué parte del costo del medio de pago (comisión de Mercado Pago) absorbe el local y cuál el cliente? Verificar las tarifas vigentes en la fuente oficial antes de calcular márgenes.
3. ¿Los impuestos y la facturación electrónica los gestiona el local o la plataforma? Requiere asesoramiento contable.
4. ¿Los topes del plan gratuito son suficientes para que el local vea valor, pero lo bastante ajustados para motivar la mejora?
5. ¿Los eventos justifican un plan propio o un cobro por evento?

Métricas a medir cuando haya locales reales: locales activos, pedidos por local por semana, tiempo hasta el primer pedido, tasa de pase de gratuito a pago, abandono en la etapa de pago, porcentaje de pedidos rechazados por el local.

## 5. Decisiones pendientes para integrar

- Montos por plan y periodicidad (solo el negocio puede definirlos).
- Tabla de suscripciones por local (plan, estado, fechas) y su migración.
- Dónde se hace cumplir: al crear un pedido (`canReceiveOrders`) y al administrar catálogo, personal, puntos y sectores (`canAdd`, `hasFeature`).
- Cómo se cobra la suscripción en sí (distinto del cobro de pedidos a clientes).
- Aviso al propietario antes del vencimiento (correo o notificación).
