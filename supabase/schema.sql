-- ============================================================================
-- PHOTOEXAMS — SCRIPT SQL COMPLETO PARA SUPABASE (PostgreSQL + RLS)
-- ============================================================================
-- Instrucciones:
-- 1. Abre el panel de tu proyecto en Supabase (https://supabase.com/dashboard).
-- 2. Ve a "SQL Editor" -> "New query".
-- 3. Pega este script completo y haz clic en "Run".
-- 4. En "Authentication" -> "Providers", asegúrate de tener habilitado:
--    - "Email" (habilitado por defecto)
--    - Opcionalmente "Anonymous Sign-Ins" (en Authentication -> Settings ->
--      Enable anonymous sign-ins) para ingreso automático sin registro previo.
-- ============================================================================

-- Extensión necesaria para gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. TABLA: public.syllabus
-- Almacena el resumen de gramática y vocabulario del estudiante.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.syllabus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL CHECK (char_length(btrim(content)) > 0),
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Restricción única en user_id para permitir UPSERT sin duplicar registros por usuario
  CONSTRAINT syllabus_user_id_unique UNIQUE (user_id)
);

COMMENT ON TABLE public.syllabus IS 'Resumen de gramática y vocabulario de inglés de cada estudiante.';
COMMENT ON COLUMN public.syllabus.id IS 'Identificador único del resumen (UUID).';
COMMENT ON COLUMN public.syllabus.content IS 'Contenido completo de los apuntes de gramática y vocabulario.';
COMMENT ON COLUMN public.syllabus.user_id IS 'UUID del estudiante autenticado en auth.users.';

-- Índice para búsquedas rápidas por usuario
CREATE INDEX IF NOT EXISTS idx_syllabus_user_id ON public.syllabus(user_id);

-- Función y trigger para mantener updated_at actualizado automáticamente
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_syllabus_updated_at ON public.syllabus;
CREATE TRIGGER trg_syllabus_updated_at
  BEFORE UPDATE ON public.syllabus
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 2. TABLA: public.practices
-- Almacena el historial de prácticas orales realizadas por el estudiante.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.practices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL CHECK (char_length(btrim(image_url)) > 0),
  generated_questions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(generated_questions) = 'array'),
  user_answer TEXT NOT NULL CHECK (char_length(btrim(user_answer)) > 0),
  ai_feedback TEXT NOT NULL CHECK (char_length(btrim(ai_feedback)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.practices IS 'Historial de prácticas de descripción de fotografías y retroalimentación IA.';
COMMENT ON COLUMN public.practices.generated_questions IS 'Lista JSONB con las 5 preguntas generadas por Gemini.';
COMMENT ON COLUMN public.practices.ai_feedback IS 'Retroalimentación estructurada (JSON serializado / Markdown) generada por Gemini.';

-- Índices para optimizar consultas de historial por estudiante y orden cronológico
CREATE INDEX IF NOT EXISTS idx_practices_user_id ON public.practices(user_id);
CREATE INDEX IF NOT EXISTS idx_practices_user_created_at ON public.practices(user_id, created_at DESC);

-- ============================================================================
-- 3. ROW LEVEL SECURITY (RLS) Y POLÍTICAS DE ACCESO
-- ============================================================================
-- NOTA DE SEGURIDAD SOBRE AUTENTICACIÓN:
-- Si la aplicación no utilizara autenticación y se crearan políticas abiertas
-- con `USING (true)` para el rol `anon`, cualquier persona con la clave
-- publicable (`sb_publishable_...`) podría leer, sobrescribir o borrar los
-- apuntes y prácticas de todos los estudiantes.
-- Por ello, se vincula cada fila a `auth.users(id)` mediante `user_id` y se
-- exige `auth.uid() = user_id` en todas las operaciones (compatible tanto con
-- cuentas de correo/contraseña como con sesiones anónimas autenticadas de Supabase Auth).
-- ============================================================================

ALTER TABLE public.syllabus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.practices ENABLE ROW LEVEL SECURITY;

-- Limpieza previa de políticas para que el script sea idempotente
DROP POLICY IF EXISTS "syllabus_select_own" ON public.syllabus;
DROP POLICY IF EXISTS "syllabus_insert_own" ON public.syllabus;
DROP POLICY IF EXISTS "syllabus_update_own" ON public.syllabus;
DROP POLICY IF EXISTS "syllabus_delete_own" ON public.syllabus;

DROP POLICY IF EXISTS "practices_select_own" ON public.practices;
DROP POLICY IF EXISTS "practices_insert_own" ON public.practices;
DROP POLICY IF EXISTS "practices_update_own" ON public.practices;
DROP POLICY IF EXISTS "practices_delete_own" ON public.practices;

-- Políticas para public.syllabus (solo el propietario autenticado)
CREATE POLICY "syllabus_select_own"
  ON public.syllabus
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "syllabus_insert_own"
  ON public.syllabus
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "syllabus_update_own"
  ON public.syllabus
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "syllabus_delete_own"
  ON public.syllabus
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Políticas para public.practices (solo el propietario autenticado)
CREATE POLICY "practices_select_own"
  ON public.practices
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "practices_insert_own"
  ON public.practices
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "practices_update_own"
  ON public.practices
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "practices_delete_own"
  ON public.practices
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Permisos explícitos al rol authenticated
GRANT SELECT, INSERT, UPDATE, DELETE ON public.syllabus TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.practices TO authenticated;
