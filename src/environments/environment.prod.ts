import { AppEnvironment } from './environment';

/**
 * Configuración de entorno de producción para Angular.
 * SEGURIDAD OBLIGATORIA:
 * GEMINI_API_KEY permanece exclusivamente en Supabase Edge Function Secrets.
 */
export const environment: AppEnvironment = {
  production: true,
  supabaseUrl: 'https://mnidmbzfxzvijfsypqqi.supabase.co',
  supabasePublishableKey: 'sb_publishable_YZPO5pDEsOvR07xQbZifMQ_EJd6zlmI',
  geminiEdgeFunctionName: 'gemini-exam',
};
