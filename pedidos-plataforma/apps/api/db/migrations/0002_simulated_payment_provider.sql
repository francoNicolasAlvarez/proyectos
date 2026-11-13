-- Proveedor de pago simulado, solo para desarrollo (nunca se habilita en producción: el servidor se niega a arrancar así).
ALTER TABLE tenant_payment_accounts DROP CONSTRAINT tenant_payment_accounts_provider_check;
ALTER TABLE tenant_payment_accounts ADD CONSTRAINT tenant_payment_accounts_provider_check CHECK (provider IN ('mercadopago', 'simulated'));
