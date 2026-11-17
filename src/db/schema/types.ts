import { customType } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL `bytea` (DATA-MODEL.md section 2.1). drizzle-orm 0.45 has no bytea builder; node-postgres sends a Buffer
 * parameter as bytea and returns bytea columns as Buffer, so no conversion is needed in either direction.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
