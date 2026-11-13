# ADR 0003: Modelo de pagos y abstracción de proveedor

**Estado:** aceptada

**Decisión:**
- Cada local conecta su cuenta de Mercado Pago por OAuth; los cobros electrónicos van directo a esa cuenta. La plataforma no custodia fondos.
- La plataforma cobra una suscripción fija por local. La comisión por transacción queda para más adelante.
- Los medios de pago los habilita cada local: electrónicos (cobro al pedir) y efectivo/tarjeta física (cobro al retirar, MVP 2).
- Interfaz `PaymentProvider` para poder sumar otros proveedores.
- La confirmación del pago se hace siempre consultando la API del proveedor tras el webhook; nunca se confía en el contenido del webhook.

**Consecuencias:** sin obligaciones de liquidación ni conciliación entre plataforma y locales. Los pagos en efectivo no generan comisión. Pendiente verificar condiciones y tarifas vigentes de Mercado Pago y el tratamiento fiscal de la suscripción con un contador.
