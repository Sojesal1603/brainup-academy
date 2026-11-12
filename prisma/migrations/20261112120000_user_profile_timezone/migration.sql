-- Zona horaria del alumno (IANA). Todo el cálculo de «hoy» (rachas, hábitos,
-- cierre nocturno, plan del día) debe usar esta zona y no la del servidor.
--
-- El valor por defecto rellena las filas existentes sin inventar datos por
-- alumno: Europe/Madrid es la zona de la cuenta actual y se puede cambiar en
-- Ajustes. `ADD COLUMN ... DEFAULT` en PostgreSQL no reescribe la tabla.
ALTER TABLE "UserProfile"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Europe/Madrid';

-- La zona debe ser una cadena IANA. La validación fina (que exista de verdad)
-- la hace Zod en la Server Action (`timeZoneSchema`); en la base se acota la
-- forma para que no entren valores absurdos por SQL directo.
ALTER TABLE "UserProfile"
  ADD CONSTRAINT "UserProfile_timezone_shape"
  CHECK (char_length("timezone") BETWEEN 1 AND 64 AND "timezone" ~ '^[A-Za-z0-9_+/-]+$');
